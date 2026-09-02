import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as childSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

const config = (over = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: CHANNEL,
      agents: [
        {
          name: "spike",
          pubkey: AGENT,
          ownerPubkey: OWNER,
          privateKeyRef: "env:TEST_AGENT_KEY",
          research: true,
          build: false,
          crossOwnerAsks: "owner-approves",
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
  ...over,
});

// A relay that hands out a scripted event stream and records what was sent.
// `history` is what already exists when the node boots; `deliver` is a message
// arriving afterwards. Keeping them separate is what lets the watermark test
// and the relay tests share one fake.
function fakeCli(history = []) {
  const sent = [];
  const events = [...history];
  return {
    sent,
    deliver(event) {
      events.push(event);
    },
    async getMessages() {
      return events;
    },
    async send(args) {
      // The id travels back on the record too: a wake's authority is keyed by
      // the id the relay gave it (DD-20), so a test that wants to read that
      // record needs to know which event the wake became.
      const event_id = `sent-${sent.length + 1}`;
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser({ pubkey }) {
      return pubkey === AGENT ? { pubkey: AGENT, display_name: "spike" } : null;
    },
  };
}

function harness({ history = [], cfg = config() } = {}) {
  const spawned = [];
  const clis = [];
  const trusted = [];
  const spawn = (command, args, opts) => {
    spawned.push({ command, args, opts });
    return { pid: 1000 + spawned.length, killed: false, kill() { this.killed = true; } };
  };
  const cli = fakeCli(history);
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  const sup = new Supervisor({
    config: cfg,
    stateDir,
    spawn,
    // Record the identity each client was created under. The node and each
    // agent must get their own: `buzz users set-profile` updates the CALLING
    // identity's profile, so publishing through the node's client would rename
    // the node instead of the agent.
    makeCli: (opts) => {
      clis.push({ ...opts, cli });
      return cli;
    },
    readAttestation: () => authTag,
    resolveKey: (ref) => (ref === "env:TEST_AGENT_KEY" ? "bb".repeat(32) : "aa".repeat(32)),
    trustWorkspace: (args) => trusted.push(args.workDir),
    log: () => {},
  });
  return { sup, spawned, cli, clis, stateDir, trusted };
}

// Same harness, but pinned to an existing state dir.
//
// It deliberately does NOT stub the liveness or identity probe by default: the
// question "is the pid in that file still my node?" is the one O-1 got wrong,
// and a harness that answers it for free is a harness that cannot catch that
// class of bug again. Pass `identify` only in the tests that are ABOUT the
// probe being unable to answer.
function harnessAt(stateDir, { pid = 90001, identify, isAlive } = {}) {
  const spawned = [];
  const logged = [];
  const spawn = (command, args, opts) => {
    spawned.push({ command, args, opts });
    return { pid: 2000 + spawned.length, kill() {} };
  };
  const cli = fakeCli();
  const sup = new Supervisor({
    config: config(),
    stateDir,
    spawn,
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    ...(identify ? { identify } : {}),
    ...(isAlive ? { isAlive } : {}),
    pid,
    log: (line) => logged.push(line),
  });
  return { sup, spawned, cli, stateDir, logged };
}

// Real OS processes, for the stale-pid tests. A recorded pid that disagrees
// with reality cannot be modelled by a fake without modelling the bug away.
const liveProcesses = [];

function spawnStranger() {
  const child = childSpawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  liveProcesses.push(child);
  return child;
}

function spawnNodeShaped() {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-fakecli-"));
  mkdirSync(path.join(dir, "bin"));
  const script = path.join(dir, "bin", "cli.mjs");
  writeFileSync(script, "setTimeout(() => {}, 120000);\n", "utf8");
  const child = childSpawn(process.execPath, [script, "up", "--config", path.join(dir, "hive402.config.json")], {
    stdio: "ignore",
  });
  liveProcesses.push(child);
  return child;
}

async function deadPid() {
  const child = childSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

// Write the pid file a previous `up` would have left behind.
function writePidFile(stateDir, { node, agents = [], startedAt = Date.now() }) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "hive402.pid.json"),
    `${JSON.stringify({ node, startedAt, agents }, null, 2)}\n`,
    "utf8",
  );
}

test.after(() => {
  for (const child of liveProcesses) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
});

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });

// --- F-002: the node actually runs -----------------------------------------

test("starting the node launches every configured agent through the launcher", async () => {
  // Cycle 1: the CLI had no launch path at all, and the live agents were
  // started by a dev-harness script outside the product.
  const { sup, spawned } = harness();
  await sup.start();
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].command, /buzz-acp/);
});

test("the launched agent carries the full policy env, not harness defaults", async () => {
  // AC-41/AC-42 — asserted on what the node actually spawns, which is the gap
  // F-005 was really pointing at.
  const { sup, spawned } = harness();
  await sup.start();
  const env = spawned[0].opts.env;
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
  assert.ok(Number(env.BUZZ_ACP_IDLE_POOL_SLEEP) > 0);
  assert.ok(Number(env.BUZZ_ACP_EXIT_AFTER_INACTIVITY) > 0);
  assert.ok(env.BUZZ_ACP_PERMISSION_MODE);
});

test("an agent whose owner requires approval is launched behind the node's gate", async () => {
  // Without this the relay wakes the agent directly and AC-14 cannot run.
  const { sup, spawned } = harness();
  await sup.start();
  assert.equal(spawned[0].opts.env.BUZZ_ACP_RESPOND_TO, "allowlist");
  // FIX-131: node AND owner. The owner was implicit in buzz-acp until FIX-117
  // moved the attestation to the node, after which the human was admitted by
  // nobody — while the node went on suppressing its own relay believing
  // otherwise, so both sides dropped the owner's messages to their own agent.
  assert.equal(spawned[0].opts.env.BUZZ_ACP_RESPOND_TO_ALLOWLIST, [NODE, OWNER].join(","));
});

test("each agent is launched in its own capability-scoped working directory", async () => {
  const { sup, spawned, stateDir } = harness();
  await sup.start();
  const cwd = spawned[0].opts.cwd;
  assert.ok(cwd?.startsWith(stateDir), `cwd should live under the state dir, got ${cwd}`);

  const settings = JSON.parse(readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"));
  // build is off in the fixture, so the build tools must be denied.
  assert.ok(settings.permissions.deny.some((r) => /Write/.test(r)));
  assert.ok(!settings.permissions.deny.some((r) => /WebSearch/.test(r)), "research is on");
});

test("the agent's working directory is registered as trusted before launch", async () => {
  // Otherwise the runtime gates it behind a trust prompt no headless agent can
  // answer, and every turn dies silently (live, 2026-08-15).
  const { sup, spawned, trusted } = harness();
  await sup.start();
  assert.deepEqual(trusted, [spawned[0].opts.cwd]);
});

test("the agent inherits the OS scaffolding it needs to find its owner's credentials", async () => {
  // Without USERPROFILE/APPDATA the model runtime cannot locate the owner's
  // login, and every turn dies with "Authentication required" (live, 2026-08-15).
  const { sup, spawned } = harness();
  await sup.start();
  const env = spawned[0].opts.env;
  assert.ok(env.USERPROFILE || env.HOME, "expected a home directory var");
  assert.ok(!("ANTHROPIC_API_KEY" in env), "must not carry an ambient API key across");
});

// --- F-001/F-006: the agent is published ------------------------------------

test("starting the node publishes every agent's profile before launching it", async () => {
  const published = [];
  const { sup, cli } = harness();
  cli.setProfile = async (args) => {
    published.push(args.name);
    return { accepted: true };
  };
  await sup.start();
  assert.deepEqual(published, ["spike"]);
});

test("an agent's profile is published under the AGENT's identity, never the node's", async () => {
  // REGRESSION (found live, 2026-08-15): `buzz users set-profile` updates the
  // calling identity's profile. Publishing through the node's client renamed
  // the NODE to "spike" — so "@spike" resolved to the node, the agent still had
  // no profile, and F-001 would have looked fixed while being differently
  // broken. The node's own AC-39 check is what caught it:
  //   WARNING name "spike" resolves to another identity (924280894112…)
  const { sup, clis } = harness();
  await sup.start();

  const publisher = clis.find((c) => c.publishesFor === "spike");
  assert.ok(publisher, `no client was created for spike: ${JSON.stringify(clis.map((c) => c.publishesFor))}`);
  assert.equal(publisher.privateKey, "bb".repeat(32), "must use the agent's own key");
  assert.deepEqual(publisher.authTag, authTag, "must carry the agent's own attestation");

  const nodeClient = clis.find((c) => c.role === "node");
  assert.notEqual(nodeClient.privateKey, publisher.privateKey, "node and agent are separate identities");
});

test("the node refuses to launch an agent with no owner attestation", async () => {
  // An unattested agent is the F-006 state: nobody can verify who owns it.
  const { sup } = harness();
  sup.readAttestation = () => null;
  await assert.rejects(() => sup.start(), /attestation|register/i);
});

// --- FIX-11 / TR-003: idempotent lifecycle ---------------------------------

test("starting twice does not stack a second copy of the same agent", async () => {
  // Cycle 1 found a 7.5-hour orphan because nothing reconciled or stopped.
  const { sup, spawned } = harness();
  await sup.start();
  await sup.start();
  assert.equal(spawned.length, 1, "the second start must reconcile, not re-spawn");
});

test("a second node refuses to start while another is still watching the room", async () => {
  // REGRESSION (found live, 2026-08-15): `down` stopped the agents but left the
  // NODE process running, and `up` only reconciled agents. Three node processes
  // ended up polling the same room, and one human message produced three
  // identical wakes. Duplicated wakes are worse than none: they multiply model
  // turns and spend the turn cap three times as fast.
  //
  // The recorded node here is a REAL running process with a real `hive402 up`
  // command line. Cycle 3's version of this test injected `isAlive: () => true`,
  // which asserts the refusal while stubbing out the only question that can be
  // wrong — and it was wrong (O-1).
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  const node = spawnNodeShaped();
  writePidFile(stateDir, { node: node.pid });

  const second = harnessAt(stateDir, { pid: 90002 });
  await assert.rejects(() => second.sup.start(), /already running|hive402 down/i);
  assert.equal(second.spawned.length, 0, "must not launch agents behind a live node");
});

// --- O-1: a stale pid file must not wedge the node --------------------------

test("up reclaims a pid file whose node process really exited", async () => {
  // THE O-1 CASE, and the normal morning-after state of the demo rig: the
  // agents' own EXIT_AFTER_INACTIVITY fires overnight, the node goes with it,
  // and nothing cleans up. `up` refused all morning behind pid 36916 while
  // `tasklist` reported it gone, so the room could not restart without a human
  // running `down` first.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  writePidFile(stateDir, { node: await deadPid() });

  const { sup, spawned, logged } = harnessAt(stateDir, { pid: 90002 });
  await sup.start();
  assert.equal(spawned.length, 1, "the room must come back up by itself");
  assert.ok(
    logged.some((l) => /already stopped|stale/i.test(l)),
    `reclaiming a stale record should be said out loud, got: ${JSON.stringify(logged)}`,
  );
});

test("up reclaims a pid file whose number was recycled onto another process", async () => {
  // A pid is a reusable number, not an identity. Windows recycles them briskly,
  // so an idle overnight rig can wake up with the node's old number held by
  // something unrelated — and then `up` stays wedged indefinitely, because the
  // number really is in use.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  const stranger = spawnStranger();
  writePidFile(stateDir, { node: stranger.pid });

  const { sup, spawned, logged } = harnessAt(stateDir, { pid: 90002 });
  await sup.start();
  assert.equal(spawned.length, 1, "another program holding the number is not our node");
  assert.ok(
    logged.some((l) => /already stopped|stale/i.test(l)),
    `got: ${JSON.stringify(logged)}`,
  );
  assert.ok(!stranger.killed, "and it must certainly not be killed");
});

test("up refuses rather than guessing when it cannot identify a live pid", async () => {
  // The failure direction is the whole point: two nodes relay every message
  // twice, so a probe that cannot answer must not be read as "nothing there".
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  const stranger = spawnStranger();
  writePidFile(stateDir, { node: stranger.pid });

  const { sup, spawned } = harnessAt(stateDir, { pid: 90002, identify: () => null });
  await assert.rejects(() => sup.start(), /could not|unconfirmed|already running/i);
  assert.equal(spawned.length, 0);
});

test("an agent pid recycled onto another process is not adopted", async () => {
  // An adopted entry is one `stop()` will later kill by number. Adopting a
  // stranger's pid turns `hive402 down` into a way to kill somebody else's
  // process — the same defect as O-2, one step earlier.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-state-"));
  const stranger = spawnStranger();
  writePidFile(stateDir, { node: await deadPid(), agents: [{ name: "spike", pid: stranger.pid }] });

  const { sup, spawned } = harnessAt(stateDir, { pid: 90002 });
  await sup.start();
  assert.equal(spawned.length, 1, "spike must be launched fresh, not adopted from a stranger");
});

test("stopping the node kills every agent it started and clears the pid file", async () => {
  const { sup, stateDir } = harness();
  await sup.start();
  const pidFile = path.join(stateDir, "hive402.pid.json");
  assert.ok(existsSync(pidFile));

  const stopped = await sup.stop();
  assert.equal(stopped.length, 1);
  assert.ok(!existsSync(pidFile));
});

// --- the listener actually relays ------------------------------------------

test("a non-owner's plain @name is relayed as a p-tagged wake", async () => {
  // The whole product claim, end to end through the node.
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();
  const wake = cli.sent.find((s) => s.mentions?.includes(AGENT));
  assert.ok(wake, `expected a p-tagged wake, got: ${JSON.stringify(cli.sent)}`);
});

test("the same event is never relayed twice", async () => {
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: "@spike hello" }));
  await sup.tick();
  await sup.tick();
  assert.equal(cli.sent.filter((s) => s.mentions?.includes(AGENT)).length, 1);
});

test("history from before the node started is not replayed on boot", async () => {
  // Otherwise restarting the node re-answers every message in the room.
  const { sup, cli } = harness({ history: [msg({ pubkey: TAL, content: "@spike hello" })] });
  await sup.start(); // watermark set here — the event above already exists
  await sup.tick();
  assert.equal(cli.sent.filter((s) => s.mentions?.includes(AGENT)).length, 0);
});

test("an unaddressed message is relayed to nobody", async () => {
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: "just chatting" }));
  await sup.tick();
  assert.equal(cli.sent.filter((s) => s.mentions?.includes(AGENT)).length, 0);
});

test("a cross-owner action request is relayed as a CONTAINED turn, not parked from its wording", async () => {
  // This test used to assert the opposite: the node read "research" in the
  // text, parked the request, and published no wake. F-013 is the bill for
  // deciding anything from wording — the same reading refused ordinary
  // conversation containing "build" or "deploy", from the agent's own owner.
  //
  // So the agent is woken (conversation is free, AC-12) and the turn carries an
  // explicit withhold. AC-14's approval request is raised when the agent
  // actually reaches for the tool — see containment-node.test.mjs for that half
  // of the loop, end to end.
  const { sup, cli, stateDir } = harness();
  await sup.start();
  cli.deliver(msg({ pubkey: TAL, content: "@spike research the weather in Paris" }));
  await sup.tick();

  const wake = cli.sent.find((s) => s.mentions?.includes(AGENT));
  assert.ok(wake, "the agent must be woken — it is being spoken to");
  assert.equal(
    cli.sent.filter((s) => /approve h4-/.test(s.content)).length,
    0,
    "nothing has been attempted yet, so there is nothing to approve",
  );

  const authority = readAuthority({ stateDir, agent: "spike", eventId: wake.event_id });
  assert.equal(authority.kind, "withheld", "a non-owner's turn may talk and nothing else");
});

test("the status report says whether each agent is addressable", async () => {
  // AC-39: the node reports it, rather than leaving a human to discover a raw
  // relay error in their own client.
  const { sup } = harness();
  await sup.start();
  const status = await sup.status();
  assert.equal(status.agents[0].addressable, true);
  assert.equal(status.agents[0].running, true);
});

// --- O-4: every missing key in ONE error ------------------------------------

test("up names every unresolvable key at once, not one per attempt", async () => {
  // Bringing the room back after the overnight exit took three runs of `up`,
  // each revealing exactly one more missing env var (HIVE402_NODE_KEY, then
  // HIVE402_SPIKE_KEY, then HIVE402_SPIKE2_KEY), because resolution happened
  // lazily as each identity was first needed. Three round trips to learn one
  // fact, at the moment the rig is down.
  const twoAgents = config({
    rooms: [
      {
        channel: CHANNEL,
        agents: [
          { ...config().rooms[0].agents[0], name: "spike", privateKeyRef: "env:HIVE402_SPIKE_KEY" },
          { ...config().rooms[0].agents[0], name: "spike2", privateKeyRef: "env:HIVE402_SPIKE2_KEY" },
        ],
      },
    ],
  });

  const missing = new Set(["env:HIVE402_SPIKE_KEY", "env:HIVE402_SPIKE2_KEY"]);
  const failing = new Supervisor({
    config: twoAgents,
    stateDir: mkdtempSync(path.join(tmpdir(), "hive402-state-")),
    spawn: () => ({ pid: 1, kill() {} }),
    makeCli: () => fakeCli(),
    readAttestation: () => authTag,
    resolveKey: (ref) => {
      if (missing.has(ref)) throw new Error(`${ref}: environment variable ${ref.slice(4)} is not set`);
      return "aa".repeat(32);
    },
    log: () => {},
  });

  const err = await failing.start().then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "start must refuse when a key cannot be resolved");
  assert.match(err.message, /HIVE402_SPIKE_KEY/, err.message);
  assert.match(err.message, /HIVE402_SPIKE2_KEY/, `both must be named in one error, got: ${err.message}`);
});

test("a config whose keys all resolve is not blocked by the pre-flight", async () => {
  const { sup, spawned } = harness();
  await sup.start();
  assert.equal(spawned.length, 1);
});
