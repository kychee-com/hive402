import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ACCEPTED_PRIVATE_FORMS,
  ACCEPTED_PUBLIC_FORMS,
  explainKeyRefusal,
  normalizePrivateKey,
  normalizePublicKey,
} from "../src/credentials/keyforms.mjs";
import { BECH32_REASONS } from "../src/credentials/bech32.mjs";
import { corrupt, hexToBech32 } from "../fixtures/bech32-encode.mjs";

// F-022 (fix cycle 13), DD-40.
//
// The rule this file guards: wherever hive402 takes a key from a person, BOTH
// written forms of that key are accepted and normalised to the 64-char
// lowercase hex the store and the wire already use. Which form the user is
// holding is decided by the screen they copied it from, not by them — and the
// only screen Buzz Desktop ever shows a user their own key on renders an
// `nsec1…` (`PrivateKeyBackupRow` → `getNsec` → `NsecMaskedDisplay`).
//
// The second rule, which is the older one: a refused value is described by KIND
// and LENGTH and never by content (DD-31, F-016). That now has to hold across a
// decode as well — nothing decoded may be mentioned either, or the refusal
// becomes a partial-key oracle.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULE = path.join(ROOT, "src", "credentials", "keyforms.mjs");

const SECRET_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const SECRET_NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const PUBLIC_HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const PUBLIC_NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";

// --- the acceptance rule ----------------------------------------------------

test("a private key is accepted as nsec or as hex, and lands on the same value (F-022)", () => {
  const fromNsec = normalizePrivateKey(SECRET_NSEC);
  const fromHex = normalizePrivateKey(SECRET_HEX);

  assert.equal(fromNsec.ok, true);
  assert.equal(fromHex.ok, true);
  assert.equal(fromNsec.hex, SECRET_HEX);
  assert.equal(fromHex.hex, SECRET_HEX);
  assert.equal(fromNsec.hex, fromHex.hex, "the two written forms are the same key");
  assert.equal(fromNsec.form, "nsec");
  assert.equal(fromHex.form, "hex");
});

test("a public key is accepted as npub or as hex (F-022)", () => {
  assert.equal(normalizePublicKey(PUBLIC_NPUB).hex, PUBLIC_HEX);
  assert.equal(normalizePublicKey(PUBLIC_HEX).hex, PUBLIC_HEX);
  assert.equal(normalizePublicKey(PUBLIC_NPUB).form, "npub");
});

test("surrounding whitespace and uppercase are tolerated, mixed case is not (F-022)", () => {
  assert.equal(normalizePrivateKey(`  ${SECRET_NSEC}\n`).hex, SECRET_HEX);
  assert.equal(normalizePrivateKey(SECRET_NSEC.toUpperCase()).hex, SECRET_HEX);
  assert.equal(normalizePrivateKey(SECRET_HEX.toUpperCase()).hex, SECRET_HEX, "hex folds too");

  // Mixed case is invalid bech32, not a nuisance to paper over: the checksum is
  // computed over one casing, so folding it would accept a string no other
  // implementation accepts and could hide a corruption.
  const mixed = `${SECRET_NSEC.slice(0, 20).toUpperCase()}${SECRET_NSEC.slice(20)}`;
  const refused = normalizePrivateKey(mixed);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "mixed-case");
});

test("a hex key is returned lowercase, so the store holds one canonical form (F-022)", () => {
  assert.equal(normalizePrivateKey(SECRET_HEX.toUpperCase()).hex, SECRET_HEX);
  assert.match(normalizePrivateKey(SECRET_NSEC).hex, /^[0-9a-f]{64}$/);
});

// --- the refusals that will actually happen ---------------------------------

test("a one-character corruption of an nsec is refused by its checksum (F-022)", () => {
  for (let i = 5; i < SECRET_NSEC.length; i += 7) {
    const result = normalizePrivateKey(corrupt(SECRET_NSEC, i));
    assert.equal(result.ok, false, `a change at ${i} must not be accepted`);
    assert.equal(result.reason, "bad-checksum");
  }
});

test("an npub at the private-key prompt is refused AS A PUBLIC KEY (F-022)", () => {
  const result = normalizePrivateKey(PUBLIC_NPUB);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "public-key");

  const message = explainKeyRefusal({ reason: result.reason, described: "a 63-character value" });
  assert.match(message, /public/i, "the operator has to be told which key they pasted");
  assert.match(message, /nsec1/, "and what the right one looks like");
});

test("an nsec in a PUBLIC key field is refused as a private key in a config file (F-022)", () => {
  const result = normalizePublicKey(SECRET_NSEC);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "private-key");

  const message = explainKeyRefusal({
    reason: result.reason,
    described: "a 63-character value",
    kind: "public",
  });
  assert.match(message, /private/i);
  assert.match(message, /config|file/i, "the danger is that it would be written to disk");
});

test("an ncryptsec encrypted backup is refused with somewhere to go (F-022)", () => {
  // Buzz offers an encrypted backup on the same settings screen as the nsec, so
  // this is a realistic paste rather than a hypothetical one.
  const result = normalizePrivateKey(`ncryptsec1${"q".repeat(152)}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "encrypted-backup");

  const message = explainKeyRefusal({ reason: result.reason, described: "a 162-character value" });
  assert.match(message, /passphrase|encrypted/i);
  assert.match(message, /nsec1/, "it must point at the form that does work");
});

test("a bech32 payload that is not 32 bytes is refused (F-022)", () => {
  const short = hexToBech32("nsec", "0011223344556677");
  const result = normalizePrivateKey(short);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong-length");
});

test("nsec-prefixed text whose real HRP is something else is refused (F-022)", () => {
  // The separator is the LAST "1", so `nsec1abc1…` has the HRP `nsec1abc`. A
  // prefix check alone would have called this an nsec.
  const written = hexToBech32("nsec1abc", SECRET_HEX);
  assert.ok(written.startsWith("nsec1abc1"));
  const result = normalizePrivateKey(written);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong-prefix");
});

test("empty, blank and unrecognised inputs each get their own reason (F-022)", () => {
  assert.equal(normalizePrivateKey("").reason, "empty");
  assert.equal(normalizePrivateKey("   \n ").reason, "empty");
  assert.equal(normalizePrivateKey(undefined).reason, "empty");
  assert.equal(normalizePrivateKey("nope").reason, "unrecognised");
  assert.equal(normalizePrivateKey("a".repeat(63)).reason, "unrecognised");
  assert.equal(normalizePrivateKey("z".repeat(64)).reason, "unrecognised");
});

// --- the refusal may never carry the value (DD-31, F-016, and now a decode) --

test("no refusal message contains the input or anything decoded from it (F-022)", () => {
  const hostile = [
    SECRET_NSEC,
    corrupt(SECRET_NSEC),
    SECRET_NSEC.slice(0, 40),
    `${SECRET_NSEC}extra`,
    SECRET_HEX.slice(0, 63),
    `${SECRET_HEX}f`,
    PUBLIC_NPUB,
    `ncryptsec1${"q".repeat(152)}`,
    hexToBech32("nsec", "0011223344556677"),
  ];

  for (const value of hostile) {
    for (const kind of ["private", "public"]) {
      const parsed = kind === "private" ? normalizePrivateKey(value) : normalizePublicKey(value);
      if (parsed.ok) continue;
      const message = explainKeyRefusal({
        reason: parsed.reason,
        described: `a ${value.length}-character value`,
        kind,
      });

      assert.ok(!message.includes(value), "the whole value reached the message");
      // Any run of 12 characters of it is already a partial-key oracle.
      for (let i = 0; i + 12 <= value.length; i += 4) {
        assert.ok(
          !message.includes(value.slice(i, i + 12)),
          `a fragment of the input at offset ${i} reached the message`,
        );
      }
      // And nothing DECODED, which is the new way to leak: the hex behind the
      // nsec never appears even when the decode succeeded and a later check
      // failed.
      assert.ok(!message.includes(SECRET_HEX), "the decoded key reached the message");
      assert.ok(!message.includes(SECRET_HEX.slice(0, 16)), "part of the decoded key did");
    }
  }
});

test("explainKeyRefusal has no way to be handed the value in the first place (F-022)", () => {
  // Structural, and the point of the signature: the builder takes a DESCRIPTION
  // string, never the value, so no future edit can reach for the content. This
  // is DD-30's "remove the value from the string" rather than "remember to
  // redact it".
  const source = readFileSync(MODULE, "utf8");
  const signature = /export function explainKeyRefusal\(\{([^}]*)\}/.exec(source);
  assert.ok(signature, "explainKeyRefusal must take a single options object");
  const parameters = signature[1];
  for (const banned of ["value", "written", "raw", "input", "key", "hex", "words", "bytes"]) {
    assert.ok(
      !new RegExp(`\\b${banned}\\b`).test(parameters),
      `explainKeyRefusal accepts "${banned}". It may only ever be given a description.`,
    );
  }
});

test("every reason a normalizer can return has a message (F-022)", () => {
  // A reason with no branch would fall through to a generic sentence, which is
  // how F-016 happened: the unrecognised case inherited the wrong default.
  const source = readFileSync(MODULE, "utf8");
  const reasons = new Set([...source.matchAll(/\brefuse\("([a-z-]+)"\)/g)].map((m) => m[1]));
  // Plus everything bech32 can hand back, which is passed through unchanged —
  // including the ones that land on the default branch, which must still read
  // as a sentence rather than as a fallthrough.
  for (const passthrough of BECH32_REASONS) reasons.add(passthrough);
  assert.ok(reasons.size >= 12, `only found ${reasons.size} reasons to check`);

  for (const reason of reasons) {
    for (const kind of ["private", "public"]) {
      const message = explainKeyRefusal({ reason, described: "a 12-character value", kind });
      assert.equal(typeof message, "string");
      assert.ok(message.length > 20, `reason "${reason}" (${kind}) produced no real sentence`);
      assert.ok(
        !message.includes("undefined"),
        `reason "${reason}" (${kind}) fell through with an undefined in it`,
      );
    }
  }
});

test("the accepted-forms strings name both forms, for prompts and help text (F-022)", () => {
  assert.match(ACCEPTED_PRIVATE_FORMS, /nsec1/);
  assert.match(ACCEPTED_PRIVATE_FORMS, /64-char hex/);
  assert.match(ACCEPTED_PUBLIC_FORMS, /npub1/);
  assert.match(ACCEPTED_PUBLIC_FORMS, /64-char hex/);
});
