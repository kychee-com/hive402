// FIX-127 — "no key" has to be a finding, not a first impression (AC-32, AC-43).
//
// ── What Barry saw, and what it told him to do ─────────────────────────────
//
// `hive402 up`, 2026-08-27, on a machine where both keys were fine:
//
//     cannot start — 2 of 2 identities have no usable key:
//       node: no key for this node's own identity (role: node) in the OS
//             credential store.
//       create one:  hive402 join <invite-link>
//                or: hive402 keygen --node
//       ... 14 lines ...
//
// He reported it as "too verbose!!!", which it was. The verbosity is the smaller
// half.
//
// **The advice was the 2026-08-26 incident.** `hive402 keygen --node` on that
// machine would have minted a SECOND node identity over a working one — which is
// the "Unnamed member" he found in his own member list the day before. The
// `ABSENT_EXIT` work stopped `join` doing that automatically; nothing stopped the
// product telling a person to do it by hand.
//
// ── Two defects ────────────────────────────────────────────────────────────
//
// 1. An absent verdict was trusted on ONE observation. A read is a process
//    spawn, and `keychain.mjs` already says in its own comment that under load
//    one occasionally does not come back. The existing retry fires only when the
//    child REJECTS, and it fires immediately, which against a transient is
//    close to not retrying. An absent answer now has to be seen twice.
//
// 2. `up` must never advise creating an identity. By the time `up` runs, the
//    config already names a pubkey for every identity. Minting a new key there
//    is ALWAYS wrong: it would not match the pubkey in the config, and the room
//    would see a stranger. That remedy belongs to `setup` and `keygen`.
//
// NOT REPRODUCIBLE ON DEMAND: 40 sequential and 96 concurrent real reads of the
// same key all succeeded. This is reasoned from the mechanism, and both halves
// are right regardless of how often the transient happens.

import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmedAbsent } from "../src/credentials/absence.mjs";

// ── Confirming an absence ─────────────────────────────────────────────────

test("a key that reads absent once and present on the retry is PRESENT", () => {
  // The whole point. One absent observation is not evidence.
  let call = 0;
  const read = async () => (call++ === 0 ? null : "a".repeat(64));
  return confirmedAbsent({ read, delay: async () => {} }).then((result) => {
    assert.equal(result.absent, false);
    assert.equal(result.value, "a".repeat(64));
    assert.equal(call, 2, "it looked twice");
  });
});

test("two absents in a row is genuinely absent", async () => {
  // A fresh machine must still be able to say "there is no key here", or setup
  // and join cannot work at all.
  let call = 0;
  const read = async () => {
    call++;
    return null;
  };
  const result = await confirmedAbsent({ read, delay: async () => {} });
  assert.equal(result.absent, true);
  assert.equal(result.value, null);
  assert.equal(call, 2);
});

test("a key that is there costs exactly ONE read", async () => {
  // The normal path must not pay for this. Every start resolves every identity,
  // so a second spawn per key on the happy path would be a real cost for
  // nothing.
  let call = 0;
  const read = async () => {
    call++;
    return "b".repeat(64);
  };
  await confirmedAbsent({ read, delay: async () => {} });
  assert.equal(call, 1);
});

test("the confirming read is SPACED, not immediate", async () => {
  // An immediate retry against a transient hits the same conditions that caused
  // it. `child()` already retries immediately and that was not enough; repeating
  // the same mistake one layer up would be a fix in name only.
  const waited = [];
  let call = 0;
  await confirmedAbsent({
    read: async () => (call++, null),
    delay: async (ms) => waited.push(ms),
  });
  assert.equal(waited.length, 1, "it waited before looking again");
  assert.ok(waited[0] > 0, `the wait must be a real one, got ${waited[0]}ms`);
});

test("a read that THROWS is not turned into an absence", () => {
  // The distinction ABSENT_EXIT exists to protect. A failure has to travel: a
  // caller that mints on null would mint on a broken credential store.
  const boom = async () => {
    throw new Error("credential store read failed (helper exit 3)");
  };
  return assert.rejects(confirmedAbsent({ read: boom, delay: async () => {} }), /read failed/);
});

test("a throw on the CONFIRMING read travels too", async () => {
  let call = 0;
  const read = async () => {
    if (call++ === 0) return null;
    throw new Error("credential store read failed (helper exit 3)");
  };
  await assert.rejects(confirmedAbsent({ read, delay: async () => {} }), /read failed/);
});

// ── An absent verdict is checked against the filesystem ───────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { osKeychain, credentialLocation, inspectStore, storeEntryNames } from "../src/credentials/keychain.mjs";

// Both variables, always. The store reads %USERPROFILE% FIRST and %LOCALAPPDATA%
// only as the legacy fallback, so a test that pins one and leaves the other
// pointing at the developer's real home reads THEIR keys and passes or fails for
// reasons that have nothing to do with the code.
//
// That is not hypothetical: three tests in this file broke the moment Barry's
// own keys were copied into `~/.hive402/credentials`, because they had pinned
// only LOCALAPPDATA back when that was the primary. Every test here now declares
// both, and any it does not want is explicitly absent.
function withStoreEnv({ home = null, local = null }, run) {
  const prevHome = process.env.USERPROFILE;
  const prevLocal = process.env.LOCALAPPDATA;
  if (home) process.env.USERPROFILE = home;
  else delete process.env.USERPROFILE;
  if (local) process.env.LOCALAPPDATA = local;
  else delete process.env.LOCALAPPDATA;
  try {
    return run();
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
  }
}

// The async twin. `return run()` from a synchronous wrapper hands the promise to
// `finally`, which restores the environment before the awaited work ever looks
// at it — a mistake already made once in this file.
async function withStoreEnvAsync(env, run) {
  const prevHome = process.env.USERPROFILE;
  const prevLocal = process.env.LOCALAPPDATA;
  if (env.home) process.env.USERPROFILE = env.home;
  else delete process.env.USERPROFILE;
  if (env.local) process.env.LOCALAPPDATA = env.local;
  else delete process.env.LOCALAPPDATA;
  try {
    return await run();
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
  }
}

test("INVARIANT: a vault file that exists is never reported as absent", async (t) => {
  // Barry hit "no usable key" TWICE on a machine whose vault files were on disk
  // and whose `hive402 keys list` said "key stored". The only route to that
  // message is the child's `Test-Path` saying no about a file that is
  // demonstrably there.
  //
  // Whatever the reason, the VERDICT is wrong, and this process can say so: it
  // resolves the same path from the same variable it hands the child and asks
  // the filesystem. A file that exists is not an absence, so it becomes a read
  // failure, which travels and which nothing turns into "mint a new identity".
  if (process.platform !== "win32") return t.skip("windows-only backend");

  const fakeLocal = mkdtempSync(path.join(tmpdir(), "hive402-local-"));
  const dir = path.join(fakeLocal, "hive402", "credentials");
  mkdirSync(dir, { recursive: true });
  // STATED PLAINLY, because it changes what this test is worth: these bytes are
  // not DPAPI ciphertext, so the child gets PAST Test-Path and fails at
  // Unprotect. That is exit 3, not exit 2, so the cross-check branch does not
  // run here — the invariant is upheld by the ordinary failure path instead.
  //
  // The cross-check branch fires only when the child DISAGREES with the
  // filesystem, which is precisely the condition nobody has been able to
  // reproduce on demand. So this test guards the property ("a present file never
  // reads as absent") from either direction rather than proving one branch, and
  // the branch itself carries its reasoning in a comment in `keychain.mjs`.
  writeFileSync(path.join(dir, "hive402_node-private-key--owner.dpapi"), Buffer.from([1, 2, 3]));

  // The file is placed in the LEGACY layout, so USERPROFILE is pointed at an
  // empty directory rather than left on the real home — otherwise this reads the
  // developer's own store and proves nothing.
  await withStoreEnvAsync(
    { home: mkdtempSync(path.join(tmpdir(), "hive402-emptyhome-")), local: fakeLocal },
    async () => {
      const kc = osKeychain("win32");
      const result = await kc.get("hive402_node-private-key", "owner").then(
        (v) => ({ absent: v === null }),
        (err) => ({ error: err }),
      );
      assert.equal(result.absent, undefined, "a file that exists must never read as absent");
      assert.ok(result.error, "it is a failure instead");
      assert.equal(result.error.exitCode !== 2, true, "and never carries the absent code onwards");
    },
  );
});

// ── doctor: which build is speaking, and a safe remedy ────────────────────

test("doctor's first line names the build and where it is running from", () => {
  // Added after an afternoon spent reasoning about a `hive402 up` failure whose
  // pasted output turned out to be from the PREVIOUS build — so the diagnostics
  // written to explain it had never run. A version and a path cost one line and
  // remove that whole class of confusion, and catch the real version of it too:
  // a second, older install earlier on PATH.
  const cli = readFileSync(new URL("../bin/cli.mjs", import.meta.url), "utf8");
  const doctor = cli.slice(cli.indexOf("async function cmdDoctor"));
  assert.match(doctor, /hive402 \$\{pkg\.version\} running from \$\{root\}/);
  assert.match(doctor, /credential store: \$\{where\}/, "and where the store actually is");
});

test("doctor offers keygen only for an agent that was never registered", () => {
  // A blanket answer is wrong in both directions here, and an existing test in
  // cli-commands.test.mjs caught me giving one.
  //
  // `keygen --agent X` mints a NEW key, producing a pubkey that is not the one
  // the config names. For an agent that has never been registered that is fine:
  // keygen prints the new pubkey and says to put it in the config, and nothing
  // else knows the old one. For a REGISTERED agent it is destructive, because
  // the room, the picker record and the attestation all name the old identity.
  // That is the shape of the 2026-08-26 "Unnamed member" incident.
  //
  // Doctor is the one command that can tell, because the attestation file
  // `register` writes IS that distinction, and doctor already checks it a few
  // lines earlier for its own reason.
  // Driven through the real command rather than by reading the source. The
  // first cut of this test split the ternary on "?" and ":" and broke on the
  // colons inside its own strings, which is what source-text assertions deserve.
  const before = doctorRemedyFor({ registered: false });
  assert.match(before, /keygen --agent ghost/, "an unregistered agent still gets the fast path");

  const after = doctorRemedyFor({ registered: true });
  assert.match(after, /keys import --agent ghost/, "a REGISTERED agent must never be told to mint");
  assert.doesNotMatch(after, /keygen --agent ghost/);
});

// Run the real `doctor` against a throwaway config and return the line about
// agent "ghost", with and without the attestation file `register` writes.
function doctorRemedyFor({ registered, wholeOutput = false, keyRef = null }) {
  const home = mkdtempSync(path.join(tmpdir(), "hive402-doc-"));
  const stateDir = path.join(home, "state");
  mkdirSync(path.join(stateDir, "agents"), { recursive: true });
  if (registered) {
    writeFileSync(path.join(stateDir, "agents", "ghost.json"), JSON.stringify({ authTag: ["auth"] }));
  }
  const agent = { name: "ghost", pubkey: "4".repeat(64), ownerPubkey: "7".repeat(64) };
  // An `env:` reference that IS set reports as "uses env:…", never as a missing
  // key — so this is how a run with nothing missing is produced.
  if (keyRef) agent.privateKeyRef = keyRef;
  const file = path.join(home, "hive402.config.json");
  writeFileSync(
    file,
    JSON.stringify({
      relayUrl: "wss://relay.example",
      stateDir,
      node: keyRef ? { pubkey: "9".repeat(64), privateKeyRef: keyRef } : { pubkey: "9".repeat(64) },
      rooms: [{ channel: "11111111-1111-1111-1111-111111111111", agents: [agent] }],
    }),
  );

  const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
  const out = spawnSync(process.execPath, [cli, "doctor", "--config", file], {
    encoding: "utf8",
    env: { ...process.env, HIVE402_DOC_OK: "aa".repeat(32) },
  });
  const said = `${out.stdout}${out.stderr}`;
  if (wholeOutput) return said;
  return said.split("\n").find((l) => l.includes("ghost") && /key for/i.test(l)) ?? said;
}

test("doctor reports what THIS process sees in the store when a key is missing", () => {
  // The question that survived every check done from outside. An empty list
  // means this process cannot see the directory, which is a permission or
  // environment problem and NOT a missing key; a list holding the entries just
  // called missing means the READ is failing and creating keys will not help.
  const said = doctorRemedyFor({ registered: false, wholeOutput: true });
  assert.match(said, /this process sees \d+ entr/, `expected a store listing in:\n${said}`);
});

test("that listing appears only when something is actually missing", () => {
  // It is a diagnostic, not a permanent extra line: the report that started all
  // of this was "too verbose!!!", and a healthy run must not grow.
  //
  // Driven through the real command, not by reading the source. The first cut
  // matched a 600-character window of `cmdDoctor` and broke the moment the guard
  // gained a clause — the SECOND time this file paid for asserting on source
  // text instead of behaviour.
  const said = doctorRemedyFor({ registered: false, wholeOutput: true, keyRef: "env:HIVE402_DOC_OK" });
  assert.doesNotMatch(said, /this process sees/, `a run with nothing missing must not grow:\n${said}`);
});

test("the listing carries entry names only, never a secret", () => {
  // DD-30: nothing a child says is surfaced, and nothing here opens a file. The
  // names are `<service>--<identity>`, and every identity in them is already in
  // the config the same command just printed.
  const fake = mkdtempSync(path.join(tmpdir(), "hive402-store-"));
  mkdirSync(path.join(fake, ".hive402", "credentials"), { recursive: true });
  writeFileSync(
    path.join(fake, ".hive402", "credentials", "hive402_node-private-key--node.dpapi"),
    "SECRET-BYTES-THAT-MUST-NOT-APPEAR",
  );
  withStoreEnv({ home: fake }, () => {
    const names = storeEntryNames("win32");
    assert.deepEqual(names, ["hive402_node-private-key--node"]);
    assert.equal(names.join(" ").includes("SECRET"), false);
    assert.equal(names.join(" ").includes(".dpapi"), false, "the extension is noise");
  });
});

test("a store directory that does not exist yet is EMPTY, not unreadable", () => {
  // A machine that has never stored a key is a legitimate empty store, and
  // calling that "unreadable" would block a first setup.
  withStoreEnv({ home: path.join(tmpdir(), "hive402-does-not-exist-at-all") }, () => {
    const seen = inspectStore("win32");
    assert.deepEqual(seen.entries, []);
    assert.equal(seen.unreadable, false, "ENOENT is an empty store, not a blocked one");
    assert.deepEqual(storeEntryNames("win32"), []);
  });
});

// ── The finding Barry's doctor actually produced ──────────────────────────
//
// `this process sees 0 entries there`, at a path where another process on the
// same machine sees two files. So the keys were never missing: the process could
// not look. Reporting that as "NO KEY" is the absent-versus-unreadable error one
// level further out again — at the DIRECTORY rather than at the entry — and its
// remedy ("import or create a key") is the one that mints a second identity.

// A store whose directory cannot be LISTED. A file where the directory should
// be makes readdir fail with ENOTDIR rather than ENOENT, which is the shape of
// "something is there and I cannot use it" without needing real ACLs.
// ASYNC and awaited. The first cut was synchronous and `return run()` handed the
// promise straight to `finally`, which restored the environment before the
// awaited work ever looked at it — so the supervisor read the REAL store and the
// test failed against a path from this machine. A swapped environment has to
// outlive the thing it is swapped for.
async function withBlockedStore(run) {
  const home = process.env.USERPROFILE;
  const local = process.env.LOCALAPPDATA;
  const base = mkdtempSync(path.join(tmpdir(), "hive402-blocked-"));
  mkdirSync(path.join(base, ".hive402"), { recursive: true });
  writeFileSync(path.join(base, ".hive402", "credentials"), "not a directory");
  process.env.USERPROFILE = base;
  // Cleared, or the legacy location would answer for the primary one and the
  // store would look merely empty rather than blocked.
  delete process.env.LOCALAPPDATA;
  try {
    return await run();
  } finally {
    if (home === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = home;
    if (local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = local;
  }
}

test("a store that cannot be READ is not an empty store", async () => {
  await withBlockedStore(() => {
    const seen = inspectStore("win32");
    assert.equal(seen.unreadable, true, "a directory that cannot be listed is UNREADABLE");
    assert.ok(seen.reason, "and the reason travels, so the message can name it");
  });
});

test("up refuses for the RIGHT reason when the store cannot be read", async () => {
  const said = await withBlockedStore(() => failureOf(nodeWithNoKeys()));
  assert.match(said, /UNREADABLE/i, `the verdict must be about the STORE, not the keys:\n${said}`);
  assert.match(said, /probably fine/i, "and must not imply the keys are gone");
  assert.doesNotMatch(said, /keygen/i, "never mint");
  assert.doesNotMatch(said, /keys import/i, "and never import either: nothing is missing");
});

test("the store lives under %USERPROFILE%, NOT under %LOCALAPPDATA%", () => {
  // The root cause of the whole afternoon. A packaged (MSIX) host redirects
  // %LOCALAPPDATA% into its own LocalCache, so keys written from inside one are
  // invisible to every ordinary terminal on the same machine, under the same
  // user, at what prints as the same path. %USERPROFILE% is not redirected —
  // proven on Barry's machine, where a plain shell reads the
  // `~/.hive402/config.json` a packaged process wrote.
  const home = process.env.USERPROFILE;
  const local = process.env.LOCALAPPDATA;
  try {
    process.env.USERPROFILE = "D:\\Users\\someone";
    process.env.LOCALAPPDATA = "D:\\Users\\someone\\AppData\\Local";
    assert.equal(credentialLocation("win32"), "D:\\Users\\someone\\.hive402\\credentials");
    assert.doesNotMatch(credentialLocation("win32"), /AppData/i, "never the redirected root");

    // With the primary gone but the legacy variable set, naming the legacy path
    // is the honest answer: that is genuinely the only place left to look.
    delete process.env.USERPROFILE;
    assert.match(credentialLocation("win32"), /AppData/i);

    // With neither, there is nothing to name and saying so IS the diagnosis.
    delete process.env.LOCALAPPDATA;
    assert.match(credentialLocation("win32"), /NOT SET/);
  } finally {
    if (home === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = home;
    if (local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = local;
  }
});

test("keys already in the LEGACY location are still found", () => {
  // Every install made before this move has its keys under %LOCALAPPDATA%,
  // including the ones stranded inside a packaged host. Reading the old location
  // is what lets those installs keep working and be migrated without a flag day.
  const home = process.env.USERPROFILE;
  const local = process.env.LOCALAPPDATA;
  const base = mkdtempSync(path.join(tmpdir(), "hive402-legacy-"));
  mkdirSync(path.join(base, "hive402", "credentials"), { recursive: true });
  writeFileSync(path.join(base, "hive402", "credentials", "hive402_node-private-key--owner.dpapi"), "x");
  try {
    process.env.USERPROFILE = mkdtempSync(path.join(tmpdir(), "hive402-newhome-"));
    process.env.LOCALAPPDATA = base;
    const seen = inspectStore("win32");
    assert.deepEqual(seen.entries, ["hive402_node-private-key--owner"]);
    assert.equal(seen.unreadable, false);
  } finally {
    if (home === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = home;
    if (local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = local;
  }
});

// ── What `up` says when a key will not resolve ────────────────────────────

import { Supervisor } from "../src/node/supervisor.mjs";

const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const nodeWithNoKeys = () =>
  nodeThatFailsWith("no key for this identity in the OS credential store");

function nodeThatFailsWith(message) {
  return new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "keychain" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\a.js", extraDirs: [] },
      rooms: [
        {
          channel: CHANNEL,
          agents: [
            {
              name: "spike",
              pubkey: SPIKE,
              ownerPubkey: OWNER,
              privateKeyRef: "keychain",
              research: true,
              build: false,
              crossOwnerAsks: "owner-approves",
              selfInitiated: "asks-owner",
              replyMode: "addressed-only",
            },
          ],
        },
      ],
    },
    stateDir: "C:\\nowhere",
    spawn: () => ({ pid: 1, exitCode: null, kill() {} }),
    makeCli: () => ({}),
    resolveKey: async () => {
      throw new Error(message);
    },
    trustWorkspace: () => {},
    log: () => {},
  });
}

const startFailure = () => failureOf(nodeWithNoKeys());

async function failureOf(sup) {
  try {
    await sup.start();
    assert.fail("expected start to refuse");
  } catch (err) {
    return err.message;
  }
}

test("up does NOT tell the owner to run keygen", async () => {
  // THE serious half of FIX-127. `up` runs against a config that already names a
  // pubkey for every identity. A new key would not match that pubkey, so the
  // agent the room can see and the agent this node holds would be two different
  // identities — which is how an "Unnamed member" appeared in Barry's community
  // on 2026-08-26.
  const said = await startFailure();
  assert.doesNotMatch(said, /keygen/i, `up must never advise minting an identity:\n${said}`);
  assert.doesNotMatch(said, /join <invite/i, "nor re-joining, which mints one too");
});

test("it points at the command that ANSWERS the question instead", async () => {
  // "Is the key really missing, or did the read fail?" is the question, and
  // `keys list` is the thing that answers it.
  const said = await startFailure();
  assert.match(said, /hive402 keys list/);
});

test("it says what a 'key stored' answer means, so the owner is not stuck", async () => {
  // This used to require the words "run up again", which was the right advice
  // while the only explanation for a wrong absent verdict was a flaky read.
  // Barry then hit it a SECOND time, deterministically, which retrying cannot
  // fix — so for an absent verdict the answer is now to compare where this
  // shell looked against where the keys are, and the retry advice moved to the
  // unreadable case where it belongs.
  const said = await startFailure();
  assert.match(said, /key stored/i, "it must name what they will see");
  assert.match(said, /looking somewhere else/i, "and give them the explanation that fits");
});

test("it names every identity that failed, and stays SHORT", async () => {
  // Barry: "too verbose!!!" — it was 14 lines. It still has to name which
  // identities failed, because a start blocked on an unnamed identity is worse
  // than a long message.
  const said = await startFailure();
  assert.match(said, /node/);
  assert.match(said, /spike/);
  const lines = said.split("\n").filter((l) => l.trim());
  assert.ok(lines.length <= 5, `at most 5 lines, got ${lines.length}:\n${said}`);
});

test("the failure carries no em-dash, because a user reads it", async () => {
  assert.doesNotMatch(await startFailure(), /[—–]/);
});

// ── Saying where it looked, and what kind of failure it was ───────────────
//
// Barry hit this a second time, on a machine whose key FILES were on disk and
// whose `hive402 keys list` said "key stored" for both identities. That is a
// flat contradiction, and the product gave him no way to resolve it: nothing it
// printed named the place it had searched.
//
// On Windows the store's location is computed from `$env:LOCALAPPDATA` inside
// the child process, so a shell whose LOCALAPPDATA differs from the one the keys
// were written under looks at a different, empty directory and TRUTHFULLY
// reports nothing there. Invisible unless the path is printed.

test("an ABSENT key makes the failure say where it looked", async () => {
  const said = await startFailure();
  assert.match(said, /Looked in:/, `the one place actually used must be named:\n${said}`);
  assert.match(said, /credentials/i, "and it must be the credential store's own path");
});

test("that is one REAL path, not a list of candidates", async () => {
  // Not a rerun of the config-not-found dump Barry objected to. That listed
  // three speculative candidates; this names the single location the read used,
  // which is the fact that resolves the contradiction.
  const said = await startFailure();
  const looked = said.split("\n").filter((l) => /Looked in:/.test(l));
  assert.equal(looked.length, 1);
});

test("an UNREADABLE store is not reported as a missing key", async () => {
  // The distinction ABSENT_EXIT exists for, which the first cut of FIX-127
  // destroyed one layer up while shortening the message. "I could not read it"
  // and "there is nothing there" need different answers: a reader given the
  // absent answer for a read failure goes hunting for a key that was never
  // missing, and the store's path is a red herring for them.
  const sup = nodeThatFailsWith("credential store read failed (helper exit 3)");
  const said = await failureOf(sup);
  assert.match(said, /could not be READ/i);
  assert.doesNotMatch(said, /Looked in:/, "the path is irrelevant when the read itself broke");
  assert.match(said, /run up again/i);
});

test("either way it still refuses to advise creating a key", async () => {
  const said = await failureOf(nodeThatFailsWith("credential store read failed (helper exit 3)"));
  assert.doesNotMatch(said, /keygen/i);
});
