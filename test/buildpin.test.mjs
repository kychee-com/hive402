// FIX-97 (AC-40, AC-42): the build pin is ENFORCED, not merely printed.
//
// The confirmed gap: `doctor` computed the sha256 of `buzz.exe`/`buzz-acp.exe`
// and printed it with an unconditional `ok`. Buzz silently updated mid-project
// (2026-08-21) and doctor said `ok` before and after with different hashes —
// cycles 1-8 all ran against the older build without anyone being told.
//
// The rule: an optional `buzzBuild` config block records the expected build;
// `doctor` FAILs on mismatch naming both sides and pointing at the AC-42
// re-audit checklist; an ABSENT block is a visible warning that the room is
// unpinned — never a silent ok.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPinCheck } from "../src/node/doctor.mjs";
import { parseConfig } from "../src/config/schema.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);

const fp = (sha256) => ({ file: "x", size: 1, sha256, modified: "2026-08-30T00:00:00Z" });

// ── The comparison ─────────────────────────────────────────────────────────

test("FIX-97: no pin block → the room is reported UNPINNED, never a silent ok", () => {
  const check = buildPinCheck({ pin: null, fingerprints: { "buzz.exe": fp(A) } });
  assert.equal(check.state, "unpinned");
  assert.match(check.detail, /unpinned/i, "the word an operator can act on");
});

test("FIX-97: a matching pin reads as pinned, naming the version", () => {
  const check = buildPinCheck({
    pin: { version: "0.5.18", sha256: { "buzz.exe": A, "buzz-acp.exe": B } },
    fingerprints: { "buzz.exe": fp(A), "buzz-acp.exe": fp(B) },
  });
  assert.equal(check.state, "pinned");
  assert.equal(check.version, "0.5.18");
  assert.ok(check.results.every((r) => r.state === "match"));
});

test("FIX-97: drift FAILS, naming BOTH sides — this is the silent update that burned cycles 1-8", () => {
  const check = buildPinCheck({
    pin: { version: "0.5.18", sha256: { "buzz.exe": A } },
    fingerprints: { "buzz.exe": fp(B) },
  });
  assert.equal(check.state, "drift");
  const drifted = check.results.find((r) => r.name === "buzz.exe");
  assert.equal(drifted.state, "drift");
  assert.equal(drifted.expected, A, "the pinned hash");
  assert.equal(drifted.actual, B, "and the hash actually on disk");
});

test("FIX-97: a pinned binary that is MISSING is drift too, not a shrug", () => {
  const check = buildPinCheck({
    pin: { version: "0.5.18", sha256: { "buzz.exe": A, "buzz-acp.exe": B } },
    fingerprints: { "buzz.exe": fp(A) },
  });
  assert.equal(check.state, "drift");
  assert.equal(check.results.find((r) => r.name === "buzz-acp.exe").state, "missing");
});

// ── The config block ───────────────────────────────────────────────────────

const config = (buzzBuild) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: "9".repeat(64), privateKeyRef: "env:K" },
  rooms: [
    {
      channel: "c1",
      agents: [
        {
          name: "spike",
          pubkey: "4".repeat(64),
          ownerPubkey: "7".repeat(64),
          privateKeyRef: "env:A",
        },
      ],
    },
  ],
  ...(buzzBuild === undefined ? {} : { buzzBuild }),
});

test("FIX-97: the buzzBuild block parses — version plus per-binary sha256", () => {
  const parsed = parseConfig(config({ version: "0.5.18", sha256: { "buzz.exe": A, "buzz-acp.exe": B } }));
  assert.deepEqual(parsed.buzzBuild, { version: "0.5.18", sha256: { "buzz.exe": A, "buzz-acp.exe": B } });
});

test("FIX-97: absent block parses to null — the pin is optional, its absence is loud only in doctor", () => {
  assert.equal(parseConfig(config(undefined)).buzzBuild, null);
});

test("FIX-97: a malformed pin is refused at load, not discovered at doctor time", () => {
  assert.throws(() => parseConfig(config({ version: "", sha256: { "buzz.exe": A } })), /version/);
  assert.throws(() => parseConfig(config({ version: "0.5.18", sha256: {} })), /sha256/);
  assert.throws(() => parseConfig(config({ version: "0.5.18", sha256: { "buzz.exe": "zz" } })), /64/);
});
