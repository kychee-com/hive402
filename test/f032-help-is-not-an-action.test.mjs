// F-032 (fix cycle 19, FIX-165, DD-66): asking a program what it does must not
// make it do something.
//
// ── The incident ───────────────────────────────────────────────────────────
//
// Mid-cycle, `hive402 up --help` was run to read the usage text. `cmdUp` never
// looked at `flags.help`, so the flag fell through to a handler whose first
// statement resolves a config — and with no `--config`, the config it resolves
// is the PRODUCTION one. It started Barry's real node, published his agents and
// launched them. `hive402 down --help` is the same defect pointing the other
// way: it stops every agent the node started.
//
// ── The audit, and why the fix is not "fix up and down" ────────────────────
//
// Six of the thirteen entries in the CLI's `COMMANDS` map ignored `--help`, and
// three of the six CHANGE STATE: `up` starts a node, `down` stops one, and
// `config set <agent>.<setting> <value> --help` WRITES the config file. The
// incident found two of the three. The failing property is not "up has a bug",
// it is "asking a program what it does may do something" — a property of the
// surface, so it is enforced over the surface (DD-66).
//
// ── The quieter half, in the parser ────────────────────────────────────────
//
// `parseArgs` treated any `--x` followed by a non-`--` token as a key/value
// pair, so `--help` swallowed the next positional as its value:
// `hive402 retire --help spike` set `flags.help = "spike"` and LOST the name.
// Every current reader tests truthiness so nothing broke, but one
// `flags.help === true` written later turns this into a command that acts when
// asked for usage — the exact failure being fixed here.
//
// ── How this file is safe to run ───────────────────────────────────────────
//
// Every spawn below is sandboxed: an isolated `USERPROFILE`/`HOME`/
// `LOCALAPPDATA`, an empty working directory, and `HIVE402_CONFIG` pointed at a
// throwaway config whose `stateDir` is a temp directory and whose relay is
// unreachable. In the RED state `up --help` really does detach a node, so the
// sweep tears down with `down` against that same temp config and asserts the
// temp state directory holds no pid record afterwards. Nothing here can reach
// the operator's own hive, which is the whole subject of the finding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin", "cli.mjs");
const PID_FILE = "hive402.pid.json";

// ── The sandbox ────────────────────────────────────────────────────────────

const SANDBOX_HOME = mkdtempSync(path.join(tmpdir(), "hive402-f032-home-"));
const EMPTY_CWD = mkdtempSync(path.join(tmpdir(), "hive402-f032-cwd-"));

function sandboxConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-f032-cfg-"));
  const file = path.join(dir, "hive402.config.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        // Port 1 is not going to answer. A `--help` that reaches the relay is a
        // `--help` that already did work.
        relayUrl: "ws://127.0.0.1:1",
        stateDir: dir,
        node: { pubkey: "9".repeat(64) },
        rooms: [
          {
            channel: "11111111-1111-1111-1111-111111111111",
            agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }],
          },
        ],
      },
      null,
      2,
    ),
  );
  return { dir, file };
}

// NOT `cli-commands.test.mjs`'s `runFrom`: that one merges `process.env`
// without the sandbox home, so a mutating command run through it would reach
// the operator's real credential store.
function runIn(cfg, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: EMPTY_CWD,
    env: {
      ...process.env,
      USERPROFILE: SANDBOX_HOME,
      LOCALAPPDATA: path.join(SANDBOX_HOME, "nolocal"),
      HOME: SANDBOX_HOME,
      HIVE402_CONFIG: cfg.file,
    },
    timeout: 60_000,
  });
}

// Whatever a `--help` may have detached, taken back down before the assertion
// that nothing is left. `down` is run against the SAME temp config, so it can
// only ever reach this test's own state directory.
function teardown(cfg) {
  runIn(cfg, "down", "--config", cfg.file);
  return existsSync(path.join(cfg.dir, PID_FILE));
}

// ── The map itself, read from the source ───────────────────────────────────
//
// The list is not hardcoded here. DD-66's guard is a POSITIVE twin: it
// enumerates `COMMANDS` so a subcommand added later FAILS this suite rather
// than quietly opting out. `whichhive.test.mjs`'s AC-73 guard is phrased as a
// prohibition and F-028 walked straight through it by taking no route at all.
const CLI_SOURCE = readFileSync(bin, "utf8");

function commandNames() {
  const start = CLI_SOURCE.indexOf("const COMMANDS = {");
  assert.ok(start >= 0, "the COMMANDS map must be findable, or this guard proves nothing");
  const end = CLI_SOURCE.indexOf("\n};", start);
  assert.ok(end > start, "the COMMANDS map must be readable");
  return [...CLI_SOURCE.slice(start, end).matchAll(/^\s{2}([a-z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]);
}

// The body of one `cmdX` handler, by brace matching from its signature.
function handlerBody(fn) {
  const sig = new RegExp(`\\n(?:async )?function ${fn}\\(`);
  const at = CLI_SOURCE.search(sig);
  assert.ok(at >= 0, `handler ${fn} must exist in bin/cli.mjs`);
  // The BODY brace, not the destructured parameter one: every handler here is
  // written `function cmdX({ flags }) {`, so the first `{` after the signature
  // belongs to the argument, and matching from it reads `{ flags }` as the
  // whole function.
  const paren = CLI_SOURCE.indexOf("(", at);
  let d = 0;
  let close = paren;
  for (let i = paren; i < CLI_SOURCE.length; i += 1) {
    if (CLI_SOURCE[i] === "(") d += 1;
    else if (CLI_SOURCE[i] === ")") {
      d -= 1;
      if (d === 0) { close = i; break; }
    }
  }
  const open = CLI_SOURCE.indexOf("{", close);
  let depth = 0;
  for (let i = open; i < CLI_SOURCE.length; i += 1) {
    if (CLI_SOURCE[i] === "{") depth += 1;
    else if (CLI_SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CLI_SOURCE.slice(open, i + 1);
    }
  }
  throw new Error(`could not read the body of ${fn}`);
}

function handlerFor(name) {
  const map = CLI_SOURCE.slice(CLI_SOURCE.indexOf("const COMMANDS = {"));
  const m = map.match(new RegExp(`^\\s{2}${name}\\s*:\\s*([A-Za-z0-9_]+)`, "m"));
  assert.ok(m, `${name} must name a handler in the COMMANDS map`);
  return m[1];
}

// There should be none. A command that may act when asked for usage is the
// finding, not an exception to it — so this list is closed and empty, and
// anything added to it has to be argued for in the diff.
const EXEMPT = new Set();

// ── DD-66's enumerating guard: every member ANSWERS ────────────────────────

test("DD-66 guard: every command in the COMMANDS map checks --help before it resolves anything", () => {
  const names = commandNames();
  assert.equal(names.length, 13, `the map should hold thirteen commands, found ${names.join(", ")}`);
  assert.equal(EXEMPT.size, 0, "a command that may act when asked for usage is the finding, not an exception");

  const missing = [];
  const late = [];
  for (const name of names) {
    if (EXEMPT.has(name)) continue;
    const body = handlerBody(handlerFor(name));
    const help = body.search(/flags\.help/);
    if (help < 0) {
      missing.push(name);
      continue;
    }
    // The check must come before the config is resolved, so `--help` answers on
    // a machine that has no config at all — and, more to the point, before the
    // PRODUCTION config is resolved on a machine that does.
    const resolve = body.search(/resolveHive\(|loadConfig\(/);
    if (resolve >= 0 && resolve < help) late.push(name);
  }
  assert.deepEqual(missing, [], "these commands never look at --help");
  assert.deepEqual(late, [], "these commands resolve a config BEFORE answering --help");
});

// ── The behavioural sweep: spawn the real CLI, once per command ────────────

test("F-032: every command answers --help with usage, exit 0, and no state change", () => {
  const cfg = sandboxConfig();
  const before = readFileSync(cfg.file, "utf8");
  const failures = [];

  for (const name of commandNames()) {
    if (EXEMPT.has(name)) continue;
    for (const flag of ["--help", "-h"]) {
      const r = runIn(cfg, name, flag);
      if (r.status !== 0) failures.push(`${name} ${flag}: exit ${r.status} — ${r.stderr?.trim()}`);
      if (!/usage:/i.test(r.stdout ?? "")) {
        failures.push(`${name} ${flag}: no usage on stdout — ${(r.stdout ?? "").slice(0, 120)}`);
      }
    }
  }

  const leftRunning = teardown(cfg);
  assert.deepEqual(failures, [], "a usage request must be answered, on every command");
  assert.equal(leftRunning, false, "and must never have started a node");
  assert.equal(readFileSync(cfg.file, "utf8"), before, "and must never have written the config");
});

// ── The three that CHANGE STATE, named one at a time ──────────────────────

test("F-032: `up --help` prints usage and starts NOTHING", () => {
  const cfg = sandboxConfig();
  const r = runIn(cfg, "up", "--help");

  const leftRunning = teardown(cfg);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: hive402 up/i);
  assert.ok(
    !/watching the room|publishing|Starting/i.test(r.stdout),
    `up --help must not have started the node: ${r.stdout.slice(0, 300)}`,
  );
  assert.equal(leftRunning, false, "no pid record — this is the incident");
});

test("F-032: `down --help` prints usage and stops NOTHING", () => {
  const cfg = sandboxConfig();
  // A pid record that `down` would act on if it ran. It names this process,
  // which is alive, so a `down` that runs has something real to report.
  writeFileSync(
    path.join(cfg.dir, PID_FILE),
    JSON.stringify({ node: { pid: process.pid, startedAt: Date.now() }, agents: {} }, null, 2),
  );
  const kept = readFileSync(path.join(cfg.dir, PID_FILE), "utf8");

  const r = runIn(cfg, "down", "--help");

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: hive402 down/i);
  assert.equal(
    readFileSync(path.join(cfg.dir, PID_FILE), "utf8"),
    kept,
    "the pid record is untouched — `down --help` stopped nothing",
  );
  // The lines cmdDown prints when it actually RUNS. Matched with the
  // "hive402: " prefix, because the usage text legitimately contains the word
  // "stopped" while describing what the command does.
  assert.ok(
    !/hive402: (nothing to stop|stopped |cleared |LEFT ALONE|nothing was running)/.test(r.stdout),
    `down --help must not have run: ${r.stdout}`,
  );
});

test("F-032: `config set … --help` prints usage and WRITES NOTHING", () => {
  // The third state-changer, and the one the incident did not find.
  const cfg = sandboxConfig();
  const before = readFileSync(cfg.file, "utf8");

  const r = runIn(cfg, "config", "set", "spike.research", "true", "--help");

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: hive402 config/i);
  assert.equal(readFileSync(cfg.file, "utf8"), before, "the config file is byte-identical");
});

// ── The parser half: `--help` is a boolean, not a key/value pair ───────────

test("F-032: `--help` does not swallow the next positional as its value", () => {
  const cfg = sandboxConfig();
  // `retire --help spike`: `flags.help` used to be the STRING "spike", and the
  // name was lost from `positional`. Every reader tests truthiness today, so
  // one `flags.help === true` written later is all it takes to turn this into
  // a command that acts when asked for usage.
  const r = runIn(cfg, "retire", "--help", "spike");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: hive402 retire/i);
});

test("F-032: `config --help set …` answers usage rather than acting on the swallowed positional", () => {
  const cfg = sandboxConfig();
  const before = readFileSync(cfg.file, "utf8");

  const r = runIn(cfg, "config", "--help", "set", "spike.research", "true");

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Usage: hive402 config/i);
  assert.equal(readFileSync(cfg.file, "utf8"), before, "and wrote nothing on the way");
});

test("F-032: `hive402 --help up` answers ABOUT up — the positional is not eaten by the flag", () => {
  // The observable half of the parser defect, and the only one there is: with
  // `--help` taking a value, `--help up` set flags.help = "up" and left
  // `positional` EMPTY, so the dispatcher saw no command and printed the global
  // usage. The user asked about `up` and was answered about the program.
  const cfg = sandboxConfig();
  const long = runIn(cfg, "--help", "up");
  const short = runIn(cfg, "-h", "up");

  assert.equal(long.status, 0, `stderr: ${long.stderr}`);
  assert.match(long.stdout, /Usage: hive402 up/i, "the subcommand it was asked about");
  // Two inputs that should NOT differ must not differ. `-h` never swallowed a
  // positional, so before the fix these two produced different documents.
  assert.equal(long.stdout, short.stdout, "--help and -h are the same request");
  assert.equal(teardown(cfg), false, "and neither one started anything");
});

test("F-032: `--version` is boolean too, for the same reason", () => {
  const cfg = sandboxConfig();
  const r = runIn(cfg, "--version", "up");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/, "the version, and not a started node");
  assert.equal(teardown(cfg), false, "and nothing was started on the way");
});

// ── The near-miss check: two inputs that should DIFFER must differ ─────────
//
// The F-028 lesson, applied to this fix rather than to the last one. A guard
// that makes `up` inert is not a fix, it is the same outage with better
// manners — so the pair that must differ is checked in both directions.

test("F-032 near-miss: `up --config <file> --help` also starts nothing, and `up --config <file>` still runs", () => {
  const cfg = sandboxConfig();

  const asked = runIn(cfg, "up", "--config", cfg.file, "--help");
  const startedByAsking = teardown(cfg);
  assert.equal(asked.status, 0, `stderr: ${asked.stderr}`);
  assert.match(asked.stdout, /Usage: hive402 up/i);
  assert.equal(startedByAsking, false, "an explicit --config does not make --help an action");

  // And the command itself is NOT inert. `--foreground` so it runs in this
  // process rather than detaching: the relay is unreachable, so it fails — but
  // it must fail having ACTED, with the AC-73 banner naming the hive first.
  const ran = runIn(cfg, "up", "--config", cfg.file, "--foreground");
  teardown(cfg);
  const said = `${ran.stdout}${ran.stderr}`;
  assert.match(said, /hive402: hive [0-9a-f]{12}/i, "AC-73: it names the hive it resolved, BEFORE it acts");
  assert.ok(
    !/Usage: hive402 up/i.test(ran.stdout ?? ""),
    "and it does not print usage instead of working — that would be the same outage with better manners",
  );
});
