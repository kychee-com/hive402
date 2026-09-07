import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentEnv,
  lifetimePolicyArgs,
  lifetimePolicyReport,
  LIFETIME_POLICY_KEYS,
  NOT_MIRRORED_POLICY,
} from "../src/launcher/env.mjs";

// AC-42 at the Buzz Desktop 0.5.23 pin bump (DD-74, Phase 48).
//
// "The node explicitly sets every buzz-acp lifetime and presence policy that
// Buzz Desktop supplies for managed agents … re-audited at every Buzz version
// pin bump." This file IS the audit, as a test: the list below is what
// Desktop's LOCAL managed-agent spawn sets at tag desktop-v0.5.23
// (desktop/src-tauri/src/managed_agents/runtime.rs, commit b9392d9d7), read
// 2026-09-07. When the next bump adds a key, the structural test at the bottom
// reddens instead of the key quietly inheriting a default.

const room = { relayUrl: "wss://kychee.communities.buzz.xyz", respondTo: "anyone" };
const agent = {
  name: "blitz",
  ownerPubkey: "a".repeat(64),
  authTag: ["auth", "a".repeat(64), "", "b".repeat(128)],
};
const secrets = { agentPrivateKey: "b".repeat(64) };
const env = () => buildAgentEnv({ agent, room, secrets, node: { pubkey: "9".repeat(64) } });

test("relay-observer is set explicitly OFF — Desktop turns it on for its own session viewer", () => {
  // "Publish encrypted ACP observer frames over the relay" (buzz-acp 0.5.23
  // --help). Nobody consumes those frames for a hand-launched agent, and an
  // encrypted transcript stream of every turn is traffic and surface the
  // owner did not ask for. Explicit, so a later bump cannot flip it silently.
  assert.equal(env().BUZZ_ACP_RELAY_OBSERVER, "false");
  assert.ok(LIFETIME_POLICY_KEYS.includes("BUZZ_ACP_RELAY_OBSERVER"));
});

test("the session policy is set explicitly to one session per channel", () => {
  assert.equal(env().BUZZ_ACP_SESSION_POLICY, "channel");
  // Observable on the live command line too (DD-18): it has a value, so it
  // can be a flag, unlike the bare on/off presence switches.
  const args = lifetimePolicyArgs();
  assert.equal(args[args.indexOf("--session-policy") + 1], "channel");
  assert.ok(lifetimePolicyReport().some((p) => p.flag === "--session-policy" && p.value === "channel"));
});

test("parallelism is set explicitly to one worker per agent", () => {
  assert.equal(env().BUZZ_ACP_AGENTS, "1");
  const args = lifetimePolicyArgs();
  assert.equal(args[args.indexOf("--agents") + 1], "1");
  assert.ok(lifetimePolicyReport().some((p) => p.flag === "--agents" && p.value === "1"));
});

test("relay-observer is env-only, never a flag — a bare switch has no way to spell off", () => {
  assert.ok(!lifetimePolicyArgs().includes("--relay-observer"));
});

test("the replay floor is never set: the node already replays a promised message exactly once", () => {
  // Desktop passes BUZZ_ACP_REPLAY_FLOOR per spawn so the harness replays a
  // message published before it started. hive402 owns that case (AC-59,
  // F-11): the node puts the message to the agent again once after recovery.
  // A harness-side replay on top would deliver it twice.
  assert.ok(!("BUZZ_ACP_REPLAY_FLOOR" in env()));
  assert.ok(NOT_MIRRORED_POLICY.BUZZ_ACP_REPLAY_FLOOR, "the reason must be recorded in product code");
  assert.match(NOT_MIRRORED_POLICY.BUZZ_ACP_REPLAY_FLOOR, /AC-59|once/);
});

// What Desktop's LOCAL managed-agent spawn sets at desktop-v0.5.23. Every key
// here must be accounted for by hive402 in exactly one of three ways.
const DESKTOP_0523_LOCAL_SPAWN = [
  "BUZZ_PRIVATE_KEY",
  "BUZZ_RELAY_URL",
  "BUZZ_AUTH_TAG",
  "BUZZ_ACP_LAZY_POOL",
  "BUZZ_ACP_IDLE_POOL_SLEEP",
  "BUZZ_ACP_AGENT_COMMAND",
  "BUZZ_ACP_AGENT_ARGS",
  "BUZZ_ACP_MCP_COMMAND",
  "BUZZ_ACP_IDLE_TIMEOUT",
  "BUZZ_ACP_MAX_TURN_DURATION",
  "BUZZ_ACP_AGENTS",
  "BUZZ_ACP_MULTIPLE_EVENT_HANDLING",
  "BUZZ_ACP_DEDUP",
  "BUZZ_ACP_TEAM_INSTRUCTIONS",
  "BUZZ_ACP_SYSTEM_PROMPT",
  "BUZZ_ACP_MODEL",
  "BUZZ_ACP_RELAY_OBSERVER",
  "BUZZ_ACP_SESSION_POLICY",
  "BUZZ_ACP_REPLAY_FLOOR",
];

// Keys hive402 sets outside the audited lifetime table: identity, relay, the
// owner attestation and the owner-facing behaviour it composes itself.
const SET_ELSEWHERE_BY_HIVE402 = new Set([
  "BUZZ_PRIVATE_KEY",
  "BUZZ_RELAY_URL",
  "BUZZ_AUTH_TAG",
  "BUZZ_ACP_TEAM_INSTRUCTIONS",
  // Passed as command-line arguments by the supervisor, not as env.
  "BUZZ_ACP_AGENT_COMMAND",
  "BUZZ_ACP_AGENT_ARGS",
]);

test("AC-42 structural: every key Desktop 0.5.23 sets locally is mirrored, set elsewhere, or deliberately not — never inherited", () => {
  const built = env();
  const unaccounted = DESKTOP_0523_LOCAL_SPAWN.filter((key) => {
    const mirrored = LIFETIME_POLICY_KEYS.includes(key);
    const elsewhere = SET_ELSEWHERE_BY_HIVE402.has(key) && (key in built || key.startsWith("BUZZ_ACP_AGENT_"));
    const deliberate = typeof NOT_MIRRORED_POLICY[key] === "string" && NOT_MIRRORED_POLICY[key].length > 20;
    return !(mirrored || elsewhere || deliberate);
  });
  assert.deepEqual(unaccounted, [], `inherited harness defaults (AC-42): ${unaccounted.join(", ")}`);
});

test("a deliberately-not-mirrored key is genuinely absent from the built env", () => {
  for (const key of Object.keys(NOT_MIRRORED_POLICY)) {
    assert.ok(!(key in env()), `${key} is listed as not mirrored but the launcher sets it`);
  }
});
