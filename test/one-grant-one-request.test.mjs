// AC-69: a grant covers the one request it answered and nothing else.
//
// "A second request cannot ride it — not one queued behind it, not one folded
// into the same agent turn, and not a later request from the same person."
//
// Barry's commit note on why this criterion exists: it is the property that
// makes AC-16's relaxation safe, and it is written from something the project
// already learned the hard way — an earlier attempt released an unsigned
// turn-scoped grant and a second person's queued message could reach it
// (FIX-87 / F-009). These are the ride-along regressions, one per shape, for
// BOTH release regimes (DD-58): exact-signature (bare approve) and
// capability-scoped (amended approve — the wider regime, so the bounds that
// remain are exactly the ones proven here: event key, prompt binding, TTL,
// single release).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";
import { runGate, toolSignature } from "../src/runtime/toolgate.mjs";
import { writeGrant, writeWithheld } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const OTHER = "cc".repeat(32);
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const now = 1_700_000_000_000;
const nowait = { waitMs: 0, sleep: async () => {} };
const WAKE = "a".repeat(64); // the release wake's event id
const QUEUED = "b".repeat(64); // somebody else's message, queued behind it

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-ac69-"));

// The amended-release grant exactly as #handleApproval writes it: capability-
// scoped (no signature), proposal-bound, keyed to the release wake's event.
function amendedRelease(dir, { eventId = WAKE } = {}) {
  writeGrant({
    stateDir: dir,
    agent: "spike",
    eventId,
    capabilities: ["build"],
    reason: "approved by owner (h4-amend), as amended",
    requester: OWNER,
    proposalId: "h4-amend",
    now,
  });
}

const call = (dir, { promptId, file = "notes/summary.md", at = now }) =>
  runGate({
    stateDir: dir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: `C:/elsewhere/${file}`, content: "x" },
      prompt_id: promptId,
      cwd: "C:/hive402/work/spike",
    },
    now: at,
    ...nowait,
  });

// ── Shape 1: a message QUEUED BEHIND the granted one ───────────────────────

test("AC-69: a queued second message is a different event — the amended grant is not its to spend", async () => {
  const dir = state();
  amendedRelease(dir);
  // The queued message got its own turn, keyed to its own event, and the node
  // said what that turn may do: nothing.
  writeWithheld({ stateDir: dir, agent: "spike", eventId: QUEUED, requester: OTHER, now });
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "p-queued", eventId: QUEUED, now });

  const result = await call(dir, { promptId: "p-queued" });
  assert.equal(result.decision, "deny", "the grant is keyed to the release wake, not to whoever queued next");
});

// ── Shape 2: a second request FOLDED INTO the same agent turn ──────────────

test("AC-69: in the exact-signature regime, a folded-in second request matches no signature (F-009's floor)", async () => {
  const dir = state();
  writeGrant({
    stateDir: dir,
    agent: "spike",
    eventId: WAKE,
    capabilities: ["build"],
    reason: "approved by owner (h4-exact)",
    requester: OWNER,
    proposalId: "h4-exact",
    signature: toolSignature({ toolName: "Write", toolInput: { file_path: "C:/elsewhere/notes/summary.md" } }),
    now,
  });
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "p-run", eventId: WAKE, now });

  const approved = await call(dir, { promptId: "p-run" });
  assert.equal(approved.decision, "allow", "the call the owner was shown runs");
  const rider = await call(dir, { promptId: "p-run", file: "somebody-elses-thing.md" });
  assert.equal(rider.decision, "deny", "a different call folded into the same turn gets nothing");
});

test("AC-69: in the amended regime, the FIX-87 window stays one prompt wide — a second prompt gets nothing", async () => {
  // The amended grant has no signature, so inside the release turn it covers
  // the amended work (that is the point). What a rider CANNOT do is reach it
  // from another prompt: the first unattributed claim binds it.
  const dir = state();
  amendedRelease(dir);

  const first = await call(dir, { promptId: "p-release" }); // no turn record: FIX-87 claim
  assert.equal(first.decision, "allow", "the released work runs");
  const second = await call(dir, { promptId: "p-second" });
  assert.equal(second.decision, "deny", "one release, one prompt — the next turn holds nothing");
});

test("AC-69: the amended grant dies with its TTL — nothing rides it later", async () => {
  const dir = state();
  amendedRelease(dir);
  const late = await call(dir, { promptId: "p-late", at: now + 6 * 60 * 1000 });
  assert.equal(late.decision, "deny", "an approval nobody used stops mattering quickly");
});

// ── Shape 3: a LATER request from the same person ──────────────────────────

test("AC-69: a later request from the same person parks afresh — the spent yes cannot be re-ridden", () => {
  const audit = new AuditLog();
  const agents = [{
    name: "spike", pubkey: SPIKE, ownerPubkey: OWNER,
    research: true, build: true, crossOwnerAsks: "owner-approves", replyMode: "addressed-only",
  }];
  const dispatcher = new Dispatcher({
    nodePubkey: NODE,
    agents,
    turnCap: new TurnCap({ limit: 20 }),
    loopGuard: new LoopGuard(),
    audit,
    workshop: { project: "prj_x", subdomain: null },
  });
  const says = (fx) => fx.filter((e) => e.type === "say");
  const tokenIn = (fx) =>
    says(fx).map((s) => s.content).join("\n").match(/approve (h4-[a-z0-9]+)/)?.[1] ?? null;
  const block = (id) => ({
    id,
    agent: "spike",
    capability: "build",
    detail: "Bash: Get-ChildItem -Recurse",
    signature: "Bash|get-childitem -recurse",
    requester: TAL,
    triggerEvent: { id: `e-${id}`, kind: 9, pubkey: TAL, content: "@spike list it", tags: [] },
    at: Date.now(),
  });

  const token1 = tokenIn(dispatcher.handleBlockedAction(block("b-first")));
  assert.ok(token1, "the first ask parks");
  dispatcher.handle({ id: "e-yes", kind: 9, pubkey: OWNER, content: `approve ${token1}`, tags: [] });

  // Tal asks again tomorrow. The IDENTICAL call must park a NEW proposal —
  // the old approval is spent, and the pending-dedupe only ever suppresses a
  // duplicate that is still awaiting its answer.
  const again = dispatcher.handleBlockedAction(block("b-later"));
  const token2 = tokenIn(again);
  assert.ok(token2, "the later request is put to the owner afresh");
  assert.notEqual(token2, token1, "a new ask, a new grant to give");
});
