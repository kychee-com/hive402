// NIP-OA — owner attestation.
//
// This is how the room knows an agent is an agent, and whose. Spec AC-35 is
// explicit that identification is "via a cryptographically verifiable owner
// attestation on its published profile, never via display name", and that the
// node uses this identification to enforce AC-14/15/24/25. So every place that
// asks "who owns this pubkey?" ends up here, and every answer is signature-
// checked.
//
// Wire format, verified against buzz @ df9e773a
// (crates/buzz-sdk/src/nip_oa.rs) and round-tripped through a live relay:
//
//   tag      = ["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>]
//   preimage = "nostr:agent-auth:" || agent_pubkey_hex || ":" || conditions
//   sig      = BIP-340 Schnorr over SHA256(preimage), by the OWNER's key
//
// The agent pubkey is inside the preimage but not inside the tag. That is what
// makes a stolen tag useless: verification re-derives the preimage from the
// pubkey of the profile you found the tag on, so pasting someone else's
// attestation onto your own profile changes the message and the signature
// stops matching.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (u8) => Buffer.from(u8).toString("hex");

// Conditions grammar (buzz nip_oa.rs): empty, or clause(&clause)* where a
// clause is kind=<0-65535>, created_at<<u32>, or created_at><u32>, in
// canonical decimal (no leading zeros). We validate rather than pass through:
// a malformed conditions string produces a tag the relay will reject, and
// finding that out at publish time is much worse than finding it out here.
const CLAUSES = [
  { prefix: "kind=", min: 0, max: 65535 },
  { prefix: "created_at<", min: 0, max: 4294967295 },
  { prefix: "created_at>", min: 0, max: 4294967295 },
];

export function validateConditions(conditions) {
  if (conditions === "") return;
  if (/\s/.test(conditions)) {
    throw new Error("conditions must not contain whitespace");
  }
  for (const clause of conditions.split("&")) {
    if (clause === "") {
      throw new Error("empty clause in conditions (leading, trailing or double '&')");
    }
    const match = CLAUSES.find((c) => clause.startsWith(c.prefix));
    if (!match) throw new Error(`unsupported clause in conditions: "${clause}"`);
    const value = clause.slice(match.prefix.length);
    const bad = (why) => new Error(`conditions: ${match.prefix} value ${why} ("${value}")`);
    if (value === "") throw bad("must not be empty");
    if (!/^[0-9]+$/.test(value)) throw bad("is not a valid decimal");
    if (value.length > 1 && value.startsWith("0")) throw bad("has a leading zero");
    const n = Number(value);
    if (n < match.min || n > match.max) throw bad("is out of range");
  }
}

function digest(agentPubkey, conditions) {
  return sha256(new TextEncoder().encode(`nostr:agent-auth:${agentPubkey}:${conditions}`));
}

// Sign an attestation binding `agentPubkey` to the owner holding
// `ownerPrivateKey`. Returns the tag as an array, ready to place in an event's
// `tags` (JSON.stringify it for BUZZ_AUTH_TAG, which wants the array form).
export function computeAuthTag({ ownerPrivateKey, agentPubkey, conditions = "" }) {
  if (!HEX64.test(ownerPrivateKey ?? "")) {
    throw new Error("ownerPrivateKey must be 64-char hex");
  }
  if (!HEX64.test(agentPubkey ?? "")) {
    throw new Error("agentPubkey must be 64-char hex");
  }
  validateConditions(conditions);

  const ownerPubkey = hex(schnorr.getPublicKey(bytes(ownerPrivateKey)));
  // An agent vouching for itself proves nothing — the whole point is that a
  // second party's key stands behind it. buzz rejects this too.
  if (ownerPubkey.toLowerCase() === agentPubkey.toLowerCase()) {
    throw new Error("owner and agent pubkeys must differ (self-attestation rejected)");
  }

  const sig = schnorr.sign(digest(agentPubkey, conditions), bytes(ownerPrivateKey));
  return ["auth", ownerPubkey, conditions, hex(sig)];
}

// Verify an attestation found on `agentPubkey`'s profile.
// Returns the owner's pubkey on success, or null. Never throws: this runs over
// data other people published, so malformed input is an expected case, not an
// error condition.
export function verifyAuthTag({ tag, agentPubkey }) {
  if (!Array.isArray(tag) || tag.length < 4) return null;
  const [label, ownerPubkey, conditions, sig] = tag;
  if (label !== "auth") return null;
  if (!HEX64.test(ownerPubkey ?? "") || !HEX128.test(sig ?? "")) return null;
  if (!HEX64.test(agentPubkey ?? "")) return null;
  if (typeof conditions !== "string") return null;
  try {
    validateConditions(conditions);
  } catch {
    return null;
  }
  // Self-attestation is refused on the read side too, so a forged profile
  // cannot declare itself its own owner and satisfy an ownership check.
  if (ownerPubkey.toLowerCase() === agentPubkey.toLowerCase()) return null;

  try {
    const ok = schnorr.verify(bytes(sig), digest(agentPubkey, conditions), bytes(ownerPubkey));
    return ok ? ownerPubkey.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Convenience for the launcher: BUZZ_AUTH_TAG wants the JSON array as a string.
export function authTagEnvValue(tag) {
  return JSON.stringify(tag);
}
