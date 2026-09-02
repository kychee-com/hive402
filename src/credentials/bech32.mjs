// bech32 decoding (BIP-173), because a key written as `nsec1…` is the same key
// as its hex and hive402 refused to read one of the two (F-022, DD-40).
//
// WHY THIS IS HERE AND NOT A DEPENDENCY. The obvious choice was `@scure/base`:
// same author as `@noble/curves`, audited, and bech32 is exactly its job. It was
// rejected after reading it. Version 1.2.6 throws
// "invalid string length: <len> (<the string>)" and
// "Invalid checksum in <the string>", interpolating the value it was handed. On
// this path that value is the owner's private key, and `bin/cli.mjs` ends in
// `die(err.message)` — so the two most likely failure modes of a pasted key, a
// truncated one and a mistyped one, would each print it. Those are F-014 and
// F-016 re-imported, into the module family that has already produced a P0 in
// two consecutive fix cycles. Worse, layer 3 of `test/f014-secret-leak.test.mjs`
// scans this directory and is structurally blind to `node_modules`, so the guard
// that exists for exactly this class would stop at the module boundary.
//
// So: THIS MODULE CANNOT SPEAK. It builds no string, constructs no Error and
// throws nothing. A failure is a `reason` from a closed vocabulary and the
// caller writes the sentence — the same discipline `keychain.mjs` applies to a
// child process's marker line (DD-30), applied to a pure function.
// `test/bech32.test.mjs` asserts that structurally, and asserts the vocabulary
// is exactly what the code can return.
//
// The decode is split where BIP-173 splits it. `decodeBech32` verifies the
// checksum and returns 5-bit words; `wordsToBytes` does the 5-to-8 conversion.
// That is not decoration: three of BIP-173's own valid-checksum vectors carry a
// data part that is not a whole number of bytes, so a single function returning
// bytes could not be tested against the published list at all.

// Every way this module can fail. Closed on purpose: a caller can exhaustively
// map these to sentences, and no input can invent a new one.
export const BECH32_REASONS = Object.freeze([
  "not-a-string",
  "too-long",
  "mixed-case",
  "no-separator",
  "empty-hrp",
  "hrp-out-of-range",
  "data-too-short",
  "bad-charset",
  "bad-checksum",
  "bad-padding",
]);

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// BIP-173's overall bound. Both forms hive402 reads (nsec, npub) are 63
// characters, so this is slack rather than a constraint — but it is the
// specified behaviour and it bounds the work done on hostile input. If hive402
// ever needs NIP-19's TLV forms (nprofile, nevent), which deliberately exceed
// 90, this becomes a parameter rather than a deletion.
const MAX_LENGTH = 90;

// The checksum is six characters; anything shorter has no data at all.
const CHECKSUM_LENGTH = 6;

// A human-readable part is US-ASCII 33..126 (BIP-173). The bound is what makes
// the separator search safe: outside it, the string is not bech32 at all.
const HRP_MIN_CODE = 33;
const HRP_MAX_CODE = 126;

const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < GENERATORS.length; i += 1) {
      if ((top >>> i) & 1) checksum ^= GENERATORS[i];
    }
  }
  return checksum >>> 0;
}

function expandHrp(hrp) {
  const out = [];
  for (const character of hrp) out.push(character.charCodeAt(0) >>> 5);
  out.push(0);
  for (const character of hrp) out.push(character.charCodeAt(0) & 31);
  return out;
}

function refuse(reason) {
  return { ok: false, reason };
}

// Verify the checksum and hand back the human-readable part plus the 5-bit data
// words, with the checksum already removed.
//
// Deliberately does NOT trim: trimming is the caller's decision about user
// input, and doing it here would silently accept a leading space as part of an
// HRP that BIP-173 says is out of range.
export function decodeBech32(text) {
  if (typeof text !== "string") return refuse("not-a-string");
  if (text.length > MAX_LENGTH) return refuse("too-long");

  // Case-insensitive as a WHOLE, and mixed case is invalid — the checksum is
  // computed over one casing, so folding a mixed-case string would accept
  // something no other implementation accepts and could mask a corruption.
  const lowered = text.toLowerCase();
  if (text !== lowered && text !== text.toUpperCase()) return refuse("mixed-case");

  // The LAST separator, because an HRP may legally contain a "1" (BIP-173's own
  // `split1check…` vector does).
  const separator = lowered.lastIndexOf("1");
  if (separator < 0) return refuse("no-separator");

  const hrp = lowered.slice(0, separator);
  if (hrp.length === 0) return refuse("empty-hrp");

  const data = lowered.slice(separator + 1);
  if (data.length < CHECKSUM_LENGTH) return refuse("data-too-short");

  for (const character of hrp) {
    const code = character.charCodeAt(0);
    if (code < HRP_MIN_CODE || code > HRP_MAX_CODE) return refuse("hrp-out-of-range");
  }

  const values = [];
  for (const character of data) {
    const value = CHARSET.indexOf(character);
    if (value < 0) return refuse("bad-charset");
    values.push(value);
  }

  if (polymod([...expandHrp(hrp), ...values]) !== 1) return refuse("bad-checksum");

  return { ok: true, hrp, words: values.slice(0, values.length - CHECKSUM_LENGTH) };
}

// 5-bit words to bytes, with BIP-173's canonical padding rule.
//
// The padding rule is the whole reason this is not three lines. A group of
// leftover bits must be fewer than 5 and must be zero. Skip that and two
// different strings decode to the same key, which for a key import means an
// owner can store an identity they cannot reproduce.
export function wordsToBytes(words) {
  let accumulator = 0;
  let bits = 0;
  const bytes = [];

  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }

  if (bits >= 5) return refuse("bad-padding");
  if (((accumulator << (8 - bits)) & 0xff) !== 0) return refuse("bad-padding");

  return { ok: true, bytes: Uint8Array.from(bytes) };
}
