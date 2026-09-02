// Addressing an agent by mention TAG, with no name in the body (AC-6, FIX-109).
//
// Upstream #6315 ("keep agents addressed across messages", buzz @ a2d8be5ef)
// lets Buzz Desktop hold an agent addressed in a channel after the first
// @mention. Subsequent messages then carry the address as a TAG and nothing
// else: `desktop/src/features/messages/lib/agentAddressMention.mjs` builds
// `["mention", <pubkey>, "agent-address"]` alongside the ordinary `p` tag, and
// the body text has no "@name" in it at all.
//
// hive402 resolved addresses out of the BODY TEXT only, so those messages
// addressed nobody as far as the node was concerned. Both halves of that are
// broken, and they break differently:
//
//   • a NON-OWNER's tray-addressed message is discarded by the agent's own
//     inbound allowlist and never relayed by the node either, so the agent is
//     simply silent — which AC-5 forbids;
//   • the OWNER's is delivered by the harness (the `p` tag is the notification
//     mechanism), so a turn STARTS, but the node wrote no authority record for
//     an event it never recognised as an address, so the turn runs contained
//     and an enabled capability does nothing.
//
// The tag rules mirror upstream exactly, because a tag hive402 accepts and
// Buzz rejects (or vice versa) is a second opinion about who was addressed:
// `desktop/src-tauri/src/events/message_tags.rs::mention_reference_tags`
// requires tag[0] == "mention", a pubkey of exactly 64 ASCII-hex characters
// (`check_pubkey`), at most three elements, and — when there are three — the
// third to be exactly "agent-address". It lowercases the pubkey.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { resolveAddressed } from "../src/listener/mentions.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const SPIKE2 = "ccc78ff39f1a7647b91c7e49c10d5441b8086bab1cd2c38daf41908ad3e5b139";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const STRANGER = "b".repeat(64);

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

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });
const wakes = (effects) => effects.filter((e) => e.type === "wake");

// A tray-addressed Desktop message: the p tag delivers, the mention tag says it
// was the composer's standing address, and the body names nobody.
const trayAddressed = (pubkey, over = {}) =>
  msg({
    content: "and what about the second half?",
    tags: [
      ["p", pubkey],
      ["mention", pubkey, "agent-address"],
    ],
    ...over,
  });

// ── The address itself ───────────────────────────────────────────────────────

test("a mention tag with no name in the text IS an address, and wakes the agent", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(trayAddressed(SPIKE));
  assert.equal(wakes(effects).length, 1, "a tray-addressed message must wake the agent it names");
  assert.equal(wakes(effects)[0].agent.name, "spike");
});

test("the two-element form is an address too — the marker is optional", () => {
  // message_tags.rs accepts `["mention", pk]` as well as the 3-element form;
  // only the THIRD element is constrained, and only when it is present.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ content: "go on then", tags: [["mention", SPIKE]] }));
  assert.equal(wakes(effects).length, 1);
});

test("an upper-case pubkey in the tag is the same identity", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ content: "go on then", tags: [["mention", SPIKE.toUpperCase(), "agent-address"]] }),
  );
  assert.equal(wakes(effects).length, 1, "upstream lowercases the pubkey; so must we");
});

test("tag AND text together wake the agent exactly once", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ content: "@spike and what about the second half?", tags: [["mention", SPIKE, "agent-address"]] }),
  );
  assert.equal(wakes(effects).length, 1, "one address, however many ways it was spelled");
});

test("body-text addressing still works with no tags at all", () => {
  const { dispatcher } = make();
  assert.equal(wakes(dispatcher.handle(msg({ content: "@spike hello" }))).length, 1);
});

test("two agents, one tag-addressed and one named, both wake", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(
    msg({ content: "@spike2 what do you make of this?", tags: [["mention", SPIKE, "agent-address"]] }),
  );
  assert.deepEqual(wakes(effects).map((w) => w.agent.name).sort(), ["spike", "spike2"]);
});

// ── Malformed tags are ignored, exactly as upstream ignores them ─────────────

test("a mention tag naming somebody who is not an agent here wakes nothing", () => {
  const { dispatcher } = make();
  assert.deepEqual(wakes(dispatcher.handle(msg({ tags: [["mention", STRANGER]] }))), []);
});

test("a fourth element makes the tag invalid", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ tags: [["mention", SPIKE, "agent-address", "extra"]] }));
  assert.deepEqual(wakes(effects), [], "mention_reference_tags rejects len > 3");
});

test("a third element that is not the marker makes the tag invalid", () => {
  const { dispatcher } = make();
  assert.deepEqual(wakes(dispatcher.handle(msg({ tags: [["mention", SPIKE, "display-name"]] }))), []);
});

test("a pubkey that is not exactly 64 hex characters is not a pubkey", () => {
  const { dispatcher } = make();
  for (const bad of [SPIKE.slice(0, 63), `${SPIKE}a`, `${SPIKE.slice(0, 63)}z`, "", "spike"]) {
    assert.deepEqual(
      wakes(dispatcher.handle(msg({ tags: [["mention", bad]] }))),
      [],
      `"${bad.slice(0, 12)}…" must not resolve — check_pubkey requires 64 ASCII-hex`,
    );
  }
});

test("a tag that is not a mention tag is not an address", () => {
  const { dispatcher } = make();
  // A `p` tag alone has never been an address for the node: it is the relay's
  // delivery mechanism, and reading it as an address is how the node would wake
  // an agent the sender only cc'd.
  assert.deepEqual(wakes(dispatcher.handle(msg({ tags: [["p", SPIKE]] }))), []);
  assert.deepEqual(wakes(dispatcher.handle(msg({ tags: [["e", SPIKE, "", "reply"]] }))), []);
});

test("a one-element mention tag carries no pubkey and is ignored", () => {
  const { dispatcher } = make();
  assert.deepEqual(wakes(dispatcher.handle(msg({ tags: [["mention"]] }))), []);
});

// ── It goes through the POLICY, not just the wake ────────────────────────────

test("a tag-addressed non-owner gets a withheld turn, like any other stranger", () => {
  const { dispatcher } = make();
  const wake = wakes(dispatcher.handle(trayAddressed(SPIKE, { pubkey: TAL })))[0];
  assert.equal(wake.authority.kind, "withhold", "addressing by tag must not skip the authority gate");
  assert.equal(wake.authority.requester, TAL);
});

test("a tag-addressed OWNER gets the grant their turn is entitled to", () => {
  // This is the half that failed SILENTLY before the fix: the p tag delivered
  // the message to the agent, so a turn started, but the node had recognised no
  // address and written no authority record — so the runtime gate found nothing
  // and an owner with `research: true` got a contained turn.
  const { dispatcher } = make({ isAgentRunning: () => true, respondTo: "anyone" });
  const effects = dispatcher.handle(trayAddressed(SPIKE, { pubkey: OWNER }));
  const authority = effects.find((e) => e.type === "authority");
  assert.ok(authority, "the owner's tray-addressed turn must still get a record");
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"]);
});

test("an agent's own mention tag cannot wake the agent that sent it", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(msg({ pubkey: SPIKE, tags: [["mention", SPIKE, "agent-address"]] }));
  assert.deepEqual(wakes(effects), [], "an agent cannot wake itself, by tag any more than by name");
});

test("an agent may address another agent by tag, still bounded by the loop guard", () => {
  // AC-24's budget is ONE EXCHANGE per pair — two messages, direction
  // insensitive (A→B then B→A) — and the third is blocked until a human
  // speaks. Addressing by tag must be inside that budget, not beside it.
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const byTag = (id) => msg({ id, pubkey: SPIKE2, tags: [["mention", SPIKE, "agent-address"]] });

  const first = dispatcher.handle(byTag("a1"));
  assert.equal(wakes(first).length, 1);
  assert.equal(wakes(first)[0].authority.kind, "withhold", "an agent is nobody's owner");

  assert.equal(wakes(dispatcher.handle(byTag("a2"))).length, 1, "the pair's second message is its last");
  assert.deepEqual(wakes(dispatcher.handle(byTag("a3"))), [], "the third is blocked until a human speaks");

  dispatcher.handle(msg({ id: "h1", pubkey: TAL, content: "carry on" }));
  assert.equal(wakes(dispatcher.handle(byTag("a4"))).length, 1, "a human speaking restores the budget");
});

// ── The resolver itself ──────────────────────────────────────────────────────

test("resolveAddressed unions text and tags without duplicating", () => {
  const agents = [spike(), spike({ name: "spike2", pubkey: SPIKE2 })];
  assert.deepEqual(
    resolveAddressed({
      content: "@spike @spike2 both of you",
      tags: [["mention", SPIKE, "agent-address"]],
      agents,
    }).sort(),
    [SPIKE, SPIKE2].sort(),
  );
});

test("resolveAddressed tolerates junk tags without throwing", () => {
  const agents = [spike()];
  for (const tags of [null, undefined, [null], [["mention", null]], ["mention", SPIKE], [[]], [{}]]) {
    assert.doesNotThrow(() => resolveAddressed({ content: "", tags, agents }));
  }
});
