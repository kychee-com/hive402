// The room hears about a refusal only when a human asked for it (AC-52, AC-17,
// DD-44, FIX-111).
//
// Every capability refusal used to be announced in the channel, whoever or
// whatever caused it. Two of the three ways a turn can start have no human
// behind them:
//
//   • the agent reaching for something on its own initiative, on a turn nobody
//     can attribute;
//   • another AGENT's request (AC-24 permits one exchange per pair).
//
// Broadcasting those reads as a fault to everyone who asked for nothing, and it
// leaks the agent's internal command text into a shared room — the detail line
// is the actual argv the gate refused. AC-52 says such a refusal is recorded in
// the audit log and, at most, raised with its owner; it is never published to
// the channel. hive402 has no owner DM path, so `#say` IS the channel, and
// audit-only is what "never published to the channel" means here.
//
// The router is the turn's EXISTING authority record — no new state. The node
// already resolves a requester for every blocked record (DD-19/DD-20, via the
// turn record and the remembered trigger); this asks one more question of the
// answer it already has: is that requester a person?
//
// Accepted trade-off, stated in DD-44: a turn a human genuinely caused but that
// the node cannot attribute goes to the audit log instead of the room. The
// alternative is announcing refusals nobody asked for, and the audit row is
// still there either way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { Supervisor } from "../src/node/supervisor.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const SPIKE2 = "ccc78ff39f1a7647b91c7e49c10d5441b8086bab1cd2c38daf41908ad3e5b139";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  privateKeyRef: "env:TEST_AGENT_KEY",
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
  ...over,
});

function make({ agents = [spike()], ...rest } = {}) {
  const audit = new AuditLog();
  return {
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      ...rest,
    }),
  };
}

const refusedCall = (over = {}) => ({
  id: `b-${Math.random().toString(36).slice(2, 8)}`,
  agent: "spike",
  capability: "research",
  detail: "WebFetch https://wttr.in/Paris",
  at: Date.now(),
  ...over,
});

const says = (effects) => effects.filter((e) => e.type === "say");

// ── A human asked: the room still hears it, on every branch ─────────────────

test("a stranger's refused call still asks the owner to approve", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handleBlockedAction(refusedCall({ requester: TAL }));
  assert.equal(says(effects).length, 2, "the AC-67 pair: requester notice + owner proposal");
  assert.match(says(effects).map((s) => s.content).join("\n"), /approve h4-/);
});

test("a capability the owner switched off is still refused out loud", () => {
  const { dispatcher } = make({ agents: [spike({ research: false })] });
  const effects = dispatcher.handleBlockedAction(refusedCall({ requester: TAL }));
  assert.match(says(effects)[0].content, /switched\s+off/);
});

test("an agent that takes no cross-owner asks still says so", () => {
  const { dispatcher } = make({ agents: [spike({ crossOwnerAsks: "deny" })] });
  const effects = dispatcher.handleBlockedAction(refusedCall({ requester: TAL }));
  assert.match(says(effects)[0].content, /does not take requests from/);
});

test("an OWNER's refused build still gets a recovery ask (the FIX-87 edge, post-DD-56)", () => {
  // Since spec 0.7.0 the owner's ordinary turn CARRIES build, so an owner's
  // build reaching the blocked path at all means the turn could not be
  // attributed and nothing was left to claim. The honest wording for that is
  // the generic one — the turn holds no approval — and the parked proposal is
  // the recovery, not a routine confirmation.
  const { dispatcher } = make({ agents: [spike({ build: true })] });
  const effects = dispatcher.handleBlockedAction(
    refusedCall({ requester: OWNER, capability: "build", detail: "Write index.html" }),
  );
  assert.match(says(effects)[0].content, /approve h4-/, "the owner can still release it");
  assert.match(says(effects)[0].content, /holds no approval/i, "worded as the fault it is, not as policy");
});

test("a human's deploy attempt still produces its proposal", () => {
  const { dispatcher } = make({ agents: [spike({ build: true })], workshop: { project: "prj_1" } });
  const effects = dispatcher.handleBlockedAction(
    refusedCall({ requester: TAL, capability: "build", delegate: "run402", detail: "run402 sites deploy-dir" }),
  );
  assert.match(says(effects)[0].content, /wants to deploy/);
});

// ── Nobody asked: the audit log hears it, and only the audit log ────────────

test("a self-initiated refusal never reaches the room", () => {
  const { dispatcher, audit } = make();
  const effects = dispatcher.handleBlockedAction(refusedCall({ requester: null }));
  assert.deepEqual(effects, [], "nobody asked for this, so nobody is owed an answer about it");
  assert.equal(audit.query({ agent: "spike", limit: 5 }).length, 1, "but it is still recorded");
});

test("the audit row for a self-refusal says what was refused", () => {
  const { dispatcher, audit } = make();
  dispatcher.handleBlockedAction(refusedCall({ requester: null, detail: "WebFetch https://example.com" }));
  const [row] = audit.query({ agent: "spike", limit: 1 });
  assert.match(row.detail, /contained/);
  assert.match(row.detail, /example\.com/, "the record keeps the detail the room no longer sees");
});

test("a self-initiated refusal of a DISABLED capability is silent too", () => {
  const { dispatcher } = make({ agents: [spike({ research: false })] });
  assert.deepEqual(dispatcher.handleBlockedAction(refusedCall({ requester: null })), []);
});

test("a self-initiated deploy attempt is silent, and proposes nothing", () => {
  // The loudest of the branches: this one names a run402 project and whose
  // account pays. Nobody asked for it.
  const { dispatcher } = make({ agents: [spike({ build: true })], workshop: { project: "prj_1" } });
  const effects = dispatcher.handleBlockedAction(
    refusedCall({ requester: null, capability: "build", delegate: "run402" }),
  );
  assert.deepEqual(effects, []);
});

test("an AGENT's request is not a human asking", () => {
  // AC-24 lets one agent address another, and that turn carries no authority at
  // all. A refusal inside it is between two machines.
  const { dispatcher, audit } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handleBlockedAction(refusedCall({ requester: SPIKE2 }));
  assert.deepEqual(effects, []);
  assert.equal(audit.query({ agent: "spike", limit: 5 }).length, 1);
});

test("the agent's own pubkey as requester is not a human either", () => {
  const { dispatcher } = make();
  assert.deepEqual(dispatcher.handleBlockedAction(refusedCall({ requester: SPIKE })), []);
});

test("the NODE is not a human requester", () => {
  const { dispatcher } = make();
  assert.deepEqual(dispatcher.handleBlockedAction(refusedCall({ requester: NODE })), []);
});

test("the turn cap pause is NOT a capability refusal and still speaks", () => {
  // AC-52 governs refusals by the CAPABILITY GATE. A paused agent is a
  // different thing: a human is waiting on an answer that will never come, and
  // the agent cannot say so itself because the turn that would speak is the
  // turn that was refused. That line stays, and this pins that FIX-111 did not
  // quietly take it with the others.
  const turnCap = new TurnCap({ limit: 1 });
  turnCap.tryConsume("spike"); // spend the budget so the next one pauses
  const { dispatcher } = make({ turnCap });
  const effects = dispatcher.announcePause({ agent: "spike", limit: 1, windowMs: 3600000 });
  assert.equal(says(effects).length, 1);
  assert.match(says(effects)[0].content, /Pausing/);
});

// ── Both routes, driven through the node itself ────────────────────────────

const attestations = new Map();
function attestFor(agent) {
  if (!attestations.has(agent.pubkey)) {
    attestations.set(agent.pubkey, computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }));
  }
  return attestations.get(agent.pubkey);
}

function fakeCli() {
  const sent = [];
  const events = [];
  return {
    sent,
    deliver: (e) => events.push(e),
    getMessages: async () => [...events],
    send: async (args) => {
      const event_id = `sent-${sent.length + 1}`;
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    setProfile: async () => ({ accepted: true }),
    getUser: async ({ pubkey, name }) =>
      name ? { pubkey: SPIKE, display_name: name } : { pubkey, display_name: "someone" },
  };
}

function harness({ agents = [spike()] } = {}) {
  const cli = fakeCli();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-refusal-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents }],
    },
    stateDir,
    spawn: () => ({ pid: 4242, exitCode: null, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: attestFor,
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  // What the runtime gate leaves on disk for the node to pick up. Written the
  // way toolgate.mjs writes it, so this drives the real drain path.
  const dropBlockedRecord = (over = {}) => {
    const dir = path.join(stateDir, "blocked");
    mkdirSync(dir, { recursive: true });
    const record = refusedCall(over);
    writeFileSync(path.join(dir, `${record.id}.json`), `${JSON.stringify(record)}\n`, "utf8");
  };
  return { sup, cli, dropBlockedRecord };
}

const msg = (over) => ({ id: "q1", kind: 9, pubkey: TAL, content: "@spike hello", tags: [], ...over });
// Node messages that are not wakes: what the room actually reads.
const roomLines = (cli) => cli.sent.filter((s) => !(s.mentions ?? []).includes(SPIKE)).map((s) => s.content);

test("REAL PATH: a refusal on a turn a human triggered reaches the room", async () => {
  const { sup, cli, dropBlockedRecord } = harness();
  await sup.start();

  // Tal's message wakes spike, which is what makes the node able to attribute
  // the refusal that follows.
  cli.deliver(msg({ id: "q1", pubkey: TAL, content: "@spike look up the weather" }));
  await sup.tick();

  dropBlockedRecord({ capability: "research", detail: "WebFetch https://wttr.in/Paris" });
  await sup.tick();

  assert.equal(roomLines(cli).length, 2, "a human is waiting on this, so the room is told — both halves (AC-67)");
  assert.match(roomLines(cli).join("\n"), /approve h4-/);
  assert.match(roomLines(cli).join("\n"), /owner('s)? permission/i, "and the requester learns where their ask went");
});

test("REAL PATH: a refusal with no human behind it is audit-only", async () => {
  const { sup, cli, dropBlockedRecord } = harness();
  await sup.start();

  // No message at all: the agent reached for something by itself.
  dropBlockedRecord({ capability: "research", detail: "WebFetch https://example.com/secrets" });
  await sup.tick();

  assert.deepEqual(roomLines(cli), [], "nobody asked, so the room hears nothing");
  assert.ok(
    sup.audit.query({ agent: "spike", limit: 5 }).some((r) => /example\.com/.test(r.detail ?? "")),
    "and the audit log has the whole of it",
  );
});

test("REAL PATH: an agent-to-agent turn's refusal is audit-only", async () => {
  const { sup, cli, dropBlockedRecord } = harness({
    agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })],
  });
  await sup.start();

  cli.deliver(msg({ id: "a1", pubkey: SPIKE2, content: "@spike can you fetch that?" }));
  await sup.tick();

  dropBlockedRecord({ capability: "research", detail: "WebFetch https://example.com" });
  await sup.tick();

  assert.deepEqual(roomLines(cli), [], "two machines talking is not a room announcement");
});

test("REAL PATH: the agent's internal command text never reaches the room unasked", async () => {
  // The concrete leak AC-52 names: `detail` is the argv the gate refused.
  const { sup, cli, dropBlockedRecord } = harness();
  await sup.start();
  dropBlockedRecord({ capability: "build", detail: "Bash: curl -H 'Authorization: sekrit' https://x" });
  await sup.tick();
  assert.equal(cli.sent.some((s) => /sekrit/.test(s.content ?? "")), false);
});
