// FIX-124 — a mention that arrives while the node is down is answered when it
// comes back (AC-2, AC-5, AC-7).
//
// ── The question that found this ───────────────────────────────────────────
//
// Barry, 2026-08-27: "Say I turn OFF my computer and tal writes to smith. Then I
// turn it on tomorrow, will smith reply then?"
//
// No. And not because the node cannot see the message — it CAN. `up` read the
// last 100 messages and put every one of them into a set of ids to skip:
//
//     // Everything already in the room when we started is history, not a
//     // backlog. Without this, restarting the node re-answers every message it
//     // can see.
//
// Tal's message is in that 100, so it is marked handled before the first tick
// and skipped forever. Nobody is told: not Tal, not Barry, not the room. That is
// the criterion AC-2 is really about — members on different machines in
// different timezones — failing silently.
//
// ── Why the rule stays ─────────────────────────────────────────────────────
//
// The comment is right. Without it a restart re-answers everything visible: a
// hundred stale replies into a live room, each burning a turn and real model
// spend. So this is a WINDOW, not a removal. Three conditions, all required:
//
//   1. addressed to one of THIS node's agents (not all traffic, just ours);
//   2. newer than the resume point — where this node got to last time;
//   3. inside a bounded age.
//
// ── Why a resume point and not a shutdown time ─────────────────────────────
//
// "Since the last shutdown" cannot be read from a shutdown. The case Barry cares
// about is the machine being OFF, which is exactly the case where `stop()` never
// runs and no clean shutdown is ever recorded. So the node records where it GOT
// TO while it was alive: the `created_at` of the newest event it has processed.
// That survives a power cut, a crash, and a closed laptop lid identically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { partitionOnResume, reconcileDrops } from "../src/node/backlog.mjs";
import { readResumePoint, writeResumePoint } from "../src/node/resumepoint.mjs";

const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const OTHER = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const agents = [{ name: "smith", pubkey: AGENT }];
const NOW = 1_800_000_000; // unix SECONDS: nostr created_at, not Date.now()
const HOUR = 3600;

// Nostr events carry `created_at` in seconds; every boundary here is in seconds
// on purpose, because mixing the two units is how a "6 hour" window silently
// becomes a 6-millisecond one.
const at = (secondsAgo, over = {}) => ({
  id: over.id ?? `e-${secondsAgo}`,
  kind: 9,
  pubkey: OTHER,
  created_at: NOW - secondsAgo,
  content: "@smith what is the status?",
  tags: [],
  ...over,
});

const opts = (over = {}) => ({
  agents,
  now: NOW,
  maxAgeSec: 12 * HOUR,
  maxItems: 5,
  ...over,
});

// ── The case Barry asked about ────────────────────────────────────────────

test("a mention that arrived while the node was down is BACKLOG, not history", () => {
  const missed = at(2 * HOUR, { id: "tal-asked" });
  const { backlog, watermark } = partitionOnResume({
    events: [missed],
    resumeFrom: NOW - 6 * HOUR, // the node was last alive six hours ago
    ...opts(),
  });
  assert.deepEqual(backlog.map((e) => e.id), ["tal-asked"]);
  assert.equal(watermark.has("tal-asked"), false, "it must NOT be pre-marked as seen");
});

test("everything the node already handled stays history", () => {
  // The reason the original rule exists. These are older than the resume point,
  // so the node answered them on a previous run.
  const old = at(8 * HOUR, { id: "answered-yesterday" });
  const { backlog, watermark } = partitionOnResume({
    events: [old],
    resumeFrom: NOW - 6 * HOUR,
    ...opts(),
  });
  assert.deepEqual(backlog, []);
  assert.equal(watermark.has("answered-yesterday"), true);
});

test("a message NOT addressed to one of this node's agents is never backlogged", () => {
  // Two people talking to each other while the node was down is not work.
  const chatter = at(HOUR, { id: "human-chat", content: "morning all" });
  const other = at(HOUR, { id: "other-agent", content: "@someoneelse ping" });
  const { backlog, watermark } = partitionOnResume({
    events: [chatter, other],
    resumeFrom: NOW - 6 * HOUR,
    ...opts(),
  });
  assert.deepEqual(backlog, []);
  assert.equal(watermark.has("human-chat"), true);
  assert.equal(watermark.has("other-agent"), true);
});

// ── The two bounds, and why one is not enough ─────────────────────────────

test("a mention older than the window is history however long the node was away", () => {
  // "Answer everything since I was last up" turns a week away into a week of
  // replies to conversations that ended days ago. That is worse than silence.
  const stale = at(30 * HOUR, { id: "last-week" });
  const { backlog, watermark } = partitionOnResume({
    events: [stale],
    resumeFrom: NOW - 40 * HOUR,
    ...opts({ maxAgeSec: 12 * HOUR }),
  });
  assert.deepEqual(backlog, []);
  assert.equal(watermark.has("last-week"), true);
});

test("a busy window is capped by COUNT, and what was dropped is reported", () => {
  // Inside the age window a busy room can still hold dozens of mentions, and
  // flushing them all would fire dozens of turns at once.
  const many = Array.from({ length: 9 }, (_, i) => at(HOUR + i, { id: `m${i}` }));
  const { backlog, dropped } = partitionOnResume({
    events: many,
    resumeFrom: NOW - 6 * HOUR,
    ...opts({ maxItems: 5 }),
  });
  assert.equal(backlog.length, 5);
  assert.equal(dropped, 4, "the count is REPORTED — a silent cap reads as 'there was nothing'");
});

test("when the cap bites it keeps the NEWEST, because those are the live ones", () => {
  const many = [at(5 * HOUR, { id: "oldest" }), at(2 * HOUR, { id: "middle" }), at(HOUR, { id: "newest" })];
  const { backlog } = partitionOnResume({
    events: many,
    resumeFrom: NOW - 6 * HOUR,
    ...opts({ maxItems: 2 }),
  });
  assert.deepEqual(backlog.map((e) => e.id), ["middle", "newest"]);
});

test("backlog is handed back oldest-first, so a conversation replays in order", () => {
  const many = [at(HOUR, { id: "second" }), at(3 * HOUR, { id: "first" })];
  const { backlog } = partitionOnResume({ events: many, resumeFrom: NOW - 6 * HOUR, ...opts() });
  assert.deepEqual(backlog.map((e) => e.id), ["first", "second"]);
});

// ── A node that has never run ─────────────────────────────────────────────

test("with no resume point the whole room is history, however recent", () => {
  // A first `up` must not answer a room's back catalogue. Someone joining a
  // channel with a year of chat in it, whose agent then replies to a mention
  // from March, is a worse first impression than any amount of silence.
  const recent = at(60, { id: "five-minutes-ago" });
  const { backlog, watermark } = partitionOnResume({
    events: [recent],
    resumeFrom: null,
    ...opts(),
  });
  assert.deepEqual(backlog, []);
  assert.equal(watermark.has("five-minutes-ago"), true);
});

// ── The clock, and events from the future ─────────────────────────────────

test("an event stamped in the future is not treated as backlog", () => {
  // `created_at` is chosen by the sender. Without a ceiling, anyone could put a
  // message permanently inside every future backlog window by dating it 2099.
  const future = at(-48 * HOUR, { id: "dated-2099" });
  const { backlog, watermark } = partitionOnResume({
    events: [future],
    resumeFrom: NOW - 6 * HOUR,
    ...opts(),
  });
  assert.deepEqual(backlog, []);
  assert.equal(watermark.has("dated-2099"), true);
});

test("an event with no usable timestamp is history, not backlog", () => {
  // The safe direction: an unanswered question is recoverable by asking again,
  // an unbidden reply to something undateable is not.
  for (const bad of [undefined, null, "yesterday", NaN]) {
    const { backlog, watermark } = partitionOnResume({
      events: [at(HOUR, { id: "undated", created_at: bad })],
      resumeFrom: NOW - 6 * HOUR,
      ...opts(),
    });
    assert.deepEqual(backlog, [], `created_at ${JSON.stringify(bad)} must not backlog`);
    assert.equal(watermark.has("undated"), true);
  }
});

// ── FIX-164 (F-031, DD-65): the counts are DERIVED, so they cannot drift ──
//
// Two fields became derived rather than primary when the bounds started
// returning ids. A count and a list that are computed separately are exactly
// how F-031 happened one layer up, so this asserts each count IS its list.

test("each bound reports WHICH messages it dropped, and the count is that list", () => {
  const many = Array.from({ length: 9 }, (_, i) => at(HOUR + i, { id: `m${i}` }));
  const aged = [at(20 * HOUR, { id: "old-1" }), at(18 * HOUR, { id: "old-2" })];
  const r = partitionOnResume({
    events: [...many, ...aged],
    resumeFrom: NOW - 30 * HOUR,
    ...opts({ maxItems: 5 }),
  });

  assert.equal(r.dropped, r.droppedIds.length, "the count bound counts its own list");
  assert.equal(r.agedOut, r.agedOutIds.length, "and so does the age bound");
  assert.equal(r.droppedIds.length, 4);
  assert.deepEqual(r.agedOutIds.sort(), ["old-1", "old-2"]);
  for (const id of r.droppedIds) {
    assert.equal(r.watermark.has(id), true, "a message the cap dropped is history, not a re-flood");
  }
});

test("reconcileDrops subtracts a promised message from BOTH bounds", () => {
  // The join F-031 was missing. The count bound had the identical defect and no
  // cycle had hit it: fixing only the age bound leaves the same false sentence
  // one config value away.
  const r = reconcileDrops({
    agedOutIds: ["a1", "a2", "a3"],
    droppedIds: ["c1", "c2"],
    promisedIds: ["a2", "c1"],
  });
  assert.deepEqual(r.agedOutIds, ["a1", "a3"]);
  assert.deepEqual(r.droppedIds, ["c2"]);
  assert.equal(r.agedOut, 2);
  assert.equal(r.dropped, 1);
});

test("reconcileDrops matches ids case-insensitively, like every other id compare", () => {
  // `promisesIn` lowercases the target it reads out of the notice tag; the
  // relay does not promise a case for the id on the event. A case-sensitive
  // join here would silently subtract nothing and read exactly like no fix.
  const r = reconcileDrops({ agedOutIds: ["AbCdEf"], promisedIds: ["abcdef"] });
  assert.equal(r.agedOut, 0);
});

test("reconcileDrops with no promises changes nothing", () => {
  const r = reconcileDrops({ agedOutIds: ["a1", "a2"], droppedIds: ["c1"] });
  assert.equal(r.agedOut, 2);
  assert.equal(r.dropped, 1);
});

// ── The resume point on disk ──────────────────────────────────────────────

test("a resume point survives the process that wrote it", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-"));
  writeResumePoint({ stateDir, channel: CHANNEL, at: NOW });
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), NOW);
});

test("each channel resumes at its own point", () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-"));
  const other = "11111111-2222-3333-4444-555555555555";
  writeResumePoint({ stateDir, channel: CHANNEL, at: NOW });
  writeResumePoint({ stateDir, channel: other, at: NOW - HOUR });
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), NOW);
  assert.equal(readResumePoint({ stateDir, channel: other }), NOW - HOUR);
});

test("a resume point never moves BACKWARDS", () => {
  // Events do not arrive in timestamp order, and a late-delivered old event
  // rewinding the point would re-open a window the node already closed —
  // re-answering what it answered on the previous tick.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-"));
  writeResumePoint({ stateDir, channel: CHANNEL, at: NOW });
  writeResumePoint({ stateDir, channel: CHANNEL, at: NOW - 5 * HOUR });
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), NOW);
});

test("no resume point, and an unreadable one, both read as null", () => {
  // Null is the safe answer: it means "treat the room as history" (see above),
  // so a corrupt file costs one silent gap rather than a room-wide replay.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-"));
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), null);
  writeResumePoint({ stateDir, channel: CHANNEL, at: "not a time" });
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), null);
});

// ── The whole thing, through a real Supervisor ────────────────────────────
//
// The tests above prove the PARTITION. These prove the WIRING, which is where
// FIX-124 could still be a no-op: a correct partition whose result nothing reads
// changes nothing about whether Tal gets an answer.
//
// Each one is the scenario Barry described. A node runs and gets to a point in
// the room. The machine goes off, modelled by dropping the Supervisor and
// keeping the state directory, which is what a power cut actually does. A
// message arrives. A NEW Supervisor starts against that same directory, and the
// question is whether it speaks.

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

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

function roomCli({ failReads = false } = {}) {
  const sent = [];
  const events = [];
  return {
    sent,
    failReads,
    deliver(e) {
      events.push(e);
    },
    async getMessages() {
      if (this.failReads) throw new Error("relay unreachable");
      return [...events];
    },
    send: async (args) => {
      sent.push(args);
      return { accepted: true, event_id: `sent-${sent.length}` };
    },
    setProfile: async () => ({ accepted: true }),
    getUser: async ({ pubkey, name }) => {
      if (name) return { pubkey: AGENT, display_name: name };
      if (pubkey === AGENT) return { pubkey, display_name: "smith" };
      return { pubkey, display_name: "Tal" };
    },
  };
}

// One node lifetime against a state dir that outlives it, so "the machine was
// off" can be modelled honestly: the process goes, the disk stays.
function nodeOn({ stateDir, cli }) {
  return new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents: [smith()] }],
    },
    stateDir,
    spawn: () => ({ pid: 4242, exitCode: null, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: (agent) => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }),
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
}

const wakes = (cli) => cli.sent.filter((s) => (s.mentions ?? []).includes(AGENT));
const nowSec = () => Math.floor(Date.now() / 1000);

const asked = (over = {}) => ({
  id: "tal-overnight",
  kind: 9,
  pubkey: OTHER,
  created_at: nowSec() - 4 * HOUR,
  content: "@smith what is the status?",
  tags: [],
  ...over,
});

const said = (over = {}) => ({
  id: "chat",
  kind: 9,
  pubkey: OTHER,
  created_at: nowSec() - 10 * HOUR,
  content: "morning",
  tags: [],
  ...over,
});

test("THE SCENARIO: the machine was off, and the question is answered on restart", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli();

  // Monday. The node runs, reads the room, records where it got to.
  cli.deliver(said({ id: "old-chat" }));
  const monday = nodeOn({ stateDir, cli });
  await monday.start();
  await monday.tick();
  assert.equal(wakes(cli).length, 0, "nothing was addressed to smith yet");

  // The lid closes. No `stop()`, and that is the whole point: a machine being
  // switched off runs no shutdown code, so anything recorded at shutdown would
  // be missing exactly here.
  cli.deliver(asked());

  // Tuesday.
  const tuesday = nodeOn({ stateDir, cli });
  await tuesday.start();
  await tuesday.tick();

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "smith is woken for the message that arrived while the node was down");
  assert.match(woken[0].content, /what is the status/, "and the question itself is relayed");
});

test("a first-ever start answers nothing, however recent the room's chat", async () => {
  // No resume point on disk. Someone joining a channel with a year of chat in
  // it, whose agent then answers a mention from March, is a worse first
  // impression than any silence.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli();
  cli.deliver(asked({ id: "before-we-existed", created_at: nowSec() - 60 }));

  const first = nodeOn({ stateDir, cli });
  await first.start();
  await first.tick();
  assert.deepEqual(wakes(cli), []);
});

test("a restart does NOT re-answer what the previous run already answered", async () => {
  // The property the original watermark existed for, and the one most likely to
  // be broken by a change like this. It must survive verbatim.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli();

  const first = nodeOn({ stateDir, cli });
  await first.start();
  cli.deliver(asked({ id: "answered-once", created_at: nowSec() - 5 }));
  await first.tick();
  assert.equal(wakes(cli).length, 1, "answered once, live");

  const second = nodeOn({ stateDir, cli });
  await second.start();
  await second.tick();
  assert.equal(wakes(cli).length, 1, "and NOT again on the next start");
});

test("a mention older than the window is left alone", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli();

  const monday = nodeOn({ stateDir, cli });
  await monday.start();
  cli.deliver(said({ id: "seed", created_at: nowSec() - 40 * HOUR }));
  await monday.tick();

  // A week away: inside the relay's last 100, far outside the day-long window.
  cli.deliver(asked({ id: "last-week", created_at: nowSec() - 30 * HOUR }));
  const later = nodeOn({ stateDir, cli });
  await later.start();
  await later.tick();
  assert.deepEqual(wakes(cli), [], "answering a conversation that ended days ago is worse than silence");
});

// ── The opposite failure, which was live and undocumented ─────────────────

test("a room whose history cannot be read is NOT answered wholesale", async () => {
  // `#currentWatermark` used to swallow a failed relay read and return an EMPTY
  // set. Empty does not mean "no history" to the tick loop — it means every
  // mention visible in the room is unseen, and gets answered. One network blip
  // at startup was enough to flush a room.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli({ failReads: true });
  cli.deliver(asked({ id: "history-1", created_at: nowSec() - 3 * HOUR }));
  cli.deliver(asked({ id: "history-2", created_at: nowSec() - 2 * HOUR }));

  const sup = nodeOn({ stateDir, cli });
  await sup.start();
  await sup.tick();
  assert.deepEqual(wakes(cli), [], "a room with no established watermark is silent, not loud");
});

// ── FIX-132: a question the agent COULD NOT ANSWER is retried once ────────
//
// Barry asked smith twice while its model backend was refusing to log in. The
// node saw both, relayed both, advanced its resume point past both, and the
// questions were left permanently unanswered with nothing to ever retry them.
//
// The resume point means "I have SEEN up to here", and that is not the same as
// "the agent ANSWERED up to here". Same blind spot as FIX-129 and FIX-130 — the
// node not knowing what the agent did — showing up in a third place.
//
// Bounded to ONE retry, which is the whole reason this was a decision rather
// than an obvious fix: a persistently broken agent must not re-ask every
// question on every restart, burning turns and model spend on something that
// will fail again.

const FAILING_LOG = [
  "2026-08-27T15:15:15.191014Z WARN buzz_acp: agent_returned agent=0 outcome=\"error\" " +
    "error=Agent reported error: Failed to authenticate: OAuth session expired",
].join("\n");

const RECOVERED_LOG = [FAILING_LOG, "2026-08-27T18:40:00Z INFO buzz_acp: agent_pool_ready agents=1"].join("\n");

function withAgentLog(stateDir, text) {
  mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  writeFileSync(path.join(stateDir, "logs", "smith.log"), text);
}

// A node that has ALREADY been running, which is the only state a hold can act
// in: with no resume point at all the whole room is history by design, so
// nothing is ever backlogged and there is nothing to hold back. A first-ever run
// whose agent fails immediately therefore gets no retry, which is consistent
// with "a first start answers nothing" and is stated here rather than left to be
// discovered.
async function alreadyRunning({ stateDir, cli }) {
  withAgentLog(stateDir, RECOVERED_LOG); // healthy, so the point advances
  const sup = nodeOn({ stateDir, cli });
  await sup.start();
  cli.deliver(said({ id: "earlier-chat", created_at: nowSec() - 600 }));
  await sup.tick();
  return sup;
}

test("a live agent failure HOLDS the room's place, so the question is retried", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-retry-"));
  const cli = roomCli();
  await alreadyRunning({ stateDir, cli });

  // Now the agent breaks, and a question arrives that it cannot answer.
  withAgentLog(stateDir, FAILING_LOG);
  const first = nodeOn({ stateDir, cli });
  await first.start();
  cli.deliver(asked({ id: "unanswered", created_at: nowSec() - 5 }));
  await first.tick();
  const wokeOnce = wakes(cli).length;

  // The agent recovers, the node restarts. The question it could not answer is
  // still owed an answer.
  withAgentLog(stateDir, RECOVERED_LOG);
  const second = nodeOn({ stateDir, cli });
  await second.start();
  await second.tick();

  assert.ok(
    wakes(cli).length > wokeOnce,
    "the message the agent could not answer must be put to it again",
  );
});

test("ONE retry, not a loop: a still-broken agent is not re-asked forever", async () => {
  // The objection that made this a decision. Without the bound, every restart
  // re-attempts every question of an agent that is going to fail again.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-retry-"));
  const cli = roomCli();
  withAgentLog(stateDir, FAILING_LOG);

  const first = nodeOn({ stateDir, cli });
  await first.start();
  cli.deliver(asked({ id: "doomed", created_at: nowSec() - 5 }));
  await first.tick();
  await first.tick();
  const afterRetry = wakes(cli).length;

  // Two more starts, agent still failing.
  for (const _ of [1, 2]) {
    const again = nodeOn({ stateDir, cli });
    await again.start();
    await again.tick();
  }
  assert.equal(wakes(cli).length, afterRetry, "a broken agent must not re-ask on every restart");
});

test("a RECOVERED failure does not hold the room's place", async () => {
  // A bad turn last Tuesday that the agent came back from must not pin the
  // resume point forever — that would replay the room on every start.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-retry-"));
  const cli = roomCli();
  withAgentLog(stateDir, RECOVERED_LOG);

  const first = nodeOn({ stateDir, cli });
  await first.start();
  cli.deliver(asked({ id: "answered", created_at: nowSec() - 5 }));
  await first.tick();
  const wokeOnce = wakes(cli).length;

  const second = nodeOn({ stateDir, cli });
  await second.start();
  await second.tick();
  assert.equal(wakes(cli).length, wokeOnce, "a healthy agent's room advances as it always did");
});

test("a resume point written by the OLD shape is still read", async () => {
  // Every install made before FIX-132 has a bare number in resume.json. Losing
  // its place would replay a room, which is the worst outcome this file has.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-retry-"));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "resume.json"), JSON.stringify({ [CHANNEL]: NOW - HOUR }));
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), NOW - HOUR);

  // And writing keeps it readable.
  writeResumePoint({ stateDir, channel: CHANNEL, at: NOW });
  assert.equal(readResumePoint({ stateDir, channel: CHANNEL }), NOW);
});

test("and it starts working the moment the relay comes back", async () => {
  // Silence must be temporary. A room that gave up permanently after one failed
  // read would be the same silent-agent bug arriving by another route.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-bl-sup-"));
  const cli = roomCli({ failReads: true });

  const sup = nodeOn({ stateDir, cli });
  await sup.start();
  await sup.tick();

  cli.failReads = false;
  await sup.tick();
  cli.deliver(asked({ id: "after-recovery", created_at: nowSec() }));
  await sup.tick();
  assert.equal(wakes(cli).length, 1, "the watermark establishes on a later tick and the room goes live");
});
