import { test } from "node:test";
import assert from "node:assert/strict";

import {
  derivePubkey,
  generateSecretKey,
  keygen,
  importPrivateKey,
  listKeys,
  removePrivateKey,
} from "../src/credentials/keys.mjs";
import { CredentialStore } from "../src/credentials/store.mjs";
import { corrupt, hexToBech32 } from "../fixtures/bech32-encode.mjs";

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

// Captures everything the command would print, so a test can assert on what
// reached the operator's terminal — which for this feature is the whole point.
function recorder() {
  const lines = [];
  return { lines, log: (line = "") => lines.push(String(line)), text: () => lines.join("\n") };
}

const freshStore = () => {
  const keychain = fakeKeychain();
  const store = new CredentialStore({ keychain });
  // AC-72: node keys are stored under each node's own pubkey, so there is no
  // machine-wide one to read back. These fixtures hold a single hive; this
  // asks for whichever node identity the store ended up holding, which is
  // what every assertion below actually means.
  store.nodeKeyHeld = async () => {
    for (const [slot, secret] of keychain.vault) {
      if (slot.startsWith("hive402:node-private-key:")) return secret;
    }
    return null;
  };
  return store;
};
const AGENT = { kind: "agent", name: "blitz" };
const NODE = { kind: "node" };
// A node target that NAMES its hive — required for reads and removes since
// AC-72 (minting and importing derive the pubkey from the secret itself).
const nodeAt = (pubkey) => ({ kind: "node", pubkey });

test("generated keys are 64-char hex and different every time", () => {
  const a = generateSecretKey();
  const b = generateSecretKey();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("keygen stores the secret and returns the matching pubkey", async () => {
  const store = freshStore();
  const out = recorder();
  const result = await keygen({ store, target: AGENT, log: out.log });

  const stored = await store.getAgentPrivateKey("blitz");
  assert.match(stored, /^[0-9a-f]{64}$/);
  // The pubkey it reported must be the pubkey of the key it actually stored —
  // otherwise the operator puts a pubkey in the config that the stored key
  // cannot sign for, and the failure appears much later as a bad signature.
  assert.equal(result.pubkey, derivePubkey(stored));
});

// The single most important property of this command.
test("keygen never prints the secret key, only the pubkey", async () => {
  const store = freshStore();
  const out = recorder();
  const result = await keygen({ store, target: AGENT, log: out.log });
  const secret = await store.getAgentPrivateKey("blitz");

  assert.ok(out.text().includes(result.pubkey), "the pubkey must be printed — it goes in the config");
  assert.ok(!out.text().includes(secret), "the SECRET must never reach the terminal");
  // Nor may it come back in the return value, where a caller could print it.
  assert.ok(
    !JSON.stringify(result).includes(secret),
    "the secret must not ride out in the result object either",
  );
});

test("keygen refuses to overwrite an existing identity without --force", async () => {
  const store = freshStore();
  await keygen({ store, target: AGENT, log: () => {} });
  const original = await store.getAgentPrivateKey("blitz");

  await assert.rejects(() => keygen({ store, target: AGENT, log: () => {} }), /already has a key|--force/i);
  assert.equal(await store.getAgentPrivateKey("blitz"), original, "the existing key must survive a refusal");
});

test("keygen --force replaces the identity and says the old one is gone for good", async () => {
  const store = freshStore();
  await keygen({ store, target: AGENT, log: () => {} });
  const original = await store.getAgentPrivateKey("blitz");

  const out = recorder();
  const result = await keygen({ store, target: AGENT, force: true, log: out.log });
  assert.equal(result.replaced, true);
  assert.notEqual(await store.getAgentPrivateKey("blitz"), original);
  assert.match(out.text(), /unrecoverable|cannot be recovered|gone/i);
  // Replacing the identity invalidates the config's pubkey and the room
  // registration; silence there is how someone loses an afternoon.
  assert.match(out.text(), /pubkey/i);
  assert.match(out.text(), /re-?register/i);
});

test("keygen --node stores under the owner identity, not as an agent", async () => {
  const store = freshStore();
  const out = recorder();
  await keygen({ store, target: NODE, log: out.log });

  assert.match(await store.nodeKeyHeld(), /^[0-9a-f]{64}$/);
  assert.equal(await store.getAgentPrivateKey("node"), null);
  // Most owners already have a Nostr identity (their Buzz account). Generating
  // a fresh one is legitimate but is NOT that identity, and quietly letting
  // someone believe otherwise costs them a confusing failed registration.
  assert.match(out.text(), /Buzz/i);
  assert.match(out.text(), /keys import --node/);
});

test("import reads the key from the prompt and stores it", async () => {
  const store = freshStore();
  const secret = generateSecretKey();
  const out = recorder();

  const result = await importPrivateKey({
    store,
    target: AGENT,
    log: out.log,
    readSecret: async () => secret,
  });

  assert.equal(await store.getAgentPrivateKey("blitz"), secret);
  assert.equal(result.pubkey, derivePubkey(secret));
  assert.ok(!out.text().includes(secret), "an imported secret must not be echoed back either");
});

test("import tolerates the whitespace a paste brings with it", async () => {
  const store = freshStore();
  const secret = generateSecretKey();
  await importPrivateKey({
    store,
    target: NODE,
    log: () => {},
    readSecret: async () => `  ${secret.toUpperCase()}\r\n`,
  });
  assert.equal(await store.nodeKeyHeld(), secret, "trimmed and lowercased to the canonical form");
});

test("import refuses anything that is not a 64-char hex key", async () => {
  const store = freshStore();
  for (const bad of ["", "   ", "nope", "a".repeat(63), "a".repeat(65), "z".repeat(64)]) {
    await assert.rejects(
      () => importPrivateKey({ store, target: AGENT, log: () => {}, readSecret: async () => bad }),
      /64-char hex/i,
      `should have refused ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(await store.getAgentPrivateKey("blitz"), null, "nothing may be stored on a refusal");
});

// --- F-022 (fix cycle 13), DD-40: the nsec form is accepted -----------------
//
// This block replaces one test, "import recognises an nsec and says what it
// wants instead", which asserted the defect: that a bech32 nsec is refused with
// "decode it first". It was a faithful test of behaviour that turned out to be
// wrong, and it is deleted rather than adapted, because the behaviour it named
// no longer exists in any form.

const NSEC_VECTOR = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const NSEC_VECTOR_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NPUB_VECTOR = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";

test("import accepts the nsec Buzz gives the user, and stores the hex (F-022)", async () => {
  const store = freshStore();
  const out = recorder();
  const result = await importPrivateKey({
    store,
    target: NODE,
    log: out.log,
    readSecret: async () => NSEC_VECTOR,
  });

  assert.equal(await store.nodeKeyHeld(), NSEC_VECTOR_HEX, "stored in the canonical form");
  assert.equal(result.pubkey, derivePubkey(NSEC_VECTOR_HEX));
  assert.match(out.text(), /imported/);
  assert.ok(!out.text().includes(NSEC_VECTOR), "the nsec itself is never printed back");
  assert.ok(!out.text().includes(NSEC_VECTOR_HEX), "and neither is the hex behind it");
});

test("importing by nsec and by hex land the SAME bytes in the store (F-022)", async () => {
  // The property that matters: the two forms are one key. Asserted through the
  // store and through the derived pubkey, because "the same string came back"
  // would also be true of a decoder that did nothing.
  const generated = generateSecretKey();
  const written = hexToBech32("nsec", generated);

  const byHex = freshStore();
  const byNsec = freshStore();
  const viaHex = await importPrivateKey({
    store: byHex,
    target: AGENT,
    log: () => {},
    readSecret: async () => generated,
  });
  const viaNsec = await importPrivateKey({
    store: byNsec,
    target: AGENT,
    log: () => {},
    readSecret: async () => written,
  });

  assert.equal(await byNsec.getAgentPrivateKey("blitz"), await byHex.getAgentPrivateKey("blitz"));
  assert.equal(viaNsec.pubkey, viaHex.pubkey);
  assert.equal(viaNsec.pubkey, derivePubkey(generated), "and it is the pubkey of the real key");
});

test("import accepts an ALL-UPPERCASE nsec, which is legal bech32 (F-022)", async () => {
  const store = freshStore();
  await importPrivateKey({
    store,
    target: NODE,
    log: () => {},
    readSecret: async () => NSEC_VECTOR.toUpperCase(),
  });
  assert.equal(await store.nodeKeyHeld(), NSEC_VECTOR_HEX);
});

test("a one-character corruption of an nsec is refused, and nothing is stored (F-022)", async () => {
  const store = freshStore();
  const broken = corrupt(NSEC_VECTOR);
  const err = await importPrivateKey({
    store,
    target: NODE,
    log: () => {},
    readSecret: async () => broken,
  }).then(
    () => null,
    (failure) => failure,
  );

  assert.ok(err, "a corrupted key must not be stored");
  assert.match(err.message, /checksum/i, "say WHY, since the user will retype it");
  assert.ok(!err.message.includes(broken), "the refusal must not echo what was typed");
  assert.ok(!err.message.includes(NSEC_VECTOR_HEX), "nor anything decoded from it");
  assert.doesNotMatch(err.message, /\b[0-9a-f]{16,}\b/, "nor any run of key-shaped hex");
  assert.equal(await store.nodeKeyHeld(), null);
});

test("an npub at the private-key prompt is refused as a PUBLIC key (F-022)", async () => {
  // The likeliest dangerous-feeling mistake: two similar-looking strings, one
  // of which is safe to share and one of which is not.
  const store = freshStore();
  await assert.rejects(
    () =>
      importPrivateKey({ store, target: NODE, log: () => {}, readSecret: async () => NPUB_VECTOR }),
    /public/i,
  );
  assert.equal(await store.nodeKeyHeld(), null);
});

test("an ncryptsec encrypted backup is refused with somewhere to go (F-022)", async () => {
  const store = freshStore();
  await assert.rejects(
    () =>
      importPrivateKey({
        store,
        target: NODE,
        log: () => {},
        readSecret: async () => `ncryptsec1${"q".repeat(152)}`,
      }),
    /passphrase|encrypted/i,
  );
  assert.equal(await store.nodeKeyHeld(), null);
});

test("--force replaces an existing key with one given as an nsec (F-022)", async () => {
  // The replacement path is separate code (a plain write rather than an
  // exclusive create, DD-32), so the new form has to be proved through it too.
  // Driven on an AGENT: one identity, one slot, so a replacement is a genuine
  // overwrite. For a node it is not — see the test after next.
  const store = freshStore();
  const first = generateSecretKey();
  await importPrivateKey({ store, target: AGENT, log: () => {}, readSecret: async () => first });

  const second = generateSecretKey();
  const out = recorder();
  await importPrivateKey({
    store,
    target: AGENT,
    force: true,
    log: out.log,
    readSecret: async () => hexToBech32("nsec", second),
  });

  assert.equal(await store.getAgentPrivateKey("blitz"), second);
  assert.match(out.text(), /replaced the existing key/);
});

test("import refuses to overwrite without --force", async () => {
  const store = freshStore();
  const first = generateSecretKey();
  await importPrivateKey({ store, target: AGENT, log: () => {}, readSecret: async () => first });

  await assert.rejects(
    () => importPrivateKey({ store, target: AGENT, log: () => {}, readSecret: async () => generateSecretKey() }),
    /already|--force/i,
  );
  assert.equal(await store.getAgentPrivateKey("blitz"), first);
});

test("AC-72: importing a second node key is a second HIVE, not an overwrite", async () => {
  // The behaviour change stated outright. A node key is stored under its own
  // pubkey, so importing a different secret adds an identity rather than
  // replacing one — which is the whole point of running several hives here.
  // Retiring the old one is a deliberate act ("keys remove --node"), not a
  // side effect of importing another.
  const store = freshStore();
  const first = generateSecretKey();
  const second = generateSecretKey();
  await importPrivateKey({ store, target: NODE, log: () => {}, readSecret: async () => first });
  await importPrivateKey({ store, target: NODE, log: () => {}, readSecret: async () => second });

  assert.equal(await store.getNodePrivateKey(derivePubkey(first)), first);
  assert.equal(await store.getNodePrivateKey(derivePubkey(second)), second, "both hives are held");
});

test("list reports presence per identity and never a value", async () => {
  const store = freshStore();
  const secret = generateSecretKey();
  await importPrivateKey({ store, target: AGENT, log: () => {}, readSecret: async () => secret });

  const config = {
    node: { pubkey: "b".repeat(64), privateKeyRef: "keychain" },
    rooms: [
      {
        channel: "c",
        agents: [
          { name: "blitz", privateKeyRef: "keychain" },
          { name: "spike", privateKeyRef: "env:HIVE402_SPIKE_KEY" },
        ],
      },
    ],
  };

  const rows = await listKeys({ store, config });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));

  assert.equal(byLabel['agent "blitz"'].present, true);
  assert.equal(byLabel["node (this hive's identity)"].present, false);
  // An env: ref is not a keychain question at all; saying "missing" about it
  // would be a false alarm on a perfectly good dev setup.
  assert.equal(byLabel['agent "spike"'].ref, "env:HIVE402_SPIKE_KEY");
  assert.equal(byLabel['agent "spike"'].present, null);

  assert.ok(!JSON.stringify(rows).includes(secret), "a listing must never carry key material");
});

test("remove clears exactly the identity named", async () => {
  const store = freshStore();
  await keygen({ store, target: AGENT, log: () => {} });
  await keygen({ store, target: NODE, log: () => {} });

  assert.equal(await removePrivateKey({ store, target: AGENT }), true);
  assert.equal(await store.getAgentPrivateKey("blitz"), null);
  assert.match(await store.nodeKeyHeld(), /^[0-9a-f]{64}$/, "the owner identity is untouched");

  assert.equal(await removePrivateKey({ store, target: AGENT }), false, "removing nothing reports false");
});
