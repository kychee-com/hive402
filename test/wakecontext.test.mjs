import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv } from "../src/launcher/env.mjs";

const room = { relayUrl: "ws://localhost:3000", respondTo: "anyone" };
const agent = {
  name: "blitz",
  ownerPubkey: "a".repeat(64),
  authTag: ["auth", "a".repeat(64), "", "b".repeat(128)], // AC-35, required at launch
};
const secrets = { agentPrivateKey: "b".repeat(64) };

// AC-11: a reply must reflect the recent conversation, not just the one line
// that woke the agent. buzz-acp's default context window is 12 messages
// (observed in the spike's `buzz-acp starting:` line) — too short for a room
// where two humans and two agents are working together.
test("the agent is given a conversation-sized context window", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.ok(env.BUZZ_ACP_CONTEXT_MESSAGE_LIMIT, "context limit must be set explicitly");
  assert.ok(
    Number(env.BUZZ_ACP_CONTEXT_MESSAGE_LIMIT) >= 50,
    `expected a conversation-sized window, got ${env.BUZZ_ACP_CONTEXT_MESSAGE_LIMIT}`,
  );
});

test("the context window never silently falls back to the harness default", () => {
  const env = buildAgentEnv({ agent, room, secrets });
  assert.notEqual(env.BUZZ_ACP_CONTEXT_MESSAGE_LIMIT, "12");
});

test("a room may tune its own context window", () => {
  const env = buildAgentEnv({
    agent,
    room: { ...room, contextMessageLimit: 80 },
    secrets,
  });
  assert.equal(env.BUZZ_ACP_CONTEXT_MESSAGE_LIMIT, "80");
});
