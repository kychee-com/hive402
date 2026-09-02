// Signing a Nostr event.
//
// hive402 publishes almost everything through the `buzz` CLI, which holds the
// key and signs — that is DD-13, and it is still the rule. Two things cannot go
// that way, and they are the reason this exists:
//
//   NIP-98 HTTP auth (kind 27235)   `buzz` has no invite verb at all, and the
//                                   relay's join routes are plain HTTP outside
//                                   the Nostr data plane.
//   The managed-agent record (30177) `buzz` has no verb for it either. It is
//                                   what a client's @ picker is built from, and
//                                   without it a hive402 agent is unpickable
//                                   even while sitting in the channel.
//
// Both are the SAME operation — serialise, hash, sign — and having two copies
// of it is how one of them quietly grows a different id calculation. The
// failure mode there is a 401 whose message is about a Schnorr signature, which
// sends the reader to look at the key.

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HEX64 = /^[0-9a-f]{64}$/i;

const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (u8) => Buffer.from(u8).toString("hex");

export const digestHex = (text) => hex(sha256(new TextEncoder().encode(text)));

// NIP-01: the id is the SHA-256 of a canonical JSON ARRAY, not of the event
// object. Anything else verifies nowhere.
export function eventId({ pubkey, created_at, kind, tags, content }) {
  return digestHex(JSON.stringify([0, pubkey, created_at, kind, tags, content]));
}

export function pubkeyOf(privateKeyHex) {
  if (!HEX64.test(privateKeyHex ?? "")) throw new Error("signing key must be 64-char hex");
  return hex(schnorr.getPublicKey(bytes(privateKeyHex)));
}

// `now` is milliseconds, `created_at` is SECONDS. A relay checking a ±60 second
// window against a millisecond value rejects every time, reporting a delta
// measured in tens of thousands of years.
export function signEvent({ privateKeyHex, kind, tags = [], content = "", now = Date.now() }) {
  const unsigned = {
    pubkey: pubkeyOf(privateKeyHex),
    created_at: Math.floor(now / 1000),
    kind,
    tags,
    content,
  };
  const id = eventId(unsigned);
  return { id, ...unsigned, sig: hex(schnorr.sign(bytes(id), bytes(privateKeyHex))) };
}
