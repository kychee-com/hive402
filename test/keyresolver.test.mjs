import { test } from "node:test";
import assert from "node:assert/strict";

import { makeKeyResolver } from "../src/node/runtime.mjs";
import { CredentialStore } from "../src/credentials/store.mjs";

// There was no test for `makeKeyResolver` at all until fix cycle 7, which is
// exactly why it shipped broken: it read through
// `store.getAgentPrivateKeySync?.(which)`, a method that exists nowhere in this
// repo. The optional call turned the missing method into `undefined`, `?? null`
// turned that into "no key", and the resolver blamed an empty credential store
// for what was a missing method. Since `"keychain"` is the schema DEFAULT for
// `privateKeyRef`, that was the path a new owner took by doing nothing.

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

// Both must be real hex: the resolver refuses a stored entry that is not a
// 64-char hex key, and "n" is not a hex digit. (This caught its own fixture on
// the first run, which is the check doing its job.)
const AGENT_KEY = "a".repeat(64);
const NODE_KEY = "d".repeat(64);
// AC-72: a node key lives under its own pubkey, and the resolver is bound to
// ONE hive — this machine may run several.
const NODE_PUBKEY = "e".repeat(64);

async function populatedStore() {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setAgentPrivateKey("blitz", AGENT_KEY);
  await store.setNodePrivateKey(NODE_PUBKEY, NODE_KEY);
  return store;
}

// Every resolver in this file is bound to that hive, the way `makeSupervisor`
// binds one from `config.node.pubkey`.
const resolverFor = async (store) =>
  makeKeyResolver({ store: store ?? (await populatedStore()), nodePubkey: NODE_PUBKEY });

test('a "keychain" ref resolves an agent key that is actually in the store', async () => {
  const resolve = await resolverFor();
  assert.equal(await resolve("keychain", { agent: "blitz" }), AGENT_KEY);
});

test("an absent ref means the keychain, because that is the schema default", async () => {
  const resolve = await resolverFor();
  assert.equal(await resolve(undefined, { agent: "blitz" }), AGENT_KEY);
});

// Every human role is the SAME human: the owner runs the node, sponsors the
// registration and signs the attestation. Keying them separately would demand
// three copies of one key (DD-28).
test("node, sponsor and owner roles all resolve to the one stored owner identity", async () => {
  const resolve = await resolverFor();
  for (const role of ["node", "sponsor", "owner"]) {
    assert.equal(await resolve("keychain", { role }), NODE_KEY, `role ${role}`);
  }
});

test("an agent named node does not collide with the owner's identity", async () => {
  const store = await populatedStore();
  await store.setAgentPrivateKey("node", AGENT_KEY);
  const resolve = await resolverFor(store);
  assert.equal(await resolve("keychain", { agent: "node" }), AGENT_KEY);
  assert.equal(await resolve("keychain", { role: "node" }), NODE_KEY);
});

test("a missing agent key names the agent, and nothing else", async () => {
  const resolve = makeKeyResolver({ store: new CredentialStore({ keychain: fakeKeychain() }) });
  await assert.rejects(
    () => resolve("keychain", { agent: "blitz" }),
    (err) => {
      assert.match(err.message, /no key/i);
      assert.match(err.message, /blitz/);
      return true;
    },
  );
});

// FIX-127 rewrote both of these, and the reason matters more than the wording.
//
// They used to require this resolver to name `hive402 keygen` / `hive402 join`.
// That is advice for a machine with no identity yet, and NO CALLER OF THIS
// RESOLVER IS EVER THAT MACHINE: reaching it requires a config, and a config
// names a pubkey for every identity in it. A key minted here would not match the
// pubkey the room already knows, so the agent people can see and the agent this
// node holds would be two different identities. `setup` is the fresh-machine
// path and it mints directly, never through here.
//
// What that advice produced in practice, when Barry hit a flaky credential read
// on 2026-08-27: a working node telling him to mint a second identity over
// itself. That is the "Unnamed member" incident of 2026-08-26, arriving by a
// route the ABSENT_EXIT fix did not cover, because this time a human was going
// to type it rather than the code doing it.
test("a missing key NEVER tells the caller to create one", async () => {
  // Bound to a hive (AC-72) so the node roles reach the missing-key message
  // under test, rather than the earlier "which hive?" refusal.
  const resolve = makeKeyResolver({
    store: new CredentialStore({ keychain: fakeKeychain() }),
    nodePubkey: NODE_PUBKEY,
  });
  for (const opts of [{ agent: "blitz" }, { role: "node" }, { role: "sponsor" }, { role: "attester" }]) {
    await assert.rejects(
      () => resolve("keychain", opts),
      (err) => {
        assert.doesNotMatch(err.message, /keygen/i, `${JSON.stringify(opts)}: ${err.message}`);
        assert.doesNotMatch(err.message, /join <invite/i, `${JSON.stringify(opts)}: ${err.message}`);
        return true;
      },
    );
  }
});

test("a missing NODE key still says the slot is not for your own Buzz key", async () => {
  // The one line of the old block worth keeping. It is not a remedy, it is the
  // AC-43 warning: a node holding a human's secret cannot be revoked without
  // revoking the human, and this slot is where somebody would put one.
  const resolve = makeKeyResolver({
    store: new CredentialStore({ keychain: fakeKeychain() }),
    nodePubkey: NODE_PUBKEY,
  });
  await assert.rejects(
    () => resolve("keychain", { role: "node" }),
    (err) => {
      assert.match(err.message, /never your own Buzz key/i);
      return true;
    },
  );
});

// AC-72: the resolver cannot answer "the node key" without being told which
// hive, and must not try. A machine-wide answer is what let a second hive
// inherit the first one's identity.
test("an unbound resolver refuses a node key rather than guessing which hive", async () => {
  const resolve = makeKeyResolver({ store: await populatedStore() });
  await assert.rejects(() => resolve("keychain", { role: "node" }), /which hive|name the node/i);
  // An AGENT key is still answerable: agents were always keyed by name.
  assert.equal(await resolve("keychain", { agent: "blitz" }), AGENT_KEY);
});

// The regression guard for the actual defect. A store that does not implement
// the read method must fail LOUDLY. Optional-calling a missing method is what
// made a structural bug wear the costume of an empty keychain for two cycles.
test("a store missing the read method throws, rather than reporting an empty keychain", async () => {
  const resolve = makeKeyResolver({ store: {} });
  await assert.rejects(
    () => resolve("keychain", { agent: "blitz" }),
    (err) => {
      assert.equal(err.constructor.name, "TypeError", `expected a TypeError, got ${err.constructor.name}`);
      assert.doesNotMatch(
        err.message,
        /no key for/i,
        "a missing method must never be reported as an empty credential store",
      );
      return true;
    },
  );
});

test("a corrupted keychain entry is refused rather than passed to the relay", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setAgentPrivateKey("blitz", "not-a-key");
  const resolve = await resolverFor(store);
  await assert.rejects(() => resolve("keychain", { agent: "blitz" }), /64-char hex/i);
});

test("env: references still work and are still validated", async () => {
  const resolve = await resolverFor();
  process.env.HIVE402_TEST_KEYRESOLVER = AGENT_KEY;
  try {
    assert.equal(await resolve("env:HIVE402_TEST_KEYRESOLVER", { agent: "blitz" }), AGENT_KEY);
    await assert.rejects(() => resolve("env:HIVE402_TEST_MISSING_VAR", {}), /is not set/);

    process.env.HIVE402_TEST_KEYRESOLVER = "nope";
    await assert.rejects(() => resolve("env:HIVE402_TEST_KEYRESOLVER", {}), /64-char hex/);
  } finally {
    delete process.env.HIVE402_TEST_KEYRESOLVER;
  }
});

test("an unsupported reference is refused", async () => {
  const resolve = await resolverFor();
  await assert.rejects(() => resolve("s3://bucket/key", {}), /must be "keychain" or "env:VAR_NAME"/);
  // And it is refused WITHOUT echoing the reference (DD-31, the F-016 class):
  // `register --sponsor <keyref>` reaches this exact throw, its help text says
  // "key", and it used to print a pasted key straight back out.
  await assert.rejects(
    () => resolve("s3://bucket/key", {}),
    (err) => !err.message.includes("s3://bucket/key") && /15-character value/.test(err.message),
  );
});

// --- F-022 (fix cycle 13), DD-40: the env: path takes an nsec too -----------
//
// A dev relay or a CI box is exactly where an owner exports the key Buzz gave
// them, and that key is written `nsec1…`. Fixing only `keys import` would move
// the wall rather than remove it.

test("an env: reference holding an nsec resolves to the hex key (F-022)", async () => {
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const resolve = await resolverFor();
  process.env.HIVE402_TEST_NSEC = hexToBech32("nsec", AGENT_KEY);
  try {
    assert.equal(await resolve("env:HIVE402_TEST_NSEC", { agent: "blitz" }), AGENT_KEY);
  } finally {
    delete process.env.HIVE402_TEST_NSEC;
  }
});

test("an env: reference holding an UPPERCASE nsec resolves too (F-022)", async () => {
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const resolve = await resolverFor();
  process.env.HIVE402_TEST_NSEC = hexToBech32("nsec", AGENT_KEY).toUpperCase();
  try {
    assert.equal(await resolve("env:HIVE402_TEST_NSEC", {}), AGENT_KEY);
  } finally {
    delete process.env.HIVE402_TEST_NSEC;
  }
});

test("an env: reference holding a CORRUPTED nsec is refused, value-free (F-022)", async () => {
  const { corrupt, hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const resolve = await resolverFor();
  const broken = corrupt(hexToBech32("nsec", AGENT_KEY));
  process.env.HIVE402_TEST_NSEC = broken;
  try {
    const err = await resolve("env:HIVE402_TEST_NSEC", {}).then(
      () => null,
      (failure) => failure,
    );
    assert.ok(err, "a corrupted key must not be handed to the relay");
    // The REFERENCE may be named — `ENV_VAR_NAME` bounds it to 48 characters
    // precisely so a key cannot fit in one (DD-31) — but the VALUE may not.
    assert.match(err.message, /HIVE402_TEST_NSEC/, "naming the variable is the whole diagnostic");
    assert.ok(!err.message.includes(broken), "the env var's value must never be echoed");
    assert.ok(!err.message.includes(AGENT_KEY), "nor the key behind it");
  } finally {
    delete process.env.HIVE402_TEST_NSEC;
  }
});

test("an npub in an env: private-key reference is refused as a PUBLIC key (F-022)", async () => {
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const resolve = await resolverFor();
  process.env.HIVE402_TEST_NSEC = hexToBech32("npub", AGENT_KEY);
  try {
    await assert.rejects(() => resolve("env:HIVE402_TEST_NSEC", {}), /public/i);
  } finally {
    delete process.env.HIVE402_TEST_NSEC;
  }
});

// A key REFERENCE names where a key lives; it is never the key. That is
// unchanged — but the advice now points somewhere that works, because
// `keys import` takes the nsec the owner is holding.
test("a pasted nsec in --sponsor is refused with advice that now works (F-022)", async () => {
  const { hexToBech32 } = await import("../fixtures/bech32-encode.mjs");
  const resolve = await resolverFor();
  const pasted = hexToBech32("nsec", AGENT_KEY);

  const err = await resolve(pasted, { role: "sponsor" }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(err);
  assert.match(err.message, /keys import/, "tell them the command that stores it");
  assert.match(err.message, /KEY, not a reference|private KEY/i);
  assert.ok(!err.message.includes(pasted), "and never echo it (DD-31, F-016)");
});

test("a pasted HEX key in --sponsor gets the same advice (F-022)", async () => {
  const resolve = await resolverFor();
  const err = await resolve(AGENT_KEY, { role: "sponsor" }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(err);
  assert.match(err.message, /keys import/);
  assert.ok(!err.message.includes(AGENT_KEY));
});

