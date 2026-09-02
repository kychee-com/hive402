import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const SPIKE2 = "ccc78ff39f1a7647b91c7e49c10d5441b8086bab1cd2c38daf41908ad3e5b139";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

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

function make({ agents = [spike()], turnCap, ...rest } = {}) {
  const audit = new AuditLog();
  return {
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: turnCap ?? new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      ...rest,
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });

const wakes = (effects) => effects.filter((e) => e.type === "wake");
const says = (effects) => effects.filter((e) => e.type === "say");
const said = (effects) => says(effects).map((e) => e.content).join(" ");

// What the runtime gate writes when it refuses a tool call, and the node turns
// into either an AC-17 refusal or an AC-14 approval request.
//
// Since DD-26 this is the ONLY thing that parks a proposal. It used to be
// possible to park one from a message's wording, which is what F-013 killed:
// the same reading that recognised "please deploy the app" also recognised
// "what did you deploy yesterday, conceptually?" and refused to talk.
const refusedCall = (over = {}) => ({
  id: `b-${Math.random().toString(36).slice(2, 8)}`,
  agent: "spike",
  capability: "research",
  detail: "WebFetch https://wttr.in/Paris",
  requester: TAL,
  at: Date.now(),
  ...over,
});

// --- the self-wake hole found while validating cycle 1 ---------------------

test("the node never wakes anything on its own wake events", () => {
  // REGRESSION: a wake message quotes the text that triggered it, so its
  // "@spike" resolves all over again. Nothing but an incidental already-tagged
  // filter stood between that and an unbounded wake storm. The node must ignore
  // its own authorship outright.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: NODE, content: "relaying to @spike: hello" }));
  assert.deepEqual(effects, []);
});

test("an agent's message never wakes an agent it did not address", () => {
  // AC-25, read exactly: "an UN-ADDRESSED agent is never woken by another
  // agent's message (agent-authored messages never trigger relevance wakes)".
  //
  // Cycle 1 implemented this by dropping every agent-authored event, which is
  // stricter than AC-25 and made AC-24's first clause — "an agent may address
  // another agent, and the addressed agent may post one reply" — impossible:
  // the addressed agent posted zero replies, never one, and the loop guard's
  // `allow()` had no caller at all. Fixed in cycle 3; see the AC-24 block below
  // for the bounded exchange this now permits.
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(msg({ pubkey: SPIKE, content: "just musing about the weather" }));
  assert.equal(wakes(effects).length, 0);
});

// --- addressing ------------------------------------------------------------

test("an unaddressed human message wakes nobody", () => {
  // AC-6
  const { dispatcher } = make();
  assert.equal(wakes(dispatcher.handle(msg({ content: "just thinking out loud" }))).length, 0);
});

test("a non-owner addressing an agent by name wakes it", () => {
  // AC-5 / AC-7 — the product's core claim.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: TAL, content: "@spike hello" }));
  assert.equal(wakes(effects).length, 1);
  assert.equal(wakes(effects)[0].agent.name, "spike");
});

test("@Name is matched case-insensitively", () => {
  const { dispatcher } = make();
  assert.equal(wakes(dispatcher.handle(msg({ content: "@SPIKE hello" }))).length, 1);
});

test("the owner's own p-tagged mention is not relayed — the harness already delivered it", () => {
  // The owner is on the agent's inbound gate, so the relay's delivery woke the
  // agent directly. Relaying again would dispatch the same turn twice.
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ pubkey: OWNER, content: "@spike hello", tags: [["p", SPIKE]] }),
  );
  assert.equal(wakes(effects).length, 0);
});

// REGRESSION (found live, 2026-08-15): "the harness already delivered it" was
// implemented by skipping the message ENTIRELY, which silently disabled every
// node-side policy for the one person most likely to use it. The owner's
// "/audit" went unanswered and a capability refusal was never posted. Only the
// WAKE is redundant on a directly-delivered message — the policy is not.
test("the owner's chat-native audit query is still answered when delivered directly", () => {
  const { dispatcher } = make();
  dispatcher.handleBlockedAction(refusedCall({ capability: "research" }));
  const effects = dispatcher.handle(
    msg({ id: "e9", pubkey: OWNER, content: "@spike /audit", tags: [["p", SPIKE]] }),
  );
  assert.equal(wakes(effects).length, 0, "no wake — the agent already has it");
  assert.match(said(effects), /research/i, "but the node must still answer from the record");
});

test("a directly-delivered owner message still gets policy — and that policy is a grant, not a refusal", () => {
  // REGRESSION (F-013). This test used to assert the opposite: that the node
  // answered the owner with `cannot do that: capability "build" is disabled`
  // whenever their sentence contained "deploy". It was posted for ordinary
  // conversation too — "what did you deploy yesterday, conceptually?" — and the
  // agent never ran.
  //
  // The half worth keeping is that the direct path is not policy-free: the
  // owner's turn still gets an authority record, and AC-17 lives IN it, because
  // a disabled capability is never granted (see the runtime refusal in
  // f013-conversation.test.mjs for the other half).
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  const effects = dispatcher.handle(
    msg({ pubkey: OWNER, content: "@spike deploy the app", tags: [["p", SPIKE]] }),
  );
  assert.equal(says(effects).length, 0, "the node must not answer in the agent's place");
  const authority = effects.find((e) => e.type === "authority");
  assert.equal(authority.kind, "grant");
  assert.ok(!authority.capabilities.includes("build"), "AC-17: a disabled capability is never granted");
});

test("a directly-delivered turn still counts against the cap", () => {
  // Otherwise the owner's own turns are invisible to the fuse and the budget is
  // wrong by exactly the traffic that matters most — which is what F-011 was.
  //
  // The COUNTING moved to the runtime in fix cycle 3 (DD-23), because that is
  // the only place an owner-direct turn is visible at all; see
  // turncap-runtime.test.mjs for the counter itself. What the node still owes
  // the room is an honest answer to "/turns", and it must come from the same
  // ledger the fuse uses rather than a second tally of its own.
  let used = 1; // the runtime has recorded the owner's direct turn
  const { dispatcher } = make({ turnCap: new TurnCap({ limit: 20, ledger: { used: () => used } }) });
  const effects = dispatcher.handle(msg({ id: "e2", pubkey: TAL, content: "@spike /turns" }));
  assert.match(said(effects), /19/, `/turns must report the runtime's count: ${said(effects)}`);
});

test("a non-owner's p-tagged mention IS relayed — the harness dropped it", () => {
  // This is the consequence of fixing F-001. Now that the relay resolves
  // "@spike" to a pubkey, a non-owner's message arrives p-tagged. If the agent
  // accepted it directly, the authority gate could never run — cycle 1's F-003
  // exactly. So the agent's inbound gate admits only the owner and this node,
  // and a p-tag from anyone else is a message the harness DISCARDED. The node
  // must relay it (after gating), not treat it as already delivered.
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ pubkey: TAL, content: "@spike hello", tags: [["p", SPIKE]] }),
  );
  assert.equal(wakes(effects).length, 1);
});

// --- the authority gate (F-003) -------------------------------------------

test("a non-owner's action request runs contained, and the owner is asked when it is attempted", () => {
  // AC-14. Cycle 1: this exact message executed immediately with no approval.
  // Cycle 2 parked it from the wording; F-013 showed what reading wording costs,
  // so the ask now follows the attempt (DD-26). The security property is
  // unchanged and the enforcement is stronger: the turn is contained BEFORE the
  // agent runs, and the approval names the exact call (DD-21).
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ pubkey: TAL, content: "@spike can you go research the weather in Paris?" }),
  );
  assert.equal(wakes(effects).length, 1, "the agent is woken — it was spoken to");
  assert.equal(wakes(effects)[0].authority.kind, "withhold", "but it may not act");
  assert.equal(says(effects).length, 0, "nothing has been attempted, so nothing to approve yet");

  const ask = dispatcher.handleBlockedAction(refusedCall());
  assert.match(said(ask), /approval|approve h4-/i);
  const proposal = says(ask).find((s) => /approve h4-/.test(s.content));
  assert.ok(proposal.mentions.includes(OWNER), "the owner must be the one asked (AC-67 adds the requester notice beside it)");
});

test("the owner asking their own agent acts immediately, with no approval round-trip", () => {
  // AC-16
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ pubkey: OWNER, content: "@spike research the weather in Paris" }),
  );
  assert.equal(wakes(effects).length, 1);
  assert.equal(says(effects).length, 0);
});

test("a non-owner may still converse freely with the agent", () => {
  // AC-12: conversation is always free. Gating chat would break AC-5/AC-7.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: TAL, content: "@spike what do you think?" }));
  assert.equal(wakes(effects).length, 1);
});

test("the owner's approval releases the parked request and wakes the agent", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e1", pubkey: TAL, content: "@spike research the weather in Paris" }));
  const ask = dispatcher.handleBlockedAction(refusedCall());
  const token = said(ask).match(/h4-[a-z0-9]+/)?.[0];
  assert.ok(token, `expected an approval token in: ${said(ask)}`);

  const effects = dispatcher.handle(msg({ id: "e2", pubkey: OWNER, content: `approve ${token}` }));
  assert.equal(wakes(effects).length, 1);
  assert.equal(wakes(effects)[0].agent.name, "spike");
});

test("a non-owner cannot approve a request made to someone else's agent", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e1", pubkey: TAL, content: "@spike research the weather in Paris" }));
  const token = said(dispatcher.handleBlockedAction(refusedCall())).match(/h4-[a-z0-9]+/)[0];

  // The requester tries to approve their own request.
  const effects = dispatcher.handle(msg({ id: "e2", pubkey: TAL, content: `approve ${token}` }));
  assert.equal(wakes(effects).length, 0);
});

test("the owner can deny a parked request, and it cannot then be approved", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e1", pubkey: TAL, content: "@spike research Paris" }));
  const token = said(dispatcher.handleBlockedAction(refusedCall())).match(/h4-[a-z0-9]+/)[0];

  dispatcher.handle(msg({ id: "e2", pubkey: OWNER, content: `deny ${token}` }));
  const late = dispatcher.handle(msg({ id: "e3", pubkey: OWNER, content: `approve ${token}` }));
  assert.equal(wakes(late).length, 0);
});

// --- capability enforcement (AC-17) ---------------------------------------

test("a capability-disabled action is refused outright, with no approval offered", () => {
  // AC-17: refused EVEN WHEN asked or approved. Offering the owner an approval
  // for something the agent cannot do would be a lie.
  //
  // The refusal is raised where the action is — the tool boundary — rather than
  // from the shape of a sentence (DD-26). What the room sees is the same
  // refusal; what changed is that it can no longer fire on a sentence that
  // merely CONTAINS "deploy", which is F-013.
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  const effects = dispatcher.handleBlockedAction(
    refusedCall({ capability: "build", detail: "Bash: npm run deploy" }),
  );
  assert.match(said(effects), /build.*switched off|switched off.*build/i);
  assert.doesNotMatch(said(effects), /h4-[a-z0-9]+/, "must not offer an approval token");
});

test("the owner is refused a disabled capability just like anyone else", () => {
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  const asked = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike deploy the app" }));
  assert.ok(
    !wakes(asked)[0].authority.capabilities.includes("build"),
    "the owner's own turn cannot carry a capability its owner switched off",
  );
  const refusal = dispatcher.handleBlockedAction(
    refusedCall({ capability: "build", requester: OWNER, detail: "Bash: npm run deploy" }),
  );
  assert.match(said(refusal), /switched off/i);
  assert.doesNotMatch(said(refusal), /h4-[a-z0-9]+/);
});

// --- the fuse (AC-26) ------------------------------------------------------

test("when the runtime pauses an agent, the room is told once", () => {
  // AC-26's visible notice. The BLOCK now happens in the runtime (DD-23) — the
  // node cannot make that decision, because the turns it cannot see are exactly
  // the ones F-011 was about. So the runtime leaves a pause record and the node
  // reports it.
  //
  // FOUND BY RUNNING IT (2026-08-16): while the node ALSO decided this, it read
  // the ledger just after the runtime had counted a turn, announced a pause for
  // the turn about to be answered, and suppressed that turn's wake. Two judges,
  // one fuse, contradictory answers. Now there is one.
  const atCap = { limit: 2, windowMs: 3600000, agent: "spike" };
  const { dispatcher } = make({ turnCap: new TurnCap({ limit: 2, ledger: { used: () => 2 } }) });

  const first = dispatcher.announcePause(atCap);
  assert.equal(first.length, 1);
  assert.match(first[0].content, /limit|paus/i);

  const second = dispatcher.announcePause(atCap);
  assert.equal(second.length, 0, "the pause notice is posted once, not per refused turn");
});

test("a pause record for an agent this node does not host is ignored", () => {
  const { dispatcher } = make({ turnCap: new TurnCap({ limit: 2, ledger: { used: () => 2 } }) });
  assert.deepEqual(dispatcher.announcePause({ agent: "someone-else", limit: 2 }), []);
});

// --- chat-native queries (AC-27) ------------------------------------------

test("the audit log is queryable from chat, answered by the node itself", () => {
  // AC-27. Cycle 1 got a narrative the agent explicitly labelled as its own
  // reconstruction — "there is no formal audit-log command". The node answers
  // from the real record, and spends no model turn doing it.
  const { dispatcher } = make();
  dispatcher.handleBlockedAction(refusedCall({ capability: "research" }));

  const effects = dispatcher.handle(msg({ id: "b", pubkey: OWNER, content: "@spike /audit" }));
  assert.equal(wakes(effects).length, 0, "a log query must not cost a model turn");
  assert.match(said(effects), /research/i);
});

test("the turn budget is queryable from chat", () => {
  const { dispatcher } = make({ turnCap: new TurnCap({ limit: 20 }) });
  const effects = dispatcher.handle(msg({ content: "@spike /turns" }));
  assert.equal(wakes(effects).length, 0);
  assert.match(said(effects), /20/);
});

// --- audit coverage --------------------------------------------------------

test("every containment decision lands in the audit log", () => {
  // AC-27 records ACTIONS, and since DD-26 the node learns about an action the
  // same way the room does: the runtime refused one. A wake is not an action,
  // so the thing to check is that a contained call is recorded — which is also
  // DD-16's point, that the detector and the log must not share a failure.
  const { dispatcher, audit } = make();
  dispatcher.handleBlockedAction(refusedCall({ capability: "research" }));
  const rows = audit.query({});
  assert.ok(rows.length > 0);
  assert.ok(rows.some((r) => r.type === "action" && /contained/.test(r.detail ?? "")));
});

test("an approval is recorded with who granted it", () => {
  const { dispatcher, audit } = make();
  dispatcher.handle(msg({ id: "e1", pubkey: TAL, content: "@spike research Paris" }));
  const ask = dispatcher.handleBlockedAction(refusedCall());
  const token = said(ask).match(/h4-[a-z0-9]+/)[0];
  dispatcher.handle(msg({ id: "e2", pubkey: OWNER, content: `approve ${token}` }));

  const approvals = audit.query({ type: "approval" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].granted, true);
});

// ── AC-24: an agent may address another, and get exactly one reply ─────────
//
// The loop guard's `allow()` had no caller. Every agent-authored event was
// dropped before any wake path, so the bounded-ness AC-24 describes was true
// only vacuously: the addressed agent posted zero replies, never one. Cycle 3
// could not tell the difference, because F-010 had spike2 mute anyway — the
// Red Team said so and asked for it to be made exercisable.
//
// AC-25 is unchanged and is what keeps this narrow: only an EXPLICIT mention
// wakes an agent. An agent's message never triggers a relevance wake.

test("an agent explicitly addressing another agent wakes it", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(msg({ id: "a1", pubkey: SPIKE2, content: "@spike morning!" }));
  assert.equal(wakes(effects).length, 1);
  assert.equal(wakes(effects)[0].agent.name, "spike");
});

test("a turn triggered by an agent carries no capability — an agent is nobody's owner", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(msg({ id: "a1", pubkey: SPIKE2, content: "@spike can you fetch the BTC price?" }));
  const authority = wakes(effects)[0].authority;
  assert.equal(authority.kind, "withhold");
});

test("AC-24: the exchange is bounded — one reply, then silence until a human speaks", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  // spike2 -> spike, then spike -> spike2. That is the one exchange.
  assert.equal(wakes(dispatcher.handle(msg({ id: "a1", pubkey: SPIKE2, content: "@spike hello" }))).length, 1);
  assert.equal(wakes(dispatcher.handle(msg({ id: "a2", pubkey: SPIKE, content: "@spike2 hello back" }))).length, 1);

  const third = dispatcher.handle(msg({ id: "a3", pubkey: SPIKE2, content: "@spike and another thing" }));
  assert.equal(wakes(third).length, 0, "the pair's budget is spent");
});

test("AC-24: a human speaking gives the pair its budget back", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  dispatcher.handle(msg({ id: "a1", pubkey: SPIKE2, content: "@spike hello" }));
  dispatcher.handle(msg({ id: "a2", pubkey: SPIKE, content: "@spike2 hello back" }));
  assert.equal(wakes(dispatcher.handle(msg({ id: "a3", pubkey: SPIKE2, content: "@spike again" }))).length, 0);

  dispatcher.handle(msg({ id: "h1", pubkey: OWNER, content: "carry on you two" }));
  assert.equal(
    wakes(dispatcher.handle(msg({ id: "a4", pubkey: SPIKE2, content: "@spike again" }))).length,
    1,
    "a person is in the conversation again",
  );
});

test("AC-25: an agent's message never wakes an agent it did not address", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  const effects = dispatcher.handle(msg({ id: "a1", pubkey: SPIKE2, content: "thinking out loud about spike stuff" }));
  assert.equal(wakes(effects).length, 0);
});

test("an agent cannot wake itself", () => {
  const { dispatcher } = make({ agents: [spike(), spike({ name: "spike2", pubkey: SPIKE2 })] });
  assert.equal(wakes(dispatcher.handle(msg({ id: "a1", pubkey: SPIKE, content: "@spike note to self" }))).length, 0);
});
