// F-029 (fix cycle 18, FIX-161): one reply for three questions.
//
// `spike2` was sent three ask-less messages in a burst and answered all three
// with a single reply anchored to one of the three threads. FIX-143's recovery
// net read the other two threads as unanswered and woke it again on each.
//
// DD-63 decides this in the direction the whole product is built around: the
// answer-check stays anchored to the thread the question was asked in. Teaching
// it to accept a bundled reply means deciding from message text (this product's
// first recurring defect class, which has lost to the next phrasing twice) or
// from arrival timing (the same guess with less information), and both fail by
// DISARMING a recovery for a message nobody answered — the P1 family the net
// exists to end.
//
// So what changes is the SOURCE, not the check: the house rules ask an agent
// that answers several messages at once to say so in each thread. If it
// complies, the existing predicate is satisfied by a real anchored reply
// rather than by a guess; if it does not, behaviour is exactly today's.
//
// The second test is the guard that keeps the decision. It asserts the
// POSITIVE form — the siblings still recover — so a later cycle that "improves"
// the predicate into accepting a bundled reply reddens it, rather than passing
// quietly while a real recovery is switched off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { HIVE_MARKER } from "../src/listener/attribution.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const attestations = new Map();
const attestFor = (agent) => {
  if (!attestations.has(agent.pubkey)) {
    attestations.set(agent.pubkey, computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: agent.pubkey }));
  }
  return attestations.get(agent.pubkey);
};

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
      // The identity publisher looks an agent up BY NAME to check the room can
      // address it, so this has to answer both questions.
      if (name) return { pubkey: AGENT, display_name: name };
      if (pubkey === AGENT) return { pubkey, display_name: "spike" };
      return { pubkey, display_name: "barry" };
    },
  };
}

function harness() {
  const cli = fakeCli();
  const spawned = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-f029-"));
  const sup = new Supervisor({
    config: {
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
    },
    stateDir,
    spawn: (command, args, opts) => {
      const child = { pid: 7001, exitCode: null, killed: false, kill() {} };
      spawned.push({ command, args, opts, child });
      return child;
    },
    makeCli: () => cli,
    readAttestation: (agent) => attestFor(agent),
    resolveKey: (ref) => (ref === "env:TEST_NODE_KEY" ? "aa".repeat(32) : "bb".repeat(32)),
    trustWorkspace: () => {},
    queryEvents: async () => [],
    submitEvent: async () => ({ published: true }),
    log: () => {},
    awaitAgentReady: async () => ({ ready: true, detail: "test" }),
  });
  return { sup, cli, spawned, stateDir };
}

const wakes = (cli) =>
  cli.sent.filter((s) => String(s.content ?? "").includes(`${HIVE_MARKER} Waking up agent`));

// Tick with the clock MOVING, or the grace window is never crossed and every
// assertion below is green against a product with no recovery at all.
async function tickOver(sup, { ticks = 12, stepMs = 60_000 } = {}) {
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

// ── The change: the house rules ask for a line in each thread ─────────────

test("FIX-161: the etiquette an agent is actually LAUNCHED with asks for a line in every thread a bundled answer covers", async () => {
  const { sup, spawned } = harness();
  await sup.start();

  assert.equal(spawned.length, 1, "one agent was launched");
  const rules = String(spawned[0].opts.env.BUZZ_ACP_TEAM_INSTRUCTIONS ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ");

  assert.match(rules, /hive402 room rules/, "the house rules reached the harness at all");
  assert.match(
    rules,
    /several messages at once/,
    "the several-messages-at-once case is named, not left to be inferred from the single-message rule",
  );
  assert.match(
    rules,
    /reply in each( of those)? thread/,
    "and the ask is a line in EACH thread, which is what the answer-check can actually see",
  );
  await sup.stop();
});

test("FIX-161: the ask lives inside 'Reply where you were asked', not as a rule of its own", async () => {
  // It is the same rule generalised from one message to several. A new
  // top-level heading would read as a second, competing instruction about
  // where to reply — and the section it belongs in is the one the agent
  // consults when deciding where its answer goes.
  const { HOUSE_ETIQUETTE } = await import("../src/launcher/instructions.mjs");
  const sections = HOUSE_ETIQUETTE.split(/^### /m);
  const replySection = sections.find((s) => s.startsWith("Reply where you were asked"));
  assert.ok(replySection, "the section still exists");
  assert.match(
    replySection.toLowerCase().replace(/\s+/g, " "),
    /several messages at once/,
    "the bundled-answer line lives in the section about where to reply",
  );
});

// ── The decision: the predicate is NOT weakened (DD-63) ───────────────────

test("DD-63 GUARD: a burst of three, one reply anchored to the third — the two siblings STILL recover", async () => {
  const { sup, cli } = harness();
  await sup.start();

  // Three ask-less messages from the agent's own owner, each its own thread.
  // All three take the direct branch, so all three are receipts and none of
  // them publishes a wake.
  const burst = ["1", "2", "3"].map((n) => ({
    id: n.repeat(64),
    kind: 9,
    pubkey: OWNER,
    created_at: Math.floor(Date.now() / 1000),
    content: `@spike thought number ${n}`,
    tags: [["p", AGENT]],
  }));
  for (const event of burst) cli.deliver(event);
  await sup.tick();
  assert.equal(wakes(cli).length, 0, "precondition: a direct delivery publishes nothing");

  // The agent bundles: ONE reply, anchored to the third thread, addressing all
  // three. This is precisely what `spike2` did in cycle 14.
  cli.deliver({
    id: "d".repeat(64),
    kind: 9,
    pubkey: AGENT,
    created_at: Math.floor(Date.now() / 1000) + 5,
    content: "Taking those in order: one, two, and three.",
    tags: [["e", burst[2].id, "", "reply"]],
  });

  await tickOver(sup, { ticks: 12, stepMs: 60_000 });

  const recovered = wakes(cli);
  assert.equal(
    recovered.length,
    2,
    "the two threads holding no reply are recovered — the answer-check reads THIS thread, and a " +
      "reply in a sibling's thread is not evidence about this one",
  );
  const quoted = recovered.map((w) => w.content);
  assert.ok(
    quoted.some((c) => c.includes("thought number 1")),
    "the first sibling came back",
  );
  assert.ok(
    quoted.some((c) => c.includes("thought number 2")),
    "and so did the second",
  );
  assert.ok(
    !quoted.some((c) => c.includes("thought number 3")),
    "and the thread that DOES hold the reply is left alone — this is not 'recover everything'",
  );
  await sup.stop();
});
