// FIX-135 (F-023, AC-7) — a message handed straight to the harness and never
// answered comes back through the ordinary wake path.
//
// ── What the Red Team saw ──────────────────────────────────────────────────
//
// Cycle 9 sent alternating messages from several people. Every NON-owner
// message was answered. Some of the OWNER's own messages simply vanished: not
// delayed, not queued, no wake, no turn record, no audit row.
//
// ── Why only the owner's ───────────────────────────────────────────────────
//
// `Dispatcher.handle` computes
//
//     deliveredDirectly = alreadyTagged && #reachesDirectly && #isAgentRunning
//
// and when it is true the node emits NO wake at all: the harness has the
// message, so relaying it as well would double every one of the owner's turns.
// That reasoning is right about delivery and blind about ANSWERING.
// `#isAgentRunning` is process liveness — it cannot see that the agent is
// mid-turn, and buzz-acp's `meh=Queue` steering folds a message that arrives
// mid-turn into the RUNNING turn. If the model does not address it, nothing
// downstream ever notices. A non-owner's message fails `#reachesDirectly`, so
// it is relayed and gets its own wake, which is why the whole of the rest of
// the burst survived.
//
// This is the third appearance of one trap: `deliveredDirectly` forks every
// room-visible signal and the owner's branch is the one that gets nothing.
//
// ── What these tests drive ─────────────────────────────────────────────────
//
// `Supervisor.tick`, the real entry point, with the real Dispatcher — never a
// mock of the mechanism under test. The clock is stubbed because the whole
// behaviour is time-bound: without moving it the grace window is never crossed
// and the tests would pass against the unfixed product.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";
import { HANDOFF_DEFAULTS } from "../src/config/schema.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const AGENT2 = "b2ff7a1c0b9b4e26a5a5d4f0e8a1c3d5b7e9f1a3c5d7e9fb1d3f5a7c9e1b3d5f";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

// A Schnorr signature is fresh every time, so the attestation is computed once
// per agent and cached — the way `register` writes it to disk once.
const attestations = new Map();
const attestFor = (agent) => {
  if (!attestations.has(agent.pubkey)) {
    attestations.set(agent.pubkey, computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }));
  }
  return attestations.get(agent.pubkey);
};

const agentEntry = (over = {}) => ({
  name: "spike",
  pubkey: AGENT,
  ownerPubkey: OWNER,
  privateKeyRef: "env:TEST_AGENT_KEY",
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
  ...over,
});

const config = ({ handoff, agents = [agentEntry()] } = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  ...(handoff ? { handoff } : {}),
  tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
  rooms: [{ channel: CHANNEL, agents }],
});

function fakeCli() {
  const sent = [];
  const events = [];
  return {
    sent,
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
    async getUser({ pubkey, name }) {
      if (name) return { pubkey: name === "spike2" ? AGENT2 : AGENT, display_name: name };
      if (pubkey === AGENT2) return { pubkey, display_name: "spike2" };
      if (pubkey === AGENT) return { pubkey, display_name: "spike" };
      return { pubkey, display_name: pubkey === OWNER ? "barry" : "someone" };
    },
  };
}

function harness({ cfg = config(), running = true } = {}) {
  const cli = fakeCli();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-handoff-"));
  const spawn = () => ({
    pid: 7001,
    // `exitCode` non-null is how the supervisor reads a dead agent, which is
    // the branch where the message is relayed anyway and no handoff arises.
    exitCode: running ? null : 0,
    killed: false,
    kill() {
      this.killed = true;
    },
  });
  const sup = new Supervisor({
    config: cfg,
    stateDir,
    spawn,
    makeCli: () => cli,
    readAttestation: (agent) => attestFor(agent),
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli, stateDir };
}

// The owner's own p-tagged message: the exact shape that takes the direct
// branch. Top-level, so its own id is its thread anchor.
const ownerAsk = (over = {}) => ({
  id: "a".repeat(64),
  kind: 9,
  pubkey: OWNER,
  created_at: Math.floor(Date.now() / 1000),
  content: "@spike can you summarise the thread so far?",
  tags: [["p", AGENT]],
  ...over,
});

// A wake is the node's p-tagged relay message — the delivery mechanism itself.
const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

// Tick with the clock MOVING. Without this the grace window is never crossed
// and every assertion below is green against the unfixed product.
async function tickOver(sup, { ticks = 2, stepMs = 60_000 } = {}) {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (let i = 0; i < ticks; i += 1) {
      clock += stepMs;
      await sup.tick();
    }
  } finally {
    Date.now = realNow;
  }
}

const auditRows = (stateDir) => {
  const file = path.join(stateDir, "audit.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

test("THE BUG: an owner's message the agent never answered is relayed on a later tick", async () => {
  const { sup, cli, stateDir } = harness();
  await sup.start();

  cli.deliver(ownerAsk());
  await sup.tick();

  // Unchanged, and deliberately so: the harness has the message, so relaying it
  // here would double every one of the owner's turns.
  assert.equal(wakes(cli).length, 0, "precondition: the direct branch still stays quiet at first");

  // Twelve minutes of polling — past the default grace window — and the agent
  // has said nothing in that thread.
  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const woken = wakes(cli);
  assert.equal(woken.length, 1, "the lost message came back — exactly once");
  assert.equal(woken[0].replyTo, ownerAsk().id, "in the conversation it was asked in");
  assert.ok(
    woken[0].content.includes("summarise the thread so far"),
    "carrying the human's own words",
  );

  const recovered = auditRows(stateDir).filter((r) => r.kind === "handoff-recovered");
  assert.equal(recovered.length, 1, "a silent loss is a visible row");
  assert.equal(recovered[0].agent, "spike");

  await sup.stop();
});

test("THE OPPOSITE FAILURE: a message the harness DID answer is never relayed a second time", async () => {
  const { sup, cli } = harness();
  await sup.start();

  const ask = ownerAsk();
  cli.deliver(ask);
  await sup.tick();

  // The agent answers in the thread, as it does on every healthy direct turn.
  cli.deliver({
    id: "b".repeat(64),
    kind: 9,
    pubkey: AGENT,
    created_at: ask.created_at + 20,
    content: "Sure — three people are arguing about the deploy window.",
    tags: [["e", ask.id, "", "reply"]],
  });

  await tickOver(sup, { ticks: 10, stepMs: 60_000 });

  assert.equal(wakes(cli).length, 0, "the agent answered it; relaying would duplicate the turn");

  await sup.stop();
});

test("a recovered message is recovered ONCE, however long the node runs", async () => {
  const { sup, cli } = harness();
  await sup.start();

  cli.deliver(ownerAsk());
  await sup.tick();
  await tickOver(sup, { ticks: 30, stepMs: 60_000 });

  assert.equal(wakes(cli).length, 1, "half an hour of ticks, one recovery");

  await sup.stop();
});

test("the grace window is respected — nothing is relayed while the turn could still be running", async () => {
  const { sup, cli } = harness({ cfg: config({ handoff: { graceSec: 600 } }) });
  await sup.start();

  cli.deliver(ownerAsk());
  await sup.tick();
  // Five minutes against a ten-minute grace: a slow turn is still a live turn.
  await tickOver(sup, { ticks: 5, stepMs: 60_000 });

  assert.equal(wakes(cli).length, 0, "an unfinished turn must not be interrupted with a duplicate");

  await sup.stop();
});

// ── FIX-143 (F-026, AC-7): the OTHER half of the same fix ─────────────────
//
// FIX-135 above put the answer check on the `deliveredDirectly` branch. The
// relayed branch — every stranger's message, and every message to an agent
// whose worker is between lives — got a wake and nothing that ever asked
// whether it was answered. Cycle 11's F-026 rode that branch: the agent drafted
// a bundled reply, Buzz's CLI refused the send over a literal at-word aimed at
// a non-member, the model reworded and resent something narrower, and a topic
// disappeared with no part of the product still watching.
//
// This is DD-34's asymmetry inverted, and the fourth time `deliveredDirectly`
// has split one of this product's fixes in half.
//
// The anchors are what make it reuse rather than rebuild: `record` keys on
// `replyAnchor(event)`, the relayed wake is published with the SAME call on the
// same event, and buzz-acp derives the agent's own `--reply-to` from the wake's
// thread tags. Every test below reads the anchor back off the wake the PRODUCT
// published rather than computing its own, because "the anchors line up" is the
// claim under test and a hand-computed anchor would assume it.

const strangerAsk = (over = {}) =>
  ownerAsk({ id: "c".repeat(64), pubkey: TAL, content: "@spike what is the status?", ...over });

// The agent's reply, anchored the way buzz-acp anchors one: on the thread root
// carried by the wake that triggered its turn.
const agentReplyTo = (wake, over = {}) => ({
  id: "d".repeat(64),
  kind: 9,
  pubkey: AGENT,
  created_at: Math.floor(Date.now() / 1000) + 20,
  content: "Everything is green.",
  tags: [["e", wake.replyTo, "", "reply"]],
  ...over,
});

test("THE OTHER HALF: a RELAYED message the agent never answered comes back", async () => {
  const { sup, cli } = harness();
  await sup.start();

  cli.deliver(strangerAsk());
  await sup.tick();
  assert.equal(wakes(cli).length, 1, "the relayed branch answers immediately, as it always has");

  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const woken = wakes(cli);
  assert.equal(woken.length, 2, "and the unanswered relay came back — exactly once");
  assert.equal(woken[1].replyTo, strangerAsk().id, "in the conversation it was asked in");
  assert.ok(woken[1].content.includes("what is the status"), "carrying the human's own words");

  await sup.stop();
});

test("THE SHARPEST EDGE: a healthy relayed message produces NO recovery at all", async () => {
  // This is the regression this task actually risks. If the receipt's anchor
  // and the anchor the harness gives the agent did not line up, EVERY healthy
  // relayed message would be re-waked once and the room's traffic would double.
  const { sup, cli } = harness();
  await sup.start();

  cli.deliver(strangerAsk());
  await sup.tick();
  const wake = wakes(cli)[0];

  cli.deliver(agentReplyTo(wake));

  await tickOver(sup, { ticks: 20, stepMs: 60_000 });

  assert.equal(
    wakes(cli).length,
    1,
    "one message, one wake, one answer, and no duplicate twenty minutes later",
  );

  await sup.stop();
});

test("a relayed recovery says it was RELAYED, never that it was delivered directly", async () => {
  const { sup, cli, stateDir } = harness();
  await sup.start();

  cli.deliver(strangerAsk());
  await sup.tick();
  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const recovery = wakes(cli)[1];
  assert.ok(recovery, "precondition: the relay was recovered");
  assert.ok(
    !/delivered to you directly/.test(recovery.content),
    "a correct mechanism inside a wrong sentence is this codebase's other standing sin",
  );
  assert.match(recovery.content, /relayed to you/i, "it says what actually happened");
  assert.ok(recovery.content.includes(HIVE_MARKER), "marked as the node's own line, like every other");

  const rows = auditRows(stateDir).filter((r) => r.kind === "handoff-recovered");
  assert.equal(rows.length, 1);
  assert.ok(
    !/delivered directly/.test(rows[0].detail),
    "and the audit row does not claim a delivery that never happened",
  );
  assert.match(rows[0].detail, /relayed to spike/);

  await sup.stop();
});

test("a DIRECT recovery still says delivered directly — the wording follows the route", async () => {
  // The other direction of the same claim: route-aware means both routes, not
  // "relayed" written over the top of a sentence that used to be right.
  const { sup, cli, stateDir } = harness();
  await sup.start();

  cli.deliver(ownerAsk());
  await sup.tick();
  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const recovery = wakes(cli)[0];
  assert.match(recovery.content, /delivered to you directly/);
  const rows = auditRows(stateDir).filter((r) => r.kind === "handoff-recovered");
  assert.match(rows[0].detail, /delivered directly to spike/);

  await sup.stop();
});

test("a relayed recovery is recovered ONCE — the recovery wake records no receipt of its own", async () => {
  // A recovery is a RE-delivery. If it recorded a receipt like any other wake,
  // a message nobody answers would be relayed on a loop forever.
  const { sup, cli } = harness();
  await sup.start();

  cli.deliver(strangerAsk());
  await sup.tick();
  await tickOver(sup, { ticks: 40, stepMs: 60_000 });

  assert.equal(wakes(cli).length, 2, "forty minutes of ticks: one wake, one recovery, and no third");

  await sup.stop();
});

test("a recovery must not open a NEW receipt for an agent that already answered", async () => {
  // The case that makes the recovery's re-delivery mark load-bearing rather
  // than defensive. One message addresses two agents. spike2 answers; spike
  // does not. Recovering spike re-dispatches the message through the ordinary
  // wake path, which wakes EVERY agent it addresses — including spike2, whose
  // receipt was closed the moment it replied. Without the mark, that second
  // wake opens a fresh receipt for an agent that has already done its job, and
  // spike2 is recovered ten minutes later for a message it answered.
  const { sup, cli, stateDir } = harness({
    cfg: config({ agents: [agentEntry(), agentEntry({ name: "spike2", pubkey: AGENT2 })] }),
  });
  await sup.start();

  const both = strangerAsk({ content: "@spike @spike2 what is the status?" });
  cli.deliver(both);
  await sup.tick();
  assert.equal(wakes(cli).length, 2, "precondition: both agents were relayed the message");

  // Only spike2 answers, in the thread the wake anchored it to.
  cli.deliver(agentReplyTo(wakes(cli)[0], { pubkey: AGENT2, content: "All green from me." }));

  await tickOver(sup, { ticks: 30, stepMs: 60_000 });

  const recovered = auditRows(stateDir).filter((r) => r.kind === "handoff-recovered");
  assert.deepEqual(
    recovered.map((r) => r.agent),
    ["spike"],
    "half an hour of ticks: spike is recovered once and spike2 is never recovered at all",
  );

  await sup.stop();
});

test("a wake the relay REFUSED records no receipt — nothing was delivered", async () => {
  const { sup, cli, stateDir } = harness();
  await sup.start();

  // The relay takes everything except the wake itself. A receipt recorded
  // before the publish would be a receipt for a message that never left.
  const realSend = cli.send.bind(cli);
  cli.send = async (args) => {
    if (String(args.content ?? "").includes(`${HIVE_MARKER} Waking up agent`)) {
      throw new Error("relay refused the wake");
    }
    return realSend(args);
  };

  cli.deliver(strangerAsk());
  await sup.tick();
  assert.equal(wakes(cli).length, 0, "precondition: nothing was published");

  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  assert.deepEqual(
    auditRows(stateDir).filter((r) => r.kind.startsWith("handoff-")),
    [],
    "no recovery was ever proposed, because nothing was ever handed over",
  );

  await sup.stop();
});

// --- the structural guards ---------------------------------------------------
//
// Five modules in this product have been built, tested and never called by
// anything, and FIX-135 itself shipped a set nothing could consult. These name
// the wiring, in the pattern respawn.test.mjs established for this exact class.

test("the RELAYED wake records its receipt, and only AFTER the send", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/node/supervisor.mjs", import.meta.url)), "utf8");
  const branch = source.slice(source.indexOf('effect.type === "wake"'));
  assert.ok(branch.length > 0, "the wake branch must still exist");
  const sendAt = branch.indexOf("entry.cli.send");
  assert.ok(sendAt > 0, "the wake branch must still publish");
  assert.match(
    branch.slice(sendAt),
    /handoff\.record\(/,
    "the receipt must be recorded in the wake branch — a receipt nothing records is not a fix",
  );
  assert.ok(
    !/handoff\.record\(/.test(branch.slice(0, sendAt)),
    "and never before the publish: a wake that never published delivered nothing",
  );
});

test("both re-delivery sites mark themselves, rather than being inferred from the note", () => {
  // Reading `effect.note`'s presence as "this is a re-delivery" is a
  // side-channel: a future wake variant that carries a note for some other
  // reason would silently stop recording receipts. Both sites say what they
  // are.
  const source = readFileSync(fileURLToPath(new URL("../src/node/supervisor.mjs", import.meta.url)), "utf8");
  for (const site of ["replayNote(", "handoffNote("] ) {
    const at = source.indexOf(site);
    assert.ok(at > 0, `${site} must still be called`);
    assert.match(
      source.slice(at - 400, at + 400),
      /redelivery/,
      `${site} sits at a re-delivery site, which must mark itself`,
    );
  }
  assert.match(source, /effect\.redelivery/, "and the receipt must be gated on that mark");
});

test("a recovered wake carries the node's note about the turn it may already have ridden", async () => {
  const { sup, cli } = harness();
  await sup.start();

  cli.deliver(ownerAsk());
  await sup.tick();
  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const woken = wakes(cli);
  assert.equal(woken.length, 1);
  assert.ok(
    woken[0].content.includes(HIVE_MARKER),
    "the note is marked as the node's own line, like every other",
  );
  assert.ok(
    /already answered/i.test(woken[0].content),
    "the one ambiguity the node cannot resolve is handed to the agent, not guessed at",
  );

  await sup.stop();
});

test("the default grace window is stated once, in the schema", () => {
  assert.equal(typeof HANDOFF_DEFAULTS.graceSec, "number");
  assert.ok(
    HANDOFF_DEFAULTS.graceSec >= 300,
    "above every turn duration this project has measured (14s to 375s)",
  );
});
