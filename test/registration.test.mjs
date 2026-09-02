import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRegistration, isAgentIdentity, agentOwner } from "../src/registry/registration.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";

// The attestation tests need a real key pair (the tag is signed), so OWNER is
// a genuine throwaway pubkey rather than a placeholder run of hex.
const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const SPONSOR = "d".repeat(64);
const AGENT_PK = "a".repeat(64);

const members = new Set([OWNER, SPONSOR]);
const existing = [{ name: "blitz", pubkey: "c".repeat(64) }];

const base = {
  agent: { name: "bzik", pubkey: AGENT_PK, ownerPubkey: OWNER },
  sponsorPubkey: SPONSOR,
  members,
  existingAgents: existing,
};

// AC-36: sponsored auto-admission — a registration signed by an existing
// community member is admitted with no per-agent operator action.
test("a member-sponsored registration is admitted automatically", () => {
  const r = validateRegistration(base);
  assert.equal(r.ok, true);
  assert.equal(r.admit.pubkey, AGENT_PK);
});

test("a registration with no member sponsor is refused", () => {
  const r = validateRegistration({ ...base, sponsorPubkey: "f".repeat(64) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sponsor|member/i);
});

// AC-37: per-room name uniqueness.
test("a name already registered in the room is refused", () => {
  const r = validateRegistration({
    ...base,
    agent: { ...base.agent, name: "Blitz" },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /name|unique/i);
});

test("relay admission uses a relay-valid role, never the channel role", () => {
  // SPIKE FINDING: relay roles are member/admin only — 'bot' is a CHANNEL role
  // and buzz-admin rejects it ("invalid role 'bot'").
  const r = validateRegistration(base);
  assert.equal(r.admit.relayRole, "member");
  assert.equal(r.admit.channelRole, "bot");
});

test("a malformed agent pubkey is refused", () => {
  const r = validateRegistration({ ...base, agent: { ...base.agent, pubkey: "xyz" } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /pubkey/i);
});

test("an agent may not claim an owner that is not a member", () => {
  const r = validateRegistration({
    ...base,
    agent: { ...base.agent, ownerPubkey: "9".repeat(64) },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /owner/i);
});

// AC-35: agents are identified by a verifiable owner attestation on their
// profile, never by display name.
test("an agent profile carrying an owner attestation is identified as an agent", () => {
  // NIP-OA shape, signed for real. This test previously asserted an invented
  // format (`["auth", "{\"owner\":…}"]`) that Buzz never emits, which is how
  // the suite stayed green while the live room had no working attestation
  // (cycle 1, F-006). Signing here means the fixture cannot drift from the
  // wire format again.
  const tag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT_PK });
  const profile = { pubkey: AGENT_PK, tags: [tag] };
  assert.equal(isAgentIdentity(profile), true);
  assert.equal(agentOwner(profile), OWNER);
});

test("a profile with no attestation is not an agent, whatever it is called", () => {
  const profile = { pubkey: "e".repeat(64), name: "totally-an-agent", tags: [] };
  assert.equal(isAgentIdentity(profile), false);
  assert.equal(agentOwner(profile), null);
});

test("a malformed attestation does not identify an agent", () => {
  const profile = { pubkey: AGENT_PK, tags: [["auth", "not-json"]] };
  assert.equal(isAgentIdentity(profile), false);
});
