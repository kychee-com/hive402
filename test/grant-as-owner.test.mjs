// AC-68 (DD-58): the owner's grant runs the action as the OWNER'S OWN request.
//
// "when the owner grants such a request, the action runs as the OWNER'S OWN
// request, exactly as if the owner had asked for it. The owner may amend it in
// the same breath ('yes, but only the top-level folder'), and what runs is the
// amended request."
//
// Two regimes for the released grant (AC-69's binding, DD-58):
//   • bare approve — DD-21 byte-for-byte: exact signature, single-use.
//   • amended approve — the amendment changes the concrete call, so an exact
//     signature would refuse the very thing the owner just asked for. The
//     grant is capability-scoped instead, bound tighter on every other axis:
//     keyed to the release wake's own event, prompt-bound, TTL'd.

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
  build: true,
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

function make(over = {}) {
  const audit = new AuditLog();
  const agents = [spike(over)];
  return {
    agents,
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      workshop: { project: "prj_x", subdomain: null },
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "@spike list the workspace", tags: [], ...over });
const says = (fx) => fx.filter((e) => e.type === "say");
const wakes = (fx) => fx.filter((e) => e.type === "wake");
const tokenIn = (fx) =>
  says(fx)
    .map((s) => s.content)
    .join("\n")
    .match(/approve (h4-[a-z0-9]+)/)?.[1] ?? null;

// Park tal's refused call and hand back the token.
function park(dispatcher, over = {}) {
  const effects = dispatcher.handleBlockedAction({
    id: over.id ?? "b-list",
    agent: "spike",
    capability: "build",
    detail: "Bash: Get-ChildItem -Recurse",
    signature: "Bash|get-childitem -recurse",
    requester: TAL,
    triggerEvent: msg(),
    at: Date.now(),
    ...over,
  });
  return tokenIn(effects);
}

// ── Bare approve: runs as the owner's own request, DD-21 intact ────────────

test("AC-68: the released wake is attributed to the OWNER — the action runs as their own request", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const released = dispatcher.handle(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}` }));
  const wake = wakes(released)[0];
  assert.ok(wake, "the approved work is re-woken");
  assert.equal(wake.attributeTo?.pubkey, OWNER, "the wake's attribution names the owner, not the asker");
  assert.equal(wake.authority?.requester, OWNER, "and the grant runs as the owner's own");
});

test("AC-68 bare approve keeps DD-21 byte-for-byte: exact signature, the proposal it answers", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const released = dispatcher.handle(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}` }));
  const grant = wakes(released)[0].authority;
  assert.equal(grant.kind, "grant");
  assert.equal(grant.signature, "Bash|get-childitem -recurse");
  assert.equal(grant.proposalId, token);
});

// ── The amendment: what runs is the amended request ────────────────────────

test("AC-68: text after the approve token is the owner amending the request in the same breath", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const released = dispatcher.handle(
    msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}, but only the top-level folder` }),
  );
  const wake = wakes(released)[0];
  assert.ok(wake, "the amended work is re-woken");
  assert.match(wake.content, /only the top-level folder/, "the amendment rides the released wake");
  assert.match(wake.content, /amended/i, "and is named as the owner's amendment");
  assert.match(wake.content, /as amended/i, "what runs is the amended request");
});

test("AC-68: an amended release is capability-scoped — an exact signature would refuse the amended call itself", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const released = dispatcher.handle(
    msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token} but only the top-level folder` }),
  );
  const grant = wakes(released)[0].authority;
  assert.equal(grant.kind, "grant");
  assert.deepEqual(grant.capabilities, ["build"], "scoped to the capability the proposal named");
  assert.equal(grant.signature, null, "the amended call cannot be signature-bound in advance");
  assert.equal(grant.proposalId, token, "but it still names the one approval that released it");
  assert.equal(grant.requester, OWNER, "and runs as the owner's own request");
});

test("a bare approve with only punctuation after the token is NOT an amendment", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const released = dispatcher.handle(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${token}.` }));
  const grant = wakes(released)[0].authority;
  assert.equal(grant.signature, "Bash|get-childitem -recurse", "punctuation does not loosen DD-21");
});

// ── Deny is unchanged, whatever rides after it ─────────────────────────────

test("deny with trailing words still denies — nothing is released", () => {
  const { dispatcher } = make();
  const token = park(dispatcher);
  const refused = dispatcher.handle(
    msg({ id: "e-no", pubkey: OWNER, content: `deny ${token}, and stop asking` }),
  );
  assert.equal(wakes(refused).length, 0);
  assert.match(says(refused)[0].content, /Denied/);
});
