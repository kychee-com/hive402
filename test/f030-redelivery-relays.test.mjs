// F-030 (fix cycle 18, FIX-158): a RE-delivery never re-asks whether the
// harness already has the message.
//
// The node was OFF when these messages arrived, so no harness ever saw them.
// `Dispatcher.handle` nevertheless re-computed `deliveredDirectly` on the
// promise-replay and backlog-drain paths, and for a message authored by the
// agent's OWN OWNER — the majority case in a real room — all three conjuncts
// were true within seconds of `start()`, because `start()` launches every
// agent before the tick loop begins. The dispatcher then returned a handoff
// receipt and no wake: nothing published, no `[hive402] Waking up agent…`
// line, the message folded into a turn that was already running or a harness
// that came up seconds ago.
//
// Every assertion below is on the PUBLISHED effects — never on
// `deliveredDirectly`'s value — because the room is where the promise is kept
// or broken, and a boolean is not a delivery.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";
import { awayNotice, replayNote } from "../src/listener/notices.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";
import { writeResumePoint } from "../src/node/resumepoint.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const AGENT2 = "5".repeat(64);
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";
const TALNODE = "b".repeat(64);

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });
const nowSec = () => Math.floor(Date.now() / 1000);

// The ask that broke: authored by the agent's OWN OWNER, p-tagged, three days
// old so no catch-up window can reach it. Everything about it is ordinary.
const ownerAsk = ({
  id = "3".repeat(64),
  at = nowSec() - 3 * 24 * 3600,
  content = "@spike can you review the doc?",
  pubkey = OWNER,
  agentPubkey = AGENT,
} = {}) => ({
  id,
  kind: 9,
  pubkey,
  created_at: at,
  content,
  tags: [["p", agentPubkey]],
});

const promiseNotice = ({
  target = "3".repeat(64),
  author = TALNODE,
  name = "spike",
  at = nowSec() - 3 * 24 * 3600 + 60,
  id = null,
} = {}) => ({
  id: id ?? `${target.slice(0, 32)}${"e".repeat(32)}`,
  kind: 9,
  pubkey: author,
  created_at: at,
  content: awayNotice({ name }),
  tags: [["e", target, "", "reply"]],
});

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
      return [{ pubkey: AGENT }, { pubkey: AGENT2 }, { pubkey: TAL }, { pubkey: OWNER }, { pubkey: NODE }];
    },
  };
}

// The world-readable registry record for a NEIGHBOUR's agent, which is what
// makes TALNODE a node this one trusts — a promise is only a promise when a
// registry node made it (DD-55).
const smithRecord = {
  kind: 30177,
  pubkey: TALNODE,
  created_at: 100,
  tags: [["d", "a".repeat(64)]],
  content: JSON.stringify({ name: "smith", parallelism: 1, respond_to: "anyone" }),
};

function fakeQuery({ noticeRows = [], originals = [], replies = [], registry = [smithRecord] }) {
  return async ({ filters }) => {
    const f = filters[0] ?? {};
    if (f.kinds?.[0] === 30177) return registry;
    if (f.ids) return originals.filter((o) => f.ids.includes(o.id));
    if (f.kinds?.[0] === 9 && f.authors) return noticeRows;
    if (f.kinds?.[0] === 9 && f["#e"]) return replies;
    return [];
  };
}

const agentDef = ({ name = "spike", pubkey = AGENT } = {}) => ({
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

function harness({
  noticeRows = [],
  originals = [],
  replies = [],
  stateDir,
  cli,
  agents = [agentDef()],
  // The whole point of the finding: the harness IS up. `start()` launches
  // every agent before the tick loop begins, so a live child handle is what a
  // real node holds on its first tick after a restart.
  child = { pid: 6001, exitCode: null, killed: false, kill() {} },
} = {}) {
  const theCli = cli ?? fakeCli();
  const dir = stateDir ?? mkdtempSync(path.join(tmpdir(), "hive402-f030-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents }],
    },
    stateDir: dir,
    spawn: () => child,
    makeCli: () => theCli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    membershipRecheckMs: 0,
    queryEvents: fakeQuery({ noticeRows, originals, replies }),
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli: theCli, stateDir: dir };
}

const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

// ── The promise arm ───────────────────────────────────────────────────────

test("FIX-158: a PROMISED message from the agent's own owner is published, not re-handed to the running harness", async () => {
  const ask = ownerAsk();
  const { sup, cli } = harness({ noticeRows: [promiseNotice()], originals: [ask] });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "the promise the room was given produced a published wake");
  assert.ok(woken[0].content.includes("can you review the doc?"), "carrying the ask");
  assert.ok(
    woken[0].content.includes(replayNote({ answered: false })),
    "and the replay note, so the room can tell a replay from a live wake",
  );
  await sup.stop();
});

// ── The backlog arm, named separately ─────────────────────────────────────
//
// Both arms get their own test on purpose: this fork has half-fixed four of
// this product's defects, and a single test that happens to cover one arm is
// exactly how.

test("FIX-158: a BACKLOGGED message from the agent's own owner is published, not re-handed to the running harness", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f030-bl-"));
  const cli = fakeCli();

  // The node ran, got to a point in the room, and the machine went off.
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 4 * 3600 });
  // Then the owner asked, one hour ago — inside the catch-up window, and
  // nobody promised it.
  cli.deliver(ownerAsk({ id: "backlogged-ask", at: nowSec() - 3600, content: "@spike status?" }));

  const { sup } = harness({ stateDir, cli });
  await sup.start();
  await sup.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "the message the node missed produced a published wake");
  assert.ok(woken[0].content.includes("status?"), "carrying the ask");
  await sup.stop();
});

// ── The F-030 reproduction proper ─────────────────────────────────────────

test("FIX-158: two promised messages for one agent, drained back to back, BOTH publish a wake", async () => {
  const first = ownerAsk({ id: "1".repeat(64), at: nowSec() - 3 * 24 * 3600, content: "@spike question one" });
  const second = ownerAsk({ id: "2".repeat(64), at: nowSec() - 3 * 24 * 3600 + 1, content: "@spike question two" });
  const { sup, cli } = harness({
    noticeRows: [promiseNotice({ target: first.id }), promiseNotice({ target: second.id })],
    originals: [first, second],
  });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 2, "both promises were kept, not just the first");
  assert.ok(woken[0].content.includes("question one"), "oldest first (AC-63)");
  assert.ok(woken[1].content.includes("question two"));
  await sup.stop();
});

// ── The relay is the ONLY thing that changes ──────────────────────────────

test("FIX-158: forcing the relay changes nothing else about the turn — same authority, same thread, same audit row as any relayed wake", async () => {
  // The CONTROL: the identical owner-authored ask, relayed by the ordinary
  // live path because the agent's process is down. Whatever this turn gets is
  // what the promised one must get.
  const live = ownerAsk({ id: "4".repeat(64), at: nowSec() - 60, content: "@spike control ask" });
  const controlCli = fakeCli();
  const control = harness({
    cli: controlCli,
    // An EXITED harness is the one way an owner's own message already reaches
    // the relay branch today, so this is the shape a relayed owner turn has.
    child: { pid: 6002, exitCode: 0, killed: false, kill() {} },
  });
  await control.sup.start();
  // After start: everything in the room at start is history, not traffic.
  controlCli.deliver(live);
  await control.sup.tick();
  const controlWake = wakes(controlCli)[0];
  assert.ok(controlWake, "the control relayed its wake");
  const controlRecord = readAuthority({
    stateDir: control.stateDir,
    agent: "spike",
    eventId: controlWake.event_id,
  });
  assert.ok(controlRecord, "and the control turn holds an authority record");
  await control.sup.stop();

  // The SUBJECT: the same shape of ask, promised, with the harness up.
  const ask = ownerAsk({ id: "3".repeat(64), content: "@spike control ask" });
  const { sup, cli, stateDir } = harness({ noticeRows: [promiseNotice()], originals: [ask] });
  await sup.start();
  await sup.tick();
  await sup.tick();

  const woken = wakes(cli)[0];
  assert.ok(woken, "the promise produced a wake");
  assert.equal(woken.replyTo, ask.id, "anchored to the thread the question was asked in (AC-63)");
  assert.deepEqual(woken.mentions, controlWake.mentions, "same p-tag as any relayed wake");

  const record = readAuthority({ stateDir, agent: "spike", eventId: woken.event_id });
  assert.ok(record, "the replayed turn holds an authority record, like any relayed turn");
  assert.equal(
    record.kind,
    controlRecord.kind,
    "of exactly the kind the control's relayed owner turn got",
  );
  assert.equal(record.requester, controlRecord.requester, "attributed to the same asker");
  assert.deepEqual(record.capabilities, controlRecord.capabilities, "with the same capabilities");
  await sup.stop();
});
