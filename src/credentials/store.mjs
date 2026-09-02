import { osKeychain } from "./keychain.mjs";
import { assertIdentityName } from "./names.mjs";

// CredentialStore — the ONLY place hive402 keeps an owner's secrets.
//
// Spec AC-32 / repo AGENTS.md: an owner's model credentials live in the
// operating system's native credential store on the owner's own device —
// the same protection class as their Buzz app credentials. Never a plaintext
// file, never Kychee infrastructure, never the network.
//
// The keychain backend is injected so the contract is testable; production
// uses the platform credential manager.
//
// Three namespaces, deliberately distinct (DD-28):
//
//   model-credential   an agent's model API credential
//   agent-private-key  an agent's own Nostr identity, one per agent name
//   node-private-key   a NODE's own Nostr identity — the one it joined the
//                      community with, and the one that sponsors and attests
//                      the agents it hosts. Keyed by that node's own PUBKEY
//                      (AC-72), because one machine may run several hives.
//                      Keeping it out of the agent namespace is what stops an
//                      agent named `node` from sharing a drawer with one.
//
// That third line used to read "the OWNER's Nostr identity — the one the node
// runs as", and the account label under it was literally `owner`. It was true
// while a node had no identity of its own: one key was the node, the sponsor
// and the attesting owner at once, so `register --owner-key keychain` signed as
// whichever of the three you happened to mean. FIX-115 gave the node its own
// key and the three came apart, so the label now says which one this is
// (FIX-117, DD-51).
//
// There is deliberately NO export/reveal method. Two reasons: an owner who can
// print a key back out will, into a terminal that keeps scrollback; and the
// AC-32 shape tests assert this class exposes nothing matching
// /file|path|disk|export|upload|fetch|post|sync|network/i, which is the
// mechanical guard on exactly that. Losing an agent key means `keygen --force`
// and re-registering, which is cheap.
const SERVICE_MODEL = "hive402:model-credential";
const SERVICE_AGENT_KEY = "hive402:agent-private-key";
const SERVICE_NODE_KEY = "hive402:node-private-key";

// A node's slot is keyed by that node's own PUBLIC KEY (AC-72, DD-61).
//
// It used to be the constant `"node"` — one slot per machine — which is the
// entire reason a second hive could not exist here. Nobody decided that: the
// agent path three functions below has always taken a per-identity account,
// and the node path was written when there was only ever one node.
//
// The pubkey is the label because it is already in every config, already
// unique, already what the community knows the node by, and known at the
// moment the key is minted. A name would be a second thing to keep in sync; a
// config-path hash breaks when a config moves.
//
// The old `"node"` and legacy `"owner"` labels are DELETED rather than read as
// a fallback. That is deliberate and it is the safe direction: a fallback is
// exactly what would let a second hive silently inherit the first hive's
// identity, which is the defect. There is one install in the world and it is
// re-joined (Barry, 2026-08-30).
function nodeAccount(nodePubkey) {
  const pubkey = String(nodePubkey ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error(
      "which node? a node key is stored under that node's own pubkey (64-char hex). " +
        "Pass the pubkey from that node's config — there is no machine-wide node identity.",
    );
  }
  return pubkey;
}

export class CredentialStore {
  #keychain;

  constructor({ keychain = osKeychain() } = {}) {
    this.#keychain = keychain;
  }

  // `schema.mjs` decides agent-name uniqueness on `name.toLowerCase()`, so the
  // store has to agree. Otherwise `keygen --agent Blitz` writes a key that a
  // config saying `"name": "blitz"` can never find, and the owner sees "no key
  // for blitz" while looking straight at the key they just made.
  //
  // The store is the security boundary, so the name rule is enforced HERE for
  // every caller, not only in the commands (DD-30): a name the OS cannot turn
  // into a file is what produced F-014.
  #account(agentName) {
    return assertIdentityName(agentName).toLowerCase();
  }

  // A blank secret is not a secret. Storing one makes a later `null` ambiguous
  // between "never set" and "set to nothing", and the second reads as a
  // baffling failure several commands downstream.
  #secret(value, what) {
    const secret = String(value ?? "");
    if (secret.trim() === "") throw new Error(`${what} is empty — nothing to store`);
    return secret;
  }

  async setModelCredential(agentName, secret) {
    await this.#keychain.set(SERVICE_MODEL, this.#account(agentName), this.#secret(secret, "model credential"));
  }

  async getModelCredential(agentName) {
    return this.#keychain.get(SERVICE_MODEL, this.#account(agentName));
  }

  async removeModelCredential(agentName) {
    return this.#keychain.remove(SERVICE_MODEL, this.#account(agentName));
  }

  async setAgentPrivateKey(agentName, privateKeyHex) {
    await this.#keychain.set(
      SERVICE_AGENT_KEY,
      this.#account(agentName),
      this.#secret(privateKeyHex, "private key"),
    );
  }

  // Create-if-absent, atomically (DD-32, F-017). `keygen` used to read, see
  // nothing, and write — so two concurrent calls for one name both reported
  // success with different pubkeys while only one key survived, silently
  // orphaning an identity whose pubkey the operator had already been shown.
  //
  // There is deliberately no `?.` and no fallback to `set`: a backend that
  // cannot express "already exists" must fail loudly rather than quietly
  // reopen the race. Optional-calling a method that does not exist is exactly
  // how `getAgentPrivateKeySync?.()` hid a structural bug for two cycles
  // (DD-28).
  async createAgentPrivateKey(agentName, privateKeyHex) {
    await this.#keychain.create(
      SERVICE_AGENT_KEY,
      this.#account(agentName),
      this.#secret(privateKeyHex, "private key"),
    );
  }

  async getAgentPrivateKey(agentName) {
    return this.#keychain.get(SERVICE_AGENT_KEY, this.#account(agentName));
  }

  async removeAgentPrivateKey(agentName) {
    return this.#keychain.remove(SERVICE_AGENT_KEY, this.#account(agentName));
  }

  // The NODE's own identity — the key it joined the community with, and the
  // one that sponsors and attests the agents it hosts (AC-47). Since FIX-115
  // this is not any human's key, and no human's key is ever stored here.
  async setNodePrivateKey(nodePubkey, privateKeyHex) {
    await this.#keychain.set(
      SERVICE_NODE_KEY,
      nodeAccount(nodePubkey),
      this.#secret(privateKeyHex, "private key"),
    );
  }

  async createNodePrivateKey(nodePubkey, privateKeyHex) {
    // Create is atomic on the store, so a race loses rather than overwriting
    // (DD-32, F-017). Scoped to THIS node now: a second setup for the same
    // identity still loses, while a different node is simply a different
    // identity and must succeed — that call used to throw "this node already
    // has a key", which is what made one hive per machine.
    await this.#keychain.create(
      SERVICE_NODE_KEY,
      nodeAccount(nodePubkey),
      this.#secret(privateKeyHex, "private key"),
    );
  }

  async getNodePrivateKey(nodePubkey) {
    return this.#keychain.get(SERVICE_NODE_KEY, nodeAccount(nodePubkey));
  }

  async removeNodePrivateKey(nodePubkey) {
    return this.#keychain.remove(SERVICE_NODE_KEY, nodeAccount(nodePubkey));
  }

  // One-shot migration off the machine-wide slot (AC-72).
  //
  // Before 0.9.0 a machine held ONE node key, under the fixed label "node"
  // (and before FIX-117, "owner"). Those labels are gone from the READ PATH on
  // purpose: a fallback there is exactly what would let a second hive inherit
  // the first one's identity. This is not that. It reads the old slot ONCE so
  // `keys migrate-node` can move the key under the identity it belongs to,
  // sparing a live hive a re-join it does not need.
  //
  // Named for what it is, so nothing mistakes it for a resolution path.
  async readPre09NodeKey() {
    for (const account of ["node", "owner"]) {
      const found = await this.#keychain.get(SERVICE_NODE_KEY, account);
      if (found) return { secret: found, account };
    }
    return null;
  }

  async removePre09NodeKey() {
    let removed = false;
    for (const account of ["node", "owner"]) {
      if (await this.#keychain.remove(SERVICE_NODE_KEY, account)) removed = true;
    }
    return removed;
  }
}
