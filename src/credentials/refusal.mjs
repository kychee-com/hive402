// How hive402 talks about a value it refused (DD-31, F-016).
//
// The rule, in one line: **a field that could hold a secret is refused by KIND
// and LENGTH, never by value.**
//
// Fix cycle 8 stopped `privateKeyRef` echoing a pasted key by RECOGNISING key
// material — exactly 64 hex characters, or `nsec1…` — and branching to a
// redacting message. Everything the detector did not recognise fell through to
// the older message, which ended `(got "${the value}")`. So 64 hex characters
// were redacted and **63 or 65 were printed verbatim** (F-016): one dropped or
// duplicated character, which is the single most common copy-paste accident for
// a fixed-length hex string, and the near-key went to terminal scrollback, CI
// logs and pasted bug reports.
//
// The lesson is that recognising the secret is a denylist over an infinite input
// space, and F-016 is what its first gap costs. Widening the detector to 60-70
// characters would be the same mistake with a wider window. So the DEFAULT is
// inverted here: nothing is echoed, and the detector survives only to make an
// already-safe message more useful.
//
// This module deliberately exports no way to render a value's content. There is
// nothing to reach for when the next message is written.

const HEX64 = /^[0-9a-f]{64}$/i;
const NSEC = /^nsec1[0-9a-z]{6,}$/i;
const NPUB = /^npub1[0-9a-z]{6,}$/i;

// What a key REFERENCE may be, in ONE place, because the config parser and the
// runtime resolver both decide it and they have to agree. They did not: the
// schema required a real variable name after `env:`, the resolver accepted any
// suffix at all, and the looser check was reachable from `register --sponsor`.
// Two validators disagreeing about the same string is how the stricter one gets
// bypassed — the same lesson DD-30 learned about identity names.
//
// The LENGTH BOUND is the load-bearing part, and it is a whitelist rather than
// a detector. "environment variable HIVE402_SPIKE_KEY is not set" has to name
// the variable — that is the whole diagnostic, and a room with five agents is
// unreadable without it. But a pasted key is itself a legal variable name
// (`^[0-9a-f]{64}$` is letters and digits starting with a letter), so an
// unbounded name is an unbounded echo. 48 characters is comfortably above any
// real name (`HIVE402_SPIKE2_PRIVATE_KEY` is 26) and below every key shape this
// product handles: a 64-character hex key and a 63-character `nsec1…` both fall
// outside it, and 48 hex characters is 192 bits, which is not a secp256k1 key.
// So what may be echoed is only ever drawn from a domain a key cannot enter.
export const ENV_VAR_NAME_MAX = 48;
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
export const KEY_REFERENCE = /^(keychain|env:[A-Za-z_][A-Za-z0-9_]{0,47})$/;

// Recognisable key material, used ONLY to upgrade a refusal's advice ("that is
// a KEY — store it with `hive402 keys import`") — never to decide whether it is
// safe to echo. Both branches are safe; this one is merely more helpful.
export function looksLikeKeyMaterial(value) {
  const written = String(value ?? "").trim();
  return HEX64.test(written) || NSEC.test(written);
}

// A PUBLIC key, which is a different question and deliberately a separate one
// (F-022, fix cycle 13).
//
// Widening `looksLikeKeyMaterial` to cover `npub1…` was the obvious move and is
// wrong: its two other callers refuse a key REFERENCE with the sentence "that is
// a private KEY, not a reference to one", and an npub is not private. A
// predicate that makes one caller better by making two others say something
// false is not an improvement.
//
// What this is for is the WRONG-FIELD mistake. An npub is safe to print, so it
// is not a disclosure — but an identity name sits one line from `pubkey` in the
// same config, and "npub1vl029mg…" is a legal agent name under the charset and
// the cap. Accepting it silently gives the owner a room where the agent is
// addressed by its own public key.
export function looksLikePublicKeyMaterial(value) {
  return NPUB.test(String(value ?? "").trim());
}

// Kind and length, and nothing else. Enough for the three real mistakes on a
// key-reference field — a pasted key (length 64, usually also named as key
// material), a typo in the literal `keychain`/`env:VAR` (short), and a path to a
// key file (long) — while the operator has the file open in front of them.
export function describeRefusedValue(value) {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length} items`;
  if (typeof value !== "string") return `a ${typeof value} value`;
  if (value === "") return "an empty string";
  if (value.trim() === "") return `${value.length} characters of whitespace`;
  return `a ${value.length}-character value`;
}

// The sentence that stops an operator re-running the command somewhere louder
// to "see the real error". Every refusal built on this module says it.
export const NOT_PRINTED = "The value has NOT been echoed here: if that was a key, it has not been printed.";
