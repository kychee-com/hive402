// What a key may LOOK like when a person hands hive402 one (F-022, DD-40).
//
// A Nostr key has two written forms and they are the same key: 64 characters of
// hex, or bech32 with a `nsec`/`npub` prefix (NIP-19). Which one a person is
// holding is decided by the screen they copied it from, not by them — and the
// only place Buzz Desktop ever shows a user their own key is the private-key
// backup row, which renders an `nsec1…`. Until fix cycle 13 hive402 recognised
// that exact string and refused it with "decode it first", which is advice with
// no in-product answer: every way to follow it involves pasting a live private
// key into something else.
//
// So this module is the ONE place that decides what a key may look like, for
// all four entry points that take one — `keys import`, the `env:` resolver, and
// the config's `pubkey` / `ownerPubkey`. One place on purpose: the config parser
// and the runtime resolver already disagreed once about a key REFERENCE, and the
// looser of the two was the reachable one (DD-31). Two validators disagreeing
// about the same string is how the stricter one gets bypassed.
//
// The refusal discipline is unchanged and now has to survive a decode as well:
// a refused value is described by KIND and LENGTH and never by content
// (DD-31, F-016), and nothing DECODED is mentioned either. A message that said
// "that decodes to 0x67de…" would be a partial-key oracle built out of a
// helpful diagnostic.

import { decodeBech32, wordsToBytes } from "./bech32.mjs";
import { NOT_PRINTED } from "./refusal.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;

// secp256k1: both a secret key and an x-only public key are 32 bytes.
const KEY_BYTES = 32;

// NIP-49. An encrypted backup needs the passphrase it was made with, and Buzz
// offers one on the same settings screen as the plain nsec — so this is a
// realistic paste, and "not a key" would be a bafflingly wrong thing to say
// about it.
const NCRYPTSEC_PREFIX = "ncryptsec1";

export const ACCEPTED_PRIVATE_FORMS = "an nsec1… or a 64-char hex private key";
export const ACCEPTED_PUBLIC_FORMS = "an npub1… or a 64-char hex public key";

const FORMS = {
  private: { hrp: "nsec", other: "npub", accepted: ACCEPTED_PRIVATE_FORMS, subject: "private key" },
  public: { hrp: "npub", other: "nsec", accepted: ACCEPTED_PUBLIC_FORMS, subject: "public key" },
};

function refuse(reason) {
  return { ok: false, reason };
}

function toHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

// Shared by both directions. `expected` is the prefix this field wants; the
// wrong one has already been caught by the caller, so anything that gets here
// and decodes under a different HRP is genuinely malformed rather than a
// recognisable mistake.
function fromBech32(written, expected) {
  const outcome = decodeBech32(written);
  if (!outcome.ok) return refuse(outcome.reason);
  if (outcome.hrp !== expected) return refuse("wrong-prefix");

  const payload = wordsToBytes(outcome.words);
  if (!payload.ok) return refuse(payload.reason);
  if (payload.bytes.length !== KEY_BYTES) return refuse("wrong-length");

  return { ok: true, hex: toHex(payload.bytes), form: expected };
}

function normalize(value, kind) {
  const { hrp, other } = FORMS[kind];
  const written = String(value ?? "").trim();

  if (written === "") return refuse("empty");
  // Hex first: it is the canonical form, the one already in every config and
  // every credential-store entry, and it costs one regex.
  if (HEX64.test(written)) return { ok: true, hex: written.toLowerCase(), form: "hex" };

  // Identify by PREFIX, before any decode. A wrong-key-kind paste is the
  // mistake worth naming precisely, and naming it must not depend on the
  // checksum being intact — someone who pastes their npub where their nsec goes
  // deserves to be told so even if they truncated it.
  const opening = written.slice(0, NCRYPTSEC_PREFIX.length).toLowerCase();
  if (opening.startsWith(NCRYPTSEC_PREFIX)) return refuse("encrypted-backup");
  if (opening.startsWith(`${other}1`)) return refuse(other === "npub" ? "public-key" : "private-key");
  if (opening.startsWith(`${hrp}1`)) return fromBech32(written, hrp);

  return refuse("unrecognised");
}

/** A private key as the store wants it: 64 lowercase hex characters. */
export function normalizePrivateKey(value) {
  return normalize(value, "private");
}

/** A public key as the config and the relay want it: 64 lowercase hex characters. */
export function normalizePublicKey(value) {
  return normalize(value, "public");
}

// The sentence for a refusal.
//
// It takes a DESCRIPTION, never the value. That is the signature doing the work
// rather than a rule someone has to remember: there is no parameter here that
// could hold key material, so no future edit of these messages can reach for
// the content the way F-016's message did. Callers build `described` with
// `describeRefusedValue`, which knows only kind and length.
export function explainKeyRefusal({ reason, described, kind = "private" }) {
  const { accepted, subject, hrp } = FORMS[kind] ?? FORMS.private;
  const tail = NOT_PRINTED;

  switch (reason) {
    case "empty":
      return `no key entered — expected ${accepted}.`;

    case "public-key":
      return (
        `that is a PUBLIC key (npub1…), not a private one. A private key starts "nsec1…" — ` +
        `in Buzz it is in Settings, behind the private-key backup row. ${tail}`
      );

    case "private-key":
      return (
        `that is a PRIVATE key (nsec1…). A private key must never be written into a config ` +
        `file — this field wants the PUBLIC key, ${accepted}. If it has been in a file, treat ` +
        `it as exposed and replace the identity. ${tail}`
      );

    case "encrypted-backup":
      return (
        `that is an "ncryptsec1…" encrypted backup, which only opens with the passphrase it ` +
        `was made with, and hive402 cannot open one. In Buzz, take the plain "nsec1…" from ` +
        `the private-key backup row on the same screen. ${tail}`
      );

    case "mixed-case":
      return (
        `that ${subject} mixes upper and lower case. bech32 is case-insensitive as a whole ` +
        `but may not be mixed, so it cannot be checked for typos as written — copy it again, ` +
        `unaltered. ${tail}`
      );

    case "bad-checksum":
      return (
        `that ${subject} failed its bech32 checksum, so at least one character is wrong or ` +
        `missing. That is the checksum doing its job: copy it again rather than editing it. ` +
        `${tail}`
      );

    case "bad-charset":
      return (
        `that ${subject} contains characters bech32 does not use — "1", "b", "i" and "o" are ` +
        `excluded from the alphabet precisely because they are misread. Copy it again. ${tail}`
      );

    case "wrong-prefix":
      return (
        `that is bech32, but not a "${hrp}1…" value — the prefix says what kind of thing it ` +
        `is, and this field wants ${accepted}. ${tail}`
      );

    case "wrong-length":
    case "bad-padding":
      return (
        `that decodes, but not to a 32-byte key, so it is not a Nostr ${subject}. ${tail}`
      );

    case "unrecognised":
      return `that is not ${accepted} (got ${described}). ${tail}`;

    default:
      // Everything bech32 can still refuse — too long, no separator, an empty
      // or out-of-range prefix, a truncated checksum. Individually they are
      // less useful to an operator than "this is not well-formed", and none of
      // them may be explained by quoting the part that was wrong.
      return `that is not a well-formed key — expected ${accepted} (got ${described}). ${tail}`;
  }
}
