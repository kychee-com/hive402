// F-009, part 3 (cycle 3, P0) — an approval releases exactly the call it named.
//
// The Red Team stated the invariant better than we had: *the thing that
// executes is the thing the approver was shown.* Cycle 2's grant did not carry
// that. It said "spike may research now", so the next research call to reach
// the gate consumed it — and in the race, that call belonged to somebody else.
// Barry read `WebFetch https://api.coinbase.com/…` in the approval prompt, said
// yes, and `WebFetch https://lobste.rs/` ran on a non-owner's behalf.
//
// So an approval grant now carries the proposal it answers AND the signature of
// the one call that proposal named, and it is spent by a single use.
//
// This property is deliberately independent of everything else in this cycle:
// it holds even when attribution is wrong, and even where the turn gate never
// fires. It is the floor, not the ceiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGate, toolSignature } from "../src/runtime/toolgate.mjs";
import { writeGrant } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-approval-"));
const now = 1_700_000_000_000;
const nowait = { sleep: async () => {}, waitMs: 0 };

const ETH = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
const LOBSTERS = "https://lobste.rs/";
const RELEASE_EVENT = "c".repeat(64);

const fetchCall = (url, promptId) => ({ tool_name: "WebFetch", tool_input: { url }, prompt_id: promptId });

// The node's side: the owner approved proposal h4-3b5zo, which named the
// ETH/USD fetch, so the released grant is bound to that call.
function approve(dir, { signature, proposalId = "h4-3b5zo" } = {}) {
  writeGrant({
    stateDir: dir,
    agent: "spike",
    eventId: RELEASE_EVENT,
    capabilities: ["research"],
    reason: `approved by owner (${proposalId})`,
    proposalId,
    signature,
    now,
  });
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "released-turn", eventId: RELEASE_EVENT, now });
}

// ── The signature ──────────────────────────────────────────────────────────

test("a tool call's signature identifies the tool and its target", () => {
  assert.equal(toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }), `WebFetch|${ETH}`);
});

test("signatures ignore differences that do not change what is fetched", () => {
  // The agent re-runs the approved call after a re-wake, and models are not
  // byte-stable about trailing slashes or host casing. Being strict about those
  // would refuse the very call the owner approved.
  const canonical = toolSignature({ toolName: "WebFetch", toolInput: { url: "https://Lobste.RS/" } });
  assert.equal(toolSignature({ toolName: "WebFetch", toolInput: { url: "https://lobste.rs" } }), canonical);
  assert.equal(toolSignature({ toolName: "WebFetch", toolInput: { url: "https://lobste.rs/" } }), canonical);
});

test("signatures do NOT ignore a different target", () => {
  assert.notEqual(
    toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }),
    toolSignature({ toolName: "WebFetch", toolInput: { url: LOBSTERS } }),
  );
});

// ── The invariant ──────────────────────────────────────────────────────────

test("F-009: an approval naming one target cannot release a call to another", async () => {
  const dir = state();
  approve(dir, { signature: toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }) });

  const wrong = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(LOBSTERS, "released-turn"),
  });
  assert.equal(wrong.decision, "deny", "this is the exact leak F-009 reported");
  assert.match(wrong.verdict.reason, /approved|proposal|named/i);
});

test("F-009: the call the owner actually approved does run", async () => {
  const dir = state();
  approve(dir, { signature: toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }) });

  const right = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "released-turn"),
  });
  assert.equal(right.decision, "allow");
});

test("F-009: an approved call is single-use — replaying it is refused", async () => {
  const dir = state();
  approve(dir, { signature: toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }) });

  const first = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "released-turn"),
  });
  const replay = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now: now + 10, ...nowait,
    input: fetchCall(ETH, "released-turn"),
  });
  assert.equal(first.decision, "allow");
  assert.equal(replay.decision, "deny", "one approval, one action");
});

test("F-009: a different tool against the approved URL is still refused", async () => {
  const dir = state();
  approve(dir, { signature: toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } }) });

  const viaShell = await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: { tool_name: "Bash", tool_input: { command: `curl -s ${ETH}` }, prompt_id: "released-turn" },
  });
  assert.equal(viaShell.decision, "deny", "the approval named a tool as well as a target");
});

test("the audit entry records the proposal and the signature it matched", async () => {
  // T-027's new caveat: reading the F-009 sequence required cross-referencing
  // the proposal's named target against the executed one, and nothing in the
  // log flagged the mismatch. A mismatch can no longer happen — and the
  // correspondence is now readable rather than reconstructible.
  const dir = state();
  const signature = toolSignature({ toolName: "WebFetch", toolInput: { url: ETH } });
  approve(dir, { signature });

  await runGate({
    stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
    input: fetchCall(ETH, "released-turn"),
  });

  const audit = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit[0].decision, "allow");
  assert.equal(audit[0].proposalId, "h4-3b5zo");
  assert.equal(audit[0].signature, signature);
});

test("a turn grant carries no signature and is not spent by one call", async () => {
  // Only APPROVAL grants are single-use and target-locked. An owner's own turn
  // legitimately makes many different calls (AC-16), so binding it to the first
  // one would break the ordinary path.
  const dir = state();
  writeGrant({
    stateDir: dir, agent: "spike", eventId: RELEASE_EVENT,
    capabilities: ["research"], reason: "owner request", now,
  });
  writeTurnRecord({ stateDir: dir, agent: "spike", promptId: "owner-turn", eventId: RELEASE_EVENT, now });

  for (const url of [ETH, LOBSTERS, "https://example.com"]) {
    const result = await runGate({
      stateDir: dir, agent: "spike", enabled: ["research"], now, ...nowait,
      input: fetchCall(url, "owner-turn"),
    });
    assert.equal(result.decision, "allow", `the owner's own turn must be free to fetch ${url}`);
  }
});
