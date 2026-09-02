import { test } from "node:test";
import assert from "node:assert/strict";
import { launchAgent } from "../src/launcher/index.mjs";

// Attestation for spec AC-3 (verify: code-review — which Anthropic account is
// billed is not observable from the Buzz chat front door). What IS mechanically
// checkable is the property billing rests on: a spawned agent process receives
// its own owner's model credential and no other.
test("each agent process receives only its owner's model credential", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push(opts.env);
    return { pid: 1 };
  };
  const room = { relayUrl: "ws://localhost:3000", respondTo: "anyone" };

  launchAgent({
    agent: {
      name: "blitz",
      ownerPubkey: "a".repeat(64),
      authTag: ["auth", "a".repeat(64), "", "1".repeat(128)],
    },
    room,
    secrets: { agentPrivateKey: "1".repeat(64) },
    spawn,
  });
  launchAgent({
    agent: {
      name: "tals-agent",
      ownerPubkey: "b".repeat(64),
      authTag: ["auth", "b".repeat(64), "", "2".repeat(128)],
    },
    room,
    secrets: { agentPrivateKey: "2".repeat(64) },
    spawn,
  });

  // Each child carries exactly its own key...
  assert.equal(calls[0].BUZZ_PRIVATE_KEY, "1".repeat(64));
  assert.equal(calls[1].BUZZ_PRIVATE_KEY, "2".repeat(64));

  // ...and the other owner's key appears nowhere in its environment.
  assert.equal(
    JSON.stringify(calls[0]).includes("2".repeat(64)),
    false,
    "agent 1's env must not contain agent 2's credential",
  );
  assert.equal(
    JSON.stringify(calls[1]).includes("1".repeat(64)),
    false,
    "agent 2's env must not contain agent 1's credential",
  );

  // Owners are distinct per process, so turns bill to the right account.
  assert.equal(calls[0].BUZZ_ACP_AGENT_OWNER, "a".repeat(64));
  assert.equal(calls[1].BUZZ_ACP_AGENT_OWNER, "b".repeat(64));
});
