import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir as realHomedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin", "cli.mjs");

// A throwaway home for every spawn in this file.
//
// `run()` used to pass the inherited environment, and the `setup` test below
// spawns a command whose FIRST STEP is minting this node's identity — so every
// `npm test` wrote a live secret into the operator's real credential store and
// left it there. The store lives under `%USERPROFILE%` (FIX-127), so pointing
// that at a temp directory is what makes these tests unable to reach it. The
// legacy `%LOCALAPPDATA%` location is redirected too, or it would answer for
// the primary one.
//
// Done at the SEAM, not at the one offending call: the next mutating command
// added to this file inherits the isolation rather than having to remember it.
const SANDBOX_HOME = mkdtempSync(path.join(tmpdir(), "hive402-clitests-"));
const SANDBOX_ENV = {
  ...process.env,
  USERPROFILE: SANDBOX_HOME,
  LOCALAPPDATA: path.join(SANDBOX_HOME, "nolocal"),
  HOME: SANDBOX_HOME,
};

// What the operator's REAL store holds, so a test can assert it was not touched.
const realStoreEntries = () => {
  const dir = path.join(realHomedir(), ".hive402", "credentials");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: SANDBOX_ENV });

// Same, but with a chosen working directory and env — which is what it takes to
// exercise config DISCOVERY rather than an echo of `--config`.
const runFrom = ({ cwd, env = {} }, ...args) =>
  spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });

function configFile(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-cfg-"));
  const file = path.join(dir, "hive402.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      relayUrl: "ws://localhost:3000",
      stateDir: dir,
      node: { pubkey: "9".repeat(64) },
      rooms: [
        {
          channel: "11111111-1111-1111-1111-111111111111",
          agents: [{ name: "spike", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) }],
        },
      ],
      ...over,
    }),
  );
  return { dir, file };
}

// F-002: `--help` was not distinctly implemented — every invocation, including
// --help and eight guessed subcommands, printed the same byte-identical
// "no command given" line and exited 1.
test("--help exits 0 and lists the commands", () => {
  const r = run("--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  for (const cmd of ["up", "down", "status", "config", "register", "audit", "doctor"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `--help should mention "${cmd}"`);
  }
});

test("a bare invocation explains itself rather than repeating the version", () => {
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /usage|--help/i);
});

test("an unknown command names the offender and points at --help", () => {
  const r = run("frobnicate");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /frobnicate/);
  assert.match(r.stderr + r.stdout, /--help/);
});

test("--help and a bare call are not the same output", () => {
  assert.notEqual(run("--help").stdout.trim(), run().stdout.trim());
});

// AC-20: an owner can view and change an agent's settings via the config file.
test("config show prints the six owner-facing settings for each agent", () => {
  const { file } = configFile();
  const r = run("config", "show", "--config", file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  for (const key of ["replyMode", "crossOwnerAsks", "selfInitiated", "research", "build"]) {
    assert.match(r.stdout, new RegExp(key));
  }
});

test("config show reports a newly registered agent as research=off build=off", () => {
  // AC-22
  const { file } = configFile();
  const r = run("config", "show", "--config", file);
  assert.match(r.stdout, /research\s*[:=]\s*false/i);
  assert.match(r.stdout, /build\s*[:=]\s*false/i);
});

test("config set changes a setting in the file on disk", () => {
  const { file } = configFile();
  const r = run("config", "set", "spike.research", "true", "--config", file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.rooms[0].agents[0].research, true);
});

test("config set refuses a setting outside the six", () => {
  const { file } = configFile();
  const r = run("config", "set", "spike.mood", "cheerful", "--config", file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /mood|unknown/i);
});

test("config set refuses an out-of-enum value", () => {
  const { file } = configFile();
  const r = run("config", "set", "spike.replyMode", "chatty", "--config", file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /replyMode|chatty/i);
});

test("config set on an unknown agent fails instead of silently doing nothing", () => {
  const { file } = configFile();
  const r = run("config", "set", "ghost.research", "true", "--config", file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /ghost/);
});

test("a broken config is reported with the reason, not a stack trace", () => {
  const { dir } = configFile();
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ relayUrl: "ws://localhost:3000", rooms: [] }));
  const r = run("config", "show", "--config", bad);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /room/i);
  assert.doesNotMatch(r.stderr, /at Object\.|at Module\./, "should not print a raw stack");
});

test("a missing config file is reported with the paths that were searched", () => {
  const r = run("config", "show", "--config", path.join(tmpdir(), "nope-does-not-exist.json"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /nope-does-not-exist/);
});

// TR-002: the cap must be drivable in a test window.
test("the turn cap is visible in config show", () => {
  const { file } = configFile({ turnCap: { limit: 3, windowMs: 60000 } });
  const r = run("config", "show", "--config", file);
  assert.match(r.stdout, /3/);
});

// TR-001: registration had no scriptable path at all — Buzz's own route only
// opens a GUI form in Desktop, which cannot be driven headlessly.
test("register --help documents a headless registration path", () => {
  const r = run("register", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /--agent/);
  assert.match(r.stdout, /--sponsor|--owner-key/);
});

test("register no longer demands a sponsor flag — the node is the sponsor", () => {
  // Until FIX-117 this command refused unless you passed `--sponsor keychain
  // --owner-key keychain`, and both read ONE credential slot documented as the
  // owner's own key. AC-47 removes that: the node is a community member in its
  // own right and vouches for the agents it hosts.
  //
  // AC-36's refusal has not gone anywhere — it moved to where it can actually
  // be decided, against the relay's real roster (see node-sponsors.test.mjs,
  // "a node that is not a community member cannot sponsor"). What this asserts
  // is that the FLAG is no longer the gate.
  //
  // Asserted as an absence, deliberately: what happens NEXT depends on the box
  // this runs on (a developer's machine has a node key in its real credential
  // store and gets as far as reaching for `buzz`; CI has neither). The property
  // under test is machine-independent — the command no longer stops at the
  // front door for want of a flag.
  const { file } = configFile();
  const r = run("register", "--agent", "spike", "--config", file);
  assert.notEqual(r.status, 0, "it still fails — this box has no relay to register against");
  const said = r.stderr + r.stdout;
  assert.doesNotMatch(said, /needs a sponsor/i, "and not for want of a flag");
  assert.doesNotMatch(said, /--owner-key/, "nor for want of an owner key");
});

test("register --help does not ask anyone for their key", () => {
  const r = run("register", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Nothing here asks for your key/i);
  assert.match(r.stdout, /HUMAN whose approval/i, "and it says who still approves");
});

test("doctor reports on the environment without needing a live relay", () => {
  const { file } = configFile();
  const r = run("doctor", "--config", file);
  assert.match(r.stdout + r.stderr, /config|relay|buzz/i);
});

// --- fix cycle 7: keygen / keys / doctor key reporting ----------------------

test("--help lists the key commands, because they are step one of onboarding", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bkeygen\b/);
  assert.match(r.stdout, /\bkeys\b/);
});

test("keygen --help promises not to print the secret", () => {
  const r = run("keygen", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /--agent/);
  assert.match(r.stdout, /--node/);
  assert.match(r.stdout, /never printed|never shown|only the public key/i);
});

test("keygen without a target refuses rather than guessing an identity", () => {
  const r = run("keygen");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--agent|--node/);
});

test("keygen refuses --agent and --node together", () => {
  const r = run("keygen", "--agent", "blitz", "--node");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /not both|either/i);
});

// There is deliberately no flag that accepts a key value: an argument lands in
// shell history and the process table. If one is ever added, this fails.
test("no key-taking flag exists on the key commands", () => {
  for (const args of [["keygen", "--help"], ["keys", "--help"]]) {
    const r = run(...args);
    assert.doesNotMatch(
      r.stdout,
      /--(secret|key|private-key|sk)\s+</,
      `${args[0]} must not offer a flag that takes a key value`,
    );
  }
  assert.match(run("keys", "--help").stdout, /prompt|echo off/i);
});

test("keys with no action prints usage and fails", () => {
  const r = run("keys");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /import|list|remove/);
});

test("keys remove reports honestly when there was nothing to remove", () => {
  const r = run("keys", "remove", "--agent", `nobody-${Date.now()}`);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /nothing to remove|no key was stored/i);
});

// The point of FIX-52: a missing keychain key used to surface only as a
// confusing failure at `up`. doctor is where a setup problem belongs.
test("doctor reports whether each identity has a key in the store", () => {
  const agent = `ghost${Date.now()}`;
  const { file } = configFile({
    rooms: [
      {
        channel: "11111111-1111-1111-1111-111111111111",
        agents: [
          { name: agent, pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) },
          {
            name: "envagent",
            pubkey: "5".repeat(64),
            ownerPubkey: "7".repeat(64),
            privateKeyRef: "env:HIVE402_DOCTOR_TEST_KEY",
          },
        ],
      },
    ],
  });
  const out = run("doctor", "--config", file).stdout;

  // An agent with no stored key: named, flagged, and told how to fix it.
  assert.match(out, new RegExp(`${agent}[^\n]*`), "the agent must appear in the key report");
  const agentLine = out.split("\n").find((l) => l.includes(agent) && /key/i.test(l));
  assert.ok(agentLine, `no key line for ${agent} in:\n${out}`);
  assert.match(agentLine, /no key|missing/i);
  assert.match(out, new RegExp(`hive402 keygen --agent ${agent}`), "must name the exact fix");

  // An env: ref is a different question and must not be reported as a missing
  // keychain entry — that would call a working dev setup broken.
  const envLine = out.split("\n").find((l) => l.includes("envagent") && /key/i.test(l));
  assert.ok(envLine, `no key line for envagent in:\n${out}`);
  assert.match(envLine, /env:HIVE402_DOCTOR_TEST_KEY/);
  assert.match(envLine, /not set/i, "an unset env var is the actual problem there");
});

// --- join (FIX-115, AC-44/AC-45/AC-43) --------------------------------------

test("join is offered as a command, not buried in a doc", () => {
  // AC-44 says setup is one guided step in two shapes. The terminal shape is
  // this command, so it has to be visible where a person looks first.
  assert.match(run("--help").stdout, /\bjoin\b/);
  assert.match(run().stderr, /\bjoin\b/, "and named in the bare-invocation line too");
});

test("join --help promises never to ask for the human's key", () => {
  const r = run("join", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /never asked for your Nostr secret key|never asked/i);
  assert.match(r.stdout, /invite-link/);
});

test("join without a link refuses instead of guessing one", () => {
  const r = run("join");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invite link/i);
});

test("join names the shape a link should have when given something else", () => {
  // The first thing anyone runs. "invalid argument" here costs a support round
  // trip; the shape costs nothing.
  const r = run("join", "https://relay.example/channels/abc");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /https:\/\/<relay-host>\/invite\/<code>/);
});

// --- status (FIX-141) -------------------------------------------------------
//
// `status` printed a confident report about a node — pid, agents, channel — with
// nothing in it naming WHICH config produced it. On a box that runs more than one
// node (this one runs a production node and a dev rig) that turns every reading
// into an inference from `nodePid` and the agent names. `doctor` has printed
// `config: <path>` all along; `cmdStatus` called the same loader and threw the
// resolved `file` away.

test("status names the config file it read", () => {
  const { file } = configFile();
  const r = run("status", "--config", file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const status = JSON.parse(r.stdout);
  assert.equal(status.configFile, file, "the report says which config it came from");
});

test("status names the state directory the report is about", () => {
  // The second half of the same fact: two configs can name one state dir, and a
  // reading of `running` means nothing without knowing which directory's pid
  // file was consulted.
  const { dir, file } = configFile();
  const status = JSON.parse(run("status", "--config", file).stdout);
  assert.equal(status.stateDir, dir);
});

test("status names a config it DISCOVERED, not the flag it was handed", () => {
  // The discriminating case. A `status` that simply echoed `flags.config` back
  // would pass the two tests above and still be useless in the situation that
  // motivated this: somebody runs a bare `hive402 status`, gets a report, and
  // has no way to tell which of the machine's configs answered. So: no
  // `--config` at all, the config reachable only through HIVE402_CONFIG, and a
  // working directory with no config of its own for it to find first.
  const { file } = configFile();
  const emptyCwd = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  const r = runFrom({ cwd: emptyCwd, env: { HIVE402_CONFIG: file } }, "status");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const status = JSON.parse(r.stdout);
  assert.equal(status.configFile, file, "it reports what the LOADER resolved");
});

// --- status: which BUILD produced this report (FIX-145, F-025) --------------
//
// The Red Team ran `hive402 status` and got a report with no `configFile` and
// no `stateDir` in it, from a machine whose repo had shipped both an hour
// earlier. The cause was a stale global install, and the only way to see it
// from outside was to compare file timestamps across two installs.
//
// The version field alone would NOT have caught it. Both package manifests read
// 0.2.0 at the time — the stale artifact and the fixed source carried the same
// number — so the stamp is only a guard once shipping bumps it, which is why
// the bump and the field land together and why the field is read from the
// manifest rather than written as a literal.

test("status names the version that produced the report", () => {
  const { file } = configFile();
  const r = run("status", "--config", file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const status = JSON.parse(r.stdout);
  assert.equal(typeof status.version, "string");
  assert.match(status.version, /^\d+\.\d+\.\d+$/, "a real version, not a placeholder");
});

test("the version status reports is the one in the package manifest", () => {
  // Read from the manifest, never a literal: a hand-written second copy is a
  // number that can disagree with the build it claims to describe, which is the
  // failure this field exists to end.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  const { file } = configFile();
  const status = JSON.parse(run("status", "--config", file).stdout);
  assert.equal(status.version, pkg.version);
  assert.equal(run("--version").stdout.trim(), pkg.version, "and so is `--version`'s");
});

test("the version survives a bare invocation with no --config", () => {
  // The case that mattered for FIX-141 and matters here for the same reason:
  // the reading somebody actually takes is a bare `hive402 status`, and a field
  // that only appears when a flag is passed is a field that is missing exactly
  // when it is needed.
  const { file } = configFile();
  const emptyCwd = mkdtempSync(path.join(tmpdir(), "hive402-nocfg-"));
  const r = runFrom({ cwd: emptyCwd, env: { HIVE402_CONFIG: file } }, "status");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(JSON.parse(r.stdout).version, /^\d+\.\d+\.\d+$/);
});

// --- profile (FIX-116, AC-46) -----------------------------------------------

test("profile is offered as a command", () => {
  assert.match(run("--help").stdout, /\bprofile\b/);
});

test("profile --help is honest that the avatar is exploratory", () => {
  // AC-46 says the avatar is unverified and the spec lists it in Open
  // Questions. Help text that promised a picture would be the place that
  // quietly turns an open question into a claim.
  const r = run("profile", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /EXPLORATORY/);
  assert.match(r.stdout, /--name/);
});

test("profile with no arguments reports and changes nothing", () => {
  // This used to point `--config` at a missing file and assert the "run
  // hive402 join" refusal. That made it depend on the DEVELOPER'S HOME
  // DIRECTORY: with no config, `profile` falls back to `~/.hive402`, so the
  // moment this machine's own node had a join record the test failed — not
  // because anything broke, but because the box had been used.
  //
  // The refusal it was reaching for is asserted in isolation in
  // profilecommand.test.mjs ("with neither, it says to join"), where the state
  // directory is a temp dir and the answer cannot depend on who is running it.
  // What belongs HERE is the machine-independent half: the command reads.
  const { file } = configFile();
  const r = run("profile", "--config", file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /hive402 profile --name/, "it says how to set a name");
  // The show output legitimately contains the word "published" (the name line
  // reads "(none published by hive402)"), so match the publish CONFIRMATION.
  assert.doesNotMatch(
    r.stdout,
    /published this node's profile/,
    "and publishes nothing when asked nothing",
  );
});

// --- setup (FIX-119, AC-44) -------------------------------------------------

test("setup is the first command --help offers", () => {
  // AC-44: "a person may complete setup knowing only which of the two shapes
  // they prefer". The terminal shape is this command, so it has to be the thing
  // someone sees first, not the fourth item in a list of key management.
  const out = run("--help").stdout;
  assert.match(out, /\bsetup\b/);
  assert.match(out, /Getting started is one command/);
  assert.match(out, /hive402 setup/);
});

test("setup --help says there is no flag that accepts the terms for you", () => {
  // The coding-agent shape's sequencing answer (AC-45). If this promise is not
  // in the help, the first thing anyone does is look for the flag.
  const r = run("setup", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /no flag that accepts for you/i);
  assert.match(r.stdout, /hive402 join <invite-link>" yourself first/i);
});

test("setup --help asks for the PUBLIC key and says so twice over", () => {
  const out = run("setup", "--help").stdout;
  assert.match(out, /PUBLIC key/);
  assert.match(out, /never wants your secret key/i);
});

test("setup reports a step list rather than a stack trace", () => {
  // Same machine-dependence as the profile test above: with no config, setup
  // falls back to ~/.hive402, so what it stops AT depends on whether this box
  // has ever joined anything. The step list and the closing "Next"/"Stopped"
  // line are the part that is true everywhere; which step it reaches is
  // asserted in isolation in setup.test.mjs.
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-setup-"));
  const r = run("setup", "--config", path.join(dir, "hive402.config.json"));
  const said = r.stdout + r.stderr;
  assert.match(said, /hive402 setup/, "it printed the report");
  assert.match(said, /Stopped:|Next:/, "and named one thing to do next");
  assert.doesNotMatch(r.stderr, /at Object.|at Module./, "never a raw stack");
});

// --- TR-014: the keys help documents the whole keys family -----------------
//
// The top-level `hive402 --help` lists `keys migrate-node`, but `KEYS_USAGE`
// showed only `<import|list|remove>` and `hive402 keys migrate-node --help`
// fell through to that same generic text and exited 0 — a dead end for exactly
// the person who found the command in the top-level help and went looking for
// what it does.
//
// Bundled with F-028's fix because it edits the same string for the same
// reason: once `keys remove` honors `--config`, its usage line has to document
// it the way `keys list` already does, or the flag works and nobody is told.

test("TR-014: keys --help names migrate-node, so the two help surfaces agree", () => {
  const r = run("keys", "--help");
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /migrate-node/, "the top-level help lists it; this one must too");
});

test("TR-014: keys --help documents --config on remove, now that it honors it", () => {
  const r = run("keys", "--help");
  const removeSection = r.stdout.slice(r.stdout.indexOf("keys remove"));
  assert.ok(removeSection, "there is a remove section");
  assert.match(
    removeSection,
    /--config/,
    "a working flag nobody is told about is the same as no flag (F-028)",
  );
});

test("TR-014: keys migrate-node --help explains migrate-node, not the generic keys help", () => {
  const generic = run("keys", "--help").stdout;
  const specific = run("keys", "migrate-node", "--help");

  assert.equal(specific.status, 0, `stderr: ${specific.stderr}`);
  assert.notEqual(
    specific.stdout.trim(),
    generic.trim(),
    "falling through to the generic text is the dead end TR-014 filed",
  );
  assert.match(specific.stdout, /migrate-node/, "it names the subcommand it is about");
});

test("TR-014: the unknown-action refusal names all four actions", () => {
  // Or the help and the error disagree about what the command can do, which
  // sends the reader back to the surface that was already wrong.
  const r = run("keys", "frobnicate");
  assert.notEqual(r.status, 0);
  const said = r.stdout + r.stderr;
  for (const action of ["import", "list", "remove", "migrate-node"]) {
    assert.match(said, new RegExp(action.replace("-", "\-")), `the refusal should name "${action}"`);
  }
});

// --- Test hygiene: this file must not write to the operator's real store ----
//
// Found while counting credential-store entries for F-028's cleanup proof: a
// full `npm test` added exactly ONE node key to the real store on every run,
// and never removed it. Bisected to the `setup` test above, which spawns the
// CLI with the inherited environment and a fresh `--config` path. `setup`'s
// first step is to mint this node's identity, so every suite run since has
// left a live secret behind under a fresh pubkey. That is where the orphaned
// node keys on this machine came from.
//
// Two reasons this is a defect and not untidiness. It writes SECRET MATERIAL
// into the operator's real credential store as a side effect of running tests,
// which is the one thing `src/credentials` exists to be careful about. And it
// silently corrupts the only evidence F-028's fix has: FIX-154 proves the fix
// by counting store entries before and after, and a suite that adds one per
// run makes that count unreadable.
//
// Fixed at the SEAM rather than at the one call site: `run()` now spawns with a
// throwaway home, so no test in this file can reach the real store whatever
// command it runs. Fixing only the `setup` line would leave the next mutating
// command someone adds free to do it again.

test("no spawn in this file can reach the operator's real credential store", () => {
  // The property, checked at the seam every test here goes through. `homedir()`
  // on Windows is `%USERPROFILE%`, and the credential store lives under it
  // (FIX-127), so a spawn that inherits the real one can write to the real
  // store.
  const r = run("--version");
  assert.equal(r.status, 0);

  const home = spawnSync(process.execPath, ["-p", "require('node:os').homedir()"], {
    encoding: "utf8",
    env: SANDBOX_ENV,
  }).stdout.trim();

  assert.notEqual(home, realHomedir(), "a spawn from this file must not inherit the real home");
  assert.ok(home.startsWith(SANDBOX_HOME), `and must land in the sandbox, got ${home}`);
});

test("a MUTATING command spawned here writes into the sandbox, not the real store", () => {
  // `setup` mints this node's identity as its first step, which is the exact
  // call that was leaking. Driven for real rather than asserted structurally:
  // the store is a directory on disk, so "did anything land in the real one" is
  // a question with a literal answer.
  const before = realStoreEntries();
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-hygiene-"));

  run("setup", "--config", path.join(dir, "hive402.config.json"));

  assert.deepEqual(
    realStoreEntries(),
    before,
    "running the suite must not add, change or remove anything in the real credential store",
  );
});


// --- F-039: doctor, on the config shape `setup` actually writes -------------
//
// `configFile()` above has no `tools` key, which is exactly what
// `starterConfig` produced: the one config shape that had never been launched.
// doctor read `config.tools.*` raw, joined the Windows binary names on inline,
// and reported "tools.buzzDir not set" / "tools.adapter not set" — accurate,
// useless, and naming no remedy. `up` then failed separately with a spawn
// ENOENT and a raw ERR_INVALID_ARG_TYPE.
//
// The environment is blanked rather than inherited so this is the same test on
// every machine: with nowhere to look, all three tools are genuinely missing
// whether or not the person running the suite has Buzz installed. That is this
// finding's own lesson — a fixture built from the local machine is how twenty
// cycles missed it.
const NOWHERE = () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "hive402-nowhere-")), "gone");
  return { LOCALAPPDATA: dir, PROGRAMFILES: dir, APPDATA: dir, HOME: dir, USERPROFILE: dir, PATH: dir };
};

test("doctor names the remedy for a tool it cannot find, rather than 'not set'", () => {
  const { file } = configFile();
  const r = runFrom({ cwd: tmpdir(), env: NOWHERE() }, "doctor", "--config", file);
  const out = r.stdout + r.stderr;

  assert.equal(out.includes("tools.buzzDir not set"), false, out);
  assert.equal(out.includes("tools.adapter not set"), false, out);

  assert.match(out, /ACP adapter not found/, out);
  assert.ok(out.includes("npm install -g @agentclientprotocol/claude-agent-acp"), out);
  assert.match(out, /buzz-acp/, out);
  assert.match(out, /Looked in/, out);
  // Never the failure mode the launcher used to produce.
  assert.equal(out.includes("ERR_INVALID_ARG_TYPE"), false, out);
});

test("doctor asks about the platform's own binary name, not a hardcoded .exe", () => {
  // The half that made Tal's host unlaunchable under ANY configuration.
  const { file } = configFile();
  const r = runFrom({ cwd: tmpdir(), env: NOWHERE() }, "doctor", "--config", file);
  const out = r.stdout + r.stderr;
  const harness = process.platform === "win32" ? "buzz-acp.exe" : "buzz-acp";
  const wrong = process.platform === "win32" ? null : "buzz-acp.exe";
  assert.ok(out.includes(harness), out);
  if (wrong) assert.equal(out.includes(wrong), false, "a Windows name must not appear off Windows");
});

test("doctor reports a configured path against ITSELF, never against a discovered one", () => {
  // Doctrine 1, end to end through the command: an explicit directory is the
  // operator's answer, so a miss is reported at THEIR path. Silently reporting
  // a different Buzz found somewhere else is how "it works and I cannot tell
  // you which binary ran" starts.
  const { file } = configFile({ tools: { buzzDir: path.join(tmpdir(), "hive402-operator-said-here") } });
  const r = runFrom({ cwd: tmpdir(), env: NOWHERE() }, "doctor", "--config", file);
  const out = r.stdout + r.stderr;
  const named = path.join(tmpdir(), "hive402-operator-said-here", process.platform === "win32" ? "buzz-acp.exe" : "buzz-acp");
  assert.ok(out.includes(named), out);
  // Nothing else was searched, so it must not claim otherwise.
  assert.equal(out.includes("Looked in"), false, out);
});
