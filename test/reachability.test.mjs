import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The module-with-no-caller guard.
//
// This project has now shipped the same bug five times: an invented attestation
// format, `LoopGuard.allow()`, `setAgentPrivateKey`, `buildAndDeploy`, and a
// caller nothing triggered. Each time, a green unit suite proved the module was
// CORRECT while the product never reached it. A test cannot prove a feature is
// triggered, nor that a third party's response has the field we read — but it
// CAN prove that a path exists from the executable to the module, and that is
// the one of the four failure modes worth automating.
//
// So: walk the real import graph out of `bin/cli.mjs`, following static and
// dynamic imports alike (this CLI lazy-loads nearly everything with
// `await import(...)`, so a static-only walk would see almost nothing).

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "bin", "cli.mjs");

// Both import spellings, because this CLI uses the dynamic one almost
// everywhere:
//   import { x } from "./y.mjs"      export * from "./y.mjs"
//   await import("./y.mjs")
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

// …and a third way of reaching a module that is NOT an import at all: the tool
// gate and turn gate run INSIDE the agent's process as buzz-acp hook scripts,
// so the supervisor reaches them by resolving a path and handing it to node
// (`new URL("../runtime/toolgate.mjs", import.meta.url)`). An import-only walk
// calls the containment layer an orphan, which is the check being wrong rather
// than the code — spawning a file is reaching it.
const URL_REFERENCE = /new URL\(\s*["']([^"']+\.mjs)["']/g;

function importsOf(file) {
  const source = readFileSync(file, "utf8");
  const out = [];
  for (const pattern of [SPECIFIER, URL_REFERENCE]) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!specifier.startsWith(".")) continue; // bare: node:, @noble, …
      out.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return out;
}

function reachableFrom(entry) {
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let next;
    try {
      next = importsOf(file);
    } catch {
      continue; // a specifier that does not resolve to a file we can read
    }
    queue.push(...next);
  }
  return seen;
}

function allSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const REACHABLE = reachableFrom(CLI);
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

function safeRead(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

test("the credential store is reachable from the CLI", () => {
  const store = path.join(ROOT, "src", "credentials", "store.mjs");
  assert.ok(
    REACHABLE.has(store),
    "bin/cli.mjs cannot reach src/credentials/store.mjs.\n" +
      "That is the exact shape of the fix-cycle-7 bug: `privateKeyRef` defaults to\n" +
      '"keychain", so the DEFAULT config path needs this module, and nothing imported it.',
  );
});

// Reachable is not enough — `registerAgent` "reached" the store for two cycles
// through a method that did not exist. Some file the CLI can reach must
// actually WRITE, or nothing ever populates the keychain and every "keychain"
// ref fails at `up`. The store's own definition does not count as its caller.
test("a module the CLI can reach writes a key to the store", () => {
  const definition = path.join(ROOT, "src", "credentials", "store.mjs");
  const writers = [...REACHABLE]
    .filter((file) => file !== definition)
    .filter((file) => /\b(setAgentPrivateKey|setNodePrivateKey)\s*\(/.test(safeRead(file)))
    .map(rel);

  assert.ok(
    writers.length > 0,
    "nothing the CLI can reach calls setAgentPrivateKey or setNodePrivateKey.\n" +
      "The store can be read but never filled, which is a keychain that is always empty —\n" +
      "the fix-cycle-7 bug exactly.",
  );
});

test("the key-management commands are reachable from the CLI", () => {
  for (const module of ["src/credentials/keys.mjs", "src/credentials/prompt.mjs"]) {
    assert.ok(REACHABLE.has(path.join(ROOT, module)), `bin/cli.mjs cannot reach ${module}`);
  }
});

// The general form. Any NEW module that nothing reaches is the next instance of
// this bug, so it fails here rather than in a system test six weeks later.
//
// `plugin.mjs` is the documented step-2 seam (DD-1): the private core package
// in the other repo imports it, not this CLI. That one is by design.
const BY_DESIGN = new Set(["src/plugin.mjs"]);

// These are NOT by design. Fix cycle 7 built this guard and it immediately
// found three more modules that have unit tests and no product caller — the
// same bug as `setAgentPrivateKey`, sitting in the tree right now:
//
//   src/launcher/index.mjs        exports launchAgent(); the Supervisor builds
//                                 the env and spawns the process itself, so
//                                 this looks superseded rather than pending
//   src/safety/buzzgovernance.mjs assertOwnEventKind/HIVE402_WRITABLE_KINDS
//
// They are recorded rather than fixed: deciding whether each is dead code or an
// unwired feature means reading what the spec expects of it, which is its own
// piece of work and not this cycle's. The list may SHRINK freely; it must never
// grow, which is what the assertion below enforces.
//
// It shrank once. FIX-121's spike established that publishing DD-5's kind-10100
// record would REPLACE the `channel_add_policy` record Buzz's own CLI owns, and
// still not reach the picker on a release Desktop build. So
// `src/registry/directory.mjs`, whose only job was to build one, was deleted
// with its test: a module with no caller that exists to send an event we must
// never send is not pending work, it is a footgun waiting to be wired up.
const KNOWN_UNREACHED = new Set([
  "src/launcher/index.mjs",
  "src/safety/buzzgovernance.mjs",
]);

test("no NEW module under src/ is unreachable from the CLI", () => {
  const unreached = allSourceFiles(path.join(ROOT, "src"))
    .map(rel)
    .filter((file) => !REACHABLE.has(path.join(ROOT, file)))
    .filter((file) => !BY_DESIGN.has(file));

  const fresh = unreached.filter((file) => !KNOWN_UNREACHED.has(file));
  assert.deepEqual(
    fresh,
    [],
    `these modules exist but nothing in the product reaches them:\n  ${fresh.join("\n  ")}\n` +
      "A module with no caller is this project's most-repeated bug. Wire it up, delete it,\n" +
      "or — if it is a deliberate seam — add it to BY_DESIGN with the reason.",
  );

  // Keep the ledger honest in the other direction too: once one is resolved,
  // this fails until it is struck off, so the list cannot quietly rot.
  const staleEntries = [...KNOWN_UNREACHED].filter((file) => !unreached.includes(file));
  assert.deepEqual(
    staleEntries,
    [],
    `these are listed as known-unreachable but are now reached (or gone):\n  ${staleEntries.join("\n  ")}\n` +
      "Remove them from KNOWN_UNREACHED.",
  );
});
