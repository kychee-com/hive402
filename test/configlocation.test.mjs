// FIX-126 — where the config lives, and what you are told when there isn't one.
//
// ── Found by using it ──────────────────────────────────────────────────────
//
// Barry ran `hive402 up` one directory over from the one he had set up in, and
// got three absolute paths and the instruction "Create one" — for a machine that
// had a working node, a registered agent and a live room. His read of it was
// right, and it is the fix: "the config should be in user domain not in a repo
// I guess."
//
// `setup` wrote `path.resolve("hive402.config.json")`: the CURRENT WORKING
// DIRECTORY. So the config landed wherever the person happened to be standing
// when they ran setup, and every later command worked from that one directory
// and nowhere else. This is not a quirk of one machine — every install has it.
//
// ── The product already disagreed with itself ──────────────────────────────
//
// `defaultStateDir` returns `~/.hive402`. The search path has always included
// `~/.hive402/config.json`. `setup` seeds its own `stateDir` there before any
// config exists. The STATE was always user-domain; only the config was not, and
// nothing was choosing that on purpose.
//
// ── What must NOT change ───────────────────────────────────────────────────
//
// The cwd path stays in the search order, and stays FIRST. A project-local
// config is a real thing to want, and every existing install has one. Moving the
// default write location must not strand them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { candidatePaths, findConfigFile, setupConfigTarget } from "../src/config/load.mjs";

const HOME = path.join("C:", "Users", "someone");

// ── Where setup writes ────────────────────────────────────────────────────

test("with nothing given and nothing found, setup writes into the USER's home", () => {
  // The whole fix. Not the cwd, which is wherever a person happened to stand.
  const target = setupConfigTarget({ explicit: null, found: null, home: HOME, cwd: "D:\\some\\project" });
  assert.equal(target, path.join(HOME, ".hive402", "config.json"));
});

test("the chosen path is one the search will actually look in", () => {
  // The bug in one line: setup wrote somewhere `findConfigFile` would only find
  // by accident, if you happened to be standing in the same place later. These
  // two must agree by construction, not by coincidence.
  const target = setupConfigTarget({ explicit: null, found: null, home: HOME, cwd: "D:\\some\\project" });
  const searched = candidatePaths(null, { home: HOME, cwd: "E:\\somewhere\\else\\entirely" });
  assert.ok(
    searched.includes(target),
    `setup writes ${target}, which the search never looks at: ${searched.join(", ")}`,
  );
});

test("an explicit --config still wins over everything", () => {
  const target = setupConfigTarget({
    explicit: "D:\\work\\mine.json",
    found: path.join(HOME, ".hive402", "config.json"),
    home: HOME,
    cwd: "D:\\some\\project",
  });
  assert.equal(target, path.resolve("D:\\work\\mine.json"));
});

test("an existing config is REUSED, never duplicated beside itself", () => {
  // Re-running setup is meant to be safe and resumable (AC-44). Writing a second
  // config in the home directory while the real one sits in a project folder
  // would give the machine two, and the search order would then silently pick
  // whichever matched the cwd.
  const existing = path.join("D:", "project", "hive402.config.json");
  const target = setupConfigTarget({ explicit: null, found: existing, home: HOME, cwd: "D:\\project" });
  assert.equal(target, existing);
});

// ── Discovery order is unchanged ──────────────────────────────────────────

test("the project-local config is still searched, and still searched FIRST", () => {
  // Every install made before this fix has its config in a working directory.
  // Demoting the cwd would strand all of them, which is a worse bug than the one
  // being fixed.
  const searched = candidatePaths(null, { home: HOME, cwd: "D:\\project" });
  assert.equal(searched[0], path.join("D:\\project", "hive402.config.json"));
  assert.ok(searched.includes(path.join(HOME, ".hive402", "config.json")));
  assert.ok(searched.includes(path.join(HOME, ".config", "hive402", "config.json")));
});

test("HIVE402_CONFIG still outranks all of them", () => {
  const searched = candidatePaths(null, { home: HOME, cwd: "D:\\project", env: "D:\\pinned.json" });
  assert.equal(searched[0], "D:\\pinned.json");
});

// ── What the person is told ───────────────────────────────────────────────

test("the not-found message names the command that fixes it", () => {
  // Barry: "I want to get clean simple answers, this is like debug data." The
  // old message described the failure in three absolute paths and ended with
  // "Create one", which is not a thing anybody can type.
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  const said = messageFrom({ cwd: empty, home: empty });
  assert.match(said, /hive402 setup/, "it must name the command");
  assert.match(said, /--config/, "and keep the escape hatch for a config that is elsewhere");
});

test("it says WHERE the config will be written, so the answer is checkable", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  const said = messageFrom({ cwd: empty, home: empty });
  assert.ok(
    said.includes(path.join(empty, ".hive402", "config.json")),
    `the home path must appear, got: ${said}`,
  );
});

test("it does NOT dump the search list", () => {
  // Three absolute paths is a description of the search, not an answer to the
  // question the person asked, which was "why doesn't this work".
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  const said = messageFrom({ cwd: empty, home: empty });
  assert.doesNotMatch(said, /Searched:/i);
  assert.ok(said.split("\n").length <= 4, `it must stay short, got:\n${said}`);
});

test("the message carries no em-dash, because a user reads it", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  assert.doesNotMatch(messageFrom({ cwd: empty, home: empty }), /[—–]/);
});

test("a path you PASSED that is not there is reported as that path", () => {
  // The other failure, and it is a different one. Somebody who typed
  // `--config D:\typo.json` has a typo in a specific file name and needs to see
  // the file name. The first cut of FIX-126 gave them the generic "run setup"
  // answer instead, and an older test in cli-commands.test.mjs refused it —
  // correctly, so the two messages stayed two messages.
  const missing = path.join(tmpdir(), "hive402-definitely-not-here.json");
  const said = messageFrom({ explicit: missing, cwd: tmpdir(), home: tmpdir() });
  assert.ok(said.includes(missing), `it must name the path given, got: ${said}`);
  assert.doesNotMatch(said, /hive402 setup/, "and not send them to setup for a typo");
});

// ── Still finds what is there ─────────────────────────────────────────────

test("a config in the home directory is found from an unrelated directory", () => {
  // The actual thing Barry wanted: `hive402 up` works from anywhere.
  const home = mkdtempSync(path.join(tmpdir(), "hive402-home-"));
  const elsewhere = mkdtempSync(path.join(tmpdir(), "hive402-cwd-"));
  mkdirSync(path.join(home, ".hive402"), { recursive: true });
  const file = path.join(home, ".hive402", "config.json");
  writeFileSync(file, "{}");
  assert.equal(findConfigFile(null, { home, cwd: elsewhere }), file);
});

// ── The help text has to agree with the code ──────────────────────────────

test("setup's --help does not still advertise the old default", async () => {
  // It said "default ./hive402.config.json" — the very behaviour this fix
  // removes. Help that describes a previous version is worse than no help,
  // because it is believed.
  const cli = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  const usage = cli.match(/const SETUP_USAGE = `([\s\S]*?)`;/)?.[1];
  assert.ok(usage, "SETUP_USAGE must be findable, or this test proves nothing");
  assert.doesNotMatch(usage, /default \.\/hive402\.config\.json/);
  assert.match(usage, /~\/\.hive402\/config\.json/, "and it names where the config now goes");
});

function messageFrom({ cwd, home, explicit = null }) {
  try {
    findConfigFile(explicit, { home, cwd });
    assert.fail("expected it to throw");
  } catch (err) {
    return err.message;
  }
}
