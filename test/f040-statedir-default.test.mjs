// F-040 (DD-73): a config's own directory is its state directory.
//
// Red Team cycle 22, found while building F-039's fresh-machine test — so it
// was reached through `hive402 setup`'s ordinary documented output, not a
// hand-built fixture. A config carrying no `stateDir` key at all routed the
// join record, the agent attestation, the instance lock and the startup log to
// the fixed default `~/.hive402`, which on the machine it was found on is the
// PRODUCTION node's directory. `up` read that node's pid file and refused to
// start: "another hive402 node is already running (pid 34900)".
//
// Four symptoms, one line — `stateDirFrom`:
//
//     if (!declared) return homeStateDir(home);   // the same path for every config
//
// reached by TWO branches, which is why the fix is two branches:
//
//   1. the config exists and parses, but declares no `stateDir`
//      (`register`, `up`'s lock, `up`'s log) — `stateDirFrom`'s null branch;
//   2. `setup --config <a path that does not exist yet>`, where `findConfigFile`
//      throws and `mustExist: false` returned the home default before
//      `stateDirFrom` was ever consulted (setup's internal join).
//
// The rule that replaces the constant: **a node's state lives in the directory
// of the config file the command resolved, or is about to create.** A file on
// disk has a directory, and that directory is a per-config answer. The home
// default survives for the one case that has no file at all — a machine with no
// config anywhere, where `~/.hive402` is where `setup` would create one, so it
// is still that hive's own directory reached by the same rule.
//
// NOT `dirname/.hive402`, which is what F-040's own recommendation suggested:
// for Barry's production config at `~/.hive402/config.json` that computes
// `~/.hive402/.hive402`, a fresh empty directory beside his real state, and his
// node would present as a first-run install and re-register. See the "Barry's
// production shape" tests below — they are what stands between that idea and
// his live node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveStateDir, stateDirFrom, homeStateDir } from "../src/config/load.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const scratch = (label) => mkdtempSync(path.join(tmpdir(), `hive402-f040-${label}-`));

// The same shape of bench the F-038 tests use: a home directory that is EMPTY
// and stays that way unless something leaks into it.
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
    homeLeak: () =>
      existsSync(path.join(home, ".hive402")) ? readdirSync(path.join(home, ".hive402")).sort() : [],
    write(name, config, dir = project) {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2), "utf8");
      return file;
    },
  };
}

// The exact shape `starterConfig` writes, minus the `stateDir` this fix adds:
// what `hive402 setup` produced on 0.3.6 and handed to `register` and `up`.
const AS_SETUP_WROTE_IT = {
  relayUrl: "ws://localhost:3000",
  node: { pubkey: "9".repeat(64) },
  tools: { buzzDir: null, adapter: null },
  rooms: [
    {
      channel: "11111111-1111-1111-1111-111111111111",
      agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }],
    },
  ],
};

// ── Branch 1: a config that exists and declares no stateDir ────────────────

test("a config that declares no stateDir keeps its state in its own directory", () => {
  // THE failing test. On 0.3.6 this answers `<home>/.hive402` — the machine's
  // first hive — for a config that lives nowhere near it.
  const b = box();
  const file = b.write("hive402.config.json", AS_SETUP_WROTE_IT);

  const resolved = resolveStateDir(file, { home: b.home });

  assert.equal(resolved.stateDir, b.project, "its own directory, the one it sits in");
  assert.notEqual(resolved.stateDir, b.homeDefault, "the home default is another hive's directory");
  assert.equal(resolved.reason, "parsed");
  assert.deepEqual(b.homeLeak(), [], "and nothing was created under the home default");
});

test("the answer is the directory EXACTLY, never a .hive402 inside it", () => {
  // F-040's own recommendation, and the one thing in it we are not taking.
  // `dirname/.hive402` is a different directory for every config EXCEPT the one
  // that matters: for a config already living in `~/.hive402`, it invents a
  // second, empty `~/.hive402/.hive402` and the node re-registers.
  const b = box();
  const file = b.write("hive402.config.json", AS_SETUP_WROTE_IT);
  const resolved = resolveStateDir(file, { home: b.home });
  assert.equal(resolved.stateDir, b.project);
  assert.notEqual(resolved.stateDir, path.join(b.project, ".hive402"));
});

test("an unparsed config gets its own directory too, which is the join-time shape", () => {
  // At join time a config has a relay and nothing else — a room needs an agent
  // and an agent needs the join to have happened (DD-72). Where this node keeps
  // its things must not depend on whether it is ready to run agents yet.
  const b = box();
  const file = b.write("hive402.config.json", { relayUrl: "ws://localhost:3000" });
  const resolved = resolveStateDir(file, { home: b.home });
  assert.equal(resolved.stateDir, b.project);
  assert.equal(resolved.reason, "unparsed");
});

test("a declared stateDir still wins, absolute or relative", () => {
  // The over-correction guard. DD-71's doctrine: the operator's answer is not
  // rewritten. Both of these resolved correctly on 0.3.6 and must be untouched.
  const b = box();
  const elsewhere = path.join(b.root, "somewhere", "else");
  assert.equal(
    resolveStateDir(b.write("abs.json", { ...AS_SETUP_WROTE_IT, stateDir: elsewhere }), { home: b.home })
      .stateDir,
    elsewhere,
  );
  assert.equal(
    resolveStateDir(b.write("rel.json", { ...AS_SETUP_WROTE_IT, stateDir: "state" }), { home: b.home })
      .stateDir,
    path.join(b.project, "state"),
  );
});

// ── Barry's production shape: the tests that protect his live node ─────────

test("a config IN the home hive directory resolves to that directory, unchanged", () => {
  // Barry's production config: `~/.hive402/config.json`, no `stateDir` key, and
  // his state — agents/, audit.jsonl, hive402.pid.json, logs/, turns/, work/ —
  // directly in `~/.hive402/`. `dirname` of that config IS that directory, so
  // this fix returns the identical string and NOTHING MOVES. There is no
  // migration because there is nothing to migrate, and this test is what makes
  // that a checked claim instead of a hope.
  const b = box();
  const file = b.write("config.json", AS_SETUP_WROTE_IT, b.homeDefault);

  const resolved = resolveStateDir(file, { home: b.home });

  assert.equal(resolved.stateDir, b.homeDefault, "exactly where his state already is");
  assert.equal(resolved.stateDir, homeStateDir(b.home), "and identical to the 0.3.6 answer");
  assert.notEqual(
    resolved.stateDir,
    path.join(b.homeDefault, ".hive402"),
    "a .hive402-inside-.hive402 is a node that looks fresh and re-registers",
  );
});

test("every state-scoped surface computes his existing path, not a new one", () => {
  // The four surfaces F-040 named, as the paths they actually are. A fix that
  // relocated any one of these would strand that part of his node.
  const b = box();
  const file = b.write("config.json", AS_SETUP_WROTE_IT, b.homeDefault);
  const dir = resolveStateDir(file, { home: b.home }).stateDir;

  assert.equal(path.join(dir, "join.json"), path.join(b.homeDefault, "join.json"));
  assert.equal(path.join(dir, "agents", "smith.json"), path.join(b.homeDefault, "agents", "smith.json"));
  assert.equal(path.join(dir, "hive402.pid.json"), path.join(b.homeDefault, "hive402.pid.json"));
  assert.equal(path.join(dir, "logs", "node.log"), path.join(b.homeDefault, "logs", "node.log"));
});

// ── Branch 2: a destination that does not exist yet (setup) ────────────────

test("setup naming a config that does not exist yet gets THAT path's directory", () => {
  // Surface 1 of F-040, and the one branch `stateDirFrom` alone cannot reach:
  // `findConfigFile` throws because the file is not there, and `mustExist:false`
  // used to answer the home default — so `setup`'s internal join wrote its
  // acceptance record into the first hive's directory before the config it was
  // creating even existed.
  const b = box();
  const target = path.join(b.root, "fresh", "hive402.config.json");
  mkdirSync(path.dirname(target), { recursive: true });

  const resolved = resolveStateDir(target, { home: b.home, mustExist: false });

  assert.equal(resolved.stateDir, path.join(b.root, "fresh"), "the destination's own directory");
  assert.equal(resolved.reason, "to-be-created", "distinct from `no-config`: you named a destination");
  assert.equal(resolved.file, null, "there is genuinely no file yet");
  assert.deepEqual(b.homeLeak(), []);
});

test("with no config anywhere and none named, the home default is still the answer", () => {
  // DD-72's judgement, kept. A machine with no config has one hive, and
  // `~/.hive402` is where `setup` would create its config — so this is that
  // hive's own directory too, reached by the same rule.
  const b = box();
  const resolved = resolveStateDir(null, { home: b.home, cwd: b.project, env: null, mustExist: false });
  assert.equal(resolved.stateDir, b.homeDefault);
  assert.equal(resolved.reason, "no-config");
});

test("an explicit --config that is not there still fails when it must exist", () => {
  // FIX-193 unchanged: only `setup` passes `mustExist: false`.
  const b = box();
  const missing = path.join(b.project, "not-here.json");
  assert.throws(() => resolveStateDir(missing, { home: b.home }), /not-here\.json/);
});

// ── Two hives, side by side ───────────────────────────────────────────────

test("two configs in two directories, neither declaring a stateDir, never share a pid lock", () => {
  // AC-72's own sentence: starting a second one never disturbs the first. On
  // 0.3.6 both of these computed the SAME `hive402.pid.json`, which is how a
  // throwaway node read Barry's pid and refused to start.
  const b = box();
  const one = path.join(b.root, "hive-a");
  const two = path.join(b.root, "hive-b");
  const fileA = b.write("hive402.config.json", AS_SETUP_WROTE_IT, one);
  const fileB = b.write("hive402.config.json", AS_SETUP_WROTE_IT, two);

  const dirA = resolveStateDir(fileA, { home: b.home }).stateDir;
  const dirB = resolveStateDir(fileB, { home: b.home }).stateDir;

  assert.notEqual(dirA, dirB);
  assert.notEqual(path.join(dirA, "hive402.pid.json"), path.join(dirB, "hive402.pid.json"));
  assert.notEqual(path.join(dirA, "logs", "node.log"), path.join(dirB, "logs", "node.log"));
  assert.notEqual(path.join(dirA, "agents", "spike.json"), path.join(dirB, "agents", "spike.json"));
  assert.deepEqual(b.homeLeak(), [], "and neither of them touched the first hive's directory");
});

test("a config beside the home hive's config is still its own hive", () => {
  // The tightest adjacency: a second config living IN `~/.hive402` under
  // another name. It is a different file, so it is a different hive, and it
  // must not be handed the first one's directory by accident of neighbourhood.
  const b = box();
  const mine = path.join(b.homeDefault, "second.config.json");
  const file = b.write("second.config.json", AS_SETUP_WROTE_IT, b.homeDefault);
  assert.equal(file, mine);
  // Same directory is the CORRECT answer here — they share a directory because
  // they share a directory, not because of a constant. Asserted so the reason
  // is on the record: co-located configs are one hive's business.
  assert.equal(resolveStateDir(file, { home: b.home }).stateDir, b.homeDefault);
});

// ── The helper, directly ──────────────────────────────────────────────────

test("stateDirFrom with no declaration and no file is the only home-default case left", () => {
  const b = box();
  assert.equal(stateDirFrom({ declared: null, file: null, home: b.home }), path.join(b.home, ".hive402"));
  assert.equal(
    stateDirFrom({ declared: null, file: path.join(b.project, "c.json"), home: b.home }),
    b.project,
  );
});

// ── FIX-199: setup resolves and records the directory of the config it creates ──

test("starterConfig writes a stateDir, so the config says where its state goes", async () => {
  // F-040's own recommendation, taken as written: the config `setup` produces
  // should be self-describing rather than silently dependent on an undocumented
  // default. Same doctrine FIX-187 applied to `tools` one cycle earlier.
  const { starterConfig } = await import("../src/setup/run.mjs");
  const config = starterConfig({
    relayUrl: "ws://localhost:3000",
    nodePubkey: "9".repeat(64),
    channel: "11111111-1111-1111-1111-111111111111",
    agent: { name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) },
  });
  assert.ok("stateDir" in config, "the config states where its state goes");
  assert.equal(config.stateDir, ".", "relative, so a copied hive folder keeps working");
});

test("what setup writes and what the resolver defaults to are the same directory", async () => {
  // The two halves of DD-73 must not drift. If `starterConfig` ever wrote an
  // absolute path, or a subdirectory, this is where it would show up: a config
  // whose declared value disagrees with the default is a config that behaves
  // differently from an identical one with the key deleted.
  const { starterConfig } = await import("../src/setup/run.mjs");
  const b = box();
  const written = starterConfig({
    relayUrl: "ws://localhost:3000",
    nodePubkey: "9".repeat(64),
    channel: "11111111-1111-1111-1111-111111111111",
    agent: { name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) },
  });
  const file = b.write("hive402.config.json", written);

  const declared = resolveStateDir(file, { home: b.home }).stateDir;
  const { stateDir: _drop, ...withoutTheKey } = written;
  const defaulted = resolveStateDir(b.write("no-key.json", withoutTheKey), { home: b.home }).stateDir;

  assert.equal(declared, defaulted, "the written value and the default are one answer");
  assert.equal(declared, b.project);
});

test("cmdSetup takes its state directory from the config file it is about to write", () => {
  // `cmdSetup` is private to bin/cli.mjs, so it is guarded the way this codebase
  // already guards private call sites (respawn.test.mjs, detach.test.mjs,
  // f038-statedir.test.mjs): by reading the source.
  //
  // It used to read `hive.stateDir` BEFORE computing `configFile` via
  // `setupConfigTarget`, so the directory it wrote state into and the directory
  // it wrote the config into could disagree by construction. They agreed only
  // when both happened to be the home default, which is the bug. Order matters
  // here, so order is what is asserted.
  const cli = readFileSync(path.join(root, "bin", "cli.mjs"), "utf8");
  const at = cli.indexOf("async function cmdSetup");
  assert.ok(at > 0, "cmdSetup is still called that");
  const body = cli.slice(at, cli.indexOf("async function cmdProfile"));

  const targetAt = body.indexOf("setupConfigTarget");
  const stateAt = body.indexOf("stateDirFrom");
  assert.ok(targetAt > 0, "it still computes its own destination");
  assert.ok(stateAt > targetAt, "and derives the state directory FROM that destination, after it");
  assert.doesNotMatch(
    body.slice(0, targetAt),
    /const\s+stateDir\s*=/,
    "a stateDir fixed before the destination is known is the disagreement returning",
  );
});

// ── FIX-200: a second hive must never adopt the first hive's identity ──────
//
// The hazard F-040 did not name, and the sharpest consequence of the fixed
// default. `runSetup` resumes a hive by reading `readJoinRecord(stateDir)` and,
// on a hit, reusing THAT record's node private key rather than minting one
// (src/setup/run.mjs, step 1). With the state directory defaulting to
// `~/.hive402` for every config, `hive402 setup --config <a throwaway path>`
// read the FIRST hive's record and would have reported
// `identity already <the first node's pubkey>` — two hives on one identity.
//
// The Red Team saw a clean mint only because Barry has no live `join.json`:
// cycle 24 renamed it to `join.json.stray-bak` after establishing it belonged
// to a foreign identity. The hazard was masked by an accident of a previous
// cycle's cleanup, and his next real join re-arms it. So it is pinned here
// through the real `runSetup` and the real `readJoinRecord`, with only the
// credential store injected — a mock of the resume mechanism would be a mock of
// exactly the thing under test.

const FIRST_HIVE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";

function keyStore(initial = null) {
  const made = [];
  let nodeKey = initial;
  return {
    made,
    async getNodePrivateKey(_pubkey) {
      return nodeKey;
    },
    async createNodePrivateKey(_pubkey, k) {
      made.push("node");
      nodeKey = k;
    },
    async getAgentPrivateKey() {
      return null;
    },
    async createAgentPrivateKey() {},
  };
}

const identityStep = (result) => result.steps.find((s) => s.name === "identity");

test("resuming the hive whose record it is, is correct and stays correct", async () => {
  // The behaviour that must NOT break: re-running setup against the SAME hive
  // resumes it. Without this half, "never adopt an identity" could be satisfied
  // by never resuming at all, which would mint a second identity every time
  // somebody re-ran setup (AC-44: setup is resumable).
  const { runSetup } = await import("../src/setup/run.mjs");
  const { writeJoinRecord } = await import("../src/registry/joinrecord.mjs");
  const { derivePubkey } = await import("../src/credentials/keys.mjs");

  const b = box();
  mkdirSync(b.homeDefault, { recursive: true });
  const first = derivePubkey(FIRST_HIVE_SK);
  writeJoinRecord({
    stateDir: b.homeDefault,
    record: { status: "joined", host: "relay.example", origin: "https://relay.example", pubkey: first },
  });

  const store = keyStore(FIRST_HIVE_SK);
  const result = await runSetup({
    store,
    stateDir: b.homeDefault,
    configFile: path.join(b.homeDefault, "config.json"),
    writeConfig: ({ file }) => file,
    log: () => {},
  });

  assert.equal(identityStep(result).state, "already", "same hive, same identity");
  assert.equal(identityStep(result).detail, first);
  assert.deepEqual(store.made, [], "nothing minted");
});

test("a second hive with its own config mints its own identity, never the first hive's", async () => {
  // The same store, the same machine, the same first-hive record on disk — and
  // one variable changed: the state directory this setup resolved. On 0.3.6
  // that variable did not exist, because both configs resolved to `~/.hive402`.
  const { runSetup } = await import("../src/setup/run.mjs");
  const { writeJoinRecord } = await import("../src/registry/joinrecord.mjs");
  const { derivePubkey } = await import("../src/credentials/keys.mjs");

  const b = box();
  mkdirSync(b.homeDefault, { recursive: true });
  const first = derivePubkey(FIRST_HIVE_SK);
  writeJoinRecord({
    stateDir: b.homeDefault,
    record: { status: "joined", host: "relay.example", origin: "https://relay.example", pubkey: first },
  });

  // Where a throwaway `setup --config <b.project>/hive402.config.json` now
  // resolves its state: its own directory, computed by the seam under test.
  const target = path.join(b.project, "hive402.config.json");
  const stateDir = resolveStateDir(target, { home: b.home, mustExist: false }).stateDir;
  assert.equal(stateDir, b.project, "the destination's own directory, not the first hive's");

  const store = keyStore(FIRST_HIVE_SK);
  const result = await runSetup({
    store,
    stateDir,
    configFile: target,
    writeConfig: ({ file }) => file,
    log: () => {},
  });

  assert.notEqual(identityStep(result).state, "already", "there is no hive here yet to resume");
  assert.equal(identityStep(result).state, "done");
  assert.notEqual(identityStep(result).detail, first, "and it is emphatically not the first hive's key");
  assert.deepEqual(store.made, ["node"], "it minted its own");
});

test("the first hive's record is not even readable from the second hive's directory", () => {
  // The mechanism under the two tests above, asserted directly: what makes the
  // adoption impossible is that `readJoinRecord` is pointed somewhere else, not
  // a check bolted on afterwards.
  const b = box();
  mkdirSync(b.homeDefault, { recursive: true });
  writeFileSync(path.join(b.homeDefault, "join.json"), JSON.stringify({ pubkey: "a".repeat(64) }), "utf8");

  const file = b.write("hive402.config.json", AS_SETUP_WROTE_IT);
  const stateDir = resolveStateDir(file, { home: b.home }).stateDir;

  assert.equal(existsSync(path.join(stateDir, "join.json")), false, "no record here, so nothing to resume");
  assert.equal(existsSync(path.join(b.homeDefault, "join.json")), true, "the first hive's is untouched");
});

// ── The four surfaces, written for real, from setup's own output ───────────

test("all four state-scoped surfaces land under the config's own directory", async () => {
  // F-040 named four leaking surfaces: the join record, the agent attestation,
  // the instance lock and the startup log. This writes all four for real —
  // through `writeJoinRecord`, the same `agents/<name>.json` path `register`
  // uses, and the same `hive402.pid.json` / `logs/node.log` paths `up` uses —
  // against a config built by `starterConfig` itself rather than a fixture,
  // which is the shape the Red Team was handed by `hive402 setup`.
  const { starterConfig } = await import("../src/setup/run.mjs");
  const { writeJoinRecord, readJoinRecord } = await import("../src/registry/joinrecord.mjs");

  const b = box();
  const file = b.write(
    "hive402.config.json",
    starterConfig({
      relayUrl: "ws://localhost:3000",
      nodePubkey: "9".repeat(64),
      channel: "11111111-1111-1111-1111-111111111111",
      agent: { name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) },
    }),
  );

  const stateDir = resolveStateDir(file, { home: b.home }).stateDir;
  assert.equal(stateDir, b.project);

  writeJoinRecord({
    stateDir,
    record: { status: "joined", host: "relay.example", origin: "https://relay.example", pubkey: "4".repeat(64) },
  });
  mkdirSync(path.join(stateDir, "agents"), { recursive: true });
  writeFileSync(path.join(stateDir, "agents", "spike.json"), JSON.stringify({ name: "spike" }), "utf8");
  writeFileSync(path.join(stateDir, "hive402.pid.json"), JSON.stringify({ node: 4242 }), "utf8");
  mkdirSync(path.join(stateDir, "logs"), { recursive: true });
  writeFileSync(path.join(stateDir, "logs", "node.log"), "started\n", "utf8");

  assert.ok(readJoinRecord(stateDir), "join record readable from its own hive");
  assert.ok(existsSync(path.join(stateDir, "agents", "spike.json")), "attestation");
  assert.ok(existsSync(path.join(stateDir, "hive402.pid.json")), "instance lock");
  assert.ok(existsSync(path.join(stateDir, "logs", "node.log")), "startup log");

  // The assertion that would have failed on 0.3.6, on all four counts at once.
  assert.deepEqual(b.homeLeak(), [], "and not one of them touched the first hive's directory");
});
