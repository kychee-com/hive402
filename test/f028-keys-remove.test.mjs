// F-028 (AC-72, AC-73): `keys remove --node` never asked which hive.
//
// ── What the red team hit ──────────────────────────────────────────────────
//
// An owner running two hives on one machine tried to remove the stored key of
// one specific node, the way AC-72 says they can:
//
//     hive402 keys remove --node --config ~/.hive402-tester-a/config.json
//     hive402: which hive? this machine can run several, so a node key is
//              stored under that node's own pubkey. Pass --config <that hive's
//              config> so the command knows which one you mean.
//
// They HAD passed --config. The flag was never read: `cmdKeys`'s remove branch
// called `keyTarget(flags)`, which answers "which identity" and by design
// carries no pubkey, and `clear()` then had nothing to key on. The refusal is
// the DD-61 guard working — a caller that forgets fails closed rather than
// silently removing someone else's key — and the caller that forgot was the
// CLI, which had the pubkey in its hand the whole time. `keys list` and
// `keys migrate-node`, the two siblings in the same file, both resolve the
// hive first; `remove` was the one that did not. Nothing was corrupted, and
// the red team had to delete a `.dpapi` file by hand.
//
// ── The sharper half, found while reproducing it ───────────────────────────
//
// `--config` was not merely ignored, it was never OPENED. So a typo and a
// perfectly good path produced byte-identical output:
//
//     keys remove --node --config <a real config>   -> "which hive? ..."
//     keys remove --node --config /nope/nope.json   -> "which hive? ..."
//     keys list        --config /nope/nope.json     -> "config not found: ..."
//
// A fix that only stopped the refusal would leave a wrong path silently
// indistinguishable from a right one, so that discrimination gets its own test
// below. The same command also printed no AC-73 banner at all, because the
// banner comes from `resolveHive` and `remove` never called it.
//
// ── What is deliberately NOT changed ───────────────────────────────────────
//
// `keygen --node` and `keys import --node` use the same `keyTarget` path and
// are CORRECT: `write`/`writeNew` derive the pubkey from the secret, so a key
// always lands under its own identity, and a config would be a second,
// disagreeing source of truth for a fact the secret already settles. `keygen`
// additionally runs BEFORE a config exists, which is AC-56's whole shape. The
// closed exception list is asserted structurally in `whichhive.test.mjs`.
//
// ── Why these run the real CLI against the real store ──────────────────────
//
// `test/multihive.test.mjs` already asserts the store half of this against a
// fake keychain, and it passed all the way through F-028 — the defect was one
// layer up, in the caller. So these drive `bin/cli.mjs` as a process, against
// the real platform credential store, with `%USERPROFILE%` pointed at a
// throwaway directory so the store lands there and this machine's real keys
// are never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin", "cli.mjs");

// A throwaway home, so the credential store is this test's own. The legacy
// %LOCALAPPDATA% location is pointed somewhere empty too — left as the real
// one it would answer for the primary store and a "no key" result would mean
// nothing.
function sandbox() {
  const base = mkdtempSync(path.join(tmpdir(), "hive402-f028-"));
  const home = path.join(base, "home");
  mkdirSync(path.join(home, ".hive402"), { recursive: true });
  return {
    base,
    home,
    env: { USERPROFILE: home, LOCALAPPDATA: path.join(base, "nolocal") },
    // What the store actually holds, by node pubkey. The Windows backend names
    // each file `<service>--<account>.dpapi`; the account for a node key is
    // that node's own pubkey (AC-72).
    nodeKeysHeld() {
      const dir = path.join(home, ".hive402", "credentials");
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.includes("node-private-key--") && f.endsWith(".dpapi"))
        .map((f) => f.replace(/^.*node-private-key--/, "").replace(/\.dpapi$/, ""));
    },
  };
}

const run = (box, ...args) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: box.base,
    env: { ...process.env, ...box.env },
  });

// A config naming one node. `stateDir` stays inside the sandbox so nothing a
// command writes escapes it.
function configFor(box, name, nodePubkey) {
  const file = path.join(box.base, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      relayUrl: "ws://localhost:3000",
      stateDir: path.join(box.base, `${name}-state`),
      ...(nodePubkey ? { node: { pubkey: nodePubkey } } : {}),
      rooms: [
        {
          channel: "11111111-1111-1111-1111-111111111111",
          agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }],
        },
      ],
    }),
  );
  return file;
}

// Mint a node identity through the product's own command and return its
// pubkey. `keygen --node` derives the pubkey from the secret, so this is also
// the check that the deliberately-untouched path still works with no config
// anywhere.
function mintNode(box) {
  const before = new Set(box.nodeKeysHeld());
  const r = run(box, "keygen", "--node");
  assert.equal(r.status, 0, `keygen --node failed: ${r.stderr}${r.stdout}`);
  const minted = box.nodeKeysHeld().filter((k) => !before.has(k));
  assert.equal(minted.length, 1, `keygen --node should add exactly one entry, added ${minted.length}`);
  return minted[0];
}

// ── The defect: --config decides WHICH node's key is removed ───────────────

test("F-028: keys remove --node removes the key of the node its --config names", () => {
  const box = sandbox();
  const nodeA = mintNode(box);
  const nodeB = mintNode(box);
  assert.notEqual(nodeA, nodeB, "two distinct identities");

  const configA = configFor(box, "hiveA", nodeA);
  const r = run(box, "keys", "remove", "--node", "--config", configA);

  assert.equal(r.status, 0, `should succeed, said: ${r.stderr}${r.stdout}`);
  assert.doesNotMatch(
    r.stdout + r.stderr,
    /which hive\?/i,
    "the whole finding: --config was passed and answers the question",
  );

  const held = box.nodeKeysHeld();
  assert.ok(!held.includes(nodeA), `A's key should be gone, store still holds: ${held.join(", ")}`);
  assert.ok(held.includes(nodeB), `B's key must be untouched, store holds: ${held.join(", ")}`);
});

// ── The discriminating case: a typo must not look like success ─────────────

test("F-028: a --config that does not exist is reported as such, not as 'which hive?'", () => {
  // Before the fix these two invocations produced byte-identical output, so an
  // owner who mistyped a path got the same sentence as one who got it right,
  // and no way to tell which mistake they had made. `keys list` has always
  // said "config not found"; this brings `remove` into line with its sibling.
  const box = sandbox();
  const missing = path.join(box.base, "definitely-not-here.json");

  const r = run(box, "keys", "remove", "--node", "--config", missing);

  assert.notEqual(r.status, 0, "a config that cannot be read is a failure");
  const said = r.stdout + r.stderr;
  assert.match(said, /definitely-not-here\.json/, "it names the path it could not read");
  assert.doesNotMatch(said, /which hive\?/i, "and does NOT blame the operator for omitting the flag they passed");
});

test("F-028: a good config and a mistyped one no longer produce identical output", () => {
  // The property, stated directly. This is what makes the previous test a fix
  // rather than a coincidence of wording.
  const box = sandbox();
  const nodeA = mintNode(box);
  const good = run(box, "keys", "remove", "--node", "--config", configFor(box, "hiveA", nodeA));
  const typo = run(box, "keys", "remove", "--node", "--config", path.join(box.base, "hiveA-typo.json"));

  assert.notEqual(
    (good.stdout + good.stderr).trim(),
    (typo.stdout + typo.stderr).trim(),
    "a correct path and a wrong one must be distinguishable",
  );
});

// ── The refusal keeps its real job ─────────────────────────────────────────

test("F-028: a config that names no hive is refused, and removes nothing", () => {
  // Planned as "still refuses with 'which hive?'" and corrected here after the
  // fix made it reachable: `node.pubkey` is MANDATORY in the schema, so a
  // config naming no identity is rejected by the loader before the store is
  // ever asked. Through `--config` the "which hive?" sentence is therefore
  // unreachable by construction, and what the operator gets instead is
  // strictly better — it names the file AND the missing field. Asserting the
  // planned wording here would have been asserting a worse product.
  const box = sandbox();
  const nodeA = mintNode(box);
  const nodeless = configFor(box, "nodeless", null);

  const r = run(box, "keys", "remove", "--node", "--config", nodeless);

  assert.notEqual(r.status, 0, "a config that cannot say which hive removes nothing");
  const said = r.stdout + r.stderr;
  assert.match(said, /nodeless\.json/, "it names the config it read");
  assert.match(said, /node\.pubkey/, "and the field that would have answered the question");
  assert.deepEqual(box.nodeKeysHeld(), [nodeA], "and no key was touched");
});

test("DD-61: the store still refuses a node target that carries no pubkey", () => {
  // The guard that produced F-028's refusal is NOT being retired — it is being
  // given its answer by the caller. It remains the backstop for any future
  // caller that forgets, which is the whole of DD-61: "a caller that forgets it
  // fails closed (no key found) rather than silently using someone else's."
  // Without this, the fix above would be indistinguishable from deleting it.
  return import("../src/credentials/keys.mjs").then(({ removePrivateKey }) =>
    assert.rejects(
      () => removePrivateKey({ store: {}, target: { kind: "node" } }),
      /which hive\?/i,
      "a node removal with no pubkey must still fail closed",
    ),
  );
});

// ── The path that needs no hive must not grow a requirement ────────────────

test("F-028: keys remove --agent still works with no config discoverable at all", () => {
  // An agent key is keyed by name and needs no hive. This property is what
  // forbids the tempting one-liner of calling `resolveHive` at the top of
  // `cmdKeys`: it would break a command that works today on a machine with no
  // config anywhere. The sandbox cwd holds no config and the sandbox home has
  // none either, so a config lookup here would fail outright.
  const box = sandbox();
  const r = run(box, "keys", "remove", "--agent", `nobody-${Date.now()}`);

  assert.equal(r.status, 0, `should succeed with nothing to remove, said: ${r.stderr}${r.stdout}`);
  assert.match(r.stdout, /nothing to remove|no key was stored/i);
  assert.doesNotMatch(r.stdout + r.stderr, /config not found|which hive\?/i, "an agent removal asks for no hive");
});

// ── AC-73: say which hive, before doing the work ───────────────────────────

test("AC-73: keys remove --node names the hive and the config before it removes anything", () => {
  const box = sandbox();
  const nodeA = mintNode(box);
  const configA = configFor(box, "hiveA", nodeA);

  const r = run(box, "keys", "remove", "--node", "--config", configA);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const lines = r.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^hive402: hive /, `the banner comes FIRST, got:\n${r.stdout}`);
  assert.match(lines[0], new RegExp(nodeA.slice(0, 12)), "and names the identity that config names");
  assert.match(lines[0], /hiveA\.json/, "and the file it read");
});

// ── FIX-152: a removal says which hive it acted on ─────────────────────────

test("FIX-152: the success message names the hive, not 'the owner identity'", () => {
  const box = sandbox();
  const nodeA = mintNode(box);
  const configA = configFor(box, "hiveA", nodeA);

  const r = run(box, "keys", "remove", "--node", "--config", configA);
  const removalLine = r.stdout.split(/\r?\n/).find((l) => /removed the stored key/i.test(l)) ?? "";

  assert.ok(removalLine, `no removal line in:\n${r.stdout}`);
  assert.match(removalLine, new RegExp(nodeA.slice(0, 12)), "it says WHICH node's key it destroyed");
  assert.doesNotMatch(
    removalLine,
    /the owner identity/i,
    "stale since FIX-117 split the node's identity from the owner's",
  );
});

test("FIX-152: the nothing-to-remove message names the hive too", () => {
  // The same sentence, reached the other way. An owner who runs this against
  // the wrong config gets "nothing to remove" — and needs to be told which
  // hive that verdict is about, or they will conclude the key is gone.
  const box = sandbox();
  const nodeA = mintNode(box);
  const configA = configFor(box, "hiveA", nodeA);

  run(box, "keys", "remove", "--node", "--config", configA); // now there is nothing
  const r = run(box, "keys", "remove", "--node", "--config", configA);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const line = r.stdout.split(/\r?\n/).find((l) => /nothing to remove|no key was stored/i.test(l)) ?? "";
  assert.ok(line, `no nothing-to-remove line in:\n${r.stdout}`);
  assert.match(line, new RegExp(nodeA.slice(0, 12)), "which hive was checked");
  assert.doesNotMatch(line, /the owner identity/i);
});

test("FIX-152: no file under bin/ or src/ calls a node identity 'the owner identity'", () => {
  // One stale sentence from FIX-117 survived in three places, and they are
  // audited together because "when a mechanism gains a second route, audit the
  // sentences it already writes" is this plan's own repeated lesson.
  // `describe()` in src/credentials/keys.mjs said "the owner identity (this
  // node)", which `report()` then contradicted two lines later with "this is
  // the NODE's identity, not yours"; src/node/runtime.mjs's corrupt-key
  // message said "the owner identity" while the branch immediately above it
  // had already been corrected to "the node identity".
  // Comment lines are skipped deliberately, and the distinction is the point:
  // this forbids a node identity being DESCRIBED to an operator as the owner's,
  // not the phrase appearing in prose that explains why it was retired. A
  // sweep that banned the words outright would have reddened on the comments
  // written by this very fix, which is a check testing itself rather than the
  // product.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.mjs$/.test(entry.name)) {
        const code = readFileSync(full, "utf8")
          .split(/\r?\n/)
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        if (/the owner identity/i.test(code)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "bin"));
  walk(path.join(root, "src"));

  assert.deepEqual(
    offenders,
    [],
    `a node is not the owner — these still say otherwise: ${offenders.join(", ")}`,
  );
});
