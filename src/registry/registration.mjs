// Agent registration + identity.
//
// Sponsored auto-admission (AC-36): a registration signed by an existing
// community member is admitted with no per-agent operator action. That is what
// makes "bring your own agent" self-service instead of a favour the relay
// operator has to perform each time.
//
// Identity (AC-35): an agent is identified by a verifiable owner attestation
// on its published profile — never by display name, which anyone can copy.

import { verifyAuthTag } from "../identity/nipoa.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;

// SPIKE FINDING (2026-08-15): relay membership roles are `member` / `admin`
// only. `bot` is a CHANNEL role — buzz-admin rejects it at the relay level
// ("invalid role 'bot': must be 'member' or 'admin'"). Registration therefore
// carries both, applied at different layers.
const RELAY_ROLE = "member";
const CHANNEL_ROLE = "bot";

export function validateRegistration({ agent, sponsorPubkey, members, existingAgents = [] }) {
  if (!agent || !HEX64.test(agent.pubkey ?? "")) {
    return { ok: false, reason: "agent pubkey must be 64-char hex" };
  }
  if (!HEX64.test(agent.ownerPubkey ?? "")) {
    return { ok: false, reason: "owner pubkey must be 64-char hex" };
  }
  if (!members?.has?.(sponsorPubkey)) {
    return { ok: false, reason: "registration must be sponsored by an existing community member" };
  }
  if (!members.has(agent.ownerPubkey)) {
    return { ok: false, reason: "the claimed owner is not a community member" };
  }
  // AC-37 — unique per ROOM (DD-17). `existingAgents` must come from the relay,
  // not from the caller's own config file: cycle 2's F-008 registered a second
  // "probe1" from a separate node because a config can only list its own
  // owner's agents, so another owner's node was invisible to this check. The
  // clash is also matched case-insensitively, because `@name` resolution is.
  const wanted = String(agent.name ?? "").toLowerCase();
  const clash = existingAgents.find(
    (a) => String(a.name).toLowerCase() === wanted && String(a.pubkey ?? "").toLowerCase() !== String(agent.pubkey).toLowerCase(),
  );
  if (clash) {
    const held = String(clash.pubkey ?? "").slice(0, 12);
    return {
      ok: false,
      reason:
        clash.scope === "relay"
          ? `agent name "${agent.name}" already resolves on this relay to ${held}… — ` +
            `registering it would leave both unaddressable by name`
          : `agent name "${agent.name}" is already registered in this room by ${held}…`,
    };
  }

  return {
    ok: true,
    admit: {
      pubkey: agent.pubkey,
      relayRole: RELAY_ROLE,
      channelRole: CHANNEL_ROLE,
      sponsoredBy: sponsorPubkey,
    },
  };
}

// --- identity -------------------------------------------------------------
//
// AC-35: an agent is identified by a CRYPTOGRAPHICALLY VERIFIABLE owner
// attestation, never by display name. So this resolves the owner by checking a
// signature, not by reading a claim. Every caller that needs "who owns this
// agent?" — the action gate (AC-14), approval authentication (AC-15), the loop
// guard (AC-24/25) — goes through here, so there is exactly one place where
// ownership can be decided and it is the place that verifies.

export function agentOwner(profile) {
  const agentPubkey = profile?.pubkey;
  for (const tag of profile?.tags ?? []) {
    const owner = verifyAuthTag({ tag, agentPubkey });
    if (owner) return owner;
  }
  return null;
}

export function isAgentIdentity(profile) {
  return agentOwner(profile) !== null;
}
