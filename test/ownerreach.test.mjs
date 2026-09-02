// FIX-131 — the owner could not talk to their own agent while it was RUNNING.
//
// ── What Barry saw ─────────────────────────────────────────────────────────
//
// He wrote `@smith heya - you there?` in his own room, with smith alive, the
// node running, the model backend working and `doctor` fully green. Nothing
// happened. No reply, and no wake in the thread either — the node never relayed
// it at all.
//
// It had worked earlier the same day. The difference was that smith had been
// IDLE-EXITED then, and was RUNNING now.
//
// ── Two components, two ideas of "owner" ───────────────────────────────────
//
// The node suppresses its wake when the harness would have delivered the
// message itself. `#reachesDirectly` decided that with:
//
//     authorPubkey === agent.ownerPubkey || allowlist.has(authorPubkey)
//
// and the comment "the owner is always implicitly on the allowlist (harness
// behaviour)". That is TRUE of buzz-acp — at buzz origin/main:
//
//     RespondTo::Allowlist => allowlist.contains(author)
//                             || is_owner_or_sibling(author, …).await
//
// but its owner is resolved from BUZZ_AUTH_TAG, and since FIX-117 the tag is
// signed by the NODE. smith's own log says so:
//
//     owner resolved from BUZZ_AUTH_TAG: bead5b81…   (the node)
//     agent owner: bead5b81…                          (not Barry, 800fab4d…)
//
// So the harness's owner is the node, while hive402 kept comparing against the
// HUMAN in the config. Barry was neither in the allowlist (which holds only the
// node) nor the harness's owner, so:
//
//     node    "he is the owner, the harness has it"   → no wake
//     harness "he is neither owner nor allowlisted"   → dropped
//
// Both let go of the same message. The owner could not reach their own agent,
// and only while it was healthy enough to be running.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { inboundGateFor } from "../src/launcher/env.mjs";

const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const OWNER = "800fab4de18646769377f4d74ee0ff214dc920c61a6f370e13f6b835d76e3e9c";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const AGENT = "0b618cc992e438a84791d4a830471f83f94308d89d52489485964dc14deb6acd";

const agent = {
  name: "smith",
  pubkey: AGENT,
  ownerPubkey: OWNER,
  research: true,
  build: false,
  crossOwnerAsks: "owner-approves",
  selfInitiated: "asks-owner",
  replyMode: "addressed-only",
};

// The dispatcher exactly as the supervisor builds it, and the agent RUNNING —
// the state the bug needed.
function dispatcher({ running = true } = {}) {
  return new Dispatcher({
    nodePubkey: NODE,
    agents: [agent],
    turnCap: { check: () => ({ allowed: true }), record: () => {} },
    loopGuard: { humanSpoke: () => {}, allow: () => ({ allowed: true }) },
    audit: { action: () => {}, refusal: () => {} },
    isAgentRunning: () => running,
    respondTo: "allowlist",
    respondToAllowlist: [NODE],
  });
}

const asked = (pubkey) => ({
  id: "q1",
  kind: 9,
  pubkey,
  created_at: Math.floor(Date.now() / 1000),
  content: "@smith heya - you there?",
  // The `p` tag a real client puts on a resolved @mention. Without it the
  // message is not "already tagged" and the bug does not arise.
  tags: [["p", AGENT]],
});

// The effect that actually puts the message in front of the agent. Everything
// else the dispatcher emits — the authority record, the audit line — happens
// either way, which is why "did it emit anything" is not the question.
const wakes = (effects) => effects.filter((e) => e.type === "wake");

// THE INVARIANT. The bug was not that one side was wrong — it was that the two
// sides ANSWERED DIFFERENTLY, and every message they disagreed about fell down
// the gap between them. Neither "always relay" nor "never relay" is the fix;
// agreeing is.
test("THE BUG: the node and the harness agree about who reaches the agent", () => {
  const gate = inboundGateFor({ agent, nodePubkey: NODE });
  const d = dispatcher({ running: true });

  for (const [who, label] of [
    [OWNER, "the owner"],
    [TAL, "a non-owner"],
    [NODE, "the node"],
  ]) {
    // What the harness will do with this author, from the gate the node
    // launches it with.
    const harnessAccepts = gate.respondTo === "anyone" || gate.respondToAllowlist.includes(who);
    // What the node BELIEVES the harness will do: it relays exactly when it
    // thinks the harness will not.
    const nodeRelays = wakes(d.handle(asked(who))).length > 0;

    if (who === NODE) continue; // the node never relays its own messages at all
    assert.equal(
      nodeRelays,
      !harnessAccepts,
      `${label}: harness ${harnessAccepts ? "accepts" : "drops"} but the node ` +
        `${nodeRelays ? "relays" : "stays silent"} — that gap is where Barry's message went`,
    );
  }
});

test("the owner is NAMED on the gate, not left implicit", () => {
  // It used to be `[nodePubkey]` alone, relying on buzz-acp admitting its own
  // owner. That owner is resolved from BUZZ_AUTH_TAG, which the NODE has signed
  // since FIX-117 — measured on Barry's machine, where the harness logs
  // `owner resolved from BUZZ_AUTH_TAG: bead5b81…` (the node) against a config
  // ownerPubkey of `800fab4d…` (Barry). The human stopped being admitted and
  // nothing said so.
  const gate = inboundGateFor({ agent, nodePubkey: NODE });
  assert.equal(gate.respondTo, "allowlist");
  assert.ok(gate.respondToAllowlist.includes(OWNER), "the owner must be named, not assumed");
  assert.ok(gate.respondToAllowlist.includes(NODE), "and the node, which publishes every relay");
  assert.equal(gate.respondToAllowlist.includes(TAL), false, "and nobody else");
});

test("the OWNER's message to a running agent is delivered by the harness, so not relayed", () => {
  // The behaviour the tests written before FIX-117 describe, restored: no
  // redundant wake, and the room stays quiet for the owner's own messages.
  assert.equal(wakes(dispatcher({ running: true }).handle(asked(OWNER))).length, 0);
});

test("an agent with no owner still gets a usable gate", () => {
  // `.filter(Boolean)`: a config without an ownerPubkey must not put `undefined`
  // on an allowlist the harness parses.
  const orphan = { ...agent, ownerPubkey: undefined };
  assert.deepEqual(inboundGateFor({ agent: orphan, nodePubkey: NODE }).respondToAllowlist, [NODE]);
});

test("a non-owner's message to a running agent is relayed too, as it always was", () => {
  assert.equal(wakes(dispatcher({ running: true }).handle(asked(TAL))).length, 1);
});

test("an idle-exited agent is still relayed to, which is what used to mask this", () => {
  // The path that worked all along: with the agent down, `deliveredDirectly` is
  // false whatever it thinks about the author, so the wake went out and Barry
  // got his answer. That is why this looked intermittent rather than broken.
  assert.equal(wakes(dispatcher({ running: false }).handle(asked(OWNER))).length, 1);
});

test("the NODE's own messages are still never relayed back to it", () => {
  // The one author that genuinely does reach the agent directly, and the guard
  // that stops the node answering itself.
  assert.deepEqual(dispatcher({ running: true }).handle(asked(NODE)), []);
});

test("respondTo 'anyone' still suppresses the wake for a running agent", () => {
  // `crossOwnerAsks: auto-allow` opens the harness to everybody, and then the
  // harness really does deliver directly. Relaying as well would double every
  // message — the duplicate class this whole area guards against.
  const open = new Dispatcher({
    nodePubkey: NODE,
    agents: [agent],
    turnCap: { check: () => ({ allowed: true }), record: () => {} },
    loopGuard: { humanSpoke: () => {}, allow: () => ({ allowed: true }) },
    audit: { action: () => {}, refusal: () => {} },
    isAgentRunning: () => true,
    respondTo: "anyone",
  });
  assert.equal(wakes(open.handle(asked(OWNER))).length, 0, "with an open harness the node must not relay as well");
});
