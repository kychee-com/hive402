import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentEnv } from "../src/launcher/env.mjs";
import { DEFAULT_MODEL } from "../src/config/schema.mjs";

// AC-74/AC-75 at the launch seam: the agent actually RUNS on the model its
// hive named. DD-62 — the config decides, never the machine.

const room = {
  relayUrl: "wss://kychee.communities.buzz.xyz",
  respondTo: "anyone",
};
const agentNamed = (over = {}) => ({
  name: "blitz",
  ownerPubkey: "a".repeat(64),
  authTag: ["auth", "a".repeat(64), "", "b".repeat(128)],
  ...over,
});
const secrets = { agentPrivateKey: "b".repeat(64) };

test("the child environment names the model the hive resolved", () => {
  const env = buildAgentEnv({
    agent: agentNamed(),
    room,
    secrets,
    node: { pubkey: "9".repeat(64), model: "claude-opus-5" },
  });
  assert.equal(env.ANTHROPIC_MODEL, "claude-opus-5");
});

test("an agent's own model beats its node's, at the launch seam too", () => {
  const env = buildAgentEnv({
    agent: agentNamed({ model: "claude-haiku-4-5-20251001" }),
    room,
    secrets,
    node: { pubkey: "9".repeat(64), model: "claude-opus-5" },
  });
  assert.equal(env.ANTHROPIC_MODEL, "claude-haiku-4-5-20251001");
});

test("two agents with different models get different environments", () => {
  const node = { pubkey: "9".repeat(64), model: "claude-opus-5" };
  const a = buildAgentEnv({ agent: agentNamed({ name: "a" }), room, secrets, node });
  const b = buildAgentEnv({
    agent: agentNamed({ name: "b", model: "claude-sonnet-5" }),
    room,
    secrets,
    node,
  });
  assert.equal(a.ANTHROPIC_MODEL, "claude-opus-5");
  assert.equal(b.ANTHROPIC_MODEL, "claude-sonnet-5");
  assert.notEqual(a.ANTHROPIC_MODEL, b.ANTHROPIC_MODEL);
});

test("a launch with no node named still gets hive402's default, never nothing", () => {
  // Fail-safe direction: a call site that forgets to pass the node degrades to
  // the model hive402 ships with. It must never degrade to "unset", which is
  // what would hand the choice back to the owner's machine-wide setting.
  const env = buildAgentEnv({ agent: agentNamed(), room, secrets });
  assert.equal(env.ANTHROPIC_MODEL, DEFAULT_MODEL);
});

test("an ambient ANTHROPIC_MODEL never reaches the child — the allowlist is not widened", () => {
  // This is the DD-62 alternative we REJECTED, so it gets a test rather than a
  // comment. Widening the allowlist would work against AC-3's isolation
  // invariant and would tie the model to how the node happened to be launched
  // rather than to what its config says.
  const original = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = "claude-from-the-ambient-environment";
  try {
    const env = buildAgentEnv({
      agent: agentNamed(),
      room,
      secrets,
      node: { pubkey: "9".repeat(64), model: "claude-opus-5" },
    });
    assert.equal(env.ANTHROPIC_MODEL, "claude-opus-5");
    assert.notEqual(env.ANTHROPIC_MODEL, "claude-from-the-ambient-environment");
  } finally {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  }
});

test("AC-3 isolation holds: one agent's environment carries nothing of another's", () => {
  const node = { pubkey: "9".repeat(64), model: "claude-opus-5" };
  const a = buildAgentEnv({
    agent: agentNamed({ name: "a" }),
    room,
    secrets: { agentPrivateKey: "1".repeat(64) },
    node,
  });
  const b = buildAgentEnv({
    agent: agentNamed({ name: "b", model: "claude-sonnet-5" }),
    room,
    secrets: { agentPrivateKey: "2".repeat(64) },
    node,
  });
  const bValues = new Set(Object.values(b).map(String));
  assert.ok(!bValues.has("1".repeat(64)), "b's environment must not carry a's key");
  const aValues = new Set(Object.values(a).map(String));
  assert.ok(!aValues.has("2".repeat(64)), "a's environment must not carry b's key");
  assert.ok(!aValues.has("claude-sonnet-5"), "a's environment must not carry b's model");
});
