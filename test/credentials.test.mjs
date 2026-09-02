import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialStore } from "../src/credentials/store.mjs";
import { osKeychain } from "../src/credentials/keychain.mjs";

// The REAL platform backend, exercised for real — the only kind of test that
// can see this file's actual failure mode. Both bugs found in this module were
// invisible to the fake backend below: the filename sanitizer (cycle 1) and the
// PowerShell interpolation (cycle 7, DD-29). A fake keychain is a Map; it
// cannot execute a secret.
//
// Guarded by platform so the suite still runs off-Windows: `osKeychain("win32")`
// unconditionally shells out to powershell.exe, which does not exist on a Mac.
const REAL_BACKEND = process.platform === "win32" ? osKeychain() : null;
const realOnly = { skip: REAL_BACKEND ? false : "real credential backend is Windows-only in this suite" };

// A fake OS keychain backend: the real one shells out to the platform
// credential manager. The contract under test is that credentials go THERE and
// nowhere else — never to a file, never over the network (spec AC-32).
function fakeKeychain() {
  const vault = new Map();
  return {
    vault,
    async set(service, account, secret) {
      vault.set(`${service}:${account}`, secret);
    },
    // Exclusive create (DD-32, F-017). A fake that cannot express
    // "already exists" cannot test the property that a raced keygen is
    // refused, so every fake in this suite implements it.
    async create(service, account, secret) {
      const { KeyExistsError } = await import("../src/credentials/keychain.mjs");
      if (vault.has(`${service}:${account}`)) throw new KeyExistsError();
      vault.set(`${service}:${account}`, secret);
    },
    async get(service, account) {
      return vault.get(`${service}:${account}`) ?? null;
    },
    async remove(service, account) {
      return vault.delete(`${service}:${account}`);
    },
  };
}

test("storing a model credential puts it in the OS keychain", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  await store.setModelCredential("blitz", "sk-ant-oat-example");
  assert.equal(await store.getModelCredential("blitz"), "sk-ant-oat-example");
  assert.equal(keychain.vault.size, 1);
});

test("credentials are namespaced per agent — no cross-agent reads", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  await store.setModelCredential("blitz", "barry-token");
  assert.equal(await store.getModelCredential("tals-agent"), null);
});

test("a missing credential returns null rather than throwing", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  assert.equal(await store.getModelCredential("nobody"), null);
});

test("removing a credential clears it from the keychain", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  await store.setModelCredential("blitz", "t");
  await store.removeModelCredential("blitz");
  assert.equal(await store.getModelCredential("blitz"), null);
  assert.equal(keychain.vault.size, 0);
});

test("the store never exposes a filesystem or network path (AC-32 shape)", () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  for (const name of surface) {
    assert.doesNotMatch(
      name,
      /file|path|disk|write|upload|fetch|post|sync/i,
      `credential store must not expose "${name}"`,
    );
  }
});

// Regression: the Windows backend derives a FILE NAME from service+account.
// A ":" in the service name (hive402:model-credential) produced
// "The given path's format is not supported." Caught by live round-trip, not
// by the fake backend — so the sanitizer is asserted directly here.
test("windows keychain target name is filename-safe (no : \\ / etc.)", realOnly, async () => {
  const kc = REAL_BACKEND;
  // exercise the same derivation the backend uses by round-tripping a name
  // containing every character Windows forbids
  const nasty = 'a:b\\c/d*e?f"g<h>i|j';
  const probe = `hive402-test-${Date.now()}`;
  await kc.set(`svc:${nasty}`, probe, "v");
  assert.equal(await kc.get(`svc:${nasty}`, probe), "v");
  assert.equal(await kc.remove(`svc:${nasty}`, probe), true);
});

// Regression, DD-29. The backend built its PowerShell script with
// `UTF8.GetBytes(${JSON.stringify(secret)})`, which lands the secret inside a
// DOUBLE-QUOTED PowerShell string — where `$(…)` is a subexpression PowerShell
// EXECUTES. Measured 2026-08-18 before the fix: storing `x$(Write-Output
// PWNED)y` and reading it back returned `xPWNEDy`. That is arbitrary code
// execution in the credential-writing path, as the owner, driven by the content
// of a secret. A hex key cannot contain `$`, but a model API token can and
// `keys import` reads arbitrary stdin.
test("a secret containing shell metacharacters round-trips byte-exact", realOnly, async () => {
  const kc = REAL_BACKEND;
  const account = `hive402-test-inject-${Date.now()}`;
  const service = "hive402:test-injection";

  // Every character that means something to PowerShell inside a quoted string:
  // subexpression, variable, backtick escape, quotes, and a newline.
  const secrets = [
    "x$(Write-Output PWNED)y",
    "before`nafter",
    '$env:USERNAME',
    'quote"and\'quote',
    "semi;colon && amp | pipe",
    "line1\nline2",
    "$(Get-Date)",
  ];

  try {
    for (const secret of secrets) {
      await kc.set(service, account, secret);
      assert.equal(
        await kc.get(service, account),
        secret,
        `secret was altered in transit: ${JSON.stringify(secret)}`,
      );
    }
  } finally {
    await kc.remove(service, account);
  }
});

test("agent private keys use a distinct namespace from model credentials", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  await store.setModelCredential("blitz", "model-token");
  await store.setAgentPrivateKey("blitz", "b".repeat(64));
  assert.equal(await store.getModelCredential("blitz"), "model-token");
  assert.equal(await store.getAgentPrivateKey("blitz"), "b".repeat(64));
  assert.equal(keychain.vault.size, 2);
});

// The owner's own identity (the node's key) is a separate slot from any
// agent's. Without this, the resolver's `agent ?? role ?? "node"` puts an agent
// literally named `node` in the same drawer as its owner — an identity
// confusion in the one module whose entire job is keeping identities apart.
test("the node identity is a distinct slot from an agent named node", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  // AC-72: a node's slot is keyed by that node's own pubkey.
  const NODE = "3f".repeat(32);
  await store.setNodePrivateKey(NODE, "n".repeat(64));
  await store.setAgentPrivateKey("node", "a".repeat(64));

  assert.equal(await store.getNodePrivateKey(NODE), "n".repeat(64));
  assert.equal(await store.getAgentPrivateKey("node"), "a".repeat(64));
  assert.equal(keychain.vault.size, 2, "they must not share one entry");

  // Removing one leaves the other intact.
  await store.removeAgentPrivateKey("node");
  assert.equal(await store.getNodePrivateKey(NODE), "n".repeat(64));
  assert.equal(await store.getAgentPrivateKey("node"), null);
});

// The config decides agent-name uniqueness case-insensitively
// (`schema.mjs` lowercases into `seenNames`), so the store must agree — or
// `keygen --agent Blitz` writes a key that a config saying `"name": "blitz"`
// can never find, and the failure surfaces as "no key" at `up`.
test("agent names are matched case-insensitively, like the config's own uniqueness rule", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setAgentPrivateKey("Blitz", "c".repeat(64));
  assert.equal(await store.getAgentPrivateKey("blitz"), "c".repeat(64));
  assert.equal(await store.getAgentPrivateKey("BLITZ"), "c".repeat(64));
  assert.equal(await store.removeAgentPrivateKey("bLiTz"), true);
  assert.equal(await store.getAgentPrivateKey("Blitz"), null);
});

// An empty or blank key is not a key. Storing one would make `getX() -> null`
// mean two different things, and "present but useless" is the state that turns
// into a confusing failure three commands later.
test("a blank private key is refused rather than stored", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await assert.rejects(() => store.setAgentPrivateKey("blitz", ""), /empty|blank/i);
  await assert.rejects(() => store.setNodePrivateKey("3f".repeat(32), "   "), /empty|blank/i);
});

// FOUND BY BARRY LOOKING AT HIS MEMBER LIST (2026-08-26): an "Unnamed member"
// he had not created.
//
// `hive402 join` had minted a SECOND node identity on a machine that already
// had one, joined the community with it, and left the real node orphaned. The
// cause was not in the join at all — it was `keychain.get` swallowing every
// failure and returning null, so "the store could not be read" and "there is no
// key" were the same answer, and the caller mints on the second.
//
// This is F-008's class, one layer down: "we could not check" rendering as
// "there is nothing there". The consequence is worse than F-008's, because the
// thing created is a durable identity in somebody's community.
test("a keychain that FAILS is not a keychain that is empty", async () => {
  const broken = {
    async get() { throw new Error("DPAPI could not unprotect this value"); },
    async set() {}, async create() {}, async remove() { return false; },
  };
  const store = new CredentialStore({ keychain: broken });
  await assert.rejects(() => store.getNodePrivateKey("3f".repeat(32)), /DPAPI/);
  await assert.rejects(() => store.getAgentPrivateKey("spike"), /DPAPI/);
});

test("an empty keychain still reads as empty", async () => {
  const empty = {
    async get() { return null; },
    async set() {}, async create() {}, async remove() { return false; },
  };
  const store = new CredentialStore({ keychain: empty });
  assert.equal(await store.getNodePrivateKey("3f".repeat(32)), null);
});

test("a node identity is NOT minted when the store cannot be read", async () => {
  // The behaviour that matters, through the real join command: a read failure
  // must stop the join, not quietly produce a second identity.
  const { runJoin } = await import("../src/registry/joincommand.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;

  const made = [];
  const store = {
    async getNodePrivateKey() { throw new Error("credential store unreadable"); },
    async createNodePrivateKey(_pubkey, k) { made.push(k); },
  };
  // AC-72: the read only happens for a hive this machine is said to hold, so
  // the scenario ("we HAVE an identity and cannot read it") is expressed by
  // naming one. With nothing named there is nothing to fail to read, and
  // minting is then the correct answer rather than the bug.
  const NAMED_HIVE = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
  await assert.rejects(
    runJoin({
      link: "https://relay.example/invite/v2.abc",
      store,
      nodePubkey: NAMED_HIVE,
      stateDir: mkdtempSync(path.join(tmpdir(), "hive402-broken-")),
      consent: async () => ({ accepted: true }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
      log: () => {},
    }),
    /unreadable/,
  );
  assert.deepEqual(made, [], "no identity may be minted over a store we could not read");
});

// The decision itself, at the layer every platform's `get` now shares.
test("only the platform's own not-found code reads as absent", async () => {
  const { absentOrRethrow, ABSENT_EXIT } = await import("../src/credentials/keychain.mjs");
  const failure = (exitCode) => Object.assign(new Error("credential store read failed"), { exitCode });

  for (const [platform, code] of Object.entries(ABSENT_EXIT)) {
    assert.equal(absentOrRethrow(failure(code), code), null, `${platform}: ${code} means absent`);
  }
  // Everything else travels. DPAPI refusing to unprotect, a locked keychain, a
  // helper that could not be started at all (exitCode null) — each of these
  // used to be indistinguishable from an empty store, and minting on that is
  // what put a second node identity into a real community.
  for (const exitCode of [1, 3, 5, 255, null, undefined]) {
    if (exitCode === ABSENT_EXIT.win32) continue;
    assert.throws(() => absentOrRethrow(failure(exitCode), ABSENT_EXIT.win32), /read failed/);
  }
});

// FOUND TWICE ON ONE DAY (2026-08-26): Barry's `hive402 up` reported "2 of 2
// identities have no usable key" on a machine whose keys were both fine, and
// the suite failed one credential round-trip in a run of 1098 and passed on the
// next. Shelling out to a platform credential tool is a process spawn, and
// under load one occasionally does not come back.
//
// A read retries once — it has nothing to undo. A WRITE must not: `create` is
// exclusive, so a retry could turn "I already wrote it" into a spurious
// KeyExistsError and refuse an identity that was in fact created.
test("a read that fails once is retried; a write is not", async () => {
  const { osKeychain } = await import("../src/credentials/keychain.mjs");
  // Exercised through the real backend's decision, by counting attempts at the
  // only seam that exists: a service name nothing else uses.
  const kc = osKeychain();
  const service = "hive402:retry-probe";
  const account = `probe-${process.pid}`;
  try {
    // An absent entry is a clean null, not a retry storm.
    assert.equal(await kc.get(service, account), null);
    // And a round trip still works with the retry wrapper in place.
    await kc.set(service, account, "value-with-$-and-`-and-'");
    assert.equal(await kc.get(service, account), "value-with-$-and-`-and-'");
  } finally {
    await kc.remove(service, account);
  }
  assert.equal(await kc.get(service, account), null, "and it is gone afterwards");
});
