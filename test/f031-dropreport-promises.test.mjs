// F-031 (fix cycle 19, FIX-164, DD-65): the AC-66 drop report counts what was
// actually dropped — not what the node is about to answer.
//
// ── What the Red Team saw ──────────────────────────────────────────────────
//
// Cycle 15 drove AC-66 live. The node came back and told the room five messages
// had sat past the backlog window and were not answered. It then answered three
// of them, each with the replay note, because each carried a standing AC-61
// promise from a peer node. The number was false about exactly the messages a
// reader most needs it to be right about: the ones somebody was told would be
// answered.
//
// ── The root cause ─────────────────────────────────────────────────────────
//
// The count and the promise set are computed by different code, from different
// sources, at different points in the same tick, and nothing joins them.
// `partitionOnResume` decides the age bound with a pure timestamp test over the
// last 100 events; a promise is not a property of the event at all — it is a
// separate kind-9 notice, authored by another node, found by a different query
// on a different pass (`#collectPromises`). And the report was published from
// `#establishWatermark`, which runs BEFORE that pass ever ran.
//
// ── The count bound has the identical defect ───────────────────────────────
//
// No cycle has observed it, and it is one config value away: a promised message
// that lands inside the age window but is trimmed by `maxItems` is added to the
// watermark and reported as dropped — and is then replayed anyway, because the
// promise pass dispatches from `entry.promised` and never consults the
// watermark. Both bounds are tested here, and both are fixed.
//
// ── What these tests drive ─────────────────────────────────────────────────
//
// A real `Supervisor.start()` plus a real tick against a real state directory
// holding a real resume point. `partitionOnResume` is not stubbed and neither is
// `#collectPromises`: the counts come from the product deciding them, and the
// promises come from a trusted peer node's notices going through the same
// registry/notice/original/reply query path production uses. The assertions are
// on the SENTENCE the room receives, never on a return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { awayNotice, replayNote } from "../src/listener/notices.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";
import { writeResumePoint } from "../src/node/resumepoint.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const SMITH = "5c2f0d1b8a7e6439ac10bd5e2f77c4a9013e8b6d2c5f7a04e9b3d81c6f2a47b5";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";
// The PEER node that made the promises. It has to be in the kind-30177 registry
// or `entry.knownNodes` is empty, every notice fails the trust filter, and every
// assertion below passes vacuously against zero promises.
const PEERNODE = "b".repeat(64);

const nowSec = () => Math.floor(Date.now() / 1000);

// 64 hex, always. `replyTargetOf` parses nothing out of a short id, so a fixture
// with `id: "ask-1"` produces no promise at all and a test that proves nothing.
const hexId = (seed) => String(seed).repeat(64).slice(0, 64);

const agentOf = ({ name, pubkey }) => ({
  name,
  pubkey,
  ownerPubkey: OWNER,
  privateKeyRef: "env:TEST_AGENT_KEY",
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
});

const ask = ({ id, at, content = "@spike what is the status?", to = [SPIKE], pubkey = TAL }) => ({
  id,
  kind: 9,
  pubkey,
  created_at: at,
  content,
  tags: to.map((p) => ["p", p]),
});

// An AC-61 away notice, authored by the peer node, in reply to the message it
// took. This is the only thing that makes a message "promised".
const promiseNotice = ({ target, name = "spike", author = PEERNODE }) => ({
  id: `${target.slice(0, 32)}${"e".repeat(32)}`,
  kind: 9,
  pubkey: author,
  created_at: nowSec() - 60,
  content: awayNotice({ name }),
  tags: [["e", target, "", "reply"]],
});

// The registry row that makes PEERNODE a trusted author.
const registryRow = {
  kind: 30177,
  pubkey: PEERNODE,
  created_at: 100,
  tags: [["d", "a".repeat(64)]],
  content: JSON.stringify({ name: "spike", parallelism: 1, respond_to: "anyone" }),
};

function fakeCli() {
  const sent = [];
  const events = [];
  return {
    sent,
    events,
    deliver(event) {
      events.push(event);
    },
    async getMessages() {
      return [...events];
    },
    async send(args) {
      const event_id = `sent-${sent.length + 1}`;
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser() {
      return null;
    },
    async myChannels() {
      return [{ channel: CHANNEL }];
    },
    async channelMembers() {
      return [{ pubkey: SPIKE }, { pubkey: SMITH }, { pubkey: TAL }, { pubkey: OWNER }, { pubkey: NODE }];
    },
  };
}

// Success AND failure both log, so a silent query means it ran and found
// nothing — which is why every branch here is explicit.
function fakeQuery({ notices = [], originals = [], replies = [], failNotices = false }) {
  return async ({ filters }) => {
    const f = filters[0] ?? {};
    if (f.kinds?.[0] === 30177) return [registryRow];
    if (f.ids) return originals.filter((o) => f.ids.includes(o.id));
    if (f.kinds?.[0] === 9 && f.authors) {
      if (failNotices) throw new Error("relay query failed");
      return notices;
    }
    if (f.kinds?.[0] === 9 && f["#e"]) return replies;
    return [];
  };
}

function harness({
  backlog,
  cover,
  agents = [agentOf({ name: "spike", pubkey: SPIKE })],
  notices = [],
  originals = [],
  replies = [],
  failNotices = false,
  resumeAgoSec = 4 * 3600,
} = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f031-"));
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - resumeAgoSec });
  const cli = fakeCli();
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      ...(backlog ? { backlog } : {}),
      ...(cover ? { cover } : {}),
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents }],
    },
    stateDir,
    spawn: () => ({ pid: 6001, exitCode: null, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: (agent) =>
      computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }),
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    queryEvents: fakeQuery({ notices, originals, replies, failNotices }),
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli, stateDir };
}

const posted = (cli, re) =>
  cli.sent.filter((s) => String(s.content ?? "").startsWith(HIVE_MARKER) && re.test(s.content));

const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

const AGE_RE = /older than the backlog window/;
const COUNT_RE = /went unanswered \(limit/;

const marks = (stateDir) => {
  const file = path.join(stateDir, "promises.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
};

// A promised aged-out message: the original, plus the notice that promised it.
function promised({ id, at, name = "spike", to = [SPIKE], content }) {
  const original = ask({ id, at, to, content: content ?? `@${name} what is the status?` });
  return { original, notice: promiseNotice({ target: id, name }) };
}

// ── The AGE bound: F-031's exact shape ─────────────────────────────────────

test("THE BUG (F-031): five aged-out messages, three of them promised — the room is told TWO", async () => {
  const NOW = nowSec();
  // Newer than the resume point (4h), older than a 60-second window: aged out.
  const p = [3000, 2400, 1800].map((ago, i) => promised({ id: hexId(i + 1), at: NOW - ago }));
  const unpromised = [ask({ id: hexId(7), at: NOW - 1200 }), ask({ id: hexId(8), at: NOW - 600 })];

  const { sup, cli, stateDir } = harness({
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    notices: p.map((x) => x.notice),
    originals: p.map((x) => x.original),
  });
  for (const e of [...p.map((x) => x.original), ...unpromised]) cli.deliver(e);

  await sup.start();
  await sup.tick();

  const reports = posted(cli, AGE_RE);
  assert.equal(reports.length, 1, "the age bound reports itself once");
  assert.match(
    reports[0].content,
    /\b2 messages\b/,
    `the report counts what was DROPPED, not what is about to be answered: ${reports[0].content}`,
  );
  assert.ok(
    !/\b5 messages\b/.test(reports[0].content),
    "five is the count of aged-out messages, three of which the node answers seconds later",
  );

  const replayed = wakes(cli).filter((w) => w.content.includes(replayNote({ answered: false })));
  assert.equal(replayed.length, 3, "and the three promised messages are still answered, with the replay note");

  assert.equal(
    Object.keys(marks(stateDir)).length,
    3,
    "promises.json holds exactly three marks — one per promise kept",
  );

  await sup.stop();
});

test("F-031: the report comes BEFORE the replay wakes, so the room reads it first", async () => {
  const NOW = nowSec();
  const p = [3000, 2400].map((ago, i) => promised({ id: hexId(i + 1), at: NOW - ago }));
  const { sup, cli } = harness({
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    notices: p.map((x) => x.notice),
    originals: p.map((x) => x.original),
  });
  for (const e of [...p.map((x) => x.original), ask({ id: hexId(9), at: NOW - 600 })]) cli.deliver(e);

  await sup.start();
  await sup.tick();

  const order = cli.sent.map((s) => String(s.content ?? ""));
  const report = order.findIndex((c) => AGE_RE.test(c));
  const firstWake = order.findIndex((c) => c.includes(`${HIVE_MARKER} Waking up agent`));
  assert.ok(report >= 0, "the report was posted");
  assert.ok(firstWake >= 0, "and a replay wake was posted");
  assert.ok(report < firstWake, "the room reads the report first, as it does today");

  await sup.stop();
});

// ── The COUNT bound: the arm no cycle has observed live ────────────────────

test("F-031's second bound: a promised message trimmed by maxItems is not reported as dropped", async () => {
  const NOW = nowSec();
  // A one-hour window, room for ONE. Five candidates, the three oldest promised:
  // the cap drops the oldest four, and three of those four are answered anyway.
  const p = [3000, 2700, 2400].map((ago, i) => promised({ id: hexId(i + 1), at: NOW - ago }));
  const unpromised = [ask({ id: hexId(7), at: NOW - 1200 }), ask({ id: hexId(8), at: NOW - 600 })];

  const { sup, cli } = harness({
    backlog: { maxItems: 1, maxAgeMs: 3600_000 },
    notices: p.map((x) => x.notice),
    originals: p.map((x) => x.original),
  });
  for (const e of [...p.map((x) => x.original), ...unpromised]) cli.deliver(e);

  await sup.start();
  await sup.tick();

  const reports = posted(cli, COUNT_RE);
  assert.equal(reports.length, 1, "the count bound reports itself once");
  assert.match(
    reports[0].content,
    /\b1 older message\b/,
    `four were trimmed by the cap, three of them promised: ${reports[0].content}`,
  );
  assert.ok(
    !/\b4 older messages\b/.test(reports[0].content),
    "the count bound has the same defect as the age bound and is one config value away",
  );

  const replayed = wakes(cli).filter((w) => w.content.includes(replayNote({ answered: false })));
  assert.equal(replayed.length, 3, "the promise pass dispatches from entry.promised, never the watermark");

  await sup.stop();
});

test("when EVERY dropped message was promised, nothing is posted at all", async () => {
  const NOW = nowSec();
  const p = [3000, 2400, 1800].map((ago, i) => promised({ id: hexId(i + 1), at: NOW - ago }));

  const { sup, cli } = harness({
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    notices: p.map((x) => x.notice),
    originals: p.map((x) => x.original),
  });
  for (const e of p.map((x) => x.original)) cli.deliver(e);

  await sup.start();
  await sup.tick();

  assert.deepEqual(
    posted(cli, /Ask again if they still matter/).map((s) => s.content),
    [],
    "nothing was dropped, so nothing is said — the report is not a routine startup line",
  );
  assert.equal(
    wakes(cli).filter((w) => w.content.includes(replayNote({ answered: false }))).length,
    3,
    "precondition: all three really were answered by the promise path",
  );

  await sup.stop();
});

// ── DD-65's deliberate carve-out: an AC-64 overflow IS still counted ────────

test("DD-65: a promise dropped by the AC-64 cap is STILL counted by the age report", async () => {
  const NOW = nowSec();
  const p = [3000, 2400, 1800].map((ago, i) => promised({ id: hexId(i + 1), at: NOW - ago }));

  const { sup, cli } = harness({
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    cover: { replayCapPerAgent: 1 },
    notices: p.map((x) => x.notice),
    originals: p.map((x) => x.original),
  });
  for (const e of p.map((x) => x.original)) cli.deliver(e);

  await sup.start();
  await sup.tick();

  const reports = posted(cli, AGE_RE);
  assert.equal(reports.length, 1, "the age bound still reports");
  assert.match(
    reports[0].content,
    /\b2 messages\b/,
    "two promises the cap refused genuinely are not answered, so the age count stays true about them",
  );
  assert.equal(
    posted(cli, /more messages were waiting for/).length,
    1,
    "and AC-64's own sentence is posted too: two true statements, not one false one",
  );

  await sup.stop();
});

// ── DD-65's failure branch: hold the report, do not guess ──────────────────

test("DD-65: a FAILED promise collection holds the report — and the backlog still drains", async () => {
  const NOW = nowSec();
  const inWindow = ask({ id: hexId(9), at: NOW - 30 });
  const { sup, cli } = harness({
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    failNotices: true,
  });
  cli.deliver(ask({ id: hexId(1), at: NOW - 3000 }));
  cli.deliver(inWindow);

  await sup.start();
  await sup.tick();

  assert.deepEqual(
    posted(cli, /Ask again if they still matter/).map((s) => s.content),
    [],
    "the node cannot know what was promised, so it does not state a number it cannot stand behind",
  );
  // FIX-160 is not reversed: the BACKLOG is released, only the REPORT is held.
  assert.equal(wakes(cli).length, 1, "the in-window message is still answered");

  await sup.stop();
});

// ── Widening once, before trusting it ──────────────────────────────────────

test("a message addressing TWO of this node's agents, promised for one, counts once and is answered", async () => {
  const NOW = nowSec();
  const both = ask({
    id: hexId(1),
    at: NOW - 3000,
    content: "@spike @smith what is the status?",
    to: [SPIKE, SMITH],
  });
  const { sup, cli } = harness({
    agents: [agentOf({ name: "spike", pubkey: SPIKE }), agentOf({ name: "smith", pubkey: SMITH })],
    backlog: { maxItems: 50, maxAgeMs: 60_000 },
    notices: [promiseNotice({ target: both.id, name: "spike" })],
    originals: [both],
  });
  cli.deliver(both);
  cli.deliver(ask({ id: hexId(7), at: NOW - 1200 }));

  await sup.start();
  await sup.tick();

  const reports = posted(cli, AGE_RE);
  assert.equal(reports.length, 1);
  assert.match(
    reports[0].content,
    /\b1 message\b/,
    "the count's unit is the MESSAGE, and the message is answered — so only the unpromised one is dropped",
  );
  assert.ok(
    wakes(cli).some((w) => w.content.includes(replayNote({ answered: false }))),
    "and it really is answered by the promise path",
  );

  await sup.stop();
});
