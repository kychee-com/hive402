// FIX-74 / DD-34 — an agent that exited is brought back by the wake that
// addresses it, and every command that reports on agents says so honestly.
//
// The defect these tests exist for was found by USING the rig, not by reading
// code: the node was alive and answering /help four hours after the last
// message, "@spike <question>" got nothing in 121 seconds, and the harness's own
// log said "inactivity bound reached — exiting gracefully inactivity_seconds=3600".
// That timeout is hive402's own policy (AC-42). Nothing in the product started
// the agent again, and nothing in the room said so.
//
// So the tests below are written against the paths a MESSAGE actually travels:
// tick() for the wake, readStatus for "hive402 status", lifecycleSubjects for
// "hive402 doctor". The last tests in the file are structural — they assert the
// wake branch of the supervisor still calls the respawn, and that there is only
// one place that spawns an agent — because this project has shipped modules that
// were built, tested and never wired to anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as childSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Supervisor } from "../src/node/supervisor.mjs";
import { readStatus } from "../src/node/runtime.mjs";
import { lifecycleSubjects } from "../src/node/doctor.mjs";
import { agentProcessState, exitEvidence, waitForAgentReady } from "../src/node/respawn.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";

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
function attestFor(agent) {
  if (!attestations.has(agent.pubkey)) {
    attestations.set(agent.pubkey, computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }));
  }
  return attestations.get(agent.pubkey);
}

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

const config = ({ agents = [agentEntry()] } = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
  rooms: [{ channel: CHANNEL, agents }],
});

// A relay whose getMessages hands back a SNAPSHOT, not the live array. The
// shared fake in supervisor.test.mjs returns the array itself, which is fine
// there and useless here: the concurrency test below needs one tick to be
// holding an older view of the room while a second tick sees a newer one.
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
    // Both lookups the publisher makes: by name, and by pubkey. Answering the
    // by-name one with a pubkey-shaped record is how a fake reports a name
    // collision against itself.
    async getUser({ pubkey, name }) {
      if (name) return { pubkey: name === "spike2" ? AGENT2 : AGENT, display_name: name };
      return pubkey === AGENT2 ? { pubkey: AGENT2, display_name: "spike2" } : { pubkey, display_name: "spike" };
    },
  };
}

// A supervisor whose spawn is fake and whose readiness wait is controllable.
// awaitAgentReady is injected so a test can hold a respawn open and prove that
// a second wake arriving during it does not start a second process.
function harness({ cfg = config(), awaitAgentReady } = {}) {
  const spawned = [];
  const cli = fakeCli();
  const logged = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-respawn-"));
  const spawn = (command, args, opts) => {
    const child = {
      pid: 1000 + spawned.length + 1,
      exitCode: null,
      killed: false,
      kill() {
        this.killed = true;
      },
    };
    spawned.push({ command, args, opts, child });
    return child;
  };
  const sup = new Supervisor({
    config: cfg,
    stateDir,
    spawn,
    makeCli: () => cli,
    // One attestation per agent, computed once. In production this reads the
    // file `register` wrote, so it is stable across a relaunch; recomputing it
    // per call would make every signature fresh and the recipe comparison below
    // would be measuring the test harness rather than the product.
    readAttestation: (agent) => attestFor(agent),
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    // Hermetic. Without these the supervisor reaches for the REAL relay at
    // `relayUrl` — which on a developer box with the local rig up is a live
    // network call inside a unit test, and a tick that takes as long as the
    // network does. It went unnoticed while the only relay read sat at the end
    // of a tick; FIX-160 moved the promise collection to the top of the room
    // loop and the dependency became visible immediately.
    queryEvents: async () => [],
    submitEvent: async () => ({ published: true }),
    log: (line) => logged.push(line),
    awaitAgentReady: awaitAgentReady ?? (async () => ({ ready: true, detail: "test" })),
  });
  return { sup, spawned, cli, stateDir, logged };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });
const wakesFor = (cli, pubkey) => cli.sent.filter((s) => s.mentions?.includes(pubkey));
// A NOTICE is a message the node posts ABOUT waking an agent, in addition to the
// wake. DD-43 removed those: the client's own working indicator already carries
// the wait, so a second message was pure chatter.
//
// The `!s.mentions?.length` clause was added by FIX-125 and is load-bearing.
// That fix made the wake ITSELF open with "Waking up agent spike." — one
// message, the one that had to be sent anyway, now readable by the humans who
// can all see it. Without this clause the detector counts the wake as its own
// notice, and these tests would forbid the wake from ever saying what it is
// doing. What DD-43 forbids is a SECOND message, so that is what this counts.
const noticesIn = (cli) =>
  cli.sent.filter((s) => /waking|asleep/i.test(s.content ?? "") && !s.mentions?.length);

// The exact thing the inactivity policy does to a process the node spawned: it
// goes away on its own, so the handle the node still holds stops reporting null.
function itExitedOnItsOwn(child) {
  child.exitCode = 0;
}

// Let a pending respawn make progress without finishing it.
async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Wait for a CONDITION rather than for a fixed number of microtask turns.
// A tick does a variable amount of relay work before it reaches the wake, so
// counting turns re-breaks a test every time that changes — FIX-160 added one
// promise-collection round trip at the top of the room loop and did exactly
// that to the readiness-ordering test below.
async function until(condition, { turns = 500 } = {}) {
  for (let i = 0; i < turns; i += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

// --- FIX-74: the wake path brings the agent back ----------------------------

test("an agent that exited on the idle policy is relaunched by the wake that addresses it", async () => {
  const { sup, spawned, cli } = harness();
  await sup.start();
  assert.equal(spawned.length, 1, "one process at up");

  itExitedOnItsOwn(spawned[0].child);

  cli.deliver(msg({ pubkey: TAL, content: "@spike are you there?" }));
  await sup.tick();

  assert.equal(spawned.length, 2, "the wake must bring the agent back, not talk to a dead process");
  assert.equal(wakesFor(cli, AGENT).length, 1, "and the wake must still be delivered");
});

test("an agent that is still running is not relaunched", async () => {
  // The other half of the claim: a respawn on every message would restart the
  // room continuously and lose every agent's session.
  const { sup, spawned, cli } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();
  assert.equal(spawned.length, 1);
});

test("the relaunch uses the identical recipe up used — command, args, cwd and env", async () => {
  const { sup, spawned, cli } = harness();
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();

  const [first, second] = spawned;
  assert.equal(second.command, first.command);
  assert.deepEqual(second.args, first.args);
  assert.equal(second.opts.cwd, first.opts.cwd);
  assert.deepEqual(second.opts.env, first.opts.env);
});

test("two wakes arriving during one respawn start ONE process and both are delivered", async () => {
  // The F-008 duplicate-agent class, in a new place: two buzz-acp processes
  // under one identity answer every message twice.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { sup, spawned, cli } = harness({
    awaitAgentReady: () => gate.then(() => ({ ready: true, detail: "test" })),
  });
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);

  cli.deliver(msg({ id: "e1", pubkey: TAL, content: "@spike first" }));
  const first = sup.tick();
  await settle();

  cli.deliver(msg({ id: "e2", pubkey: TAL, content: "@spike second" }));
  const second = sup.tick();
  await settle();

  release();
  await Promise.all([first, second]);

  assert.equal(spawned.length, 2, "one launch at up, one respawn — never two respawns");
  assert.equal(wakesFor(cli, AGENT).length, 2, "both messages must still reach the agent");
});

test("a respawned turn holds exactly the authority a warm turn would have held", async () => {
  // DD-20/DD-21: the record is keyed to the wake event the relay accepts. A
  // respawn happens BEFORE that send, so it must not widen, drop or re-key it.
  const warm = harness();
  await warm.sup.start();
  warm.cli.deliver(msg({ pubkey: TAL, content: "@spike research the weather in Paris" }));
  await warm.sup.tick();
  const warmWake = wakesFor(warm.cli, AGENT)[0];
  const warmAuthority = readAuthority({ stateDir: warm.stateDir, agent: "spike", eventId: warmWake.event_id });

  const cold = harness();
  await cold.sup.start();
  itExitedOnItsOwn(cold.spawned[0].child);
  cold.cli.deliver(msg({ pubkey: TAL, content: "@spike research the weather in Paris" }));
  await cold.sup.tick();
  const coldWake = wakesFor(cold.cli, AGENT)[0];
  const coldAuthority = readAuthority({ stateDir: cold.stateDir, agent: "spike", eventId: coldWake.event_id });

  assert.ok(warmAuthority, "the warm case must produce an authority record at all");
  assert.ok(coldAuthority, "and so must the cold one");
  assert.equal(coldAuthority.kind, warmAuthority.kind);
  assert.deepEqual(coldAuthority.capabilities, warmAuthority.capabilities);
  assert.equal(coldAuthority.requester, warmAuthority.requester);
  assert.equal(coldAuthority.eventId, coldWake.event_id);
});

test("the wake is held until the relaunched harness is actually listening", async () => {
  // This test used to assert that a "Waking spike up…" notice reached the room
  // BEFORE the readiness wait. DD-43 removed the notice, but the ordering it was
  // observing is still load-bearing and is what this now pins directly: a wake
  // published to a harness that has not subscribed yet is lost silently, which
  // is the original deaf-room failure wearing a new hat.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { sup, spawned, cli } = harness({
    awaitAgentReady: () => gate.then(() => ({ ready: true, detail: "test" })),
  });
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);

  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  const tick = sup.tick();
  await until(() => spawned.length === 2);

  assert.equal(spawned.length, 2, "the relaunch is in flight");
  assert.equal(wakesFor(cli, AGENT).length, 0, "but nothing is published while the harness is still starting");

  release();
  await tick;
  assert.equal(wakesFor(cli, AGENT).length, 1, "one wake per respawn, published once it can be received");
});

test("a respawn puts nothing in the room but the wake itself", async () => {
  const { sup, spawned, cli } = harness();
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();
  assert.equal(noticesIn(cli).length, 0, "DD-43: the client's working indicator carries the wait");
  assert.equal(wakesFor(cli, AGENT).length, 1);
});

test("respawning one agent leaves the other alone", async () => {
  const cfg = config({ agents: [agentEntry(), agentEntry({ name: "spike2", pubkey: AGENT2, research: false })] });
  const { sup, spawned, cli } = harness({ cfg });
  await sup.start();
  assert.equal(spawned.length, 2);
  const spike2Pid = spawned[1].child.pid;

  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();

  assert.equal(spawned.length, 3, "only spike is relaunched");
  const status = await sup.status();
  assert.equal(status.agents.find((a) => a.name === "spike2").pid, spike2Pid, "spike2 was never touched");
  assert.equal(status.agents.find((a) => a.name === "spike2").running, true);
});

test("the pid file records the new process, so down stops the right one", async () => {
  const { sup, spawned, cli, stateDir } = harness();
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();

  const record = JSON.parse(readFileSync(path.join(stateDir, "hive402.pid.json"), "utf8"));
  assert.equal(record.agents.find((a) => a.name === "spike").pid, spawned[1].child.pid);
});

// --- FIX-78: the direct-delivery path, found by running the fix --------------

test("an agent whose process is gone is relayed a wake even by an author the harness would reach it directly from", async () => {
  // FOUND LIVE, by the belt tool written for FIX-77. The first version of this
  // fix hung the respawn on the wake effect — and the dispatcher deliberately
  // emits NO wake when the harness would have delivered the message itself
  // (`deliveredDirectly`), which is the normal case for an agent's OWN OWNER.
  // So spike (owner: owner) came back and spike2 (owner: tal) did not: killed,
  // addressed by tal, no notice, no relaunch, nothing in 180 seconds.
  //
  // "The harness already delivered it" is a claim about a harness that is
  // RUNNING. When the process is gone, nothing was delivered to anybody.
  let n = 0;
  const { sup, spawned, cli } = harness();
  await sup.start();

  // Its own owner, with the p tag a real client puts on a resolved @mention.
  // The harness delivers an owner message straight to the agent, so the node
  // publishes no wake — which is exactly the case the first cut of this fix
  // never reached.
  const fromOwner = () =>
    msg({ id: `own-${(n += 1)}`, pubkey: OWNER, content: "@spike hello", tags: [["p", AGENT]] });

  cli.deliver(fromOwner());
  await sup.tick();
  assert.equal(spawned.length, 1, "a LIVE agent still needs no relay — the harness delivered it");
  assert.equal(wakesFor(cli, AGENT).length, 0, "and no duplicate wake is published");

  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(fromOwner());
  await sup.tick();

  assert.equal(spawned.length, 2, "a DEAD agent must be relaunched by its owner's message too");
  assert.equal(wakesFor(cli, AGENT).length, 1, "and the message must be relayed, since nothing delivered it");
  assert.equal(noticesIn(cli).length, 0, "DD-43: relaying it is the fix — announcing it was the noise");
});

test("the relayed wake for a dead agent carries the same authority the direct path would have written", async () => {
  // The direct path writes its authority as its own effect, keyed by the
  // triggering event; the relayed path keys it by the wake. An owner's turn must
  // end up with the same GRANT either way, or a respawn would quietly demote its
  // owner to a stranger.
  const { sup, spawned, cli, stateDir } = harness();
  await sup.start();

  cli.deliver(msg({ id: "warm", pubkey: OWNER, content: "@spike hello", tags: [["p", AGENT]] }));
  await sup.tick();
  const warm = readAuthority({ stateDir, agent: "spike", eventId: "warm" });
  assert.ok(warm, "the direct path writes its authority keyed by the triggering event");

  itExitedOnItsOwn(spawned[0].child);
  cli.deliver(msg({ id: "cold", pubkey: OWNER, content: "@spike hello again", tags: [["p", AGENT]] }));
  await sup.tick();
  const wake = wakesFor(cli, AGENT).at(-1);
  const cold = readAuthority({ stateDir, agent: "spike", eventId: wake.event_id });

  assert.ok(cold, "the relayed path writes one keyed by the wake it published");
  assert.equal(cold.kind, warm.kind);
  assert.deepEqual(cold.capabilities, warm.capabilities);
  assert.equal(cold.requester, warm.requester);
});

test("the dispatcher asks whether the agent is running before believing the harness delivered anything", () => {
  // Structural: `deliveredDirectly` must consult liveness. Without this the two
  // tests above can be satisfied by a second respawn call bolted onto the
  // authority effect, which would leave the message itself undelivered.
  const source = readFileSync(fileURLToPath(new URL("../src/listener/dispatch.mjs", import.meta.url)), "utf8");
  const decision = source.slice(source.indexOf("const deliveredDirectly"), source.indexOf("#forAgent({ agent, event, deliveredDirectly })"));
  assert.match(decision, /isAgentRunning/, "the deliveredDirectly decision must include a liveness check");
});

// --- FIX-74: liveness, and where DD-25 applies -------------------------------

test("a child this node spawned is judged by its own handle, with no probe", () => {
  const probe = () => {
    throw new Error("a spawned child must not need an OS probe");
  };
  assert.equal(agentProcessState({ pid: 4242, exitCode: null, killed: false }, { classify: probe }).alive, true);
  assert.equal(agentProcessState({ pid: 4242, exitCode: 0, killed: false }, { classify: probe }).alive, false);
});

test("an ADOPTED agent's pid is checked against the OS, never believed (DD-25)", () => {
  const gone = agentProcessState(
    { pid: 4242, adopted: true },
    { classify: () => ({ state: "gone", detail: "pid 4242 is not running" }) },
  );
  assert.equal(gone.alive, false);

  const ours = agentProcessState(
    { pid: 4242, adopted: true },
    { classify: () => ({ state: "ours", detail: "pid 4242 is a live hive402 agent" }) },
  );
  assert.equal(ours.alive, true);
});

test("an adopted pid that now belongs to somebody else is a stale record, not an idle exit", () => {
  const state = agentProcessState(
    { pid: 4242, adopted: true },
    { classify: () => ({ state: "reused", detail: "pid 4242 now belongs to another process" }) },
  );
  assert.equal(state.alive, false);
  assert.equal(state.state, "stale-record");
});

test("no process recorded at all is not-launched, and is still respawned by a wake", async () => {
  assert.equal(agentProcessState(null, {}).alive, false);
  assert.equal(agentProcessState(null, {}).state, "not-launched");
});

// --- FIX-74: the readiness wait ---------------------------------------------

test("the readiness wait returns as soon as the harness reports its pool ready", async () => {
  let text = "";
  const result = await waitForAgentReady({
    logFile: "x.log",
    channel: CHANNEL,
    timeoutMs: 5000,
    pollMs: 1,
    read: () => text,
    sleep: async () => {
      text = `subscribed to channel ${CHANNEL}\nagent_pool_ready agents=1\n`;
    },
  });
  assert.equal(result.ready, true);
  assert.match(result.detail, /pool/i);
});

test("a subscribed harness whose pool is slow is ready enough — the wake would queue", async () => {
  const result = await waitForAgentReady({
    logFile: "x.log",
    channel: CHANNEL,
    timeoutMs: 5000,
    graceMs: 0,
    pollMs: 1,
    read: () => `subscribed to channel ${CHANNEL}\n`,
    sleep: async () => {},
  });
  assert.equal(result.ready, true);
  assert.match(result.detail, /subscrib/i);
});

test("a harness that never subscribes is reported not ready, and says so", async () => {
  let t = 0;
  const result = await waitForAgentReady({
    logFile: "x.log",
    channel: CHANNEL,
    timeoutMs: 10,
    pollMs: 1,
    read: () => "buzz-acp starting: relay=ws://localhost:3000\n",
    now: () => (t += 5),
    sleep: async () => {},
  });
  assert.equal(result.ready, false);
  assert.match(result.detail, /subscrib/i);
});

test("the readiness wait reads only what was written AFTER this launch", async () => {
  // The agent log is appended to across restarts. A wait that reads the whole
  // file sees the PREVIOUS run's agent_pool_ready and returns instantly, so the
  // wake is published to a harness that is not listening yet.
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-log-"));
  const file = path.join(dir, "spike.log");
  const before = "agent_pool_ready agents=1\nbuzz-acp stopped\n";
  writeFileSync(file, before, "utf8");

  let t = 0;
  const result = await waitForAgentReady({
    logFile: file,
    fromByte: Buffer.byteLength(before),
    channel: CHANNEL,
    timeoutMs: 10,
    pollMs: 1,
    now: () => (t += 5),
    sleep: async () => {},
  });
  assert.equal(result.ready, false, "the previous run's ready line must not count for this one");
});

// --- FIX-75: status and doctor tell the truth --------------------------------

test("exitEvidence quotes the harness's own inactivity line when it is there", () => {
  const log = [
    "2026-08-19T06:30:51Z buzz-acp starting: relay=ws://localhost:3000",
    "2026-08-19T08:00:21Z inactivity bound reached — exiting gracefully inactivity_seconds=3600",
    "2026-08-19T08:00:21Z buzz-acp stopped",
  ].join("\n");
  const evidence = exitEvidence(log);
  assert.equal(evidence.idle, true);
  assert.match(evidence.detail, /inactivity/i);
});

test("exitEvidence does not claim an idle exit it cannot see", () => {
  const evidence = exitEvidence("2026-08-19T06:30:51Z buzz-acp starting: relay=ws://localhost:3000\n");
  assert.equal(evidence.idle, false);
  assert.doesNotMatch(evidence.detail, /inactivity bound/i);
});

test("exitEvidence ignores an inactivity exit from a PREVIOUS run of the same log", () => {
  const log = [
    "2026-08-19T06:00:00Z buzz-acp starting: relay=ws://localhost:3000",
    "2026-08-19T07:00:00Z inactivity bound reached — exiting gracefully inactivity_seconds=3600",
    "2026-08-19T08:00:00Z buzz-acp starting: relay=ws://localhost:3000",
  ].join("\n");
  assert.equal(exitEvidence(log).idle, false, "the current run has not exited");
});

test("status reports a recorded-but-gone agent as idle-exited, not as alive and not as dead", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-status-"));
  const child = childSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const dead = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));

  mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  writeFileSync(
    path.join(stateDir, "logs", "spike.log"),
    "buzz-acp starting: relay=ws://x\ninactivity bound reached — exiting gracefully inactivity_seconds=3600\n",
    "utf8",
  );
  writeFileSync(
    path.join(stateDir, "hive402.pid.json"),
    JSON.stringify({ node: 111, startedAt: Date.now(), agents: [{ name: "spike", pid: dead }] }),
    "utf8",
  );

  const status = await readStatus({
    config: config(),
    stateDir,
    identify: (pid) =>
      pid === 111
        ? { present: true, commandLine: "node cli.mjs up", startedAt: Date.now() - 1000 }
        : { present: false, commandLine: null, startedAt: null },
  });
  const spike = status.agents.find((a) => a.name === "spike");
  assert.equal(spike.alive, false);
  assert.equal(spike.state, "idle-exited");
  assert.match(spike.detail, /respawn/i, "an operator must be told it comes back by itself");
  assert.match(spike.detail, /inactivity/i, "and on what evidence");
});

test("status reports a live agent as running", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-status2-"));
  writeFileSync(
    path.join(stateDir, "hive402.pid.json"),
    JSON.stringify({ node: 111, startedAt: Date.now(), agents: [{ name: "spike", pid: 222 }] }),
    "utf8",
  );
  const status = await readStatus({
    config: config(),
    stateDir,
    identify: (pid) => ({
      present: true,
      commandLine: pid === 111 ? "node cli.mjs up" : "buzz-acp.exe --channels x",
      startedAt: Date.now() - 1000,
    }),
  });
  const spike = status.agents.find((a) => a.name === "spike");
  assert.equal(spike.alive, true);
  assert.equal(spike.state, "running");
});

test("the supervisor's own status stops calling a self-exited child running", async () => {
  // running was !child.killed, and a process that exits on its own was never
  // killed — so the node's own status reported a dead agent as up.
  const { sup, spawned } = harness();
  await sup.start();
  itExitedOnItsOwn(spawned[0].child);
  const status = await sup.status();
  const spike = status.agents.find((a) => a.name === "spike");
  assert.equal(spike.running, false);
  assert.equal(spike.state, "idle-exited");
});

test("doctor separates an agent that idle-exited from a pid that belongs to somebody else", async () => {
  const child = childSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const dead = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));

  const subjects = lifecycleSubjects({
    record: {
      node: 111,
      startedAt: Date.now(),
      agents: [
        { name: "spike", pid: dead },
        { name: "spike2", pid: 222 },
      ],
    },
    identify: (pid) =>
      pid === dead
        ? { present: false, commandLine: null, startedAt: null }
        : {
            present: true,
            commandLine: pid === 111 ? "node cli.mjs up" : "node -e setTimeout",
            startedAt: Date.now() - 1000,
          },
  });
  assert.equal(subjects.nodeDown, false);
  assert.equal(subjects.idleExited.length, 1);
  assert.equal(subjects.idleExited[0].name, "spike");
  assert.match(subjects.idleExited[0].detail, /respawn/i);
  assert.equal(subjects.stale.length, 1, "a recycled pid is still a stale record, not an idle exit");
  assert.equal(subjects.stale[0].name, "spike2");
});

// --- the structural guard ----------------------------------------------------

test("the WAKE PATH calls the respawn — a respawn nothing triggers is not a fix", () => {
  // Five modules in this product have been built, tested and never called by
  // anything. Every unit test above would still pass against a supervisor whose
  // wake branch never consults the respawn, so this asserts the wiring itself:
  // the call must sit in the branch that handles a wake, BEFORE the send that
  // publishes it.
  const source = readFileSync(fileURLToPath(new URL("../src/node/supervisor.mjs", import.meta.url)), "utf8");
  // Anchored at `#apply`, which is the method this test is about. Anchored at
  // the FILE's first `effect.type === "wake"` instead, the window moved onto
  // whichever caller happened to be written above `#apply` — and a caller that
  // merely ASKS whether an effect was a wake (FIX-159's promise path does, to
  // decide whether the promise was kept) is not code that should be
  // respawning anything. The guard was reading the wrong branch.
  const applyIndex = source.indexOf("async #apply(");
  assert.ok(applyIndex >= 0, "the supervisor must still apply its effects in #apply");
  const apply = source.slice(applyIndex);
  const branch = apply.slice(apply.indexOf('effect.type === "wake"'));
  assert.ok(branch.length > 0, "the wake branch must still exist");
  const untilSend = branch.slice(0, branch.indexOf("entry.cli.send"));
  assert.match(
    untilSend,
    /ensureAgentRunning/,
    "the wake branch must ensure the agent is running BEFORE it publishes the wake",
  );
  assert.match(source, /#ensureAgentRunning\(/, "and the method must exist");
});

test("the respawn goes through the SAME launch call the initial bring-up uses", () => {
  // A second, divergent spawn site is how a respawned agent quietly loses a
  // policy flag or an env var that up supplies.
  const source = readFileSync(fileURLToPath(new URL("../src/node/supervisor.mjs", import.meta.url)), "utf8");
  assert.equal(
    (source.match(/this\.#spawn\(/g) ?? []).length,
    1,
    "there must be exactly one place in the supervisor that spawns an agent",
  );
});

// ── The wake notice is GONE (AC-5 as amended in 0.5.0, DD-43) ───────────────
//
// A test that pinned the wording of `respawnNotice` used to sit here. It was
// deleted together with the function it described, which is the correct move
// rather than a shortcut to green: the test asserted that a certain sentence
// reached the room, and spec 0.5.0 decided no sentence should. Keeping it would
// have meant keeping the behaviour it pinned.
//
// What replaced it lives in `test/no-routine-notices.test.mjs`: the node
// publishes ZERO room messages for a cold respawn and for a slow live turn,
// while the respawn mechanism and its audit row carry on unchanged.

// FOUND BY RUNNING THE MEMBERSHIP TEST ON A LIVE COMMUNITY (2026-08-26).
//
// The pid file was written ONCE, at the end of `start()`. Every relaunch after
// that — a respawn, or a channel change — replaced the child without rewriting
// it, so the file named a pid that was already dead while the real process ran
// untracked. Measured on the real relay after two channel changes: TWO live
// `buzz-acp` processes, and a pid file naming a third that was gone.
//
// `hive402 down` runs in a different process and stops what the FILE records,
// so an untracked agent cannot be stopped at all — TR-003, the buzz-acp still
// running hours after the session that started it.
test("the pid file names the CURRENT child after a relaunch", async () => {
  const { Supervisor } = await import("../src/node/supervisor.mjs");
  const { computeAuthTag } = await import("../src/identity/nipoa.mjs");
  const { mkdtempSync, readFileSync: read } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;

  const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
  const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
  const stateDir = mkdtempSync(nodePath.join(tmpdir(), "hive402-pidfile-"));
  let nextPid = 1000;
  let channels = [{ channel_id: "c1" }];
  const cli = {
    async myChannels() { return channels; },
    async getMessages() { return []; },
    async send() { return { accepted: true, event_id: "e" }; },
    async setProfile() { return {}; },
    async getUser({ pubkey }) { return pubkey === AGENT ? { pubkey: AGENT, display_name: "spike" } : null; },
  };
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: "9".repeat(64), privateKeyRef: "env:N" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\Buzz", nodeDir: "C:\node", adapter: "C:\a.js", extraDirs: [] },
      rooms: [{ channel: "c1", agents: [{
        // The declared owner must BE the attester, or the publisher rightly
        // refuses it as a foreign attestation.
        name: "spike", pubkey: AGENT, ownerPubkey: "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a", privateKeyRef: "env:A",
        research: true, build: false, crossOwnerAsks: "owner-approves",
        selfInitiated: "asks-owner", replyMode: "addressed-only", avatar: null,
        instructions: null, instructionsFile: null,
      }] }],
    },
    stateDir,
    spawn: () => ({ pid: (nextPid += 1), kill() {} }),
    makeCli: () => cli,
    readAttestation: () => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT }),
    resolveKey: async () => "bb".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    membershipRecheckMs: 0,
  });
  await sup.start();

  const recorded = () => JSON.parse(read(nodePath.join(stateDir, "hive402.pid.json"), "utf8")).agents[0].pid;
  const first = recorded();
  assert.ok(first > 1000, "the launch was recorded");

  // Exactly how it happens in the field: somebody adds the agent to another
  // channel in a Buzz client, the re-check notices, and the agent is relaunched
  // so its subscription matches.
  channels = [{ channel_id: "c1" }, { channel_id: "c2" }];
  await sup.tick();

  assert.notEqual(recorded(), first, "the file must name the NEW child, not the dead one");
  assert.equal(recorded(), nextPid, "and it names the one actually running");
});
