// Every identity command honours the config's own `privateKeyRef`
// (AC-46, AC-56, AC-72, F-033, FIX-170).
//
// ── The third and fourth instance of one defect ────────────────────────────
//
// `up` has always honoured `node.privateKeyRef`. `join` did not, and FIX-136
// fixed it after a throwaway rig joined a throwaway community AS THE PRODUCTION
// NODE, spent a single-use invite and left a registration behind. That comment
// is still in `joincommand.mjs`, and it is the scar this file is about.
//
// `profile` is the third. `profilecommand.mjs` read the credential store
// directly, so an env-configured node — the shape this project's own dev rig
// has used since cycle 1 — was told:
//
//     no key for this hive (…) in the OS credential store
//
// …while `doctor`, run in the same shell moments before and after, resolved the
// same variable correctly. The message named the wrong problem, which is worse
// than failing: it sends the reader to look in a place that was never going to
// have the key.
//
// `namecheckcommand.mjs` is the FOURTH, and the Red Team could not have seen
// it: on an env-configured node the AC-56 check at `keygen --agent` degraded to
// "this node has no identity yet, so it cannot ask the relay anything" — the
// precise arm T-211's caveat says was never tested.
//
// ── The semantics are join's, deliberately ────────────────────────────────
//
// A declared non-keychain reference is an INSTRUCTION, and the store is not
// consulted at all. Not "preferred": consulting it is exactly what picked the
// production identity in FIX-136, and a fallback would put that mistake one
// failure away. `"keychain"` is the schema's own default and means the store,
// so it takes the ordinary path unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProfile } from "../src/registry/profilecommand.mjs";
import { makeNameCheck } from "../src/registry/namecheckcommand.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

const NODE_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const NODE = derivePubkey(NODE_SK);
const ENV_VAR = "HIVE402_TEST_NODE_KEY";
const REF = `env:${ENV_VAR}`;

// A store that holds NOTHING and remembers every question it was asked.
//
// Both halves matter. Empty is F-033's exact shape — the rig's node key lives
// in an environment variable and was never imported into the OS keychain. The
// ledger is what proves the stronger half of join's semantics: a declared
// reference means the store is not consulted AT ALL, and "it happened to
// return null" is not evidence of that.
const emptyStore = () => {
  const asked = [];
  return {
    asked,
    async getNodePrivateKey(pubkey) {
      asked.push(["node", pubkey]);
      return null;
    },
    async getAgentPrivateKey(name) {
      asked.push(["agent", name]);
      return null;
    },
  };
};

const withEnv = async (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_VAR);
  const before = process.env[ENV_VAR];
  if (value === null) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[ENV_VAR] = before;
    else delete process.env[ENV_VAR];
  }
};

const envConfig = (over = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: REF },
  ...over,
});

const stateDir = () => mkdtempSync(path.join(tmpdir(), "hive402-f033-"));

// A CLI that records what it was handed instead of talking to a relay.
const recordingCli = () => {
  const calls = [];
  return {
    calls,
    make(opts) {
      calls.push(opts);
      return {
        async setProfile(fields) {
          calls.push({ setProfile: fields });
          return { ok: true };
        },
        async getUser() {
          return null; // nothing holds this name
        },
        async channelMembers() {
          return [];
        },
      };
    },
  };
};

// ── `hive402 profile` (AC-46) ──────────────────────────────────────────────

test("F-033: profile --name resolves an env-declared node key, with nothing in the store", async () => {
  // The RED, and F-033's exact reproduction: the variable is set, the store is
  // empty, and the command must publish rather than reporting an empty keychain.
  const store = emptyStore();
  const cli = recordingCli();
  const result = await withEnv(NODE_SK, () =>
    runProfile({
      name: "Barry's hive",
      config: envConfig(),
      stateDir: stateDir(),
      store,
      makeCli: cli.make,
      log: () => {},
    }),
  );
  assert.equal(result.published, true, "the profile is published");
  assert.equal(result.name, "Barry's hive");
  assert.equal(result.pubkey, NODE, "…signed as the hive the config names");
});

test("F-033: a declared reference means the store is NOT CONSULTED AT ALL", async () => {
  // The stronger half of join's semantics (FIX-136). Consulting the store is
  // what picked the production identity there; a fallback would put the same
  // mistake one failure away, so the store must not be asked even once.
  const store = emptyStore();
  const cli = recordingCli();
  await withEnv(NODE_SK, () =>
    runProfile({
      name: "Barry's hive",
      config: envConfig(),
      stateDir: stateDir(),
      store,
      makeCli: cli.make,
      log: () => {},
    }),
  );
  assert.deepEqual(store.asked, [], `the store was asked: ${JSON.stringify(store.asked)}`);
});

test("F-033: an unset variable names the REFERENCE, never an empty credential store", async () => {
  // The message has to send the reader to the right place. "no key in the OS
  // credential store" names a place the key was never going to be, which is how
  // F-033 cost a cycle. And it names the variable, never its value (DD-31).
  const store = emptyStore();
  await withEnv(null, async () => {
    await assert.rejects(
      () =>
        runProfile({
          name: "Barry's hive",
          config: envConfig(),
          stateDir: stateDir(),
          store,
          makeCli: recordingCli().make,
          log: () => {},
        }),
      (err) => {
        assert.match(err.message, new RegExp(ENV_VAR), "the variable is named");
        assert.doesNotMatch(err.message, /credential store/i, "and the wrong place is not");
        return true;
      },
    );
  });
});

test("F-033: a keychain-declared node still reads the store, with today's wording", async () => {
  // The negative control for the whole change. `"keychain"` is the schema's own
  // default, it means the store, and this path must be byte-for-byte what it
  // was — including the message, which names the hive and is better here than
  // the resolver's generic one.
  const store = {
    asked: [],
    async getNodePrivateKey(pubkey) {
      this.asked.push(pubkey);
      return NODE_SK;
    },
  };
  const cli = recordingCli();
  const result = await runProfile({
    name: "Barry's hive",
    config: { relayUrl: "ws://localhost:3000", node: { pubkey: NODE, privateKeyRef: "keychain" } },
    stateDir: stateDir(),
    store,
    makeCli: cli.make,
    log: () => {},
  });
  assert.equal(result.published, true);
  assert.deepEqual(store.asked, [NODE], "the store IS the declared source here");
});

test("F-033: the pre-config path is unchanged — profile runs before there is a config", async () => {
  // AC-46's own reason for existing: a profile can be published the moment the
  // node has joined, which is BEFORE `hive402.config.json` is written. There is
  // no `privateKeyRef` to honour there, so that path keeps today's store read.
  const dir = stateDir();
  writeFileSync(
    path.join(dir, "join.json"),
    JSON.stringify({ origin: "http://localhost:3000", host: "localhost:3000", pubkey: NODE }),
    "utf8",
  );
  const store = {
    asked: [],
    async getNodePrivateKey(pubkey) {
      this.asked.push(pubkey);
      return NODE_SK;
    },
  };
  const result = await runProfile({
    name: "Barry's hive",
    config: null,
    stateDir: dir,
    store,
    makeCli: recordingCli().make,
    log: () => {},
  });
  assert.equal(result.published, true, "no config is not an error here");
  assert.deepEqual(store.asked, [NODE], "and the join record is what names the hive");
});

test("F-033: a keychain miss still reports the empty store, naming the hive", async () => {
  const store = emptyStore();
  await assert.rejects(
    () =>
      runProfile({
        name: "Barry's hive",
        config: { relayUrl: "ws://localhost:3000", node: { pubkey: NODE, privateKeyRef: "keychain" } },
        stateDir: stateDir(),
        store,
        makeCli: recordingCli().make,
        log: () => {},
      }),
    /credential store/i,
  );
});

// ── The AC-56 name check under `keygen --agent` ────────────────────────────

test("FIX-170: the keygen name check reaches the relay on an env-configured node", async () => {
  // T-211's untested arm. Before this, an env-configured node produced
  // "this node has no identity yet, so it cannot ask the relay anything" — a
  // sentence that is false, and that turns AC-56 into a warning nobody can act
  // on. F-008's lesson is the standard here: "we could not ask" must never
  // render as "there is nothing there", and it must not be said when we CAN ask.
  const store = emptyStore();
  const cli = recordingCli();
  const check = await withEnv(NODE_SK, () =>
    makeNameCheck({ config: envConfig(), stateDir: stateDir(), store, makeCli: cli.make, log: () => {} }),
  );
  const said = await check("newagent");
  assert.deepEqual(said.warnings, [], `the check ran, so it warns about nothing: ${JSON.stringify(said.warnings)}`);
  assert.equal(said.error, null);
  assert.ok(
    cli.calls.some((c) => c.privateKey === NODE_SK),
    "the relay client was built with the key the CONFIG named",
  );
});

test("FIX-170: the name check does not consult the store when a reference is declared", async () => {
  const store = emptyStore();
  const check = await withEnv(NODE_SK, () =>
    makeNameCheck({
      config: envConfig(),
      stateDir: stateDir(),
      store,
      makeCli: recordingCli().make,
      log: () => {},
    }),
  );
  await check("newagent");
  assert.deepEqual(store.asked, [], `the store was asked: ${JSON.stringify(store.asked)}`);
});

test("FIX-170: an unresolvable reference makes the name check say SO, and say why", async () => {
  // It must never throw — a name check that fails the command it is helping
  // makes AC-56 a reason to stop running `keygen`. And it must not claim the
  // node has no identity, which is the wrong diagnosis and the whole finding.
  const store = emptyStore();
  const check = await withEnv(null, () =>
    makeNameCheck({
      config: envConfig(),
      stateDir: stateDir(),
      store,
      makeCli: recordingCli().make,
      log: () => {},
    }),
  );
  const said = await check("newagent");
  assert.equal(said.warnings.length, 1, "a check that could not run reports that it could not run");
  assert.match(said.warnings[0], /could not check/);
  assert.match(said.warnings[0], new RegExp(ENV_VAR), "and names the reference that failed");
  assert.doesNotMatch(
    said.warnings[0],
    /no identity yet/,
    "never 'this node has no identity yet' — that is the wrong diagnosis",
  );
});

test("FIX-170: a keychain-configured node still reads the store for the name check", async () => {
  const store = {
    asked: [],
    async getNodePrivateKey(pubkey) {
      this.asked.push(pubkey);
      return NODE_SK;
    },
  };
  const check = await makeNameCheck({
    config: { relayUrl: "ws://localhost:3000", node: { pubkey: NODE, privateKeyRef: "keychain" } },
    stateDir: stateDir(),
    store,
    makeCli: recordingCli().make,
    log: () => {},
  });
  const said = await check("newagent");
  assert.deepEqual(said.warnings, []);
  assert.deepEqual(store.asked, [NODE]);
});
