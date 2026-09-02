// AC-67 (DD-57): a non-owner's ask is put to the owner alone — escalation
// replaces refusal.
//
// Barry, after watching Tal ask smith for a file count and get a flat no:
// "if anyone else it asks ME and ME only." The blocked-action path becomes two
// messages with two audiences: the requester learns the one fact that is
// theirs — it needs the owner's permission and the owner has been asked — and
// the OWNER gets the proposal, addressed to them, naming the call and the
// asker. Nobody but the owner can grant it, however the request is phrased:
// that half is the approver check in #handleApproval, pinned here as the
// AC-67 regression it now is.

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

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "@spike count the files", tags: [], ...over });
const says = (fx) => fx.filter((e) => e.type === "say");
const tokenIn = (text) => text.match(/approve (h4-[a-z0-9]+)/)?.[1] ?? null;

// Tal's actual ask, as the gate refused it.
const talsBlock = (over = {}) => ({
  id: "b-count",
  agent: "spike",
  capability: "build",
  detail: "Bash: Get-ChildItem -Recurse | Measure-Object",
  signature: "Bash|get-childitem -recurse | measure-object",
  requester: TAL,
  triggerEvent: msg(),
  at: Date.now(),
  ...over,
});

// ── The escalation pair: two messages, two audiences ───────────────────────

test("AC-67: the requester is told it needs the owner's permission — and told the owner has been asked", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handleBlockedAction(talsBlock());
  const notices = says(effects).filter((s) => s.mentions.includes(TAL));
  assert.equal(notices.length, 1, "exactly one requester-facing line");
  assert.match(notices[0].content, /owner('s)? permission/i, "the fact that is theirs to know");
  assert.match(notices[0].content, /asked|put/i, "and that the ask is already on its way");
  assert.equal(tokenIn(notices[0].content), null, "the grant handle is not the requester's to hold");
  assert.ok(notices[0].replyTo, "threaded on the ask it answers");
});

test("AC-67: the request is put to the owner — addressed to the owner alone, naming the call and the asker", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handleBlockedAction(talsBlock());
  const asks = says(effects).filter((s) => tokenIn(s.content));
  assert.equal(asks.length, 1, "exactly one proposal");
  assert.deepEqual(asks[0].mentions, [OWNER], "to that owner alone");
  assert.match(asks[0].content, /Get-ChildItem/, "naming the call");
  assert.match(asks[0].content, new RegExp(TAL.slice(0, 8)), "naming who asked");
  assert.match(asks[0].content, /only you/i, "and saying whose grant it takes");
});

test("AC-67: nobody but the owner can grant it — the requester's own approve is ignored", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handleBlockedAction(talsBlock());
  const token = tokenIn(says(effects).map((s) => s.content).join("\n"));

  const attempt = dispatcher.handle(msg({ id: "e-self", pubkey: TAL, content: `approve ${token}` }));
  assert.match(says(attempt)[0].content, /only .*owner can approve/i);
  const after = dispatcher.handle(msg({ id: "e-real", pubkey: OWNER, content: `approve ${token}` }));
  assert.ok(after.length > 0, "the owner's own approve still releases it afterwards");
});

test("a capability the owner switched OFF still refuses — no proposal asks the owner to approve what they configured away", () => {
  const { dispatcher } = make({ build: false });
  const effects = dispatcher.handleBlockedAction(talsBlock());
  assert.equal(says(effects).length, 1, "one refusal, no escalation pair");
  assert.match(says(effects)[0].content, /switched\s+off/);
  assert.equal(tokenIn(says(effects)[0].content), null);
});

test("the FIX-87 owner edge keeps its single message — there is no self-notice to send", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handleBlockedAction(
    talsBlock({ requester: OWNER, triggerEvent: msg({ pubkey: OWNER }) }),
  );
  assert.equal(says(effects).length, 1, "the owner is both audiences at once");
  assert.match(says(effects)[0].content, /holds no approval/i);
  assert.ok(tokenIn(says(effects)[0].content), "and still carries the recovery token");
});

test("auto-allow: a build ask escalates instead of DD-35's flat loss (DD-57)", () => {
  const { dispatcher } = make({ crossOwnerAsks: "auto-allow" });
  const effects = dispatcher.handleBlockedAction(talsBlock());
  const asks = says(effects).filter((s) => tokenIn(s.content));
  assert.equal(asks.length, 1, "the owner is asked, not bypassed and not silent");
  assert.deepEqual(asks[0].mentions, [OWNER]);
  assert.equal(
    says(effects).filter((s) => s.mentions.includes(TAL)).length,
    1,
    "and the requester still learns where their ask went",
  );
});
