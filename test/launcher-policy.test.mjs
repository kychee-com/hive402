import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAgentEnv, inboundGateFor, LIFETIME_POLICY_KEYS } from "../src/launcher/env.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";

const authTag = ["auth", OWNER, "", "ab".repeat(64)];

const env = ({ agent: agentOver = {}, room: roomOver = {}, ...over } = {}) =>
  buildAgentEnv({
    agent: { name: "spike", ownerPubkey: OWNER, authTag, ...agentOver },
    room: { relayUrl: "ws://localhost:3000", respondTo: "anyone", ...roomOver },
    secrets: { agentPrivateKey: "aa".repeat(32) },
    configDir: "C:\\state\\spike",
    ...over,
  });

// AC-42: the node explicitly sets every buzz-acp lifetime and presence policy
// Desktop supplies for managed agents, rather than inheriting harness defaults.
// Cycle 1's F-005 concluded these were unset from the process COMMAND LINE —
// but they are supplied by environment, which a command line cannot show. The
// audited table is asserted here, and the live check reads the harness's own
// startup policy line.
test("every audited lifetime and presence policy is present in the built env", () => {
  const e = env();
  for (const key of LIFETIME_POLICY_KEYS) {
    assert.ok(key in e, `AC-42: ${key} must be set explicitly, not inherited`);
    assert.notEqual(e[key], "", `AC-42: ${key} must have a real value`);
  }
});

test("the idle pool sleep is non-zero and lazy-pool is on, so a woken pool comes back down", () => {
  // AC-41. The 7.5-hour orphan cycle 1 found is what the default (disabled)
  // buys you.
  const e = env();
  assert.equal(e.BUZZ_ACP_LAZY_POOL, "true");
  assert.ok(Number(e.BUZZ_ACP_IDLE_POOL_SLEEP) > 0);
});

test("the permission mode is set explicitly rather than inherited", () => {
  assert.ok(env().BUZZ_ACP_PERMISSION_MODE);
});

test("the agent's own owner attestation rides on every event it signs", () => {
  // AC-35 — without this the agent's messages carry no verifiable owner.
  assert.equal(env().BUZZ_AUTH_TAG, JSON.stringify(authTag));
});

test("the agent runtime is pointed at its own capability-scoped config dir", () => {
  assert.equal(env().CLAUDE_CONFIG_DIR, "C:\\state\\spike");
});

test("a missing attestation is refused at launch, not published as an unowned agent", () => {
  assert.throws(() => env({ agent: { authTag: null } }), /attestation/i);
});

// --- the inbound gate that makes the authority gate enforceable ------------

test("an agent whose owner requires approval admits only its owner and the node", () => {
  // Now that the relay resolves @name for any sender (the F-001 fix), an
  // agent on respond_to=anyone would be woken directly by a non-owner and the
  // approval gate could never run — F-003 all over again.
  const gate = inboundGateFor({
    agent: { ownerPubkey: OWNER, crossOwnerAsks: "owner-approves" },
    nodePubkey: NODE,
  });
  assert.equal(gate.respondTo, "allowlist");
  // FIX-131: the OWNER is named here now, and this test's own TITLE always said
  // they should be — "admits only its owner and the node". The assertion said
  // `[NODE]` alone because buzz-acp admits its own owner implicitly, and before
  // FIX-117 that owner WAS the human.
  //
  // FIX-117 moved the attestation to the node, so the harness's owner became the
  // node and the human silently stopped being admitted. Measured on Barry's
  // machine: the harness logs `owner resolved from BUZZ_AUTH_TAG: bead5b81…`
  // (the node) while the config's ownerPubkey is `800fab4d…` (Barry). He wrote
  // to his own agent, in his own room, and neither component delivered it.
  //
  // An implicit guarantee from another component can be withdrawn without
  // anybody noticing. This one was, and the title was right all along.
  assert.deepEqual(gate.respondToAllowlist, [NODE, OWNER]);
});

test("an agent whose owner auto-allows cross-owner asks can be addressed directly", () => {
  // Nothing to enforce, so take the fastest path and let the relay deliver.
  const gate = inboundGateFor({
    agent: { ownerPubkey: OWNER, crossOwnerAsks: "auto-allow" },
    nodePubkey: NODE,
  });
  assert.equal(gate.respondTo, "anyone");
});

test("an agent that takes no cross-owner requests still admits the node", () => {
  // The node must always be able to relay, or /audit and the turn-cap notice
  // would have no way in.
  const gate = inboundGateFor({
    agent: { ownerPubkey: OWNER, crossOwnerAsks: "deny" },
    nodePubkey: NODE,
  });
  assert.equal(gate.respondTo, "allowlist");
  assert.ok(gate.respondToAllowlist.includes(NODE));
});

test("the derived gate is never the harness's owner-only default", () => {
  // AC-38, stated as an invariant over every setting rather than per case.
  for (const crossOwnerAsks of ["owner-approves", "auto-allow", "deny"]) {
    const gate = inboundGateFor({ agent: { ownerPubkey: OWNER, crossOwnerAsks }, nodePubkey: NODE });
    assert.notEqual(gate.respondTo, "owner-only");
    assert.notEqual(gate.respondTo, "nobody");
  }
});

test("the derived gate flows through into the built env", () => {
  const gate = inboundGateFor({
    agent: { ownerPubkey: OWNER, crossOwnerAsks: "owner-approves" },
    nodePubkey: NODE,
  });
  const e = env({ room: { relayUrl: "ws://localhost:3000", ...gate } });
  assert.equal(e.BUZZ_ACP_RESPOND_TO, "allowlist");
  // FIX-131: the owner rides here too, so the harness will take their messages
  // directly. It stopped doing that when FIX-117 made the NODE the owner it
  // resolves from BUZZ_AUTH_TAG, and nothing noticed until Barry could not
  // reach his own agent.
  assert.equal(e.BUZZ_ACP_RESPOND_TO_ALLOWLIST, [NODE, OWNER].join(","));
  assert.ok(!e.BUZZ_ACP_RESPOND_TO_ALLOWLIST.includes(TAL), "non-owner humans route via the node");
});
