// AC-72 (DD-61): several hive402 nodes on one machine.
//
// Barry, 2026-08-30: "why can I run buzz desktop and hive and not two hives?"
// There was no reason. Everything about a node has always been per-config —
// state dir, pid file, audit log, relay, rooms, agents — except the credential
// store's node slot, which was a fixed label `"node"` written when there was
// only ever one. The same store has ALWAYS keyed agent credentials per agent
// (`#account(agentName)`); the node just never used that capability.
//
// So the node's key is keyed by the node's own pubkey. No backward
// compatibility is kept: the fixed `"node"` and legacy `"owner"` labels are
// deleted, not chained, because there is exactly one install in the world and
// it gets re-joined (Barry's decision).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CredentialStore } from "../src/credentials/store.mjs";

const NODE_A = "305e6147aa4a66b09bd27d2fbb560824769ea4115369c4d9be2e76095a605359";
const NODE_B = "18a077bf849bae4d2e97dcd00f1999ada9599918164c0a8a2ac9f9b077446f9f";
const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

function fakeKeychain() {
  const vault = new Map();
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

// ── Two hives coexist ──────────────────────────────────────────────────────

test("AC-72: two nodes' identities coexist, and neither read returns the other's", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setNodePrivateKey(NODE_A, KEY_A);
  await store.setNodePrivateKey(NODE_B, KEY_B);

  assert.equal(await store.getNodePrivateKey(NODE_A), KEY_A);
  assert.equal(await store.getNodePrivateKey(NODE_B), KEY_B);
});

test("AC-72: a node with no stored key reads null — never somebody else's", async () => {
  // Fail closed. The old single slot meant an unknown node silently got
  // whichever identity happened to be on the machine, which on this box was a
  // live hive.
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setNodePrivateKey(NODE_A, KEY_A);
  assert.equal(await store.getNodePrivateKey(NODE_B), null);
});

test("AC-72: removing one node's key leaves the other's alone", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.setNodePrivateKey(NODE_A, KEY_A);
  await store.setNodePrivateKey(NODE_B, KEY_B);

  assert.equal(await store.removeNodePrivateKey(NODE_A), true);
  assert.equal(await store.getNodePrivateKey(NODE_A), null);
  assert.equal(await store.getNodePrivateKey(NODE_B), KEY_B, "B is untouched");
});

// ── The atomicity that F-017 bought stays per node ─────────────────────────

test("AC-72: create is still exclusive per node, and no longer machine-wide", async () => {
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await store.createNodePrivateKey(NODE_A, KEY_A);

  // DD-32/F-017: a raced second setup for the SAME node loses rather than
  // overwriting the identity the winner already joined with.
  await assert.rejects(() => store.createNodePrivateKey(NODE_A, KEY_B), /already/i);
  assert.equal(await store.getNodePrivateKey(NODE_A), KEY_A);

  // But a DIFFERENT node is a different identity and must simply work — this
  // is the exact call that used to throw "this node already has a key".
  await store.createNodePrivateKey(NODE_B, KEY_B);
  assert.equal(await store.getNodePrivateKey(NODE_B), KEY_B);
});

// ── The old machine-wide labels are gone, not chained ──────────────────────

test("AC-72: the fixed node/owner labels are not read or written any more", async () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  await store.setNodePrivateKey(NODE_A, KEY_A);

  const accounts = [...keychain.vault.keys()];
  assert.equal(accounts.length, 1);
  assert.ok(accounts[0].endsWith(NODE_A.toLowerCase()), `keyed by pubkey, got ${accounts[0]}`);

  // A key sitting under the old machine-wide label is NOT adopted: no
  // backward compatibility, by decision. Adopting it is what would let a
  // second hive silently inherit the first hive's identity.
  keychain.vault.set("hive402:node-private-key:node", "cc".repeat(32));
  keychain.vault.set("hive402:node-private-key:owner", "dd".repeat(32));
  assert.equal(await store.getNodePrivateKey(NODE_B), null);
});

// ── Asking for the wrong thing fails loudly ───────────────────────────────

test("AC-72: a node key call with no node named is refused, not defaulted", async () => {
  // The whole defect in one assertion: with a machine-wide slot, "which node?"
  // had no answer and the store picked one. It must now be impossible to ask
  // without saying.
  const store = new CredentialStore({ keychain: fakeKeychain() });
  await assert.rejects(() => store.getNodePrivateKey(), /node/i);
  await assert.rejects(() => store.setNodePrivateKey(undefined, KEY_A), /node/i);
});
