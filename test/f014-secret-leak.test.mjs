import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { osKeychain } from "../src/credentials/keychain.mjs";
import { CredentialStore } from "../src/credentials/store.mjs";
import { importPrivateKey, keygen, generateSecretKey, derivePubkey } from "../src/credentials/keys.mjs";
import { assertIdentityName } from "../src/credentials/names.mjs";
import { parseConfig } from "../src/config/schema.mjs";
import { makeKeyResolver } from "../src/node/runtime.mjs";

// F-014 (P0, system test cycle 5) and the bug class behind it.
//
// `hive402 keygen --agent <a 300-character name>` printed the freshly generated
// private key to stderr. The credential-store file path blew past Windows'
// 260-character MAX_PATH, `WriteAllBytes` threw, and `execFile`'s rejection
// message is `Command failed: <the whole command line>\n<the child's stderr>` —
// where the command line was the PowerShell script, and the script contained
// `[Convert]::FromBase64String('<the secret>')`. `bin/cli.mjs` ends in
// `die(err.message)`, so the key went straight to the terminal, contradicting
// the CLI's own printed promise that it is "never printed, never returned and
// never written to a file".
//
// Reproduced first-hand before this fix: one base64 blob in stderr, decoding to
// a 64-hex private key.
//
// The class, not the instance (DD-30): "a secret reaches a printable sink."
// These tests come in three layers, deliberately, because each catches
// something the others cannot:
//
//   1. the REAL DPAPI backend, driven into a REAL write failure — the layer
//      that must hold even when name validation is bypassed;
//   2. the REAL CLI, spawned, with F-014's exact input — the layer the Red Team
//      actually drove;
//   3. a structural scan of `src/credentials/*.mjs` — the layer that fails if
//      the bug class returns in code nobody thought to test.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "cli.mjs");
const CREDENTIALS_DIR = path.join(ROOT, "src", "credentials");

const REAL_BACKEND = process.platform === "win32" ? osKeychain() : null;
const realOnly = { skip: REAL_BACKEND ? false : "real credential backend is Windows-only in this suite" };

// --- the leak detector, used by every behavioural test below ----------------
//
// Three independent shapes, because the leak arrived base64-wrapped: a naive
// "does it contain the key" check would have passed the original bug.
function keyMaterialIn(text, knownSecret = null) {
  const found = [];
  const s = String(text ?? "");

  if (knownSecret && s.includes(knownSecret)) found.push("the secret verbatim");
  if (knownSecret && s.includes(Buffer.from(knownSecret, "utf8").toString("base64"))) {
    found.push("the secret base64-encoded");
  }
  // Anything that decodes to a 64-char hex private key, whatever produced it.
  for (const blob of s.match(/[A-Za-z0-9+/]{80,}={0,2}/g) ?? []) {
    let decoded;
    try {
      decoded = Buffer.from(blob, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (/^[0-9a-f]{64}$/.test(decoded)) found.push("a base64 blob decoding to a 64-hex key");
  }
  // A bare private key, in case a future change stops encoding it.
  if (/\b[0-9a-f]{64}\b/.test(s)) found.push("a bare 64-hex string");
  return found;
}

// The script's own landmarks. If any of these reach an operator, the error path
// is quoting the script again — which is how the secret escaped the first time,
// so it fails here even when this particular script happens to hold no secret.
function scriptTextIn(text) {
  return (String(text ?? "").match(/FromBase64String|ProtectedData|WriteAllBytes|Command failed:/g) ?? [])
    .filter((v, i, a) => a.indexOf(v) === i);
}

// `assert.rejects` resolves to undefined, so it cannot hand back the error these
// tests exist to inspect. This does both: it fails if nothing threw, and it
// returns what did.
async function rejection(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection, got none");
}

// --- layer 1: the real backend, driven into a real failure ------------------

test("a failing real-backend write never carries the secret (F-014)", realOnly, async () => {
  const kc = REAL_BACKEND;
  // A KNOWN secret, so the assertion is exact rather than pattern-shaped.
  const secret = "b".repeat(32) + "a".repeat(32);
  assert.match(secret, /^[0-9a-f]{64}$/);

  // Long enough that the credential file path exceeds MAX_PATH — the exact
  // mechanism F-014 used. This bypasses the name validation added in this cycle
  // on purpose: the backend has to be safe by itself, not only behind a guard.
  const account = `hive402-test-f014-${"a".repeat(300)}`;

  const err = await rejection(() => kc.set("hive402:test-f014", account, secret));

  const leaked = keyMaterialIn(`${err.message}\n${err.stack}`, secret);
  assert.deepEqual(leaked, [], `the error carried key material: ${leaked.join(", ")}`);

  const quoted = scriptTextIn(err.message);
  assert.deepEqual(quoted, [], `the error quoted the script: ${quoted.join(", ")}`);
});

test("a failing real-backend write still says what went wrong (F-014)", realOnly, async () => {
  const kc = REAL_BACKEND;
  const account = `hive402-test-f014b-${"a".repeat(300)}`;
  const err = await rejection(() => kc.set("hive402:test-f014", account, "c".repeat(64)));

  // Sanitized does not mean useless: the operation, a classified cause and the
  // exit code all survive. An operator given only "it failed" files a bug about
  // the diagnostic instead of fixing their name.
  assert.match(err.message, /credential store/i);
  assert.match(err.message, /write/i);
  assert.match(err.message, /too long|PathTooLong/i, `unhelpful message: ${err.message}`);
});

// The properties an error object carries are as printable as its message: a
// caller doing `console.error(err)` or `JSON.stringify(err)` gets them all.
test("the thrown error object carries no child-process fields at all", realOnly, async () => {
  const kc = REAL_BACKEND;
  const secret = "d".repeat(64);
  const account = `hive402-test-f014c-${"a".repeat(300)}`;
  const err = await rejection(() => kc.set("hive402:test-f014", account, secret));

  for (const field of ["stdout", "stderr", "cmd", "spawnargs"]) {
    assert.equal(err[field], undefined, `the sanitized error must not carry .${field}`);
  }
  const dump = [err.message, err.stack, JSON.stringify(err, Object.getOwnPropertyNames(err))].join("\n");
  assert.deepEqual(keyMaterialIn(dump, secret), [], "a full dump of the error must be clean");
});

// The read path's stdout IS the secret, so absence must stay a quiet null
// rather than an error carrying whatever the child said.
test("a missing entry reads back as null, not as an error", realOnly, async () => {
  const kc = REAL_BACKEND;
  const account = `hive402-test-f014d-${"a".repeat(300)}`;
  assert.equal(await kc.get("hive402:test-f014", account), null);
});

// --- layer 2: the real CLI, F-014's exact input -----------------------------

test("the real CLI's F-014 repro prints no key material (F-014)", () => {
  const name = `redteam-c5-${"a".repeat(300)}`;
  const r = spawnSync(process.execPath, [CLI, "keygen", "--agent", name], {
    encoding: "utf8",
    env: { ...process.env },
  });

  const output = `${r.stderr}\n${r.stdout}`;
  const leaked = keyMaterialIn(output);
  assert.deepEqual(leaked, [], `the CLI printed key material: ${leaked.join(", ")}`);

  const quoted = scriptTextIn(output);
  assert.deepEqual(quoted, [], `the CLI quoted its own script: ${quoted.join(", ")}`);

  assert.notEqual(r.status, 0, "an unusable name must fail");
  // And it must fail for the RIGHT reason: the name, named as the problem,
  // rather than an incidental path error several layers down.
  assert.match(r.stderr, /name/i);
  assert.match(r.stderr, /64|too long|length/i, `stderr should explain the limit: ${r.stderr}`);
});

// --- the guard that makes the failure unreachable, not merely non-leaking ---

test("keygen refuses an unusable name BEFORE generating a key", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  let generated = 0;
  const generate = () => {
    generated += 1;
    return generateSecretKey();
  };

  await assert.rejects(
    () => keygen({ store, target: { kind: "agent", name: "a".repeat(300) }, log: () => {}, generate }),
    /name/i,
  );
  // The whole point: a name that cannot be stored must never have a key to leak.
  assert.equal(generated, 0, "a key was generated for a name that can never be stored");
});

test("identity names are capped and charset-restricted", async () => {
  const store = () => new CredentialStore({ keychain: fakeKeychain() });

  const bad = [
    "a".repeat(65), // one over the cap
    "a".repeat(300), // F-014's own input
    "../../evil", // traversal
    "has space",
    "quote'breakout", // the single-quoted PowerShell literal the script uses
    "back`tick",
    "$(Write-Output PWNED)",
    "semi;colon",
    "pipe|char",
    "naivé", // non-ASCII: the filename sanitizer would silently mangle it
    "",
    "   ",
    // Fix cycle 9 (DD-31): a name IS printed back, by `keygen`, `keys list`,
    // `doctor` and the `register` line this CLI tells you to run, so key
    // material pasted here reaches a printable sink with no error involved at
    // all. 64 hex characters is exactly the cap and exactly the charset, so it
    // used to be a perfectly legal name.
    "a".repeat(64),
    `nsec1${"q".repeat(58)}`,
  ];
  for (const name of bad) {
    await assert.rejects(
      () => keygen({ store: store(), target: { kind: "agent", name }, log: () => {} }),
      /name/i,
      `should have refused ${JSON.stringify(name)}`,
    );
  }

  // `a`.repeat(64) used to be the cap-boundary fixture here and is now refused
  // as key material (above), so the boundary is proved with a 64-character name
  // that is not all-hex. The property under test is unchanged: 64 is legal, 65
  // is not.
  const good = ["spike", "spike2", "tals-agent", "a.b", "A", `${"a".repeat(63)}z`, "blitz_1"];
  for (const name of good) {
    const s = store();
    await keygen({ store: s, target: { kind: "agent", name }, log: () => {} });
    assert.match(await s.getAgentPrivateKey(name), /^[0-9a-f]{64}$/, `should have accepted ${name}`);
  }
});

// The sanitizer must not have broken the thing it protects.
test("keygen still round-trips through the REAL credential store", realOnly, async () => {
  const store = new CredentialStore();
  const name = `hive402-test-rt-${Date.now()}`;
  try {
    const { pubkey } = await keygen({ store, target: { kind: "agent", name }, log: () => {} });
    const stored = await store.getAgentPrivateKey(name);
    assert.match(stored, /^[0-9a-f]{64}$/, "the real store must hold a real key");
    assert.equal(derivePubkey(stored), pubkey, "the reported pubkey must belong to the stored key");
  } finally {
    await store.removeAgentPrivateKey(name);
  }
  assert.equal(await store.getAgentPrivateKey(name), null, "and it must be removable again");
});

// --- layer 3: structural, so the class cannot return quietly ----------------

const SECRET_IDENTIFIERS = /\b(secret|secrets|privateKey|privateKeyHex|plaintext|secretB64|encoded)\b/;

function credentialSources() {
  return readdirSync(CREDENTIALS_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => ({ file: f, source: readFileSync(path.join(CREDENTIALS_DIR, f), "utf8") }));
}

// Comments are prose; `${` inside one is not an interpolation. Strip them
// first, or every explanation of this bug fails the test that guards it.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const lines = (source) => stripComments(source).split(/\r?\n/);

// Every `${…}` in the file, with balanced-brace handling so a nested template
// or object literal does not truncate the expression.
function interpolations(source) {
  const out = [];
  for (let i = 0; i < source.length - 1; i += 1) {
    if (source[i] !== "$" || source[i + 1] !== "{") continue;
    let depth = 1;
    let j = i + 2;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth += 1;
      else if (source[j] === "}") depth -= 1;
      j += 1;
    }
    out.push(source.slice(i + 2, j - 1));
  }
  return out;
}

// F-014 was one interpolation. The rule that would have prevented it is
// mechanical, and it is absolute on purpose: there is no carve-out, because a
// rule with an exception carved into it is a rule that erodes. `keys.mjs` takes
// a secret's LENGTH into a number first, for exactly this reason.
//
// The honest limit of this guard: it knows the names below and no others. It
// catches the bug that happened and the obvious next one, not every conceivable
// one.
test("no secret is ever interpolated into a string in src/credentials (F-014 class)", () => {
  for (const { file, source } of credentialSources()) {
    for (const expression of interpolations(stripComments(source))) {
      assert.doesNotMatch(
        expression,
        SECRET_IDENTIFIERS,
        `${file}: a secret is interpolated into a string. That is F-014: any string ` +
          `built this way can reach an error, a log or a script. Expression: ${expression}`,
      );
    }
  }
});

// The second half of the class: reporting a child process's failure by handing
// on its own words. `message` carries the command line (the script on Windows,
// the secret itself in argv on macOS); `stdout` on the READ path IS the secret;
// `cmd` and `spawnargs` are the command line again.
//
// The rule is file-wide rather than sink-shaped, and that is the lesson from
// writing it: the first version of this test only looked inside `throw` and
// `log(...)` calls, and a deliberately reintroduced leak walked straight past it
// because the code built the Error on one line and threw it on another. Reading
// the text at all is the thing worth banning.
test("no child-process error text is read at all in src/credentials (F-014 class)", () => {
  const READ = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\.\s*(message|stdout|cmd|spawnargs)\b/g;
  // `process.stdout` is THIS process's own console, which `prompt.mjs` writes
  // the prompt to. It is not a child's error text and never was.
  const OWN = new Set(["process"]);

  for (const { file, source } of credentialSources()) {
    lines(source).forEach((line, n) => {
      for (const [, receiver, property] of line.matchAll(READ)) {
        if (OWN.has(receiver)) continue;
        assert.fail(
          `${file}:${n + 1}: a child process's own error text is read here ` +
            `(${receiver}.${property}). That text can hold the script, the command line or ` +
            `the secret, and anything that reads it is one console.error away from F-014:` +
            `\n  ${line.trim()}`,
        );
      }
    });
  }
});

// `stderr` is the single exception, because the sanitizer has to look in it for
// the marker the script writes. It is allowed ONLY on a line that also runs the
// whitelist matcher over it, so "read stderr" cannot quietly become "report
// stderr".
test("stderr is only ever read through the whitelist matcher", () => {
  let seen = 0;
  for (const { file, source } of credentialSources()) {
    lines(source).forEach((line, n) => {
      if (!/\.\s*stderr\b/.test(line)) return;
      seen += 1;
      assert.match(
        line,
        /ERROR_MARKER\.exec\(/,
        `${file}:${n + 1}: stderr is read outside the whitelist matcher:\n  ${line.trim()}`,
      );
    });
  }
  // If nobody reads stderr at all the test above is vacuous, and a rename could
  // make it vacuous without anyone noticing.
  assert.equal(seen, 1, "expected exactly one stderr read, inside the sanitizer");
});

// --- F-016 (cycle 6): a key REFERENCE is refused by kind and length ---------
//
// DD-30 part 4 stopped `privateKeyRef` echoing a pasted key by RECOGNISING key
// material — exactly 64 hex characters, or `nsec1…` — and branching to a
// redacting message. Everything it did not recognise fell through to the older
// message ending `(got "${written}")`. So 64 hex characters were redacted and
// **63 or 65 were printed verbatim**: one dropped or duplicated character, the
// single most common copy-paste accident for a fixed-length hex string.
//
// The lesson (DD-31) is that recognising the secret is a denylist over an
// infinite input space, and F-016 is what its first gap costs. So these tests do
// not check that the detector got wider. They check the INVERTED default: a
// refused key reference is reported by kind and length, whatever it is.

// Deliberately not only near-64: a value this field refuses may be a key in any
// encoding, a passphrase, a token, or a path. None of them may come back out.
function secretShapedValues() {
  const out = [];
  for (let n = 60; n <= 70; n += 1) {
    out.push({ what: `${n}-char hex`, value: "deadbeef0011223344556677889900aabbccddeeff".repeat(3).slice(0, n) });
  }
  for (let n = 60; n <= 70; n += 1) {
    out.push({
      what: `${n}-char HEX (uppercase)`,
      value: "DEADBEEF0011223344556677889900AABBCCDDEEFF".repeat(3).slice(0, n).toUpperCase(),
    });
  }
  out.push({ what: "an nsec1 bech32 key", value: `nsec1${"q7w8e9r0t1y2u3i4o5p6a7s8d9f0g1h2j3k4l5z6x7c8v9b0n1m2".slice(0, 58)}` });
  out.push({ what: "a base64 blob", value: Buffer.from("f".repeat(64), "utf8").toString("base64") });
  out.push({ what: "a base64 blob with padding", value: Buffer.from("0123456789abcdef".repeat(4) + "!", "utf8").toString("base64") });
  out.push({ what: "a raw 64-byte string", value: "x".repeat(64) });
  out.push({ what: "a passphrase someone pasted", value: "correct horse battery staple hunter2 correct horse" });
  out.push({ what: "a path to a key file", value: "C:\\Users\\barry\\secrets\\spike.key" });
  return out;
}

function configWith(mutate) {
  const raw = {
    relayUrl: "wss://relay.example",
    node: { pubkey: "a".repeat(64) },
    rooms: [
      {
        channel: "channel-1",
        agents: [{ name: "spike", pubkey: "b".repeat(64), ownerPubkey: "c".repeat(64) }],
      },
    ],
  };
  mutate(raw);
  return raw;
}

// Every field in the schema documented as naming WHERE a key lives. A field of
// this kind sits in the config right beside the place a key would be pasted,
// which is what makes pasting one into it the obvious slip.
const KEY_REFERENCE_FIELDS = [
  { field: "node.privateKeyRef", set: (raw, v) => { raw.node.privateKeyRef = v; } },
  { field: "agent.privateKeyRef", set: (raw, v) => { raw.rooms[0].agents[0].privateKeyRef = v; } },
];

test("no key-reference refusal ever echoes the value it refused (F-016)", () => {
  for (const { field, set } of KEY_REFERENCE_FIELDS) {
    for (const { what, value } of secretShapedValues()) {
      const err = throwsFrom(() => parseConfig(configWith((raw) => set(raw, value))));
      const dump = `${err.message}\n${err.stack}`;

      assert.equal(
        dump.includes(value),
        false,
        `${field}: refusing ${what} echoed the value back. That is F-016: this message ` +
          `travels to terminal scrollback, CI logs and pasted bug reports.\n  ${err.message}`,
      );
      const leaked = keyMaterialIn(dump, value);
      assert.deepEqual(leaked, [], `${field}: refusing ${what} carried key material: ${leaked.join(", ")}`);
    }
  }
});

// Redacting everything would pass the test above and leave the operator with
// nothing to act on. The refusal has to stay a diagnostic.
test("a key-reference refusal still says what is wrong and what is legal (F-016)", () => {
  for (const { field, set } of KEY_REFERENCE_FIELDS) {
    for (const { what, value } of secretShapedValues()) {
      const err = throwsFrom(() => parseConfig(configWith((raw) => set(raw, value))));

      assert.match(err.message, /privateKeyRef/, `${field}: ${what} — the message must name the field`);
      assert.match(err.message, /keychain/, `${field}: ${what} — the message must name the keychain form`);
      assert.match(err.message, /env:/, `${field}: ${what} — the message must name the env form`);
      // Kind and length are what replaces the value: enough to recognise your
      // own mistake in the file open in front of you.
      assert.match(
        err.message,
        new RegExp(`\\b${value.length}[- ]character|private KEY`),
        `${field}: ${what} — the message must give the length, or name it as key material:\n  ${err.message}`,
      );
      // And it must say the value was withheld, or an operator re-runs with the
      // value pasted somewhere louder to "see the real error".
      assert.match(err.message, /NOT been (echoed|printed)|not been printed/i, `${field}: ${what} — say it was withheld`);
    }
  }
});

// Layer 2, at the exact boundary F-016 was found on: the real CLI, the real
// error path, the Red Team's own 63/64/65 battery.
test("the real CLI refuses a 63/64/65-character privateKeyRef without echoing it (F-016)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-f016-"));
  try {
    const base = "deadbeef00112233445566778899aabbccddeeff0011223344556677889baab"; // 63
    for (const value of [base, `${base}0`, `${base}01`, base.toUpperCase(), `${base}0`.toUpperCase()]) {
      const file = path.join(dir, `c${value.length}-${value === value.toUpperCase() ? "up" : "lo"}.json`);
      writeFileSync(
        file,
        JSON.stringify(configWith((raw) => { raw.rooms[0].agents[0].privateKeyRef = value; })),
        "utf8",
      );

      for (const argv of [["doctor", "--config", file], ["status", "--config", file]]) {
        const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
        const output = `${r.stdout}\n${r.stderr}`;
        // The Red Team's own measurement: `grep -c` for the literal value.
        const occurrences = output.split(value).length - 1;
        assert.equal(
          occurrences,
          0,
          `hive402 ${argv[0]}: the ${value.length}-character value appeared ${occurrences} time(s) ` +
            `in the output:\n${output}`,
        );
        assert.deepEqual(keyMaterialIn(output), [], `hive402 ${argv[0]}: key material in the output:\n${output}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The same rule, on the other field that can catch a pasted key from a
// mistyped command line: `--agent <name>`. The over-long branch is where a
// pasted 65-character near-key lands, and it used to quote the first 24
// characters of it.
test("an over-long identity name is refused by length, not by quoting it (F-016 class)", () => {
  const nearKey = `${"deadbeef00112233445566778899aabbccddeeff0011223344556677889baab"}01`; // 65
  const err = throwsFrom(() => assertIdentityName(nearKey));
  assert.equal(
    err.message.includes(nearKey.slice(0, 24)),
    false,
    `the refusal quoted the start of the value:\n  ${err.message}`,
  );
  assert.match(err.message, /65/, "the length is the useful half and must survive");
});

// An identity name is printed back by `keygen`, `keys list`, `doctor` and the
// register command line, so a key pasted THERE reaches a printable sink by the
// front door. 64 hex characters is both a valid key and — until this cycle — a
// valid name, since it is exactly the cap and exactly the charset.
test("key material is refused as an identity name (F-016 class)", () => {
  for (const value of ["a".repeat(63) + "f", "F".repeat(64), `nsec1${"q".repeat(58)}`]) {
    const err = throwsFrom(() => assertIdentityName(value));
    assert.equal(err.message.includes(value), false, `the refusal echoed the value:\n  ${err.message}`);
    assert.match(err.message, /key/i, `it must say why: ${err.message}`);
  }
});

// The same class, found by the FIX-65 sweep rather than reported: `register`
// takes `--sponsor <keyref>` and `--owner-key <keyref>`, both documented as
// "the sponsoring member's key", both passed straight to the key resolver — and
// the resolver's refusal was `unsupported key reference "${ref}"`.
//
// This is worse than F-016 was: it is not length-dependent, so a **valid,
// immediately usable** 64-character key pasted into the flag came straight back
// out, which is F-014's original severity through a third code path. And the
// paste is the likely one: the flag's own help text says "key", and an owner
// whose key is on the clipboard is exactly who is running this command.
test("a key pasted into --sponsor/--owner-key is never echoed (F-016 class)", async () => {
  const resolve = makeKeyResolver({ store: { async getNodePrivateKey() { return null; } } });

  for (const { what, value } of secretShapedValues()) {
    const err = await rejection(() => resolve(value, { role: "sponsor" }));
    const dump = `${err.message}\n${err.stack}`;
    assert.equal(
      dump.includes(value),
      false,
      `resolving ${what} echoed the value back:\n  ${err.message}`,
    );
    assert.deepEqual(keyMaterialIn(dump, value), [], `resolving ${what} carried key material`);
    // Still a diagnostic: it has to name what a key reference actually is.
    assert.match(err.message, /keychain/, `unhelpful: ${err.message}`);
    assert.match(err.message, /env:/, `unhelpful: ${err.message}`);
  }
});

// `env:` was matched by `startsWith` alone in the resolver, while the schema
// requires `env:[A-Za-z_][A-Za-z0-9_]*`. Two validators that disagree about the
// same string is how the FIRST one gets bypassed: `--sponsor env:<a key>` sailed
// past the loose check and the "variable is not set" message printed the
// suffix. The two now agree, which is the same three-places-agree rule DD-30
// applied to identity names.
test("an env: reference with a non-name suffix is refused without echoing it (F-016 class)", async () => {
  const resolve = makeKeyResolver({ store: { async getNodePrivateKey() { return null; } } });

  for (const { what, value } of secretShapedValues()) {
    const err = await rejection(() => resolve(`env:${value}`, { role: "sponsor" }));
    assert.equal(
      `${err.message}\n${err.stack}`.includes(value),
      false,
      `env:${what} echoed the suffix back:\n  ${err.message}`,
    );
  }

  // And a real env reference still resolves, so this did not just break the
  // dev/CI path it guards.
  process.env.HIVE402_TEST_F016_KEY = "a".repeat(63) + "f";
  try {
    assert.equal(await resolve("env:HIVE402_TEST_F016_KEY", {}), "a".repeat(63) + "f");
  } finally {
    delete process.env.HIVE402_TEST_F016_KEY;
  }
});

test("the real CLI's register --sponsor never echoes a pasted key (F-016 class)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-f016b-"));
  try {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(configWith(() => {})), "utf8");
    const key = "deadbeef00112233445566778899aabbccddeeff00112233445566778899baab";
    assert.equal(key.length, 64, "the fixture must be a full, valid-shaped key");

    for (const flag of ["--sponsor", "--owner-key"]) {
      const argv = ["register", "--agent", "spike", flag, key, "--config", file];
      // `--owner-key` alone is refused before any resolution, so give it a
      // sponsor it can resolve past.
      if (flag === "--owner-key") argv.push("--sponsor", "keychain");
      const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
      const output = `${r.stdout}\n${r.stderr}`;
      assert.equal(
        output.split(key).length - 1,
        0,
        `hive402 register ${flag}: the pasted key appeared in the output:\n${output}`,
      );
      assert.deepEqual(keyMaterialIn(output), [], `key material in the output:\n${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F-017 (cycle 6): concurrent keygen of the identical name ---------------
//
// `keygen` read the store, saw nothing, and wrote. Two simultaneous
// `hive402 keygen --agent x`, neither with `--force`, therefore BOTH reported
// success with DIFFERENT pubkeys, and exactly one key survived. The loser's
// pubkey had already been printed to its operator — who may well have pasted it
// into a config or a registration by the time anyone notices — and the identity
// behind it is unrecoverable. That silent retirement is precisely what `--force`
// exists to make somebody confirm, and it was reached without `--force`.
//
// Reproduced first-hand before the fix, against the REAL Windows backend:
//   A exit 0  pubkey f1b41248...   B exit 0  pubkey 32541079...
//   stored: 32541079...   orphaned: f1b41248...

// A fake that can be told to hold every reader at the door until they have all
// arrived. Without that, `Promise.all` of two keygens may happen to serialise
// and the test would pass against the very code that has the bug.
function racingKeychain({ readers = 2 } = {}) {
  const vault = new Map();
  let arrived = 0;
  let release;
  const allArrived = new Promise((resolve) => { release = resolve; });

  return {
    vault,
    async set(service, account, value) {
      vault.set(`${service}:${account}`, value);
    },
    // Exclusive create: first caller wins, every later one is told it exists.
    async create(service, account, value) {
      const { KeyExistsError } = await import("../src/credentials/keychain.mjs");
      if (vault.has(`${service}:${account}`)) throw new KeyExistsError();
      vault.set(`${service}:${account}`, value);
    },
    // The barrier lives here because `get` is what the pre-check calls: holding
    // it open until BOTH callers have looked forces the exact interleaving
    // F-017 needs — two readers that both saw "absent".
    async get(service, account) {
      arrived += 1;
      if (arrived >= readers) release();
      await allArrived;
      return vault.get(`${service}:${account}`) ?? null;
    },
    async remove(service, account) {
      return vault.delete(`${service}:${account}`);
    },
  };
}

test("two concurrent keygens of one name: one succeeds, the other is refused (F-017)", async () => {
  const store = new CredentialStore({ keychain: racingKeychain() });
  const target = { kind: "agent", name: "raced" };

  const results = await Promise.allSettled([
    keygen({ store, target, log: () => {} }),
    keygen({ store, target, log: () => {} }),
  ]);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one caller may be told it created the identity");
  assert.equal(lost.length, 1, "the other must be refused, not told it succeeded");

  // And refused with the SAME message a sequential second call gets, because
  // the situation is identical: this identity already has a key.
  assert.match(lost[0].reason.message, /already has a key/i);
  assert.match(lost[0].reason.message, /--force/);

  // The decisive property: the pubkey the winner was shown is the one actually
  // in the store. Before the fix, one caller held a pubkey nobody could sign
  // with.
  const stored = await store.getAgentPrivateKey("raced");
  assert.equal(derivePubkey(stored), won[0].value.pubkey, "the reported pubkey must be the stored one");
});

test("a concurrent import of one name is refused the same way (F-017)", async () => {
  const store = new CredentialStore({ keychain: racingKeychain() });
  const target = { kind: "node" };
  const readSecret = async () => "a".repeat(63) + "f";

  const results = await Promise.allSettled([
    importPrivateKey({ store, target, log: () => {}, readSecret }),
    importPrivateKey({ store, target, log: () => {}, readSecret }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already has a key/i);
});

// `--force` MEANS "replace it". Two concurrent replacements are a coin toss by
// definition, and making that atomic would be inventing a semantic nobody asked
// for — so this asserts the deliberate NON-property, to stop a later reader
// "fixing" it.
test("--force is still a plain replace, deliberately (F-017)", async () => {
  const store = new CredentialStore({ keychain: racingKeychain({ readers: 1 }) });
  const target = { kind: "agent", name: "forced" };

  await keygen({ store, target, log: () => {} });
  const second = await keygen({ store, target, force: true, log: () => {} });
  assert.equal(second.replaced, true);
  assert.equal(derivePubkey(await store.getAgentPrivateKey("forced")), second.pubkey);
});

// A backend that cannot express "already exists" must fail LOUDLY rather than
// quietly fall back to a racy write. This is the DD-28 lesson: optional-calling
// a missing method (`store.getAgentPrivateKeySync?.()`) hid a structural bug
// behind a plausible domain error for two whole cycles.
test("a keychain with no create() fails loudly instead of racing (F-017)", async () => {
  const store = new CredentialStore({
    keychain: { async set() {}, async get() { return null; }, async remove() { return true; } },
  });
  const err = await rejection(() => keygen({ store, target: { kind: "agent", name: "nocreate" }, log: () => {} }));
  assert.equal(err.constructor.name, "TypeError", `expected a TypeError, got ${err.constructor.name}`);
});

// Layer 2: the Red Team's own T-092 probe, against the REAL Windows backend and
// the REAL CLI — two processes, started together, neither passing --force.
test("two REAL concurrent keygen processes leave no orphaned identity (F-017)", realOnly, async () => {
  const { spawn } = await import("node:child_process");
  const name = `hive402-test-f017-${Date.now()}`;

  const run = () =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, "keygen", "--agent", name], { windowsHide: true });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("close", (code) => resolve({ code, out }));
    });

  const store = new CredentialStore();
  try {
    const [a, b] = await Promise.all([run(), run()]);
    const pubkeyOf = (r) => r.out.match(/pubkey:\s+([0-9a-f]{64})/)?.[1] ?? null;

    const winners = [a, b].filter((r) => r.code === 0);
    const losers = [a, b].filter((r) => r.code !== 0);
    assert.equal(winners.length, 1, `exactly one process may succeed:\n${a.out}\n---\n${b.out}`);
    assert.equal(losers.length, 1, "the other must exit nonzero");
    assert.match(losers[0].out, /already has a key/i, `the loser must be told why:\n${losers[0].out}`);
    assert.match(losers[0].out, /--force/);
    assert.equal(pubkeyOf(losers[0]), null, "a refused caller must not be shown a pubkey it does not own");

    // The whole point of F-017: no identity was reported to anybody that is not
    // the one in the store.
    const stored = await store.getAgentPrivateKey(name);
    assert.equal(derivePubkey(stored), pubkeyOf(winners[0]), "the stored key must be the one reported");
  } finally {
    await store.removeAgentPrivateKey(name);
  }
});

function throwsFrom(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected a throw, got none");
}

function fakeKeychain() {
  const vault = new Map();
  return {
    vault,
    async set(service, account, secret) {
      vault.set(`${service}:${account}`, secret);
    },
    // Exclusive create (DD-32, F-017). A fake that cannot express
    // "already exists" cannot test the property that a raced keygen is
    // refused, so every fake in this suite implements it.
    async create(service, account, secret) {
      const { KeyExistsError } = await import("../src/credentials/keychain.mjs");
      if (vault.has(`${service}:${account}`)) throw new KeyExistsError();
      vault.set(`${service}:${account}`, secret);
    },
    async get(service, account) {
      return vault.get(`${service}:${account}`) ?? null;
    },
    async remove(service, account) {
      return vault.delete(`${service}:${account}`);
    },
  };
}

// ---------------------------------------------------------------------------
// F-022 (fix cycle 13): the same class, now across a DECODE.
//
// Fix cycle 13 made every key-shaped entry point accept `nsec1…` / `npub1…` as
// well as hex (DD-40). That adds a second thing that must never reach a
// printable sink, and it is a thing that did not exist before: the key BEHIND
// the string. A refusal saying "that nsec decodes to 67dea2ed…" would be a
// perfectly friendly diagnostic and a complete key disclosure, and none of the
// guards above would have caught it, because every one of them was written when
// the only value in play was the one the user typed.
//
// So this section drives bech32-shaped input through every entry point that
// takes a key and asserts BOTH the input and the decoded key stay out of
// everything thrown, logged or printed.

const KNOWN_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const FIXTURES = await import("../fixtures/bech32-encode.mjs");

function bech32Fixtures() {
  const { corrupt, hexToBech32 } = FIXTURES;
  const nsec = hexToBech32("nsec", KNOWN_HEX);
  const npub = hexToBech32("npub", KNOWN_HEX);
  return [
    { what: "a valid nsec", value: nsec },
    { what: "an nsec with one character changed", value: corrupt(nsec) },
    { what: "an nsec with its last character changed", value: corrupt(nsec, nsec.length - 1) },
    { what: "a truncated nsec", value: nsec.slice(0, 48) },
    { what: "an nsec with something appended", value: `${nsec}0` },
    { what: "a MIXED-CASE nsec", value: `${nsec.slice(0, 20).toUpperCase()}${nsec.slice(20)}` },
    { what: "an UPPERCASE nsec", value: nsec.toUpperCase() },
    { what: "an npub", value: npub },
    { what: "a corrupted npub", value: corrupt(npub) },
    { what: "an ncryptsec backup", value: `ncryptsec1${"q".repeat(152)}` },
    { what: "an nsec whose real prefix is longer", value: hexToBech32("nsec1abc", KNOWN_HEX) },
    { what: "a short bech32 payload", value: hexToBech32("nsec", "00112233445566778899aabb") },
  ];
}

// Everything that must stay out: what the user typed, any long fragment of it,
// and the key it decodes to.
function assertNothingLeaked(text, value, where) {
  const dump = String(text ?? "");
  assert.equal(dump.includes(value), false, `${where}: the value itself was echoed:\n  ${dump}`);
  assert.equal(
    dump.includes(KNOWN_HEX),
    false,
    `${where}: the DECODED key was echoed. That is F-022's own failure mode:\n  ${dump}`,
  );
  assert.equal(
    dump.includes(KNOWN_HEX.slice(0, 16)),
    false,
    `${where}: part of the decoded key was echoed:\n  ${dump}`,
  );
  for (let i = 0; i + 16 <= value.length; i += 8) {
    assert.equal(
      dump.includes(value.slice(i, i + 16)),
      false,
      `${where}: a 16-character fragment of the input at offset ${i} was echoed:\n  ${dump}`,
    );
  }
  assert.deepEqual(keyMaterialIn(dump, value), [], `${where}: key material in the output`);
  assert.deepEqual(scriptTextIn(dump), [], `${where}: script text in the output`);
}

test("keys import refuses bech32-shaped input without leaking it or its key (F-022)", async () => {
  for (const { what, value } of bech32Fixtures()) {
    const store = new CredentialStore({ keychain: fakeKeychain() });
    const printed = [];
    let accepted = false;
    try {
      await importPrivateKey({
        store,
        target: { kind: "agent", name: "spike" },
        log: (line = "") => printed.push(String(line)),
        readSecret: async () => value,
      });
      accepted = true;
    } catch (err) {
      assertNothingLeaked(`${err.message}\n${err.stack}`, value, `keys import / ${what}`);
    }

    // A valid nsec is SUPPOSED to be accepted now, and the success path prints
    // things — so the check here has to be sharper than "no 64 hex characters
    // anywhere". A successful import prints the derived PUBLIC key, which is
    // the whole point of the output: it is what the owner copies into their
    // config. So assert exactly which key is printed rather than that none is.
    const output = printed.join("\n");
    assert.equal(output.includes(value), false, `${what}: the input was printed back`);
    assert.equal(output.includes(KNOWN_HEX), false, `${what}: the PRIVATE key was printed`);
    for (const run of output.match(/\b[0-9a-f]{64}\b/g) ?? []) {
      assert.equal(
        run,
        derivePubkey(KNOWN_HEX),
        `${what}: a 64-hex value was printed that is not the derived public key`,
      );
    }
    assert.deepEqual(scriptTextIn(output), [], `${what}: script text in the output`);

    assert.equal(
      await store.getAgentPrivateKey("spike"),
      accepted ? KNOWN_HEX : null,
      `${what}: wrong store state after ${accepted ? "acceptance" : "refusal"}`,
    );
  }
});

test("the env: resolver refuses bech32-shaped input without leaking it (F-022)", async () => {
  const resolve = makeKeyResolver({ store: { async getNodePrivateKey() { return null; } } });
  for (const { what, value } of bech32Fixtures()) {
    process.env.HIVE402_F022_PROBE = value;
    try {
      let err = null;
      try {
        await resolve("env:HIVE402_F022_PROBE", {});
      } catch (failure) {
        err = failure;
      }
      if (err) {
        assertNothingLeaked(`${err.message}\n${err.stack}`, value, `env: / ${what}`);
        // Naming the VARIABLE is the whole diagnostic, and `ENV_VAR_NAME` caps
        // it at 48 characters precisely so a key cannot be one (DD-31).
        assert.match(err.message, /HIVE402_F022_PROBE/, `env: / ${what}: name the variable`);
      }
    } finally {
      delete process.env.HIVE402_F022_PROBE;
    }
  }
});

test("a bech32 value pasted into --sponsor never comes back out (F-022)", async () => {
  const resolve = makeKeyResolver({ store: { async getNodePrivateKey() { return null; } } });
  for (const { what, value } of bech32Fixtures()) {
    const err = await rejection(() => resolve(value, { role: "sponsor" }));
    assertNothingLeaked(`${err.message}\n${err.stack}`, value, `--sponsor / ${what}`);
  }
});

test("every config key field refuses bech32-shaped input without leaking (F-022)", () => {
  const fields = [
    { field: "node.pubkey", set: (raw, v) => { raw.node.pubkey = v; } },
    { field: "agent.pubkey", set: (raw, v) => { raw.rooms[0].agents[0].pubkey = v; } },
    { field: "agent.ownerPubkey", set: (raw, v) => { raw.rooms[0].agents[0].ownerPubkey = v; } },
    { field: "agent.privateKeyRef", set: (raw, v) => { raw.rooms[0].agents[0].privateKeyRef = v; } },
    { field: "node.privateKeyRef", set: (raw, v) => { raw.node.privateKeyRef = v; } },
  ];

  for (const { field, set } of fields) {
    for (const { what, value } of bech32Fixtures()) {
      let err = null;
      try {
        parseConfig(configWith((raw) => set(raw, value)));
      } catch (failure) {
        err = failure;
      }
      // An npub in a pubkey field is legal since DD-40, so no error is a
      // correct outcome for some of these rather than a missed refusal.
      if (err) assertNothingLeaked(`${err.message}\n${err.stack}`, value, `${field} / ${what}`);
    }
  }
});

test("bech32-shaped input is refused as an identity NAME without echoing it (F-022)", () => {
  // An identity name is printed straight back by `keygen`, `keys list`,
  // `doctor` and the register line this CLI tells you to run, so this is the
  // sink that needs no error at all (DD-31).
  for (const { what, value } of bech32Fixtures()) {
    const err = throwsFrom(() => assertIdentityName(value));
    assertNothingLeaked(`${err.message}\n${err.stack}`, value, `identity name / ${what}`);
  }
});

// Layer 2 for this cycle: the REAL CLI, spawned, through `die(err.message)` —
// the sink every one of these findings has actually travelled through.
//
// Invalid values only, against a throwaway agent name, AND WITH UNCONDITIONAL
// CLEANUP. The cleanup is not politeness. Writing this test without it left
// four real DPAPI entries in `%LOCALAPPDATA%\hive402\credentials` on this
// machine — not from the test passing, but from the removal experiments that
// deliberately break the checksum check, at which point the CLI correctly
// accepts a key it should not and stores it for real. Any test that drives the
// real store has to assume the product under it may be temporarily wrong, which
// is the whole reason the test exists.
test("the real CLI's nsec paths print no key material (F-022)", () => {
  const { corrupt, hexToBech32 } = FIXTURES;
  const nsec = hexToBech32("nsec", KNOWN_HEX);
  const agent = `f022probe${process.pid}`;

  try {
    for (const value of [
      corrupt(nsec),
      nsec.slice(0, 48),
      `${nsec.slice(0, 20).toUpperCase()}${nsec.slice(20)}`,
      hexToBech32("npub", KNOWN_HEX),
      `ncryptsec1${"q".repeat(152)}`,
    ]) {
      const r = spawnSync(process.execPath, [CLI, "keys", "import", "--agent", agent], {
        encoding: "utf8",
        input: `${value}\n`,
      });
      const output = `${r.stdout}\n${r.stderr}`;
      assert.notEqual(r.status, 0, `the CLI accepted a malformed key:\n${output}`);
      assertNothingLeaked(output, value, "the real CLI");
    }
  } finally {
    spawnSync(process.execPath, [CLI, "keys", "remove", "--agent", agent], { encoding: "utf8" });
  }

  // And prove the cleanup worked, rather than trusting it: nothing this test
  // touched may outlive it in the operator's own credential store.
  const left = spawnSync(process.execPath, [CLI, "keys", "remove", "--agent", agent], {
    encoding: "utf8",
  });
  assert.match(
    `${left.stdout}`,
    /no key was stored/,
    "this test left a real entry behind in the OS credential store",
  );
});

test("a 32-byte payload that is not a valid secp256k1 scalar leaks nothing (F-022)", async () => {
  // A path this cycle made newly reachable. bech32 will happily decode any 32
  // bytes, and two of them are not valid secret keys: zero, and anything at or
  // above the curve order. Those reach `schnorr.getPublicKey` inside
  // `@noble/curves`, so the message an owner sees is written by a DEPENDENCY —
  // which is the exact hazard DD-40 rejected `@scure/base` over. Today noble
  // says "invalid field element: outside of range 0..ORDER" and "invalid
  // scalar: out of range", both value-free. This test is what notices if a
  // version bump changes that.
  const { hexToBech32 } = FIXTURES;
  for (const hex of ["f".repeat(64), "0".repeat(64)]) {
    for (const value of [hex, hexToBech32("nsec", hex)]) {
      const store = new CredentialStore({ keychain: fakeKeychain() });
      const err = await rejection(() =>
        importPrivateKey({
          store,
          target: { kind: "agent", name: "spike" },
          log: () => {},
          readSecret: async () => value,
        }),
      );
      const dump = `${err.message}\n${err.stack}`;
      assert.equal(dump.includes(value), false, `the input reached the message:\n  ${dump}`);
      assert.equal(dump.includes(hex), false, `the decoded key reached the message:\n  ${dump}`);
      assert.deepEqual(keyMaterialIn(dump, value), [], `key material in the output:\n  ${dump}`);
      assert.equal(await store.getAgentPrivateKey("spike"), null, "nothing may be stored");
    }
  }
});

// --- structural, extended for the decode path -------------------------------
//
// The tests above are behavioural and know only the inputs I thought of. These
// fail if the class returns in code nobody thought to test, which is the whole
// reason layer 3 exists.

test("nothing decoded is ever interpolated into a string in src/credentials (F-022)", () => {
  // The names fix cycle 13 introduced that hold key material. `hex` on its own
  // is deliberately NOT in the list: `keychain.mjs` legitimately interpolates
  // `digest("hex")`, and a rule that produces false positives is a rule someone
  // eventually weakens. The `.hex` PROPERTY is banned separately below, which
  // is the precise shape this cycle could leak.
  const DECODED_IDENTIFIERS = /\b(bytes|words|payload|typed|held)\b/;

  for (const { file, source } of credentialSources()) {
    for (const expression of interpolations(stripComments(source))) {
      assert.doesNotMatch(
        expression,
        DECODED_IDENTIFIERS,
        `${file}: something decoded from a key is interpolated into a string. What comes ` +
          `out of a decode IS the key (F-022). Expression: ${expression}`,
      );
      assert.doesNotMatch(
        expression,
        /\.\s*hex\b/,
        `${file}: the normalised key (".hex") is interpolated into a string. That is the ` +
          `private key in its canonical form (F-022). Expression: ${expression}`,
      );
    }
  }
});

test("the refusal builder cannot be handed a key at any call site (F-022)", () => {
  // `explainKeyRefusal` takes a DESCRIPTION, never a value, so every caller is
  // forced through `describeRefusedValue` — kind and length only. Checked at
  // the CALL SITES too, because a safe signature nobody uses safely is not a
  // guard, and the count is asserted so a new entry point cannot be added
  // without this test noticing.
  const callers = [
    path.join(ROOT, "src", "credentials", "keys.mjs"),
    path.join(ROOT, "src", "config", "schema.mjs"),
    path.join(ROOT, "src", "node", "runtime.mjs"),
  ];
  let seen = 0;
  for (const file of callers) {
    const source = readFileSync(file, "utf8");
    for (const [call] of source.matchAll(/explainKeyRefusal\(\{[^}]*\}\)/g)) {
      seen += 1;
      assert.match(call, /described/, `${path.basename(file)}: ${call} passes no description`);
      assert.doesNotMatch(
        call,
        /\bvalue\b|\.hex\b|\btyped\b|\bheld\b|\bwritten\b/,
        `${path.basename(file)}: a raw value is handed to the refusal builder: ${call}`,
      );
    }
  }
  assert.equal(seen, 3, `expected one call per entry point that reads a key, found ${seen}`);
});
