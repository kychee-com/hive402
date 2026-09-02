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
const toolPaths = { buzzDir: "C:\\Buzz", nodeDir: "C:\\Program Files\\nodejs" };

// SPIKE FINDING (2026-08-15): a woken agent produced no channel message.
// Buzz discards an agent's plain text — agents reply by RUNNING
// `buzz messages send`. So the child process must be able to find and
// authenticate the buzz CLI, or the agent wakes and stays mute forever.
test("agent env puts the buzz CLI directory on PATH so the agent can speak", () => {
  const env = buildAgentEnv({ agent, room, secrets, toolPaths });
  assert.ok(env.PATH, "PATH must be set");
  assert.ok(
    env.PATH.split(";").includes(toolPaths.buzzDir),
    `buzz dir missing from PATH: ${env.PATH}`,
  );
});

test("agent env includes the node directory (the ACP adapter runs under node)", () => {
  const env = buildAgentEnv({ agent, room, secrets, toolPaths });
  assert.ok(env.PATH.split(";").includes(toolPaths.nodeDir));
});

test("the CLI's auth env travels with the agent (same vars the harness uses)", () => {
  const env = buildAgentEnv({ agent, room, secrets, toolPaths });
  assert.equal(env.BUZZ_RELAY_URL, room.relayUrl);
  assert.equal(env.BUZZ_PRIVATE_KEY, secrets.agentPrivateKey);
});

// SPIKE FINDING: an http:// relay URL fails at connect time with
// "URL scheme not supported" — and only AFTER the agent pool is ready, so it
// reads as a runtime crash rather than a config error. Fail fast instead.
test("a non-websocket relay url is rejected up front", () => {
  assert.throws(
    () => buildAgentEnv({ agent, room: { ...room, relayUrl: "http://localhost:3000" }, secrets, toolPaths }),
    /ws:\/\/|wss:\/\/|websocket/i,
  );
});

test("wss:// is accepted", () => {
  const env = buildAgentEnv({
    agent,
    room: { ...room, relayUrl: "wss://kychee.communities.buzz.xyz" },
    secrets,
    toolPaths,
  });
  assert.equal(env.BUZZ_RELAY_URL, "wss://kychee.communities.buzz.xyz");
});

test("PATH carries only the curated tool dirs — no ambient env leakage", () => {
  process.env.__HIVE_PATH_PROBE__ = "leak";
  try {
    const env = buildAgentEnv({ agent, room, secrets, toolPaths });
    assert.equal(env.__HIVE_PATH_PROBE__, undefined);
    for (const dir of env.PATH.split(";")) {
      assert.ok(dir.length > 0, "no empty PATH segments");
    }
  } finally {
    delete process.env.__HIVE_PATH_PROBE__;
  }
});
