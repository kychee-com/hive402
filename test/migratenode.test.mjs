// One-shot node-key migration (AC-72).
//
// Before 0.9.0 a machine held ONE node key, under the fixed label "node" (and
// before FIX-117, "owner"). Keying by pubkey is what lets several hives coexist
// — but it also means an existing install cannot find its own key, which looks
// exactly like a node that never joined.
//
// Barry's decision was "no backward compatibility, we can re-install my hive".
// The READ PATH honours that: nothing resolves a key through the old label any
// more. This is the other thing — a one-shot tool that moves the key it already
// has under the identity it belongs to, so a live hive does not have to be
// re-joined, re-registered and re-named to survive an internal change.
//
// It never prints the key, and it refuses rather than guessing which identity
// an unlabelled key belongs to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CredentialStore } from "../src/credentials/store.mjs";
import { migrateNodeKey } from "../src/credentials/keys.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const PK = derivePubkey(SK);
const OTHER_PK = "1".repeat(64);

function fakeKeychain(seed = {}) {
  const vault = new Map(Object.entries(seed));
  return {
    vault,
    async set(service, account, secret) {
      vault.set(`${service}:${account}`, secret);
    },
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

const withOldKey = (account = "node") =>
  fakeKeychain({ [`hive402:node-private-key:${account}`]: SK });

test("AC-72: the key moves under its own pubkey, and the hive keeps its identity", async () => {
  const kc = withOldKey();
  const store = new CredentialStore({ keychain: kc });

  const result = await migrateNodeKey({ store, nodePubkey: PK, log: () => {} });

  assert.equal(result.migrated, true);
  assert.equal(await store.getNodePrivateKey(PK), SK, "readable where every command now looks");
  assert.equal(result.pubkey, PK);
});

test("the pre-FIX-117 label is migrated too", async () => {
  const store = new CredentialStore({ keychain: withOldKey("owner") });
  const result = await migrateNodeKey({ store, nodePubkey: PK, log: () => {} });
  assert.equal(result.migrated, true);
  assert.equal(await store.getNodePrivateKey(PK), SK);
});

test("it REFUSES when the stored key is not the identity the config names", async () => {
  // The whole risk of a migration: moving a key under the wrong identity would
  // produce a hive that signs as somebody it is not, silently. The stored key
  // proves which pubkey it is — so it is checked, not assumed.
  const store = new CredentialStore({ keychain: withOldKey() });
  await assert.rejects(
    () => migrateNodeKey({ store, nodePubkey: OTHER_PK, log: () => {} }),
    (err) => {
      assert.match(err.message, /does not match|different identity/i);
      assert.ok(!err.message.includes(SK), "and the refusal never echoes the key");
      return true;
    },
  );
  assert.equal(await store.getNodePrivateKey(OTHER_PK), null, "nothing was written");
});

test("with nothing to migrate it says so, and writes nothing", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  const result = await migrateNodeKey({ store, nodePubkey: PK, log: () => {} });
  assert.equal(result.migrated, false);
  assert.match(result.reason, /nothing to migrate|no key/i);
});

test("running it twice is safe — the second run finds the hive already migrated", async () => {
  const store = new CredentialStore({ keychain: withOldKey() });
  await migrateNodeKey({ store, nodePubkey: PK, log: () => {} });
  const again = await migrateNodeKey({ store, nodePubkey: PK, log: () => {} });
  assert.equal(again.migrated, false);
  assert.match(again.reason, /already/i);
  assert.equal(await store.getNodePrivateKey(PK), SK, "and the key is still there");
});

test("nothing it prints contains the key", async () => {
  const lines = [];
  const store = new CredentialStore({ keychain: withOldKey() });
  await migrateNodeKey({ store, nodePubkey: PK, log: (l) => lines.push(String(l)) });
  const said = lines.join("\n");
  assert.ok(said.length > 0, "it does report what it did");
  assert.ok(!said.includes(SK), "but never the secret");
  assert.match(said, new RegExp(PK.slice(0, 12)), "naming the hive by its public half");
});
