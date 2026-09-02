// FIX-133 and FIX-134 — the two things Tal's first conversation exposed.
//
// Tal talked to smith successfully (AC-2, AC-33, proven for the first time). Two
// things around that exchange were wrong, and Barry named both.
//
// ── FIX-133: he addressed the HIVE and nothing answered ────────────────────
//
// "Barry's Hive" is in Tal's @ picker, so he wrote to it. Nothing came back: the
// node resolves addresses against its AGENTS and is not one of them, so the
// message matched nobody and produced no effects at all.
//
// The node cannot be hidden from that picker. It publishes a profile because it
// must — it is a channel member in its own right, and that membership is what
// lets it post the wakes every relayed message depends on. A member with a name
// is a member people can address. So it answers instead, and points at the
// agents.
//
// ── FIX-134: the node's notices landed in the channel root ─────────────────
//
// smith answered in the thread, correctly, because the wake carries `replyTo`
// and the harness anchors the reply to it. The node's refusal about the same
// exchange went to the channel root — out of context, beside nothing it referred
// to. No `say` effect had ever carried a thread anchor: not refusals, not
// turn-cap notices, not approval prompts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";

const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const OWNER = "800fab4de18646769377f4d74ee0ff214dc920c61a6f370e13f6b835d76e3e9c";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const AGENT = "0b618cc992e438a84791d4a830471f83f94308d89d52489485964dc14deb6acd";
const ROOT = "a".repeat(64);

const smith = {
  name: "smith",
  pubkey: AGENT,
  ownerPubkey: OWNER,
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
};

const dispatcher = ({ agents = [smith] } = {}) =>
  new Dispatcher({
    nodePubkey: NODE,
    agents,
    turnCap: { check: () => ({ allowed: true }), record: () => {} },
    loopGuard: { humanSpoke: () => {}, allow: () => ({ allowed: true }) },
    audit: { action: () => {}, refusal: () => {} },
    isAgentRunning: () => false,
    respondTo: "allowlist",
    respondToAllowlist: [NODE],
  });

const msg = (over = {}) => ({
  id: "m1",
  kind: 9,
  pubkey: TAL,
  created_at: Math.floor(Date.now() / 1000),
  content: "hello",
  tags: [],
  ...over,
});

const says = (effects) => effects.filter((e) => e.type === "say");

// ── FIX-133: the node answers for itself ──────────────────────────────────

test("addressing the HIVE gets an answer, not silence", () => {
  const effects = dispatcher().handle(msg({ content: "hello", tags: [["p", NODE]] }));
  const [said] = says(effects);
  assert.ok(said, "the node must not ignore somebody talking to it");
  assert.match(said.content, /not somebody to talk to/i);
});

test("and it names the agents, so the reader knows who to ask", () => {
  const [said] = says(dispatcher().handle(msg({ tags: [["p", NODE]] })));
  assert.match(said.content, /@smith/, "the point of the reply is the redirection");
});

test("it is addressed to whoever asked", () => {
  const [said] = says(dispatcher().handle(msg({ tags: [["p", NODE]] })));
  assert.deepEqual(said.mentions, [TAL]);
});

test("a channel with no agents says THAT rather than naming nobody", () => {
  const [said] = says(dispatcher({ agents: [] }).handle(msg({ tags: [["p", NODE]] })));
  assert.match(said.content, /no agent is set up/i);
  assert.doesNotMatch(said.content, /Ask an agent instead: \./, "never a dangling empty list");
});

test("addressing the node AND an agent wakes the agent, with no lecture", () => {
  // The redirection exists for a message that reached nobody. A message that
  // reached an agent is not that, and adding a notice would be the routine
  // chatter AC-5 forbids.
  const effects = dispatcher().handle(
    msg({ content: "@smith can you help", tags: [["p", NODE], ["p", AGENT]] }),
  );
  assert.equal(says(effects).length, 0, `no notice: ${JSON.stringify(says(effects))}`);
  assert.ok(effects.some((e) => e.type === "wake"), "and the agent is still woken");
});

test("a message addressing NOBODY is still silent", () => {
  // Two people talking to each other must not be interrupted by the node.
  assert.deepEqual(dispatcher().handle(msg({ content: "morning all" })), []);
});

test("the node never answers its own messages", () => {
  // Its own wakes carry the node's p-tag; answering them would be a loop.
  assert.deepEqual(dispatcher().handle(msg({ pubkey: NODE, tags: [["p", NODE]] })), []);
});

// ── FIX-134: notices land in the thread ───────────────────────────────────

test("a node notice is anchored to the thread it is about", () => {
  const [said] = says(
    dispatcher().handle(msg({ tags: [["p", NODE], ["e", ROOT, "", "reply"]] })),
  );
  assert.equal(said.replyTo, ROOT, "a notice at the channel root is out of context");
});

test("a notice about a top-level message anchors to that message", () => {
  // Barry's complaint was the split: smith answered in the thread while the
  // node's refusal shouted in the main channel. A top-level question starts its
  // own thread, and the notice belongs in it.
  const [said] = says(dispatcher().handle(msg({ id: "asked", tags: [["p", NODE]] })));
  assert.equal(said.replyTo, "asked");
});

test("EVERY say carries an anchor field, so a new notice cannot forget one", () => {
  // The anchor is set once per handled message rather than passed in at each
  // call site. This asserts the property that makes that safe.
  for (const e of says(dispatcher().handle(msg({ tags: [["p", NODE]] })))) {
    assert.ok("replyTo" in e, `a say without replyTo lands at the channel root: ${e.content}`);
  }
});
