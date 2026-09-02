import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv, lifetimePolicyArgs } from "../src/launcher/env.mjs";

// A representative room + agent config. `respond_to` at the room level drives
// the cross-owner author gate; the launcher must NEVER leave it at buzz-acp's
// owner-only default (spec AC-38, issue #1 finding 1).
const room = {
  relayUrl: "wss://kychee.communities.buzz.xyz",
  respondTo: "anyone", // or "allowlist" with a member list
};
const agent = {
  name: "blitz",
  ownerPubkey: "a".repeat(64),
  // Every launched agent carries a NIP-OA owner attestation (AC-35); the
  // launcher refuses to start one without it, so the fixture has one.
  authTag: ["auth", "a".repeat(64), "", "b".repeat(128)],
};
const secrets = {
  agentPrivateKey: "b".repeat(64),
};

test("respond-to gate is explicit and never the harness owner-only default", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.equal(env.BUZZ_ACP_RESPOND_TO, "anyone");
  assert.notEqual(env.BUZZ_ACP_RESPOND_TO, undefined);
});

test("allowlist mode carries the member pubkeys", () => {
  const env = buildAgentEnv({
    agent,
    room: { ...room, respondTo: "allowlist", respondToAllowlist: ["c".repeat(64), "d".repeat(64)] },
    secrets,
  });
  assert.equal(env.BUZZ_ACP_RESPOND_TO, "allowlist");
  assert.equal(env.BUZZ_ACP_RESPOND_TO_ALLOWLIST, `${"c".repeat(64)},${"d".repeat(64)}`);
});

test("idle-pool-sleep is set non-zero AND paired with lazy-pool (issue #1: sleep needs lazy)", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.equal(env.BUZZ_ACP_LAZY_POOL, "true");
  assert.ok(Number(env.BUZZ_ACP_IDLE_POOL_SLEEP) > 0, "idle pool sleep must be > 0");
});

test("Desktop-owned lifetime/presence policies are re-supplied, not defaulted", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.ok(Number(env.BUZZ_ACP_EXIT_AFTER_INACTIVITY) > 0);
  assert.equal(env.BUZZ_ACP_NO_PRESENCE, "false");
});

test("owner and agent identity are wired to the real buzz vars", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.equal(env.BUZZ_ACP_AGENT_OWNER, agent.ownerPubkey);
  assert.equal(env.BUZZ_PRIVATE_KEY, secrets.agentPrivateKey);
  assert.equal(env.BUZZ_RELAY_URL, room.relayUrl);
});

test("a bad respond_to value is rejected, not silently passed to the harness", () => {
  assert.throws(
    () => buildAgentEnv({ agent, room: { ...room, respondTo: "everybody" }, secrets }),
    /respond_to/i,
  );
});

test("allowlist mode requires a non-empty allowlist", () => {
  assert.throws(
    () => buildAgentEnv({ agent, room: { ...room, respondTo: "allowlist", respondToAllowlist: [] }, secrets }),
    /allowlist/i,
  );
});

// ── One turn, one requester (DD-24, fix cycle 3) ──────────────────────────
//
// FOUND BY RUNNING IT (2026-08-16), re-attacking F-009 live. buzz-acp's
// `multiple_event_handling` defaults to `steer`, whose own documentation reads:
// "Cancel the in-flight turn and re-dispatch a merged prompt… Fires for any
// author the inbound author gate admits."
//
// That merges a SECOND SENDER's request into a turn already running for someone
// else. Per-event authority cannot separate them, because after the merge there
// is one turn, one prompt id and therefore one authority — and if the turn
// began as the owner's, it carries the owner's grant. A non-owner's request
// riding an owner's authority is F-009 by another route.
//
// `queue` is the mode that matches what hive402 promises: new events wait for
// the current turn to finish, so every request gets its own turn, its own
// authority and its own approval. This is exactly what AC-42 is for — the
// harness's default was never chosen by us.

test("mid-turn delivery is queued, never merged into a turn already running", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.equal(env.BUZZ_ACP_MULTIPLE_EVENT_HANDLING, "queue");
});

test("the queueing policy is visible on the command line too", () => {
  // DD-18: policy nobody can observe is policy nobody can verify.
  const args = lifetimePolicyArgs();
  const at = args.indexOf("--multiple-event-handling");
  assert.ok(at >= 0, `expected the flag in: ${args.join(" ")}`);
  assert.equal(args[at + 1], "queue");
});

test("dedup stays queue, which the harness requires alongside it", () => {
  // buzz-acp refuses a cancel-mode with dedup=drop. We are not in a cancel mode,
  // but pinning both means the pair can never drift into a refused combination.
  assert.equal(buildAgentEnv({ agent, room, secrets }).BUZZ_ACP_DEDUP, "queue");
});
