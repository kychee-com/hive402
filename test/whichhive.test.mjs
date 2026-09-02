// AC-73: every command that acts on a node says which node it acted on.
//
// The red team filed the shape of this after a near-miss: a bare `hive402`
// with no `--config` silently resolved to Barry's live hive. With one node
// that is untidy. With several (AC-72) it is how you deploy to the wrong hive,
// and the wrong hive is somebody's running room.
//
// `status` already named its config (FIX-141). This makes it the rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hiveBanner } from "../src/config/load.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const NODE = "305e6147aa4a66b09bd27d2fbb560824769ea4115369c4d9be2e76095a605359";

test("AC-73: the banner names the config it resolved and the identity that config names", () => {
  const line = hiveBanner({ configFile: "C:/Users/barry/.hive402/config.json", config: { node: { pubkey: NODE } } });
  assert.match(line, /config\.json/, "the file it read");
  assert.match(line, new RegExp(NODE.slice(0, 12)), "and the hive that file names");
});

test("AC-73: a config with no identity still says which FILE was read", () => {
  // Half an answer beats none: "which file" is the half that tells an operator
  // whether they are pointed at the hive they meant.
  const line = hiveBanner({ configFile: "C:/tmp/other.json", config: {} });
  assert.match(line, /other\.json/);
});

// The rule, enforced structurally rather than command by command — a
// node-acting command added later must not be able to skip it quietly.
//
// ONE seam: commands resolve a hive through `resolveHive`, which loads the
// config AND says which one. Calling `loadConfig` directly inside a command is
// the bypass, so it is what this forbids.
test("AC-73: no command resolves a config without going through the announcing seam", () => {
  const src = readFileSync(CLI, "utf8");
  const handlers = [...src.matchAll(/async function (cmd\w+)\s*\(([\s\S]*?)\n\}/g)];
  const bypassing = handlers.filter(([body]) => /loadConfig\(/.test(body)).map(([, name]) => name);
  assert.deepEqual(
    bypassing,
    [],
    `these commands load a config directly instead of resolveHive, so they never say ` +
      `which hive they acted on (AC-73): ${bypassing.join(", ")}`,
  );

  // And the seam really announces.
  assert.match(src, /function resolveHive\b/, "the seam exists");
  const seam = src.slice(src.indexOf("function resolveHive"), src.indexOf("function resolveHive") + 700);
  assert.match(seam, /hiveBanner\(/, "and it is what prints the banner");
});

test("AC-73: status answers in-band, in its JSON, rather than printing a banner over it", () => {
  // The one command whose output is parsed by machines. A banner line before
  // the JSON would break every caller, so it carries the same two facts as
  // fields instead — which is stricter, not laxer.
  const src = readFileSync(CLI, "utf8");
  const body = src.slice(src.indexOf("async function cmdStatus"), src.indexOf("async function cmdConfig"));
  assert.match(body, /configFile/, "status names the config it resolved");
});

// ── The keys family: which of its actions may skip the seam (F-028) ────────
//
// The no-bypass test above looks for the WRONG WAY to resolve a config
// (`loadConfig` inside a command). F-028 passed it vacuously, because
// `keys remove` resolved no config AT ALL — there was no bypass to find. A
// command that never asks which hive cannot be caught by a test that only
// watches how commands ask.
//
// So this asserts the positive form, per action, with a CLOSED exception list.
// Two actions may skip the seam, and only because they DERIVE the node pubkey
// from the secret itself (`write`/`writeNew` in src/credentials/keys.mjs), so a
// key always lands under its own identity and a config would be a second,
// disagreeing source of truth. `keygen` additionally runs before a config
// exists at all, which is AC-56's whole shape. Everything that READS or
// REMOVES a node key takes the pubkey from that hive's config.
const KEYS_ACTIONS_THAT_DERIVE = ["import"];

test("AC-72/AC-73: every keys action that reads or removes a node key resolves a hive", () => {
  const src = readFileSync(CLI, "utf8");
  const start = src.indexOf("async function cmdKeys");
  assert.ok(start > 0, "cmdKeys exists");
  const body = src.slice(start, src.indexOf("\n}", start));

  const marks = [...body.matchAll(/if \(action === "([\w-]+)"\)/g)];
  assert.ok(marks.length >= 3, `expected the keys actions to be dispatched by name, found ${marks.length}`);

  const ends = [...marks.map((m) => m.index), body.length].slice(1);
  const skipping = marks
    .map((m, i) => ({ action: m[1], code: body.slice(m.index, ends[i]) }))
    .filter(({ action, code }) => !KEYS_ACTIONS_THAT_DERIVE.includes(action) && !/resolveHive\(/.test(code))
    .map(({ action }) => action);

  assert.deepEqual(
    skipping,
    [],
    `these keys actions act on a node key without resolving a hive, so they can neither find ` +
      `the right key nor say which one they meant (F-028): ${skipping.join(", ")}`,
  );
});

test("AC-72: the exception list is closed — a new keys action must be classified", () => {
  // Guard on the guard. Without this, an action added later that neither
  // resolves a hive nor derives a pubkey could be waved through by widening
  // the list, which is the failure mode the test above exists to prevent.
  const src = readFileSync(CLI, "utf8");
  const start = src.indexOf("async function cmdKeys");
  const body = src.slice(start, src.indexOf("\n}", start));
  const actions = [...body.matchAll(/if \(action === "([\w-]+)"\)/g)].map((m) => m[1]).sort();

  assert.deepEqual(
    actions,
    ["import", "list", "migrate-node", "remove"],
    "a keys action was added or renamed — decide whether it derives its pubkey or resolves a hive, " +
      "then update this list and KEYS_ACTIONS_THAT_DERIVE deliberately",
  );
});

test("AC-72: the exception is earned — the deriving path really derives", () => {
  // The allowance is a claim about the code, so it is checked rather than
  // asserted. If `write`/`writeNew` ever stopped deriving the pubkey from the
  // secret, `keygen` and `keys import` would be storing node keys under an
  // unverified label and the exception above would be unsafe.
  const keys = readFileSync(path.join(path.dirname(CLI), "..", "src", "credentials", "keys.mjs"), "utf8");
  for (const fn of ["const write =", "const writeNew ="]) {
    const at = keys.indexOf(fn);
    assert.ok(at > 0, `${fn} exists`);
    assert.match(
      keys.slice(at, at + 260),
      /derivePubkey\(secret\)/,
      `${fn} must derive the node pubkey from the secret — that is why keygen and import may skip the seam`,
    );
  }
});
