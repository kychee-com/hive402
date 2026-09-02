// F-038 — the join record lands in whichever hive's directory the config names.
//
// Red Team cycle 21, found verifying AC-45's positive branch: a throwaway node
// joined a policy-gated community with its own `--config`, whose config
// declared its own `stateDir`, and the acceptance record was written to
// `C:\Users\volin\.hive402\join.json` — Barry's PRODUCTION node's state
// directory. The throwaway's own `stateDir` was never created at all.
//
// ── The mechanism is not the one the finding named ────────────────────────
//
// The report reads it as "the write ignores the config's stateDir". It does
// not: `writeJoinRecord({ stateDir, record })` has always taken a `stateDir`,
// and `cmdJoin` already calls `defaultStateDir(config)`. Implementing that
// recommendation would have changed nothing.
//
// The defect is the line below it:
//
//     try { config = resolveHive(flags).config; stateDir = defaultStateDir(config); }
//     catch { stateDir = path.join(homedir(), ".hive402"); }
//
// `parseConfig` REJECTS a config with no rooms, a room requires a registered
// agent, and an agent cannot be registered until after the join. So at the
// moment `join` runs, a legitimately-authored config throws, this `catch`
// swallows it without a word, and the write relocates to the home directory —
// which is where Barry's production node lives, because his own config
// declares no `stateDir` either.
//
// Four commands share the idiom, not one: `keygen`, `join`, `setup`, `profile`.
//
// ── What is pinned here, and what only the live cell can pin ──────────────
//
// This file pins the DECISION: given a config, which state directory. The
// end-to-end proof needs a real relay serving a real invite, so it is FIX-197,
// run live. That split is deliberate — a mock of a join would be a mock of the
// mechanism, which has shipped bugs in this product twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveStateDir, stateDirFrom } from "../src/config/load.mjs";
import { readJoinRecord, writeJoinRecord } from "../src/registry/joinrecord.mjs";

const scratch = (label) => mkdtempSync(path.join(tmpdir(), `hive402-f038-${label}-`));

// A home directory that is EMPTY and stays that way unless something leaks
// into it. This is the assertion that would have failed on 0.3.5.
function box() {
  const root = scratch("box");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return {
    root,
    home,
    project,
    homeDefault: path.join(home, ".hive402"),
    // Everything under the home default, or [] when it was never created —
    // "nothing leaked" has to be a literal read, not an inference.
    homeLeak: () => (existsSync(path.join(home, ".hive402")) ? readdirSync(path.join(home, ".hive402")).sort() : []),
    // `dir` defaults to the project directory. It is a parameter because the
    // question "does this config live in the home hive directory or somewhere
    // else" turned out to be load-bearing (F-040) and was not askable here.
    write(name, config, dir = project) {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2), "utf8");
      return file;
    },
  };
}

// The shape a config has AT JOIN TIME: a relay, a state directory, and no
// rooms — because a room needs an agent and an agent needs the join to have
// happened. This is the config the product itself leads you to.
const AT_JOIN_TIME = (stateDir) => ({ relayUrl: "ws://localhost:3000", stateDir });

// The shape after `register`: this one parses.
const LAUNCHABLE = (stateDir) => ({
  relayUrl: "ws://localhost:3000",
  stateDir,
  node: { pubkey: "9".repeat(64) },
  rooms: [
    {
      channel: "11111111-1111-1111-1111-111111111111",
      agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }],
    },
  ],
});

// ── The core of F-038 ─────────────────────────────────────────────────────

test("a config that declares a stateDir and has no rooms yet still names its own directory", () => {
  // The failing test, written first. On 0.3.5 this config threw
  // `config needs at least one room`, the catch swallowed it, and the answer
  // was the home directory.
  const b = box();
  const mine = path.join(b.root, "mine", ".hive402");
  const file = b.write("hive402.config.json", AT_JOIN_TIME(mine));

  const resolved = resolveStateDir(file, { home: b.home });

  assert.equal(resolved.stateDir, mine, "the config named a directory and it is the answer");
  assert.notEqual(resolved.stateDir, b.homeDefault, "the home default is another node's directory");
  assert.equal(resolved.reason, "unparsed", "it genuinely does not parse — that is the point");
  assert.equal(resolved.config, null, "and nothing pretends it did");
  assert.equal(resolved.file, file);
});

test("reading one top-level string does not require the config to be launch-ready", () => {
  // Why `unparsed` reads the RAW object: `stateDir` is a string at the top of
  // the file. Requiring `rooms` before it can be read is what tied "where does
  // this node keep its things" to "is this node ready to run agents".
  const b = box();
  const mine = path.join(b.root, "mine");
  const file = b.write("hive402.config.json", { ...AT_JOIN_TIME(mine), rooms: [] });
  assert.equal(resolveStateDir(file, { home: b.home }).stateDir, mine);
});

test("a launchable config resolves the same way, and says so", () => {
  const b = box();
  const mine = path.join(b.root, "mine");
  const file = b.write("hive402.config.json", LAUNCHABLE(mine));
  const resolved = resolveStateDir(file, { home: b.home });
  assert.equal(resolved.stateDir, mine);
  assert.equal(resolved.reason, "parsed");
  assert.ok(resolved.config, "a config that parses is handed back parsed");
});

test("with no config anywhere, the home default is still the answer", () => {
  // The case the catch was written for, and the only one it was right about.
  // A machine with no config has exactly one node, and this is its directory.
  const b = box();
  const resolved = resolveStateDir(null, { home: b.home, cwd: b.project, env: null });
  assert.equal(resolved.stateDir, b.homeDefault);
  assert.equal(resolved.reason, "no-config");
  assert.equal(resolved.file, null);
});

// CORRECTED at F-040 (cycle 25). What stood here was a single test —
// "a config that declares no stateDir gets the home default, which is its own" —
// which asserted the exact behaviour the Red Team later filed as a P1, and was
// GREEN through two cycles. Its comment named Barry's production config, where
// the claim IS true, because his config lives IN `~/.hive402`. Its body wrote
// the config into the project directory instead, silently dropping the one
// condition that made "which is its own" true. The comment and the body
// described different scenarios and only the comment was right.
//
// Split into the two scenarios it was conflating. Neither assertion is
// re-pointed: the first is the case the old comment described, unchanged, and
// the second is the case its body actually built.

test("a config IN the home hive directory gets the home default, which really is its own", () => {
  // Barry's production shape: `~/.hive402/config.json`, no `stateDir` key, and
  // his state directly in `~/.hive402/`. `dirname` of that config IS that
  // directory, so this answer is identical before and after F-040's fix and his
  // node needs no migration.
  const b = box();
  const file = b.write("config.json", LAUNCHABLE(undefined), b.homeDefault);
  const resolved = resolveStateDir(file, { home: b.home });
  assert.equal(resolved.stateDir, b.homeDefault);
  assert.equal(resolved.reason, "parsed");
});

test("a config anywhere else that declares no stateDir gets ITS own directory", () => {
  // The case the old body built and the old assertion got wrong. `~/.hive402`
  // is the FIRST hive's directory; handing it to a config that lives elsewhere
  // is how a throwaway node came to read Barry's pid file and refuse to start.
  const b = box();
  const file = b.write("hive402.config.json", LAUNCHABLE(undefined));
  const resolved = resolveStateDir(file, { home: b.home });
  assert.equal(resolved.stateDir, b.project);
  assert.notEqual(resolved.stateDir, b.homeDefault);
  assert.equal(resolved.reason, "parsed");
});

// ── An explicit --config is never silently discarded ──────────────────────

test("an explicit --config that is not there fails, rather than relocating the write", () => {
  const b = box();
  const missing = path.join(b.project, "not-here.json");
  assert.throws(
    () => resolveStateDir(missing, { home: b.home }),
    (err) => {
      assert.ok(err.message.includes(missing), `it must name the path passed:\n${err.message}`);
      return true;
    },
  );
  assert.deepEqual(b.homeLeak(), [], "and nothing was created under the home default");
});

test("a config that exists but is not JSON fails, whether it was passed or found", () => {
  // The file EXISTS. Silently ignoring a config that is present is the whole
  // defect class — and for `setup` the old behaviour was worse than silent, it
  // overwrote the unreadable file with a fresh one.
  const b = box();
  const file = b.write("hive402.config.json", "{ not json");
  for (const explicit of [file, null]) {
    assert.throws(
      () => resolveStateDir(explicit, { home: b.home, cwd: b.project, env: null }),
      /not valid JSON/,
      explicit ? "passed explicitly" : "found by discovery",
    );
  }
});

test("discovery with nothing found stays silent, because that genuinely is step one", () => {
  // The half that must NOT become strict: `hive402 join <link>` on a fresh
  // machine has no config and needs none.
  const b = box();
  assert.doesNotThrow(() => resolveStateDir(null, { home: b.home, cwd: b.project, env: null }));
});

// ── FIX-195: a relative stateDir belongs to the config, not to the cwd ─────

test("a relative stateDir resolves against the config file, not wherever you stood", () => {
  // The same class as FIX-126, which this module's own comments record: a path
  // resolved against the current directory follows the operator around, so the
  // same config means a different directory depending on where it was run.
  const b = box();
  const file = b.write("hive402.config.json", AT_JOIN_TIME(".hive402"));
  const resolved = resolveStateDir(file, { home: b.home, cwd: b.root });
  assert.equal(resolved.stateDir, path.join(b.project, ".hive402"), "beside the config that named it");
  assert.notEqual(resolved.stateDir, path.join(b.root, ".hive402"), "not beside the caller");
});

test("an absolute stateDir is left exactly as written", () => {
  // Doctrine, same as DD-71's: the operator's answer is not rewritten.
  const b = box();
  const mine = path.join(b.root, "somewhere", "else");
  const file = b.write("hive402.config.json", AT_JOIN_TIME(mine));
  assert.equal(resolveStateDir(file, { home: b.home }).stateDir, mine);
});

// ── Two hives never share a record ────────────────────────────────────────

const RECORD = (pubkey, policyVersion) => ({
  status: "joined",
  host: "relay.example",
  origin: "https://relay.example",
  pubkey,
  policyVersion,
  ageConfirmed: true,
});

test("two configs with different stateDirs never share a join record", () => {
  const b = box();
  const first = path.join(b.root, "hive-a", ".hive402");
  const second = path.join(b.root, "hive-b", ".hive402");
  const fileA = b.write("a.config.json", AT_JOIN_TIME(first));
  const fileB = b.write("b.config.json", AT_JOIN_TIME(second));

  const dirA = resolveStateDir(fileA, { home: b.home }).stateDir;
  const dirB = resolveStateDir(fileB, { home: b.home }).stateDir;
  assert.notEqual(dirA, dirB);

  writeJoinRecord({ stateDir: dirA, record: RECORD("aa".repeat(32), "policy-a") });
  writeJoinRecord({ stateDir: dirB, record: RECORD("bb".repeat(32), "policy-b") });

  // Each hive's record is its own — the pubkey AND the exact policy version
  // AC-45 requires recorded.
  assert.equal(readJoinRecord(dirA).pubkey, "aa".repeat(32));
  assert.equal(readJoinRecord(dirA).policyVersion, "policy-a");
  assert.equal(readJoinRecord(dirB).pubkey, "bb".repeat(32));
  assert.equal(readJoinRecord(dirB).policyVersion, "policy-b");

  // And the thing that actually happened in cycle 21: nothing under the home
  // default, which on the real machine is a third node's directory.
  assert.deepEqual(b.homeLeak(), [], "no record leaked into the home default");
});

test("a second join by a second node does not overwrite the first", () => {
  // The report's live risk: "a second join would silently overwrite whatever is
  // currently there." With per-hive directories it cannot reach it.
  const b = box();
  const first = path.join(b.root, "hive-a", ".hive402");
  const second = path.join(b.root, "hive-b", ".hive402");
  writeJoinRecord({ stateDir: first, record: RECORD("aa".repeat(32), "policy-a") });
  writeJoinRecord({ stateDir: second, record: RECORD("bb".repeat(32), "policy-b") });
  assert.equal(readJoinRecord(first).policyVersion, "policy-a", "the first record survived the second join");
});

// ── The structural guard: a fifth command cannot reintroduce the idiom ────
//
// Phase 45's guard was written to stop a FOURTH caller hardcoding a binary
// name and immediately found three that already existed. This one is written
// expecting the same, and it is why the home-default literal now has one home.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// BROADENED at F-040 (cycle 25). The original matched `path.join(...)` calls
// containing `homedir()`, which is one spelling of one question. It could not
// see `pathJoin(home, ".hive402", …)` where `home` came from
// `process.env.USERPROFILE` — the spelling the credential store actually uses —
// so "exactly one place" was only ever checked against half the ways to write
// it. The rule is now about the DESTINATION rather than how the home directory
// was spelled: any path built from a literal `.hive402` segment is a hive
// directory being named from outside the seam.
//
// The allowlist is explicit, with a reason per entry, rather than a bare skip.
// A silent `continue` is indistinguishable from an oversight the next time
// somebody reads this.
const HIVE_PATH_ALLOWED = {
  "src/config/load.mjs":
    "the seam itself — `homeStateDir` and `stateDirFrom` are where this decision is made (DD-72, DD-73)",
  "src/credentials/keychain.mjs":
    "the credential store is machine-scoped BY DESIGN and keyed per node inside it (AC-72, DD-73): " +
    "one OS-keychain stand-in per user, not one per hive, and moving it would strand every key already stored",
};

test("a hive directory is never built from a literal path outside the seam", () => {
  const offenders = [];
  for (const file of [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "bin"))]) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel in HIVE_PATH_ALLOWED) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const call of code.match(/\b(?:path\.)?(?:join|resolve)\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
      if (/["'`]\.hive402["'`]/.test(call)) offenders.push(`${rel}: ${call}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a hive directory belongs to src/config/load.mjs alone — a command that builds its own is a " +
      "command that can silently read or write another hive's state (F-038, F-040). Allowed, with " +
      `reasons:\n${Object.entries(HIVE_PATH_ALLOWED).map(([k, v]) => `  ${k} — ${v}`).join("\n")}` +
      `\nFound outside those:\n${offenders.join("\n")}`,
  );
});

test("the allowlist names files that exist and still contain what it excuses", () => {
  // An allowlist entry that has gone stale is a hole nobody can see. If the
  // credential store ever stops building that path, the entry must go, or it
  // silently licenses a future one.
  for (const rel of Object.keys(HIVE_PATH_ALLOWED)) {
    const full = path.join(root, rel);
    assert.ok(existsSync(full), `${rel} is allowlisted but does not exist`);
    assert.match(
      stripComments(readFileSync(full, "utf8")),
      /["'`]\.hive402["'`]/,
      `${rel} is allowlisted but no longer builds a hive path — remove the entry`,
    );
  }
});

test("no command resolves a config inside a try/catch that swallows the failure", () => {
  // The literal shape of the bug: four commands each wrapped config resolution
  // in a catch whose only statement re-pointed the state directory.
  const cli = stripComments(readFileSync(path.join(root, "bin", "cli.mjs"), "utf8"));
  assert.equal(
    /catch\s*(\([^)]*\))?\s*\{[^}]*stateDir\s*=/.test(cli),
    false,
    "a catch that reassigns stateDir is the F-038 idiom returning",
  );
});


// ── setup's --config is a DESTINATION, not a file that must be there ──────

test("setup may name a config that does not exist yet, because that is where it writes it", () => {
  // Found by an existing test the moment the strict rule landed
  // (`setup reports a step list rather than a stack trace`): `hive402 setup
  // --config <new path>` is how a person chooses where their config goes, so
  // the one command that CREATES the file must not require it to exist.
  //
  // CORRECTED at F-040 (cycle 25). The contract this test exists for — setup
  // may name a file that is not there, and does not throw — was right and is
  // unchanged. Its last assertion was the second half of the same defect:
  // "no config yet means the first node's own directory" is true when nobody
  // named anywhere, and false the moment somebody did. `setup --config <a fresh
  // path>` is somebody naming somewhere, and answering it with `~/.hive402` is
  // how setup's own internal join wrote its acceptance record into the first
  // hive's directory (F-040, surface 1).
  const b = box();
  const target = path.join(b.project, "not-yet.json");
  const resolved = resolveStateDir(target, { home: b.home, mustExist: false });
  assert.equal(resolved.reason, "to-be-created", "distinct from `no-config`: a destination was named");
  assert.equal(resolved.file, null, "and there is genuinely no file yet");
  assert.equal(resolved.stateDir, b.project, "the destination's own directory");
  assert.notEqual(resolved.stateDir, b.homeDefault, "never the first node's");
});

test("nothing named and nothing found still means the home default", () => {
  // The half the corrected test above no longer covers, written down rather
  // than left implied: with no `--config` at all there is no directory to take,
  // and `~/.hive402` is where `setup` would create the config — so it is still
  // that hive's own directory (DD-72's judgement, kept by DD-73).
  const b = box();
  const resolved = resolveStateDir(null, { home: b.home, cwd: b.root, env: null, mustExist: false });
  assert.equal(resolved.reason, "no-config");
  assert.equal(resolved.stateDir, b.homeDefault);
});

test("and every other command still refuses a --config that is not there", () => {
  // The exception is one command wide. Without `mustExist: false` the strict
  // rule is the default, so a fifth command cannot inherit the exemption by
  // accident.
  const b = box();
  assert.throws(() => resolveStateDir(path.join(b.project, "nope.json"), { home: b.home }), /nope.json/);
});

// ── up and join must never disagree about where this node lives ───────────

test("a relative stateDir means the same directory to every command", () => {
  // The split this task exists to prevent: if `join` resolved a relative
  // `stateDir` against the config and `up` resolved it against the cwd, the
  // join record and the pid file would live in two different places and each
  // command would be individually correct.
  const b = box();
  const file = b.write("hive402.config.json", LAUNCHABLE(".hive402"));

  const viaJoin = resolveStateDir(file, { home: b.home, cwd: b.root }).stateDir;
  // What `up`, `down`, `status`, `audit`, `register`, `retire` and `doctor`
  // compute, through the same helper `defaultStateDir` now calls.
  const viaUp = stateDirFrom({ declared: LAUNCHABLE(".hive402").stateDir, file, home: b.home });

  assert.equal(viaJoin, viaUp);
  assert.equal(viaJoin, path.join(b.project, ".hive402"));
});

test("the whole point, stated once: one machine, two hives, two directories", () => {
  // AC-72 in one assertion. Two configs, each with its own relative stateDir,
  // resolved from a third directory entirely — nothing lands in the home
  // default and nothing lands in the other hive's.
  const b = box();
  const a = b.write("a.json", LAUNCHABLE(".hive402"));
  const second = path.join(b.root, "second");
  mkdirSync(second, { recursive: true });
  const bFile = path.join(second, "b.json");
  writeFileSync(bFile, JSON.stringify(LAUNCHABLE(".hive402")), "utf8");

  const dirA = resolveStateDir(a, { home: b.home, cwd: b.root }).stateDir;
  const dirB = resolveStateDir(bFile, { home: b.home, cwd: b.root }).stateDir;

  assert.notEqual(dirA, dirB);
  assert.equal(dirA, path.join(b.project, ".hive402"));
  assert.equal(dirB, path.join(second, ".hive402"));
  assert.deepEqual(b.homeLeak(), []);
});

// ── The seam every other command reaches it through (E5) ─────────────────
//
// `defaultStateDir` is private to bin/cli.mjs, so it is guarded the way this
// codebase already guards private call sites (respawn.test.mjs,
// detach.test.mjs): by reading the source. Without this, dropping the config
// file on the way to `stateDirFrom` reintroduces the up/join split silently —
// which is precisely what the discrimination check caught when the first
// version of this file asserted `stateDirFrom` directly and never exercised
// `defaultStateDir` at all.

test("defaultStateDir forwards the config file, so up resolves what join resolves", () => {
  const cli = readFileSync(path.join(root, "bin", "cli.mjs"), "utf8");
  const at = cli.indexOf("function defaultStateDir");
  const body = cli.slice(at, at + 300);
  assert.match(body, /stateDirFrom\(/, "it goes through the one helper");
  assert.match(body, /\bfile\b/, "and hands it the config file");
  assert.doesNotMatch(body, /file:\s*null/, "dropping the file is the up/join split returning");
});

test("every command hands defaultStateDir the config file it resolved", () => {
  // A call site that forgets is a command whose state directory disagrees with
  // every other command's, for the one config shape that declares a relative
  // path. Comments are stripped first: this file's own explanation quotes the
  // old one-argument form in order to explain it.
  const cli = stripComments(readFileSync(path.join(root, "bin", "cli.mjs"), "utf8"));
  const oneArg = [...cli.matchAll(/defaultStateDir\((?:[^()]|\([^()]*\))*\)/g)]
    .map((m) => m[0])
    .filter((call) => !call.includes(","));
  assert.deepEqual(oneArg, [], `these calls drop the config file:\n${oneArg.join("\n")}`);
});
