// The node posts no routine notices (spec 0.5.0 AC-5, DD-43).
//
// Two notices were built in two consecutive cycles, each for a real silence:
// DD-34's "Waking <agent> up…" when a respawn is needed, and DD-39's
// "<agent> is on it…" when a live turn runs long. Both answered the question
// "how does a waiting human know anything is happening?" with a message in a
// shared room.
//
// Spec 0.5.0 answers it differently, and the difference is not a refinement —
// it reverses the decision. Buzz's own clients already show a working indicator
// against the addressed agent, so the node's line duplicates a signal the human
// already has, and it costs every OTHER member of the room a line to read. AC-5
// as amended says so plainly: a message the client already conveys is noise in
// a shared room, and a client that shows no indicator has a client defect,
// "not [something to be] papered over with chat".
//
// So both notices go. What STAYS is everything that was actually load-bearing:
// the respawn itself (an agent that idle-exited is still relaunched by the
// message that addresses it), the audit rows, and the FAILURE message — a node
// that could not restart an agent is not being routine, it is reporting that
// the room is broken.
//
// These tests drive `Supervisor.tick`, the real entry point, and read what the
// node actually SENT. A node-authored room message is anything the node put in
// the channel that is not the wake itself (the wake is p-tagged to the agent
// and is the whole delivery mechanism).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const AGENT2 = "ccc78ff39f1a7647b91c7e49c10d5441b8086bab1cd2c38daf41908ad3e5b139";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

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
      return pubkey === AGENT2 ? { pubkey: AGENT2, display_name: "spike2" } : { pubkey, display_name: "spike" };
    },
  };
}

function harness({ cfg = config() } = {}) {
  const spawned = [];
  const cli = fakeCli();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-quiet-"));
  const spawn = () => {
    const child = {
      pid: 1000 + spawned.length + 1,
      exitCode: null,
      killed: false,
      kill() {
        this.killed = true;
      },
    };
    spawned.push({ child });
    return child;
  };
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
  return { sup, spawned, cli, stateDir };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });

// Everything the node said to the room that is NOT a wake. A wake carries the
// agent's p tag — that tag IS the delivery mechanism — so it is the one node
// message a quiet node still publishes.
const chatter = (cli) => cli.sent.filter((s) => !(s.mentions ?? []).includes(AGENT));

// Poll repeatedly with the CLOCK MOVING, which is the whole point.
//
// This is a discrimination fix, and it is worth naming: the first cut of these
// tests ran 40 ticks against the real clock, which take milliseconds, so
// DD-39's 25-second threshold was never crossed and two "the node stays
// silent" tests passed against the UNFIXED product. That is precisely the trap
// this plan's cycle-12 log records — a negative test in this product is worth
// only as much as its discrimination check. Advancing a stubbed `Date.now` (the
// clock `WorkingNotices` reads by default) makes them fail before the fix and
// pass after it.
async function pollOverMinutes(sup, { ticks = 6, stepMs = 60_000 } = {}) {
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

test("a cold respawned turn produces ZERO node-authored room messages", async () => {
  const { sup, spawned, cli } = harness();
  await sup.start();
  spawned[0].child.exitCode = 0; // the AC-42 idle policy took it

  cli.deliver(msg({ id: "e1", pubkey: TAL, content: "@spike are you there?" }));
  await sup.tick();

  assert.equal(spawned.length, 2, "precondition: the respawn mechanism still ran");
  assert.deepEqual(
    chatter(cli).map((s) => s.content),
    [],
    "the client's own working indicator carries the wait — the node says nothing",
  );
});

test("a slow live turn produces ZERO node-authored room messages, however long it runs", async () => {
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ id: "e1", pubkey: TAL, content: "@spike research the weather in Paris" }));

  // Six minutes of polling with no reply from the agent: the case DD-39 was
  // built for, and the shape of F-021's 874-second data point.
  await pollOverMinutes(sup);

  assert.deepEqual(
    chatter(cli).map((s) => s.content),
    [],
    "a long silence is the client's to show, not the room's to read",
  );
});

test("the OWNER's slow turn is silent too — the direct route posts nothing either", async () => {
  // The harness delivers an owner's message itself, so the node relays no wake
  // at all. F-021's 240-second data point is this route, and DD-39 armed a
  // notice on it; nothing may be posted here now.
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ id: "e1", pubkey: OWNER, content: "@spike write me a page", tags: [["p", AGENT]] }));
  await pollOverMinutes(sup);

  assert.deepEqual(cli.sent.map((s) => s.content), [], "the node published nothing at all");
});

test("an agent-to-agent exchange stays silent as well", async () => {
  const cfg = config({ agents: [agentEntry(), agentEntry({ name: "spike2", pubkey: AGENT2 })] });
  const { sup, cli } = harness({ cfg });
  await sup.start();
  cli.deliver(msg({ id: "e1", pubkey: AGENT2, content: "@spike what do you think?" }));
  await pollOverMinutes(sup);
  // Note: this one guarded correctly even before DD-43 (an agent-authored
  // trigger was never armed), so it does not discriminate — it is kept as the
  // cheap standing check that the quiet path covers agent traffic too.
  assert.deepEqual(chatter(cli).map((s) => s.content), []);
});

// ── What stays ───────────────────────────────────────────────────────────────

test("the respawn AUDIT row survives — the record is not what was noisy", async () => {
  const { sup, spawned, cli } = harness();
  await sup.start();
  spawned[0].child.exitCode = 0;
  cli.deliver(msg({ id: "e1", pubkey: TAL, content: "@spike hello" }));
  await sup.tick();

  const rows = sup.audit.query({ agent: "spike", limit: 20 });
  assert.ok(
    rows.some((r) => r.kind === "respawn"),
    "the node still records that it relaunched the agent",
  );
});

test("a respawn that FAILS is still reported — that is not a routine notice", async () => {
  // DD-43 removes the two ROUTINE lines. An agent the node could not restart is
  // a broken room, and a room that is broken must not be quiet about it.
  const { sup, spawned, cli } = harness();
  await sup.start();
  spawned[0].child.exitCode = 0;
  sup.readAttestation = () => null; // relaunch will throw

  cli.deliver(msg({ id: "e1", pubkey: TAL, content: "@spike hello" }));
  await sup.tick();

  assert.ok(
    cli.sent.some((s) => /could not restart it/.test(s.content ?? "")),
    "the room is told the agent is down and could not be brought back",
  );
});

// ── Structural: the notices are GONE, not merely unreachable ─────────────────

test("the working-notice module no longer exists", () => {
  assert.equal(
    existsSync(fileURLToPath(new URL("../src/node/working.mjs", import.meta.url))),
    false,
    "a module kept 'just in case' is a second behaviour nobody tests",
  );
});

test("the respawn module exports no room notice", async () => {
  const respawn = await import("../src/node/respawn.mjs");
  assert.equal(respawn.respawnNotice, undefined, "the wake notice is removed, not just uncalled");
});

test("the supervisor holds no notice machinery at all", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/node/supervisor.mjs", import.meta.url)), "utf8");
  for (const gone of ["respawnNotice", "workingNotice", "WorkingNotices", "#armWorking", "#working"]) {
    assert.doesNotMatch(
      source,
      new RegExp(gone.replace("#", "\\#")),
      `${gone} must be gone from the supervisor, not left dormant`,
    );
  }
});
