// Per-turn capability containment on the node side (DD-15/DD-16, fix cycle 2).
//
// F-007: as a non-owner, a request phrased around the verb lexicon reached
// spike ungated and produced a live web fetch, with no approval and no audit
// entry. The lexicon is not fixable — natural language is an open set. So the
// node stops trying to tell an action request from conversation and instead
// states, before every wake it publishes, what THIS turn may do. A non-owner's
// turn may do nothing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
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
const wakes = (fx) => fx.filter((e) => e.type === "wake");
const says = (fx) => fx.filter((e) => e.type === "say");
const said = (fx) => says(fx).map((e) => e.content).join(" ");
// Authority reaches the supervisor two ways, and which one is used says WHICH
// EVENT the turn it authorises will be triggered by (DD-20, fix cycle 3):
//   • a standalone `authority` effect — the harness delivered the message
//     directly, so the trigger is that message and its id is known now;
//   • riding on a `wake` effect — the node is about to publish the wake, and
//     the trigger will be that wake's own event, whose id does not exist until
//     it has been sent.
const grants = (fx) =>
  fx.flatMap((e) => {
    if (e.type === "authority") return [e];
    if (e.type === "wake" && e.authority) return [{ ...e.authority, viaWake: true }];
    return [];
  });

// The verbatim F-007 message. It contains none of the lexicon's verbs.
const F007 =
  "@spike random one for you, no pressure either way - what's the top story " +
  "headline on Hacker News' front page at this moment?";

test("a non-owner's conversational wake is preceded by an explicit withhold", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  // The lexicon still reads this as conversation — that is exactly the point.
  assert.equal(wakes(effects).length, 1, "conversation stays free: the agent is still woken");
  const g = grants(effects);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "withhold", "a non-owner's turn must carry no capability");
  assert.equal(g[0].agent.name, "spike");
});

test("a node-published wake carries its own authority, so it can be keyed to that wake", () => {
  // Cycle 2 guaranteed this by ORDERING: write the withhold first, publish the
  // wake second, so the agent could not reach a tool while a previous turn's
  // grant was still on disk. That guarantee was only ever as good as there
  // being one turn at a time, and F-009 showed there is not.
  //
  // Keying replaces ordering. The authority now travels WITH the wake, because
  // the turn it authorises will be triggered by that wake's own event — an id
  // that does not exist until the wake has been sent. A turn cannot reach an
  // authority written for a different event no matter what order they land in,
  // and a turn whose authority is not written yet waits rather than proceeding.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: TAL, content: "@spike what's up?" }));

  const wake = wakes(effects)[0];
  assert.ok(wake, "the agent is still woken");
  assert.ok(wake.authority, "the wake must carry the authority for the turn it will trigger");
  assert.equal(wake.authority.kind, "withhold");
  assert.equal(
    effects.some((e) => e.type === "authority"),
    false,
    "a relayed wake must NOT also write a free-standing record — that record would be keyed to the wrong event",
  );
});

test("a directly-delivered message names the event its turn will be triggered by", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(
    msg({ id: "owner-event-id", pubkey: OWNER, content: "@spike hello", tags: [["p", SPIKE]] }),
  );
  const authority = effects.find((e) => e.type === "authority");
  assert.ok(authority, "the harness delivered it, so the trigger is the message itself");
  assert.equal(authority.eventId, "owner-event-id");
  assert.equal(authority.kind, "grant");
});

test("two messages 40ms apart produce two authorities, for two different events", () => {
  // F-009's exact shape at the node level: the owner and a non-owner addressing
  // the same agent inside one poll. Before DD-20 these were two writes to one
  // file and the second erased the first.
  const { dispatcher } = make();
  const fromOwner = dispatcher.handle(
    msg({ id: "owner-event-id", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", SPIKE]] }),
  );
  const fromTal = dispatcher.handle(msg({ id: "tal-event-id", pubkey: TAL, content: "@spike check lobste.rs" }));

  const ownerAuthority = fromOwner.find((e) => e.type === "authority");
  assert.equal(ownerAuthority.kind, "grant");
  assert.equal(ownerAuthority.eventId, "owner-event-id");

  // tal's own message never carries authority: it was dropped by the harness,
  // and the turn it eventually causes is triggered by the node's wake instead.
  assert.equal(fromTal.some((e) => e.type === "authority"), false);
  assert.equal(wakes(fromTal)[0].authority.kind, "withhold");
});

test("the owner's own message grants that agent's enabled capabilities — AC-16, no round trip", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike what's the BTC price?" }));
  const g = grants(effects);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "grant");
  assert.deepEqual(g[0].capabilities, ["research"], "spike has research=true, build=false");
});

test("a grant never contains a capability its owner disabled — AC-17 survives the change", () => {
  const { dispatcher } = make({ agents: [spike({ research: false, build: false })] });
  const effects = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike hello" }));
  assert.ok(grants(effects).every((e) => e.kind !== "grant" || e.capabilities.length === 0));
});

test("an owner's approval releases the parked request WITH a grant for that capability", () => {
  // The proposal is parked by the REFUSAL, not by the wording (DD-26): the
  // non-owner's message wakes a contained turn, the agent reaches for the tool,
  // and the gate's refusal is what asks the owner.
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: "@spike can you look up the BTC price?" }));
  const parked = dispatcher.handleBlockedAction({
    id: "b-btc",
    agent: "spike",
    capability: "research",
    detail: "WebFetch https://api.coinbase.com/v2/prices/BTC-USD/spot",
    requester: TAL,
    at: Date.now(),
  });
  const token = said(parked).match(/approve (h4-[a-z0-9]+)/)[1];
  const released = dispatcher.handle(msg({ id: "e2", pubkey: OWNER, content: `approve ${token}` }));
  const g = grants(released);
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "grant");
  assert.deepEqual(g[0].capabilities, ["research"]);
  assert.equal(wakes(released).length, 1, "and the parked work is released");
});

test("a wake the agent already received directly still gets its grant written", () => {
  // The owner's message reaches the agent through the relay, so the node emits
  // no wake — but the runtime gate still needs to know whose turn this is, or
  // the owner's own turn would be contained.
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike hello", tags: [["p", SPIKE]] }));
  assert.equal(wakes(effects).length, 0, "no relay needed — the harness delivered it");
  assert.equal(grants(effects).length, 1, "but the grant is still required");
  assert.equal(grants(effects)[0].kind, "grant");
});

test("an auto-allow agent grants on every turn — its owner opted out of gating", () => {
  const { dispatcher } = make({ agents: [spike({ crossOwnerAsks: "auto-allow" })] });
  assert.equal(grants(dispatcher.handle(msg({ pubkey: TAL, content: "@spike hi" })))[0].kind, "grant");
});

test("a chat command answers without granting anything", () => {
  const { dispatcher } = make();
  assert.equal(grants(dispatcher.handle(msg({ pubkey: TAL, content: "@spike /audit" }))).length, 0);
});

// ── The blocked-action escalation (FIX-17) ────────────────────────────────

const blocked = (over = {}) => ({
  id: "b1",
  agent: "spike",
  capability: "research",
  detail: "WebFetch https://news.ycombinator.com/",
  signature: "WebFetch|https://news.ycombinator.com",
  at: 1,
  ...over,
});

// AC-67 (DD-57): a non-owner's refusal is now an escalation PAIR — the
// requester's notice, then the owner's proposal. The ask is the say carrying
// the token; `escalation.test.mjs` pins the pair itself.
const askIn = (fx) => says(fx).find((s) => /approve h4-/.test(s.content));

test("a blocked tool call asks the OWNER for approval, not the requester", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const effects = dispatcher.handleBlockedAction(blocked());
  const ask = askIn(effects);
  assert.ok(ask, "the proposal exists");
  assert.deepEqual(ask.mentions, [OWNER], "only the owner can approve");
  assert.match(ask.content, /research/);
  const notice = says(effects).find((s) => s !== ask);
  assert.deepEqual(notice.mentions, [TAL], "and the requester is told, without the token (AC-67)");
});

test("approving a blocked action grants the capability and re-wakes the original trigger", () => {
  const { dispatcher } = make();
  const trigger = msg({ pubkey: TAL, content: F007 });
  dispatcher.handle(trigger);
  const token = askIn(dispatcher.handleBlockedAction(blocked())).content.match(/approve (h4-[a-z0-9]+)/)[1];

  const released = dispatcher.handle(msg({ id: "e9", pubkey: OWNER, content: `approve ${token}` }));
  const g = grants(released);
  assert.equal(g[0].kind, "grant");
  assert.deepEqual(g[0].capabilities, ["research"]);
  assert.equal(wakes(released).length, 1);
  assert.equal(wakes(released)[0].event.content, trigger.content, "the ORIGINAL request is what gets re-run");
});

test("denying a blocked action issues nothing and tells the room", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const token = askIn(dispatcher.handleBlockedAction(blocked())).content.match(/approve (h4-[a-z0-9]+)/)[1];
  const refused = dispatcher.handle(msg({ id: "e9", pubkey: OWNER, content: `deny ${token}` }));
  assert.equal(grants(refused).length, 0);
  assert.equal(wakes(refused).length, 0);
  assert.match(said(refused), /Denied/);
});

test("the requester cannot approve their own blocked action", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const token = askIn(dispatcher.handleBlockedAction(blocked())).content.match(/approve (h4-[a-z0-9]+)/)[1];
  const attempt = dispatcher.handle(msg({ id: "e9", pubkey: TAL, content: `approve ${token}` }));
  assert.equal(grants(attempt).length, 0, "no grant may be issued");
  assert.match(said(attempt), /only spike's owner/);
});

test("the same blocked record never raises two approval requests", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: "@spike hello" }));
  assert.equal(says(dispatcher.handleBlockedAction(blocked())).length, 2, "the escalation pair (AC-67)");
  assert.equal(says(dispatcher.handleBlockedAction(blocked())).length, 0, "a re-scanned record is not a new request");
});

test("a blocked action is refused outright when the capability is disabled", () => {
  // AC-17: no approval is offered for something the owner switched off, because
  // the owner cannot unlock it from chat — the tool is gone from the runtime.
  const { dispatcher } = make({ agents: [spike({ research: false })] });
  dispatcher.handle(msg({ pubkey: TAL, content: "@spike hello" }));
  const effects = dispatcher.handleBlockedAction(blocked());
  assert.ok(!said(effects).includes("approve h4-"), "no token may be offered");
  assert.match(said(effects), /switched off/);
});

test("a blocked action for an unknown agent is ignored rather than crashing the node", () => {
  const { dispatcher } = make();
  assert.deepEqual(dispatcher.handleBlockedAction(blocked({ agent: "ghost" })), []);
});

test("a blocked action is audited even when no owner is around to approve it", () => {
  const { audit, dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  dispatcher.handleBlockedAction(blocked());
  const rows = audit.query({ agent: "spike" });
  assert.ok(rows.some((r) => /contained|blocked/i.test(`${r.detail ?? ""}${r.kind ?? ""}`)),
    `expected a containment entry, got: ${JSON.stringify(rows)}`);
});

// ── The approval names, and releases, one specific call (DD-21, fix cycle 3) ─

test("approving a blocked action releases a grant bound to that exact call", () => {
  // F-009: the released grant said only "spike may research now", so the next
  // research call to reach the gate spent it — and in the race that call was
  // somebody else's. The grant now carries the proposal and the signature of
  // the one call the owner was shown.
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const token = askIn(dispatcher.handleBlockedAction(blocked())).content.match(/approve (h4-[a-z0-9]+)/)[1];

  const released = dispatcher.handle(msg({ id: "e9", pubkey: OWNER, content: `approve ${token}` }));
  const g = grants(released)[0];
  assert.equal(g.kind, "grant");
  assert.equal(g.proposalId, token, "the grant must name the proposal it answers");
  assert.equal(g.signature, "WebFetch|https://news.ycombinator.com", "and the call that proposal named");
});

test("the owner is shown the same call the grant will release", () => {
  // The whole invariant in one assertion: what the approver reads and what the
  // gate will permit are derived from the same record.
  const { dispatcher } = make();
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const ask = askIn(dispatcher.handleBlockedAction(blocked()));
  const token = ask.content.match(/approve (h4-[a-z0-9]+)/)[1];
  assert.match(ask.content, /news\.ycombinator\.com/, "the prompt must name the target");

  const released = dispatcher.handle(msg({ id: "e9", pubkey: OWNER, content: `approve ${token}` }));
  assert.match(grants(released)[0].signature, /news\.ycombinator\.com/);
});

test("a turn grant carries no signature — only approvals are call-bound", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: OWNER, content: "@spike hello", tags: [["p", SPIKE]] }));
  assert.equal(grants(effects)[0].signature, null);
});

// ── Blocked calls are attributed to the turn that caused them (FIX-27) ─────

test("a blocked call names the requester the RUNTIME reported, not the last message seen", () => {
  // F-009's mis-attribution. `#lastTrigger` was one slot per agent, overwritten
  // by whatever arrived most recently, so the owner's own blocked fetch was
  // reported as "while answering [tal]" and parked against tal's message. The
  // turn gate now supplies the truth, and the supervisor resolves it before the
  // record ever reaches here.
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", SPIKE]] }));
  dispatcher.handle(msg({ id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" }));

  const ask = askIn(
    dispatcher.handleBlockedAction(
      blocked({
        detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
        signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
        requester: OWNER,
        triggerEvent: { id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price" },
      }),
    ),
  );
  assert.match(ask.content, /coinbase/, "the prompt must name the call that was actually refused");
  // Post-DD-56 the OWNER edge speaks to the owner directly ("for you") rather
  // than reciting their own key back at them — what matters is that it is NOT
  // attributed to tal, whose message arrived later.
  assert.match(ask.content, /for you/, "attributed to the owner, addressed as the owner");
  assert.deepEqual(ask.mentions, [OWNER]);
  assert.doesNotMatch(ask.content, new RegExp(TAL.slice(0, 8)), "F-009's misattribution stays dead");
});

test("two interleaved requests produce two proposals, each naming its own target", () => {
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", SPIKE]] }));
  dispatcher.handle(msg({ id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" }));

  const first = askIn(dispatcher.handleBlockedAction(blocked({
    id: "b-eth", detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    requester: OWNER, triggerEvent: { id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price" },
  })));
  const second = askIn(dispatcher.handleBlockedAction(blocked({
    id: "b-lob", detail: "WebFetch https://lobste.rs/", signature: "WebFetch|https://lobste.rs",
    requester: TAL, triggerEvent: { id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" },
  })));

  const tokenA = first.content.match(/approve (h4-[a-z0-9]+)/)[1];
  const tokenB = second.content.match(/approve (h4-[a-z0-9]+)/)[1];
  assert.notEqual(tokenA, tokenB, "two refused calls are two proposals");
  assert.match(first.content, /coinbase/);
  assert.match(second.content, /lobste/);
});

test("approving one proposal leaves the other pending, and releases only its own call", () => {
  // The heart of F-009: one approval must not settle two requests.
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", SPIKE]] }));
  dispatcher.handle(msg({ id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" }));

  const ethAsk = askIn(dispatcher.handleBlockedAction(blocked({
    id: "b-eth", detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    requester: OWNER, triggerEvent: { id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price" },
  })));
  const lobAsk = askIn(dispatcher.handleBlockedAction(blocked({
    id: "b-lob", detail: "WebFetch https://lobste.rs/", signature: "WebFetch|https://lobste.rs",
    requester: TAL, triggerEvent: { id: "e-tal", pubkey: TAL, content: "@spike check lobste.rs" },
  })));

  const ethToken = ethAsk.content.match(/approve (h4-[a-z0-9]+)/)[1];
  const lobToken = lobAsk.content.match(/approve (h4-[a-z0-9]+)/)[1];

  const released = dispatcher.handle(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${ethToken}` }));
  const g = grants(released)[0];
  assert.equal(g.signature, "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot");
  assert.notEqual(g.signature, "WebFetch|https://lobste.rs");

  // The other proposal is untouched and still approvable on its own terms.
  const alsoReleased = dispatcher.handle(msg({ id: "e-approve2", pubkey: OWNER, content: `approve ${lobToken}` }));
  assert.equal(grants(alsoReleased)[0].signature, "WebFetch|https://lobste.rs");
});

test("the re-wake states the approved action, so the right work is what resumes", () => {
  // Barry approved and the agent went off and did tal's request instead,
  // because the re-wake replayed whichever message the node had in its slot.
  // The re-wake is now derived from the proposal itself.
  const { dispatcher } = make();
  dispatcher.handle(msg({ id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price", tags: [["p", SPIKE]] }));
  const ask = says(dispatcher.handleBlockedAction(blocked({
    detail: "WebFetch https://api.coinbase.com/v2/prices/ETH-USD/spot",
    signature: "WebFetch|https://api.coinbase.com/v2/prices/ETH-USD/spot",
    requester: OWNER, triggerEvent: { id: "e-owner", pubkey: OWNER, content: "@spike fetch the ETH price" },
  })))[0];
  const token = ask.content.match(/approve (h4-[a-z0-9]+)/)[1];

  const released = dispatcher.handle(msg({ id: "e-approve", pubkey: OWNER, content: `approve ${token}` }));
  const wake = wakes(released)[0];
  const content = wake.content ?? wake.event.content;
  assert.match(content, /coinbase/, "the approved action must be named in the wake");
});

// ── The room notice says which kind of refusal it is (FIX-30) ─────────────

test("a capability the owner switched off is described as the owner's setting", () => {
  // Cycle 3 saw `capability "build" is disabled for spike` posted in the room
  // for a turn that was merely WITHHELD. A member reading that would conclude
  // the owner could not get it to work either, which was false. The two cases
  // now read differently, and the permanent one says why no token is offered.
  const { dispatcher } = make({ agents: [spike({ build: false })] });
  dispatcher.handle(msg({ pubkey: TAL, content: "@spike hello" }));
  const notice = said(dispatcher.handleBlockedAction(blocked({ capability: "build" })));

  assert.match(notice, /switched off|disabled/i);
  assert.match(notice, /owner/i, "it must be clear whose setting this is");
  assert.match(notice, /approval|approve/i, "and that no approval can unlock it");
  assert.ok(!/approve h4-/.test(notice), "so no token may be offered");
});

test("a withheld turn on an enabled capability offers the approval instead", () => {
  const { dispatcher } = make({ agents: [spike({ research: true })] });
  dispatcher.handle(msg({ pubkey: TAL, content: F007 }));
  const notice = said(dispatcher.handleBlockedAction(blocked({ capability: "research" })));

  assert.match(notice, /approve h4-/, "this one IS unlockable, and by whom is the point");
  assert.ok(!/switched off/i.test(notice), "it must not read as permanent");
});
