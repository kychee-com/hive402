#!/usr/bin/env node
// The terminal shape of AC-44's single guided setup.
//
//   node scripts/setup.mjs --invite <link> --agent <name> --owner <npub1…>
//
// It is a thin wrapper on purpose. The WORK lives in `hive402 setup`, which the
// coding-agent shape also drives — two shapes reaching one recipe, because two
// recipes drift and the one that drifts is always the one nobody ran this week.
// What this script adds is the part a person in a terminal needs and a coding
// agent already has: checking that the prerequisites are actually present, and
// saying what to install when they are not.
//
// No installer, per AC-44. This runs hive402 from the checkout it is in.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

const say = (line = "") => process.stdout.write(`${line}\n`);
const die = (line) => {
  process.stderr.write(`setup: ${line}\n`);
  process.exit(1);
};

// ── Prerequisites ─────────────────────────────────────────────────────────
//
// hive402 runs agents on Buzz's own harness and shells out to Buzz's own CLI.
// Both ship with Buzz, so a missing one is not a hive402 problem to work
// around — it is "install Buzz first", and saying so is faster than every
// failure that follows from not saying it.

const cliPath = path.join(root, "bin", "cli.mjs");

// Reading the help must not require anything to be installed. Someone deciding
// WHETHER to set this up is exactly the person who has not installed Buzz yet,
// and answering their question with an installation error is a bad trade.
if (args.includes("--help") || args.includes("-h")) {
  const shown = spawnSync(process.execPath, [cliPath, "setup", "--help"], { stdio: "inherit" });
  process.exit(shown.status ?? 0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) die(`node ${process.versions.node} is too old — hive402 needs 20 or newer.`);

const buzz = process.platform === "win32" ? "buzz.exe" : "buzz";
const probe = spawnSync(buzz, ["--version"], { encoding: "utf8", shell: false });
if (probe.error) {
  die(
    `could not run "${buzz}". hive402 talks to the relay through Buzz's own CLI and runs\n` +
      `  agents on Buzz's own harness, so Buzz has to be installed and signed in first:\n` +
      `  https://github.com/block/buzz`,
  );
}

if (!existsSync(cliPath)) die(`this script expects to sit next to hive402's bin/cli.mjs (looked in ${root}).`);

say("setup: node and buzz are present.");
say("");

// ── The work ──────────────────────────────────────────────────────────────
//
// Handed straight through, stdio inherited, because the join asks a person to
// accept the community's terms in their own words and that conversation has to
// reach the terminal they are sitting at (AC-45).

const result = spawnSync(process.execPath, [cliPath, "setup", ...args], { stdio: "inherit" });
process.exit(result.status ?? 1);
