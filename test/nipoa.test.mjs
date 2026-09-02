import { test } from "node:test";
import assert from "node:assert/strict";

import { computeAuthTag, verifyAuthTag } from "../src/identity/nipoa.mjs";
import { isAgentIdentity, agentOwner } from "../src/registry/registration.mjs";

// Fixed throwaway keys (never used anywhere real).
const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER_PK = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT_PK = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const OTHER_PK = "ccc78ff39f1a7647b91c7e49c10d5441b8086bab1cd2c38daf41908ad3e5b139";

// The tag Buzz itself accepted from the live relay on 2026-08-15. Pinning a
// real, externally-produced value means a refactor that quietly changes our
// preimage or encoding fails here rather than in the room.
const LIVE_TAG = [
  "auth",
  OWNER_PK,
  "",
  "f1c897c0edb0aca55ecd627a6d406329d1b441c3bc547e4ec9d52b9811c47a5cd3acb74835af192f369a5b1277d6fe0bee5636353b0b1d36341ddcc1aae0610f",
];

test("the auth tag is NIP-OA shaped: [auth, owner-pubkey, conditions, signature]", () => {
  const tag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT_PK });
  assert.equal(tag[0], "auth");
  assert.equal(tag[1], OWNER_PK);
  assert.equal(tag[2], "");
  assert.match(tag[3], /^[0-9a-f]{128}$/);
});

test("a tag the live relay accepted verifies against the agent it names", () => {
  assert.equal(verifyAuthTag({ tag: LIVE_TAG, agentPubkey: AGENT_PK }), OWNER_PK);
});

test("a tag we compute round-trips through our own verifier", () => {
  const tag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT_PK });
  assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), OWNER_PK);
});

test("a tampered signature does not verify", () => {
  const tag = [...LIVE_TAG];
  tag[3] = tag[3].replace(/^f1/, "f2");
  assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), null);
});

test("an attestation for one agent does not authenticate a different agent", () => {
  // The attack this blocks: copy someone else's valid auth tag onto your own
  // profile and inherit their owner.
  assert.equal(verifyAuthTag({ tag: LIVE_TAG, agentPubkey: OTHER_PK }), null);
});

test("claiming a different owner than the one who signed does not verify", () => {
  const tag = [...LIVE_TAG];
  tag[1] = OTHER_PK;
  assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), null);
});

test("conditions are covered by the signature — editing them invalidates the tag", () => {
  const tag = [...LIVE_TAG];
  tag[2] = "kind=9";
  assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), null);
});

test("self-attestation is refused: an agent cannot vouch for itself", () => {
  assert.throws(
    () => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: OWNER_PK }),
    /self-attestation/i,
  );
});

test("malformed conditions are refused rather than signed", () => {
  for (const bad of ["kind=abc", "kind=07", "kind=9&", "kind=9 &kind=10", "nonsense"]) {
    assert.throws(
      () => computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT_PK, conditions: bad }),
      /conditions|clause|decimal|whitespace/i,
      `expected "${bad}" to be refused`,
    );
  }
});

test("well-formed conditions are signed and verify", () => {
  const conditions = "kind=0&created_at>1700000000";
  const tag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT_PK, conditions });
  assert.equal(tag[2], conditions);
  assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), OWNER_PK);
});

test("a non-tag, a short tag, and junk all verify as null rather than throwing", () => {
  for (const tag of [null, undefined, [], ["auth"], ["auth", OWNER_PK], ["p", OWNER_PK, "", "aa"], "nope"]) {
    assert.equal(verifyAuthTag({ tag, agentPubkey: AGENT_PK }), null);
  }
});

// --- the registry reads identity through the verifier ----------------------

test("agentOwner returns the owner only when the attestation actually verifies", () => {
  const profile = { pubkey: AGENT_PK, tags: [LIVE_TAG] };
  assert.equal(agentOwner(profile), OWNER_PK);
  assert.equal(isAgentIdentity(profile), true);
});

test("a profile carrying a forged attestation is not an agent identity", () => {
  // This is the F-006 regression: the old parser accepted any JSON blob naming
  // an owner, so a profile could claim any owner it liked.
  const forged = { pubkey: AGENT_PK, tags: [["auth", JSON.stringify({ owner: OWNER_PK })]] };
  assert.equal(isAgentIdentity(forged), false);
  assert.equal(agentOwner(forged), null);
});

test("a profile that copied another agent's valid attestation is refused", () => {
  const stolen = { pubkey: OTHER_PK, tags: [LIVE_TAG] };
  assert.equal(isAgentIdentity(stolen), false);
  assert.equal(agentOwner(stolen), null);
});

test("a profile with no auth tag is a plain human identity", () => {
  assert.equal(isAgentIdentity({ pubkey: AGENT_PK, tags: [] }), false);
  assert.equal(agentOwner({ pubkey: AGENT_PK, tags: [] }), null);
});
