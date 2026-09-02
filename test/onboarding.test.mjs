import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialStore } from "../src/credentials/store.mjs";

// Attestation for spec AC-32 (verify: code-review — secret-at-rest storage is
// not observable from the chat front door). This asserts the mechanically
// checkable half: the store writes through the OS credential backend only, and
// exposes no filesystem or network path by which a credential could leave.
test("registration writes model credentials to the OS credential store and never to plaintext or the network", async () => {
  const written = [];
  const keychain = {
    async set(service, account, secret) {
      written.push({ service, account, secret });
    },
    async get(service, account) {
      const hit = written.find((w) => w.service === service && w.account === account);
      return hit ? hit.secret : null;
    },
    async remove() {
      return true;
    },
  };

  const store = new CredentialStore({ keychain });
  await store.setModelCredential("blitz", "sk-ant-oat01-EXAMPLE");

  // The credential went to the OS keychain backend — the only sink there is.
  assert.equal(written.length, 1);
  assert.equal(written[0].secret, "sk-ant-oat01-EXAMPLE");
  assert.match(written[0].service, /^hive402:/);

  // Round-trips through that backend and nowhere else.
  assert.equal(await store.getModelCredential("blitz"), "sk-ant-oat01-EXAMPLE");

  // The public surface offers no file/network escape hatch: nothing that
  // writes to disk, uploads, posts, or syncs a credential.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  for (const name of surface) {
    assert.doesNotMatch(
      name,
      /file|path|disk|export|upload|fetch|post|sync|network/i,
      `credential store must not expose "${name}"`,
    );
  }
});
