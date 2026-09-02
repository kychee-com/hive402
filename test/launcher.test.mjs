import { test } from "node:test";
import assert from "node:assert/strict";
import { launchAgent } from "../src/launcher/index.mjs";

const base = {
  room: { relayUrl: "wss://relay.example", respondTo: "anyone" },
  agent: {
    name: "blitz",
    ownerPubkey: "a".repeat(64),
    authTag: ["auth", "a".repeat(64), "", "b".repeat(128)], // AC-35, required at launch
  },
  secrets: { agentPrivateKey: "b".repeat(64) },
};

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    return { pid: 4242, kill() {} };
  };
  return { spawn, calls };
}

test("launchAgent spawns with the built policy env applied", () => {
  const { spawn, calls } = recordingSpawn();
  launchAgent({ ...base, spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.env.BUZZ_ACP_RESPOND_TO, "anyone");
  assert.equal(calls[0].opts.env.BUZZ_ACP_LAZY_POOL, "true");
});

test("launchAgent returns the spawned child handle", () => {
  const { spawn } = recordingSpawn();
  const handle = launchAgent({ ...base, spawn });
  assert.equal(handle.pid, 4242);
});

test("each agent's spawn env carries only its own private key (AC-3 isolation)", () => {
  const { spawn, calls } = recordingSpawn();
  launchAgent({ ...base, spawn });
  launchAgent({
    ...base,
    agent: {
      name: "bzik",
      ownerPubkey: "e".repeat(64),
      authTag: ["auth", "e".repeat(64), "", "f".repeat(128)],
    },
    secrets: { agentPrivateKey: "f".repeat(64) },
    spawn,
  });
  assert.equal(calls[0].opts.env.BUZZ_PRIVATE_KEY, "b".repeat(64));
  assert.equal(calls[1].opts.env.BUZZ_PRIVATE_KEY, "f".repeat(64));
  // no cross-contamination: agent 2's key is absent from agent 1's env
  assert.notEqual(calls[0].opts.env.BUZZ_PRIVATE_KEY, calls[1].opts.env.BUZZ_PRIVATE_KEY);
});

test("launchAgent does not inherit the ambient process env (no secret leakage)", () => {
  const { spawn, calls } = recordingSpawn();
  process.env.__HIVE_LEAK_PROBE__ = "should-not-appear";
  try {
    launchAgent({ ...base, spawn });
    assert.equal(calls[0].opts.env.__HIVE_LEAK_PROBE__, undefined);
  } finally {
    delete process.env.__HIVE_LEAK_PROBE__;
  }
});
