import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { BECH32_REASONS, decodeBech32, wordsToBytes } from "../src/credentials/bech32.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";
import {
  bytesToHex,
  bytesToWords,
  encodeBech32,
  hexToBytes,
} from "../fixtures/bech32-encode.mjs";

// F-022 (fix cycle 13), DD-40.
//
// hive402 decodes bech32 itself rather than adding `@scure/base`, whose decoder
// interpolates the string it was given into two of its own error messages
// (`invalid string length: ${slen} (${str})` and `Invalid checksum in ${str}`,
// 1.2.6). On this path that string IS the owner's nsec, and `bin/cli.mjs` ends
// in `die(err.message)`. The full argument is DD-40; this file is the other half
// of it, because owning a decoder is only defensible if it is actually proved.
//
// Three layers, matching how BIP-173 itself is specified:
//
//   1. the published VALID checksum vectors — the checksum layer only, since
//      several of them are deliberately not a whole number of bytes;
//   2. the published INVALID vectors, each with the reason it must be refused
//      by, so a decoder that rejects everything cannot pass;
//   3. the 5-to-8 bit conversion, including the canonical zero-padding rule,
//      which is the one part of bech32 a hand-written decoder gets wrong.
//
// Then the NIP-19 vectors, which are the actual product requirement, and a
// structural guard that the module cannot build a string at all.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULE = path.join(ROOT, "src", "credentials", "bech32.mjs");

// The encoder used for the round trips lives in `fixtures/bech32-encode.mjs`,
// written independently of the module under test rather than sharing its
// polymod: a round trip through one implementation proves self-consistency, a
// round trip through two proves correctness. It found two transcription errors
// in the BIP-173 vectors below while this file was being written. It is in
// `fixtures/` and not `src/` because nothing in the product encodes, and an
// exported function with no production caller is this repo's most-repeated bug
// (see `test/reachability.test.mjs`).

// --- layer 1: BIP-173's published VALID checksum vectors --------------------
//
// These test the CHECKSUM and nothing else. Three of them carry a data part
// that is not a whole number of bytes, which is legal bech32 and is exactly why
// `decodeBech32` stops at words and `wordsToBytes` is a separate step.

const BIP173_VALID = [
  "A12UEL5L",
  "a12uel5l",
  "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
  "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
  `11${"q".repeat(82)}c8247j`, // BIP-173's 90-character case, at the limit
  "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
  "?1ezyfcl",
];

test("every BIP-173 valid-checksum vector decodes (F-022)", () => {
  for (const vector of BIP173_VALID) {
    const result = decodeBech32(vector);
    assert.equal(result.ok, true, `${vector} should decode, got reason ${result.reason}`);
    assert.equal(typeof result.hrp, "string");
    assert.ok(result.hrp.length >= 1);
    assert.ok(Array.isArray(result.words));
  }
});

test("a decoded HRP is lowercased, whatever case it arrived in (F-022)", () => {
  const lower = decodeBech32("a12uel5l");
  const upper = decodeBech32("A12UEL5L");
  assert.equal(lower.ok, true);
  assert.equal(upper.ok, true);
  assert.equal(upper.hrp, "a");
  assert.deepEqual(upper.words, lower.words);
});

test("the empty data part decodes to zero bytes, not to a failure (F-022)", () => {
  const result = decodeBech32("a12uel5l");
  assert.equal(result.ok, true);
  assert.deepEqual(result.words, []);
  const bytes = wordsToBytes(result.words);
  assert.equal(bytes.ok, true);
  assert.equal(bytes.bytes.length, 0);
});

// --- layer 2: BIP-173's published INVALID vectors, each with its reason ------
//
// The reason matters as much as the refusal. A decoder that answered
// "bad-checksum" to all twelve would pass a pass/fail list, and would then tell
// an owner their correctly-typed key was corrupt.

const BIP173_INVALID = [
  { vector: "\x201nwldj5", reason: "hrp-out-of-range", why: "HRP character 0x20" },
  { vector: "\x7f1axkwrx", reason: "hrp-out-of-range", why: "HRP character 0x7f" },
  { vector: "\x801eym55h", reason: "hrp-out-of-range", why: "HRP character 0x80" },
  {
    vector:
      "an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx",
    reason: "too-long",
    why: "overall max length exceeded",
  },
  { vector: "pzry9x0s0muk", reason: "no-separator", why: "no separator character" },
  { vector: "1pzry9x0s0muk", reason: "empty-hrp", why: "empty HRP" },
  { vector: "x1b4n0q5v", reason: "bad-charset", why: "invalid data character" },
  { vector: "li1dgmt3", reason: "data-too-short", why: "too short checksum" },
  { vector: "de1lg7wt\xff", reason: "bad-charset", why: "invalid character in checksum" },
  { vector: "A1G7SGD8", reason: "bad-checksum", why: "checksum calculated with uppercase HRP" },
  { vector: "10a06t8", reason: "empty-hrp", why: "empty HRP" },
  { vector: "1qzzfhee", reason: "empty-hrp", why: "empty HRP" },
];

test("every BIP-173 invalid vector is refused, for the RIGHT reason (F-022)", () => {
  for (const { vector, reason, why } of BIP173_INVALID) {
    const result = decodeBech32(vector);
    assert.equal(result.ok, false, `should have been refused (${why})`);
    assert.equal(result.reason, reason, `wrong reason for "${why}"`);
  }
});

test("a mixed-case string is refused as mixed-case, never silently folded (F-022)", () => {
  // Bech32 is case-insensitive as a WHOLE and mixed case is invalid, because
  // the checksum is computed over one casing. Folding it would accept a string
  // no other implementation accepts.
  for (const vector of ["A12Uel5l", "a12UEL5L", "Nsec1abc"]) {
    const result = decodeBech32(vector);
    assert.equal(result.ok, false, `${vector} is mixed case and must be refused`);
    assert.equal(result.reason, "mixed-case");
  }
});

test("the separator is the LAST 1, so an HRP may contain one (F-022)", () => {
  const result = decodeBech32(
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
  );
  assert.equal(result.ok, true);
  assert.equal(result.hrp, "split");
});

test("a non-string is refused without being coerced (F-022)", () => {
  for (const value of [undefined, null, 42, {}, ["nsec1"]]) {
    const result = decodeBech32(value);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-a-string");
  }
});

// --- layer 3: the 5-to-8 conversion and its padding rule --------------------

test("wordsToBytes converts whole bytes and refuses a partial one (F-022)", () => {
  // 8 words = 40 bits = 5 bytes exactly.
  const exact = wordsToBytes([31, 31, 31, 31, 31, 31, 31, 31]);
  assert.equal(exact.ok, true);
  assert.equal(exact.bytes.length, 5);
  assert.deepEqual([...exact.bytes], [0xff, 0xff, 0xff, 0xff, 0xff]);

  // One word is 5 bits: fewer than a byte, so the remainder is 5 bits, which is
  // more padding than bech32 permits.
  const tooMuchPadding = wordsToBytes([0]);
  assert.equal(tooMuchPadding.ok, false);
  assert.equal(tooMuchPadding.reason, "bad-padding");
});

test("wordsToBytes refuses NON-ZERO padding bits (F-022)", () => {
  // Two words = 10 bits = one byte with 2 bits left over. Those two bits are
  // `01` here, and a canonical encoding pads with zeroes only. This is the
  // check a hand-written convertbits forgets, and forgetting it would let two
  // different strings decode to the same key.
  const result = wordsToBytes([1, 1]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-padding");

  // The same length with zero padding is fine.
  const ok = wordsToBytes([1, 0]);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.bytes], [0b00001000]);
});

test("a valid-checksum string with bad padding is refused at the byte layer (F-022)", () => {
  // Built with the independent encoder, so the checksum is genuinely valid and
  // the ONLY thing wrong is the padding.
  const encoded = encodeBech32("nsec", [1, 1]);
  const decoded = decodeBech32(encoded);
  assert.equal(decoded.ok, true, "the checksum layer must accept it");
  const bytes = wordsToBytes(decoded.words);
  assert.equal(bytes.ok, false);
  assert.equal(bytes.reason, "bad-padding");
});

// --- the actual product requirement: NIP-19 -------------------------------
//
// The two published NIP-19 vectors. These are the reason this module exists.

const NIP19 = {
  nsec: {
    written: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    hex: "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa",
  },
  npub: {
    written: "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg",
    hex: "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e",
  },
};

test("the published NIP-19 nsec vector decodes to its published hex (F-022)", () => {
  const decoded = decodeBech32(NIP19.nsec.written);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.hrp, "nsec");
  const bytes = wordsToBytes(decoded.words);
  assert.equal(bytes.ok, true);
  assert.equal(bytes.bytes.length, 32);
  assert.equal(bytesToHex(bytes.bytes), NIP19.nsec.hex);
});

test("the published NIP-19 npub vector decodes to its published hex (F-022)", () => {
  const decoded = decodeBech32(NIP19.npub.written);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.hrp, "npub");
  const bytes = wordsToBytes(decoded.words);
  assert.equal(bytes.ok, true);
  assert.equal(bytesToHex(bytes.bytes), NIP19.npub.hex);
});

test("the NIP-19 vectors survive an encode/decode round trip (F-022)", () => {
  for (const { written, hex } of Object.values(NIP19)) {
    const hrp = written.slice(0, 4);
    const reEncoded = encodeBech32(hrp, bytesToWords(hexToBytes(hex)));
    assert.equal(reEncoded, written, "the independent encoder must reproduce the vector");
    const decoded = decodeBech32(reEncoded);
    assert.equal(decoded.ok, true);
    assert.equal(bytesToHex(wordsToBytes(decoded.words).bytes), hex);
  }
});

test("the two NIP-19 vectors are a matched keypair, which cross-checks both (F-022)", () => {
  // Noticed while debugging, and worth keeping: NIP-19's published nsec and its
  // published npub are the SAME identity. So decoding both and deriving one
  // from the other checks the decoder against two independent published values
  // at once — a convertbits bug would have to corrupt both consistently AND
  // land on a valid secp256k1 relationship to survive this.
  const secret = wordsToBytes(decodeBech32(NIP19.nsec.written).words).bytes;
  const expected = wordsToBytes(decodeBech32(NIP19.npub.written).words).bytes;
  assert.equal(derivePubkey(bytesToHex(secret)), bytesToHex(expected));
});

test("an uppercase nsec decodes to the same key as its lowercase form (F-022)", () => {
  // BIP-173 allows an all-uppercase encoding (for QR efficiency), and a user
  // whose terminal or clipboard uppercased a paste is holding the same key.
  const upper = decodeBech32(NIP19.nsec.written.toUpperCase());
  assert.equal(upper.ok, true);
  assert.equal(upper.hrp, "nsec");
  assert.equal(bytesToHex(wordsToBytes(upper.words).bytes), NIP19.nsec.hex);
});

test("one changed character breaks the checksum (F-022)", () => {
  // The whole point of bech32 over base32: a single-character typo is caught
  // rather than silently decoding to a different, unusable key.
  const written = NIP19.nsec.written;
  let refused = 0;
  for (let i = 5; i < written.length; i += 1) {
    const ch = written[i];
    const swap = ch === "q" ? "p" : "q";
    const broken = `${written.slice(0, i)}${swap}${written.slice(i + 1)}`;
    const result = decodeBech32(broken);
    assert.equal(result.ok, false, `a one-character change at ${i} must not decode`);
    assert.equal(result.reason, "bad-checksum");
    refused += 1;
  }
  assert.equal(refused, written.length - 5, "every position must have been tried");
});

// --- structural: the decoder cannot speak ----------------------------------
//
// DD-40's load-bearing property, and the reason a hand-written decoder is safer
// here than a dependency: this module has nothing to interpolate a secret INTO.
// `@scure/base` fails this test, which is the whole argument.

test("bech32.mjs contains no template literal and no Error (F-022, DD-40)", () => {
  const source = readFileSync(MODULE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  assert.doesNotMatch(
    source,
    /\$\{/,
    "bech32.mjs interpolates something into a string. It decodes private keys and " +
      "must have nothing for one to be interpolated into (DD-40).",
  );
  assert.doesNotMatch(
    source,
    /\bError\s*\(/,
    "bech32.mjs constructs an Error. It reports failure as a closed-vocabulary " +
      "reason code so the caller writes the sentence and the value never travels (DD-40).",
  );
  assert.doesNotMatch(
    source,
    /\bthrow\b/,
    "bech32.mjs throws. A pure decoder returns a result; a throw is how a value " +
      "reaches `die(err.message)` (DD-40).",
  );
});

test("every reason bech32.mjs can return is in its declared vocabulary (F-022)", () => {
  const source = readFileSync(MODULE, "utf8");

  // One construction point for every failure, so this scan cannot miss one.
  const bareFailures = [...source.matchAll(/ok:\s*false/g)].length;
  assert.equal(
    bareFailures,
    1,
    "a { ok: false } is built somewhere other than refuse(). Every failure must go " +
      "through the one helper, or the vocabulary scan below has a blind spot.",
  );

  const emitted = [...source.matchAll(/\brefuse\("([a-z-]+)"\)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 8, "expected the module to name its failure reasons inline");
  for (const reason of emitted) {
    assert.ok(
      BECH32_REASONS.includes(reason),
      `"${reason}" is returned but is not in BECH32_REASONS. The vocabulary is closed ` +
        `so that no failure can ever be described using the input.`,
    );
  }
  // And the declared vocabulary is not padded with reasons nothing returns —
  // a stale entry would make the check above pass for free.
  for (const declared of BECH32_REASONS) {
    assert.ok(emitted.includes(declared), `BECH32_REASONS declares "${declared}", unreachable`);
  }
});
