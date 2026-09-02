// The key-management commands: `hive402 keygen` and `hive402 keys`.
//
// Fix cycle 7. Before this module existed, `privateKeyRef` defaulted to
// `"keychain"`, `CredentialStore.setAgentPrivateKey` had no caller anywhere,
// and the onboarding doc handed agents a raw `node -e` one-liner over
// @noble/curves. So the default config path was a guaranteed failure and the
// documented path was hand-rolled crypto. This is the caller that was missing
// (DD-28) — and `test/reachability.test.mjs` fails if `bin/cli.mjs` ever stops
// reaching it, because a module with no caller is this project's most-repeated
// bug.
//
// Everything here takes its side effects by injection — the store, the output
// sink, the secret source, the randomness — so the decisions are testable
// without a keychain, a terminal or a person.

import { schnorr } from "@noble/curves/secp256k1.js";

import { assertIdentityName } from "./names.mjs";
import { explainKeyRefusal, normalizePrivateKey } from "./keyforms.mjs";
import { describeRefusedValue } from "./refusal.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;

// Bytes in, bytes out. `schnorr.getPublicKey` takes a Uint8Array of 32 bytes
// and rejects a hex string outright in this version — which is a mercy: the
// hand-rolled one-liner in the old onboarding doc worked only because whoever
// wrote it happened to pass bytes.
export function derivePubkey(privateKeyHex) {
  const bytes = Uint8Array.from(Buffer.from(privateKeyHex, "hex"));
  return Buffer.from(schnorr.getPublicKey(bytes)).toString("hex");
}

export function generateSecretKey() {
  return Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
}

// A target names WHICH identity: one agent by name, or this node's own.
// Validating here is what makes `keygen` refuse BEFORE it generates anything:
// every command calls `describe` first, so a name that the credential store
// could never write never has a key to leak (DD-30, F-014).
//
// It said "the owner identity (this node)" until FIX-152, which `report()`
// then contradicted two lines further down with "this is the NODE's identity,
// not yours". One sentence left over from before FIX-117 gave the node a key
// of its own; the node is not the owner and never was.
function describe(target) {
  if (target?.kind === "node") return "this node's own identity";
  if (target?.kind === "agent") return `agent "${assertIdentityName(target.name)}"`;
  throw new Error("no identity named — pass --agent <name> or --node");
}

// A node target carries the pubkey of the node it means (AC-72, DD-61): this
// machine may run several hives, so "the node key" names nothing on its own.
// For a key being minted or imported the pubkey is DERIVED FROM THE SECRET, so
// a key always lands under its own identity; for reads and removes the caller
// supplies it from that hive's config.
const nodeKeyOf = (target) => {
  if (target.pubkey) return target.pubkey;
  throw new Error(
    "which hive? this machine can run several, so a node key is stored under that node's own " +
      "pubkey. Pass --config <that hive's config> so the command knows which one you mean.",
  );
};

const read = (store, target) =>
  target.kind === "node" ? store.getNodePrivateKey(nodeKeyOf(target)) : store.getAgentPrivateKey(target.name);

const write = (store, target, secret) =>
  target.kind === "node"
    ? store.setNodePrivateKey(derivePubkey(secret), secret)
    : store.setAgentPrivateKey(target.name, secret);

// Create-if-absent, atomic on the store, so the loser of a race is refused
// rather than told it succeeded (DD-32, F-017).
const writeNew = (store, target, secret) =>
  target.kind === "node"
    ? store.createNodePrivateKey(derivePubkey(secret), secret)
    : store.createAgentPrivateKey(target.name, secret);

const clear = (store, target) =>
  target.kind === "node" ? store.removeNodePrivateKey(nodeKeyOf(target)) : store.removeAgentPrivateKey(target.name);

// Replacing an identity is not an edit, it is a new identity. The old key
// cannot be recovered (there is no export, by design), the `pubkey` in the
// config now belongs to a key nobody holds, and the room still has the OLD
// pubkey registered under this name. Saying all three is the difference between
// a deliberate act and a lost afternoon.
function warnReplacement(log, target) {
  log(`  ! replaced the existing key for ${describe(target)}.`);
  log(`    The previous identity is unrecoverable — hive402 never kept a copy.`);
  log(`    Update "pubkey" in your config to the value above, then re-register:`);
  log(
    target.kind === "node"
      ? `      (the node's pubkey is node.pubkey)`
      : `      hive402 register --agent ${target.name}`,
  );
}

// ONE message, reached two ways: by the pre-check below, and by losing the race
// to another process between that check and the write. A caller must not be
// able to tell which happened, because the situation is identical — this
// identity already has a key and replacing it is a deliberate act.
//
// ── The way OUT, not only the way THROUGH (FIX-182, F-037) ────────────────
//
// `--force` was the only remedy named here, and it answers one of the two
// situations that reach this message. The other is a key that should not exist
// at all: anyone who hit F-037 on 0.3.4 holds an orphaned
// `hive402_agent-private-key--<name>` for a name they were told was free and
// never got to register. On 0.3.5 their next `keygen` hits this guard BEFORE
// the name check, and `--force` now correctly refuses at that check — so the
// only remedy on offer led straight back to here, with the stray key still
// there and nothing pointing at the command that clears it.
//
// `keys remove` already exists and is already in `keys --help`. It was only
// unreachable from the message that sends people looking.
function alreadyHasKey(target) {
  const remove = target?.kind === "node" ? "hive402 keys remove --node" : `hive402 keys remove --agent ${target?.name}`;
  return new Error(
    `${describe(target)} already has a key in the OS credential store.\n` +
      `  Pass --force to replace it. The current key cannot be exported first, so\n` +
      `  replacing it retires that identity permanently.\n` +
      `  If that key should not exist — it was never registered, or the name turned\n` +
      `  out to be taken — clear it instead and start over:\n` +
      `    ${remove}`,
  );
}

async function guardExisting({ store, target, force, log }) {
  // Minting or importing a NODE identity has nothing to collide with unless a
  // hive was named (AC-72): the key lands under its own pubkey, and a pubkey
  // that does not exist yet cannot already hold a key. Under the old
  // machine-wide slot this check is what refused a second hive outright.
  if (target.kind === "node" && !target.pubkey) return false;
  const existing = await read(store, target);
  if (!existing) return false;
  if (!force) throw alreadyHasKey(target);
  return true;
}

function report({ log, target, pubkey, replaced, source }) {
  log(`hive402: ${source} a key for ${describe(target)}`);
  log(`  pubkey:  ${pubkey}`);
  log(`  stored:  OS credential store (never a file, never the network)`);
  if (replaced) warnReplacement(log, target);
  log("");
  log(`Next:`);
  if (target.kind === "node") {
    log(`  put this pubkey in your config as node.pubkey`);
    log(`  this is the NODE's identity, not yours — it is what sponsors and attests`);
  } else {
    log(`  put this pubkey in your config as the "pubkey" of agent "${target.name}"`);
    log(`  leave privateKeyRef unset (it defaults to "keychain") and register:`);
    log(`    hive402 register --agent ${target.name}`);
  }
}

// Generate a brand-new identity and store the secret. The secret is never
// printed, never returned, and never written anywhere but the credential store.
// `nameCheck` is AC-56: an async function that answers "is this name already
// taken?" and is run BEFORE anything is generated. Injected rather than built
// here because this module is deliberately offline — it holds no relay, no
// config and no network — and because the answer is useless if it arrives after
// the identity exists. A caller with no relay to ask passes nothing, and the
// command says it could not check rather than implying it did.
export async function keygen({
  store,
  target,
  force = false,
  log = console.log,
  generate = generateSecretKey,
  nameCheck = null,
}) {
  describe(target); // validates the target before anything is generated
  const replaced = await guardExisting({ store, target, force, log });

  if (nameCheck && target.kind === "agent") {
    const { error, warnings } = await nameCheck(target.name);
    for (const warning of warnings ?? []) log(`  ! ${warning}`);
    if (error) {
      // Before the key. That is the whole point of AC-56: a clash reported
      // after `keygen` is a clash reported about an identity that already
      // exists in the OS credential store and has to be cleaned up by hand.
      throw new Error(
        `${error}\n` +
          `  No key was generated. Pick another name, or resolve the clash first.`,
      );
    }
  }

  const secret = generate();
  if (!HEX64.test(secret)) throw new Error("key generation produced something that is not a 64-char hex key");
  const pubkey = derivePubkey(secret);

  // Without `--force` the write is an exclusive create, so the second of two
  // concurrent callers is refused instead of overwriting (F-017, DD-32). The
  // pre-check above still runs: it gives the sequential case its refusal
  // without spending a keygen, and this is the backstop for when it was raced.
  //
  // With `--force` the write stays a plain replace. `--force` MEANS "replace
  // it", and two concurrent replacements are a coin toss by definition.
  if (replaced) {
    await write(store, target, secret);
  } else {
    try {
      await writeNew(store, target, secret);
    } catch (failure) {
      if (failure?.exists) throw alreadyHasKey(target);
      throw failure;
    }
  }

  if (target.kind === "node") {
    log(`hive402: NOTE — this is a NEW identity, not your existing Buzz account.`);
    log(`  If your human already uses Buzz, stop and import that key instead:`);
    log(`    hive402 keys import --node`);
    log("");
  }
  report({ log, target, pubkey, replaced, source: "generated" });

  return { pubkey, replaced };
}

// Store a key the owner already has — normally their Buzz identity.
//
// `readSecret` is a callback rather than a parameter on purpose: a key passed
// as a command-line argument lands in shell history, in the process table, and
// in any terminal recording. The CLI supplies a prompt with echo off; a test
// supplies a function. There is deliberately no flag that takes the value.
//
// Accepts `nsec1…` as well as hex (F-022, DD-40). They are the same key written
// differently, and the nsec is the only form Buzz ever shows a user.
export async function importPrivateKey({ store, target, force = false, log = console.log, readSecret }) {
  describe(target);
  const replaced = await guardExisting({ store, target, force, log });

  const typed = String((await readSecret()) ?? "");

  // BOTH written forms of the key, normalised to the hex the store holds
  // (F-022, DD-40). This used to detect `nsec1…` and refuse it with "decode it
  // first" — advice with no in-product answer, since there is deliberately no
  // command here that prints or converts a key. Buzz Desktop's own backup
  // screen shows the owner an nsec and nothing else, so the one string hive402
  // was guaranteed to be handed was the one string it would not take.
  const given = normalizePrivateKey(typed);
  if (!given.ok) {
    // Kind and length, and nothing else — including nothing DECODED, which is
    // the new way this could leak (DD-31, F-016). Taking the description into a
    // local FIRST is not cosmetic: `src/credentials` is under a structural rule
    // that no secret-bearing identifier may appear inside a string
    // interpolation (DD-30), and a rule with an exception carved into it is a
    // rule that erodes.
    const described = describeRefusedValue(typed.trim());
    throw new Error(explainKeyRefusal({ reason: given.reason, described }));
  }
  const secret = given.hex;

  const pubkey = derivePubkey(secret);
  // Same rule as `keygen` (DD-32): without `--force` this is an exclusive
  // create, so a raced import cannot silently replace a key that arrived
  // between the pre-check and the write. Import is the lower-stakes half of the
  // pair — the operator still holds the key they typed — but the refusal has to
  // be the same one, or the two commands disagree about what `--force` means.
  if (replaced) {
    await write(store, target, secret);
  } else {
    try {
      await writeNew(store, target, secret);
    } catch (failure) {
      if (failure?.exists) throw alreadyHasKey(target);
      throw failure;
    }
  }
  report({ log, target, pubkey, replaced, source: "imported" });

  return { pubkey, replaced };
}

// What the store holds, as presence only. A listing that could print a key
// would be an export in all but name.
//
// An `env:` reference is not a keychain question, so it is reported as its own
// state rather than as "missing" — calling a working dev setup broken is how a
// diagnostic loses the operator's trust.
export async function listKeys({ store, config }) {
  const rows = [];
  const entry = async (label, ref, target) => {
    const usesKeychain = !ref || ref === "keychain";
    rows.push({
      label,
      ref: ref ?? "keychain",
      present: usesKeychain ? Boolean(await read(store, target)) : null,
    });
  };

  await entry("node (this hive's identity)", config?.node?.privateKeyRef, {
    kind: "node",
    pubkey: config?.node?.pubkey ?? null,
  });
  for (const room of config?.rooms ?? []) {
    for (const agent of room.agents ?? []) {
      await entry(`agent "${agent.name}"`, agent.privateKeyRef, { kind: "agent", name: agent.name });
    }
  }
  return rows;
}

// Move a pre-0.9.0 node key under the identity it belongs to (AC-72).
//
// The read path has no fallback to the old machine-wide label, and must not:
// a fallback is precisely what would let a second hive inherit the first one's
// identity. But an install that already exists should not have to be re-joined,
// re-registered and re-named to survive an internal change, so this moves the
// key it already has.
//
// The one real risk in any migration is putting a key under the WRONG identity
// — a hive that then signs as somebody it is not, silently. The stored key
// proves which pubkey it is, so that is checked rather than assumed, and a
// mismatch refuses without writing anything.
//
// The key is never printed, never returned, and never leaves this process.
export async function migrateNodeKey({ store, nodePubkey, log = console.log }) {
  if (!nodePubkey) {
    throw new Error(
      "which hive? pass --config <that hive's config> so the key is migrated under the " +
        "identity that config names.",
    );
  }

  const already = await store.getNodePrivateKey(nodePubkey);
  if (already) {
    log(`hive402: hive ${nodePubkey.slice(0, 12)}… is already migrated — nothing to do.`);
    return { migrated: false, reason: "already migrated", pubkey: nodePubkey };
  }

  const found = await store.readPre09NodeKey();
  if (!found) {
    log(`hive402: nothing to migrate — no pre-0.9.0 node key is in the OS credential store.`);
    return { migrated: false, reason: "nothing to migrate" };
  }

  const actual = derivePubkey(found.secret);
  if (actual.toLowerCase() !== String(nodePubkey).toLowerCase()) {
    // No value in the message, and none decoded from it (DD-31): the pubkeys
    // are public, and they are the whole of what the operator needs.
    throw new Error(
      `the key in the old slot is a different identity: it is ${actual.slice(0, 12)}…, and this ` +
        `config names ${String(nodePubkey).slice(0, 12)}…. Nothing was written. Point --config at ` +
        `the hive that key belongs to, or leave it and set that hive up fresh.`,
    );
  }

  await store.setNodePrivateKey(actual, found.secret);
  const readBack = await store.getNodePrivateKey(actual);
  if (!readBack) {
    throw new Error("the key was written but could not be read back — the old slot is untouched");
  }

  // The old slot is cleared only after the new one reads back. A crash between
  // the two leaves the key in BOTH, which is recoverable; the reverse loses it.
  await store.removePre09NodeKey();

  log(`hive402: migrated hive ${actual.slice(0, 12)}… to its own credential slot.`);
  log(`  it keeps its identity, its membership, and every agent it has registered.`);
  return { migrated: true, pubkey: actual, from: found.account };
}

export async function removePrivateKey({ store, target }) {
  describe(target);
  return Boolean(await clear(store, target));
}
