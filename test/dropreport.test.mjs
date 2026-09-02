// FIX-142 (F-027, AC-66) — what the backlog bounds dropped is said IN THE ROOM,
// not only on the node's own console.
//
// ── What the Red Team saw ──────────────────────────────────────────────────
//
// Cycle 11 drove AC-66 live: three messages, both cover nodes and the main rig
// node down, one node restarted with `-BacklogItems 2`. The count bound dropped
// one message and the node said so — in `cover-b.log`, a file on the machine
// running the node. Nobody in the room was told anything. From the room the
// dropped question is indistinguishable from a question nobody ever asked,
// which is the exact failure `backlog.mjs`'s own comment says the counts exist
// to end: "an unreported age-drop reads exactly like 'there was nothing to
// answer'".
//
// AC-64's sibling notice — the replay overflow — publishes with `entry.cli.send`
// and leaves an audit row. AC-66's two reports went to `this.#log`. The node had
// the fact and handed it to a console.
//
// ── What these tests drive ─────────────────────────────────────────────────
//
// A real `Supervisor.start()` against a real state directory holding a real
// resume point, so the watermark is established the way a restart establishes
// it. `partitionOnResume` is not stubbed: the drop counts come from the product
// deciding them. The two bounds are exercised separately because they have
// different remedies and one merged sentence would tell the owner the wrong
// thing about half its own subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { writeResumePoint } from "../src/node/resumepoint.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const nowSec = () => Math.floor(Date.now() / 1000);

function roomCli({ failSends = false } = {}) {
  const sent = [];
  const events = [];
  return {
    sent,
    deliver(e) {
      events.push(e);
    },
    async getMessages() {
      return [...events];
    },
    async send(args) {
      // The room that cannot be posted to. A relay blip must not stop the node
      // establishing its watermark, or one failed send becomes a room the node
      // never dispatches in at all.
      if (failSends) throw new Error("relay refused the publish");
      sent.push(args);
      return { accepted: true, event_id: `sent-${sent.length}` };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser({ pubkey, name }) {
      if (name) return { pubkey: AGENT, display_name: name };
      return { pubkey, display_name: pubkey === AGENT ? "smith" : "Tal" };
    },
    async myChannels() {
      return [{ channel: CHANNEL }];
    },
    async channelMembers() {
      return [{ pubkey: AGENT }, { pubkey: TAL }, { pubkey: OWNER }, { pubkey: NODE }];
    },
  };
}

const smith = () => ({
  name: "smith",
  pubkey: AGENT,
  ownerPubkey: OWNER,
  privateKeyRef: "env:TEST_AGENT_KEY",
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
});

function nodeOn({ stateDir, cli, backlog }) {
  return new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      ...(backlog ? { backlog } : {}),
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents: [smith()] }],
    },
    stateDir,
    spawn: () => ({ pid: 4242, exitCode: null, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: (agent) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }),
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    // FIX-164 (F-031, DD-65): the reports are published after the promise
    // collection, so this harness has to have one. Without these two stubs the
    // Supervisor reaches the REAL relay, the collection throws, and the report
    // is HELD — every assertion below would pass vacuously against silence.
    // Empty rows mean "nothing was promised", which is this file's subject:
    // messages the bounds really did drop.
    queryEvents: async () => [],
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
}

const ask = (secondsAgo, over = {}) => ({
  id: over.id ?? `ask-${secondsAgo}`,
  kind: 9,
  pubkey: TAL,
  created_at: nowSec() - secondsAgo,
  content: "@smith what is the status?",
  tags: [],
  ...over,
});

// Everything the node published into the room under its own marker.
const notices = (cli) => cli.sent.filter((s) => String(s.content ?? "").startsWith(HIVE_MARKER));

const auditRows = (stateDir) => {
  const file = path.join(stateDir, "audit.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

// A node that was here an hour ago, so there IS a resume point and the window
// applies. Without one the whole room is history and no bound can ever bite.
function restarted({ backlog, cli = roomCli() } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-drop-"));
  writeResumePoint({ stateDir, channel: CHANNEL, at: nowSec() - 3600 });
  return { stateDir, cli, sup: nodeOn({ stateDir, cli, backlog }) };
}

// ── The COUNT bound ────────────────────────────────────────────────────────

test("THE BUG: a count-bound drop is reported IN THE ROOM, not only to a log file", async () => {
  // Three questions inside the window, room for one. Two are dropped.
  const { sup, cli, stateDir } = restarted({ backlog: { maxItems: 1, maxAgeMs: 3600_000 } });
  for (const secs of [300, 200, 100]) cli.deliver(ask(secs));

  await sup.start();
  // FIX-164 (F-031, DD-65): the report is published on the first TICK now, not
  // inside the watermark pass, because what the BOUNDS dropped is not yet what
  // was NOT ANSWERED until the promise set for this start is known. Nothing
  // else about these assertions changes: they are still about the sentence the
  // room receives.
  await sup.tick();

  const posted = notices(cli).filter((s) => /went unanswered/.test(s.content));
  assert.equal(posted.length, 1, "the room is told once that the count bound dropped work");
  assert.match(posted[0].content, /\b2 older messages\b/, "and told how many");
  assert.match(posted[0].content, /limit 1/, "and what the limit was, which is the remedy");
  assert.equal(posted[0].channel, CHANNEL);

  const rows = auditRows(stateDir).filter((r) => r.kind === "backlog-dropped");
  assert.equal(rows.length, 1, "a drop leaves a row, exactly as the replay overflow does");
  assert.match(rows[0].detail, /count/, "naming WHICH bound dropped");
  assert.match(rows[0].detail, /2/, "and how many");

  await sup.stop();
});

// ── The AGE bound ──────────────────────────────────────────────────────────

test("an age-bound drop posts its OWN sentence, because the remedy is different", async () => {
  // Newer than the resume point, older than a 60-second window: aged out.
  const { sup, cli } = restarted({ backlog: { maxItems: 50, maxAgeMs: 60_000 } });
  cli.deliver(ask(600, { id: "aged-1" }));
  cli.deliver(ask(500, { id: "aged-2" }));

  await sup.start();
  // FIX-164 (F-031, DD-65): the report is published on the first TICK now, not
  // inside the watermark pass, because what the BOUNDS dropped is not yet what
  // was NOT ANSWERED until the promise set for this start is known. Nothing
  // else about these assertions changes: they are still about the sentence the
  // room receives.
  await sup.tick();

  const posted = notices(cli).filter((s) => /older than the backlog window/.test(s.content));
  assert.equal(posted.length, 1, "the age bound reports itself");
  assert.match(posted[0].content, /\b2 messages\b/);
  assert.ok(
    !/went unanswered \(limit/.test(posted[0].content),
    "and does not borrow the count bound's remedy, which does not apply to it",
  );

  await sup.stop();
});

test("both bounds firing produce TWO distinct sentences, never one merged one", async () => {
  // Two aged out past a 60s window, and three inside it with room for one.
  const { sup, cli, stateDir } = restarted({ backlog: { maxItems: 1, maxAgeMs: 60_000 } });
  cli.deliver(ask(600, { id: "aged-1" }));
  cli.deliver(ask(500, { id: "aged-2" }));
  for (const secs of [30, 20, 10]) cli.deliver(ask(secs));

  await sup.start();
  // FIX-164 (F-031, DD-65): the report is published on the first TICK now, not
  // inside the watermark pass, because what the BOUNDS dropped is not yet what
  // was NOT ANSWERED until the promise set for this start is known. Nothing
  // else about these assertions changes: they are still about the sentence the
  // room receives.
  await sup.tick();

  const posted = notices(cli).filter((s) => /Ask again if they still matter/.test(s.content));
  assert.equal(posted.length, 2, "two bounds, two sentences");
  assert.equal(
    new Set(posted.map((p) => p.content)).size,
    2,
    "and they say different things, because the remedies differ",
  );

  const rows = auditRows(stateDir).filter((r) => r.kind === "backlog-dropped");
  assert.equal(rows.length, 2, "one row per bound");
  assert.deepEqual(
    rows.map((r) => /count/.test(r.detail)).sort(),
    [false, true],
    "one names the count bound, the other the age bound",
  );

  await sup.stop();
});

// ── The discrimination that matters: silence when nothing was dropped ──────

test("a clean start posts NOTHING — the notice is not a routine startup line", async () => {
  const { sup, cli } = restarted({ backlog: { maxItems: 50, maxAgeMs: 3600_000 } });
  cli.deliver(ask(100));

  await sup.start();
  // FIX-164 (F-031, DD-65): the report is published on the first TICK now, not
  // inside the watermark pass, because what the BOUNDS dropped is not yet what
  // was NOT ANSWERED until the promise set for this start is known. Nothing
  // else about these assertions changes: they are still about the sentence the
  // room receives.
  await sup.tick();

  assert.deepEqual(
    notices(cli).filter((s) => /Ask again if they still matter/.test(s.content)),
    [],
    "one message, room for fifty, inside the window: nothing was dropped and nothing is said",
  );

  await sup.stop();
});

// ── It must not wake anything, now or on any later replay ──────────────────

test("the report is never mention-shaped: no @, no mention tag, channel root", async () => {
  const { sup, cli } = restarted({ backlog: { maxItems: 1, maxAgeMs: 60_000 } });
  cli.deliver(ask(600, { id: "aged-1" }));
  for (const secs of [30, 20]) cli.deliver(ask(secs));

  await sup.start();
  // FIX-164 (F-031, DD-65): the report is published on the first TICK now, not
  // inside the watermark pass, because what the BOUNDS dropped is not yet what
  // was NOT ANSWERED until the promise set for this start is known. Nothing
  // else about these assertions changes: they are still about the sentence the
  // room receives.
  await sup.tick();

  const posted = notices(cli).filter((s) => /Ask again if they still matter/.test(s.content));
  assert.equal(posted.length, 2, "precondition: both reports were posted");
  for (const p of posted) {
    // A non-member at-word blocks the send outright in Buzz clients, and an
    // address would wake an agent on the replay pass reading it back.
    assert.ok(!p.content.includes("@"), `no at-word anywhere in: ${p.content}`);
    assert.deepEqual(p.mentions ?? [], [], "no mention tag");
    assert.equal(p.replyTo ?? null, null, "at the channel root, like AC-64's sibling");
  }

  await sup.stop();
});

// ── A room that cannot be posted to must not stop the node ─────────────────

test("a send that throws still leaves the node dispatching from that room", async () => {
  const cli = roomCli({ failSends: true });
  const { sup } = restarted({ backlog: { maxItems: 1, maxAgeMs: 3600_000 }, cli });
  for (const secs of [300, 200, 100]) cli.deliver(ask(secs));

  await sup.start();
  // The watermark was established despite the failed publish, so the backlog it
  // kept is dispatched on the next tick rather than the room going permanently
  // silent behind one relay blip.
  await sup.tick();

  assert.ok(sup.watching().includes(CHANNEL), "the room is still being watched");

  await sup.stop();
});
