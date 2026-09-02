// A reply appears where the question was asked (AC-50, DD-42, FIX-108).
//
// ── Why the NODE's wake decides where the AGENT's answer lands ───────────────
//
// The agent does not choose its own thread. buzz-acp resolves a `--reply-to`
// anchor for every human-facing turn and puts it in the prompt
// (`crates/buzz-acp/src/queue.rs::resolve_reply_anchor`, buzz @ a2d8be5ef):
//
//     thread_tags.root_event_id.unwrap_or(triggering_event_id)
//
// and its base prompt tells the agent to use it ("Use the reply destination
// supplied in the [Context] block"). The triggering event for a relayed turn is
// THE NODE'S WAKE. So an unthreaded wake makes the harness anchor the agent's
// reply to the node's own relay message, and the answer to a question asked in
// a thread surfaces in a brand-new thread hanging off a machine's message,
// which is exactly the split AC-50 forbids.
//
// Thread the wake to the trigger's own thread root and the harness computes the
// right anchor by itself: the agent replies where the human asked, with no
// cooperation from the model required.
//
// ── The NIP-10 rules are upstream's, verbatim ───────────────────────────────
//
// `crates/buzz-core/src/nip10.rs` is the single resolver the relay's ingest and
// ACP's anchoring both call. A marker counts only when tag[0] is "e", the tag
// has at least 4 elements, tag[1] is exactly 64 ASCII-hex, and tag[3] is
// exactly "root" or "reply". Last valid occurrence of each marker wins. Then:
//
//     root + reply  -> (root, reply)      a nested reply names both
//     reply only    -> (reply, reply)     a direct reply to the root
//     root only     -> None               top-level; a lone root never anchors
//     neither       -> None               top-level
//
// Getting any of that wrong puts hive402's idea of a thread out of step with
// the relay's, which is worse than not threading at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { replyAnchor, threadRootOf } from "../src/listener/threads.mjs";
import { Dispatcher } from "../src/listener/dispatch.mjs";
import { Supervisor } from "../src/node/supervisor.mjs";
import { BuzzCli } from "../src/relay/buzzcli.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const ROOT = "a".repeat(64);
const PARENT = "c".repeat(64);

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "@spike hello", tags: [], ...over });

// ── threadRootOf: pure NIP-10, matching buzz_core ────────────────────────────

test("an event with no e tags sits in no thread", () => {
  assert.equal(threadRootOf(msg({ tags: [] })), null);
});

test("a direct reply to the root names only the root", () => {
  assert.equal(threadRootOf(msg({ tags: [["e", ROOT, "", "reply"]] })), ROOT);
});

test("a nested reply names root and parent; the ROOT is the thread", () => {
  assert.equal(
    threadRootOf(msg({ tags: [["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]] })),
    ROOT,
    "AC-50 keeps a human-facing reply flat at layer 1, so the root is the anchor",
  );
});

test("a lone root marker is TOP-LEVEL, not a reply", () => {
  // The one rule that reads backwards and is worth pinning: buzz_core says a
  // lone `root` tag never anchors a reply, and ACP was corrected to match
  // ingest on exactly this point.
  assert.equal(threadRootOf(msg({ tags: [["e", ROOT, "", "root"]] })), null);
});

test("a marker whose id is not 64 hex is ignored, never treated as a thread link", () => {
  for (const bad of ["bad", ROOT.slice(0, 63), `${ROOT}a`, `${ROOT.slice(0, 63)}z`]) {
    assert.equal(threadRootOf(msg({ tags: [["e", bad, "", "reply"]] })), null);
  }
});

test("an e tag with no marker element is ignored", () => {
  assert.equal(threadRootOf(msg({ tags: [["e", ROOT]] })), null);
  assert.equal(threadRootOf(msg({ tags: [["e", ROOT, ""]] })), null);
});

test("an unknown marker word is ignored", () => {
  assert.equal(threadRootOf(msg({ tags: [["e", ROOT, "", "mention"]] })), null);
});

test("the last valid occurrence of a marker wins, as in the relay's single pass", () => {
  assert.equal(
    threadRootOf(msg({ tags: [["e", ROOT, "", "reply"], ["e", PARENT, "", "reply"]] })),
    PARENT,
  );
});

test("threadRootOf survives junk without throwing", () => {
  for (const tags of [null, undefined, [null], [{}], ["e"], [["e"]], [[]]]) {
    assert.doesNotThrow(() => threadRootOf({ id: "x", tags }));
  }
});

// ── replyAnchor: where a reply to THIS event belongs ─────────────────────────

test("a reply to a top-level message anchors on that message", () => {
  // Upstream's own rule for a human-facing top-level mention: "the triggering
  // message is the thread root". The answer attaches to the question.
  assert.equal(replyAnchor(msg({ id: "top", tags: [] })), "top");
});

test("a reply to a threaded message anchors on the thread it is already in", () => {
  assert.equal(replyAnchor(msg({ id: "deep", tags: [["e", ROOT, "", "reply"]] })), ROOT);
});

// ── The dispatcher puts the anchor on the wake ───────────────────────────────

function make({ agents = [spike()], ...rest } = {}) {
  return new Dispatcher({
    nodePubkey: NODE,
    agents,
    turnCap: new TurnCap({ limit: 20 }),
    loopGuard: new LoopGuard(),
    audit: new AuditLog(),
    ...rest,
  });
}
const wakeFor = (effects) => effects.find((e) => e.type === "wake");

test("a threaded trigger produces a threaded wake", () => {
  const wake = wakeFor(make().handle(msg({ id: "q", tags: [["e", ROOT, "", "reply"]] })));
  assert.equal(wake.replyTo, ROOT, "the wake joins the thread the question was asked in");
});

test("a channel-root trigger anchors the wake on the question itself", () => {
  const wake = wakeFor(make().handle(msg({ id: "q", tags: [] })));
  assert.equal(
    wake.replyTo,
    "q",
    "not null: an unanchored wake makes the harness root the agent's reply on the NODE's message",
  );
});

test("a nested trigger anchors on the thread root, not the immediate parent", () => {
  const wake = wakeFor(make().handle(msg({ id: "q", tags: [["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]] })));
  assert.equal(wake.replyTo, ROOT);
});

// ── …and the supervisor actually SENDS it ────────────────────────────────────
//
// This is the half that was missing entirely. `BuzzCli.send` has accepted a
// `replyTo` argument since the identity/gate commit and NOTHING in the product
// ever passed one: a parameter with no caller, which reads as a working feature
// in the diff and is dead on the wire. Threading is only real if the send
// carries it, so the test drives Supervisor.tick and reads the CLI call.

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
      name ? { pubkey: SPIKE, display_name: name } : { pubkey, display_name: "spike" },
  };
}

function harness() {
  const cli = fakeCli();
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-thread-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [{ channel: CHANNEL, agents: [spike()] }],
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
  return { sup, cli };
}

const wakeSent = (cli) => cli.sent.filter((s) => (s.mentions ?? []).includes(SPIKE));

test("the wake the node PUBLISHES carries the thread anchor", async () => {
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ id: "q", pubkey: TAL, tags: [["e", ROOT, "", "reply"]] }));
  await sup.tick();

  assert.equal(wakeSent(cli).length, 1);
  assert.equal(wakeSent(cli)[0].replyTo, ROOT, "replyTo must reach the relay call, not just the effect");
});

test("a channel-root question also produces an anchored wake on the wire", async () => {
  const { sup, cli } = harness();
  await sup.start();
  cli.deliver(msg({ id: "q", pubkey: TAL, tags: [] }));
  await sup.tick();
  assert.equal(wakeSent(cli)[0].replyTo, "q");
});

// ── The CLI wrapper turns it into the flag buzz actually takes ───────────────

test("BuzzCli.send spells replyTo as --reply-to", async () => {
  const calls = [];
  const cli = new BuzzCli({
    binPath: "buzz",
    relayUrl: "ws://localhost:3000",
    privateKey: "aa".repeat(32),
    run: async ({ args }) => {
      calls.push(args);
      return { stdout: "{}", stderr: "", code: 0 };
    },
  });

  await cli.send({ channel: CHANNEL, content: "hi", mentions: [SPIKE], replyTo: ROOT });
  const args = calls[0];
  assert.ok(args.includes("--reply-to"), "buzz messages send takes --reply-to <event id>");
  assert.equal(args[args.indexOf("--reply-to") + 1], ROOT);

  await cli.send({ channel: CHANNEL, content: "hi" });
  assert.ok(!calls[1].includes("--reply-to"), "and omits it entirely when there is nothing to anchor to");
});
