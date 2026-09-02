// `hive402 join` — the command, separated from `bin/cli.mjs` so it is testable
// and so AC-43 can be proved structurally over the WHOLE path rather than over
// the protocol module alone.
//
// The one interesting decision here is where the node's key comes from.
//
// AC-43: hive402 never asks a human for their Nostr secret key. AC-44: the node
// joins "with its own identity, with no human private key supplied at any
// point". So if this machine has no node identity yet, joining MINTS one — that
// is the first of the five steps AC-44 names (identity, join, name, agent,
// first channel), and stopping to say "run keygen first" would put a human
// key-handling step in the middle of the one flow that exists to remove it.
//
// It is announced, not silent: the pubkey is printed, and the operator is told
// it was created here and that hive402 kept no copy they can export.

import path from "node:path";

import { joinCommunity, parseInviteLink } from "./join.mjs";
import { JOIN_RECORD_FILE, readJoinRecord, rememberDisplayName } from "./joinrecord.mjs";
import { derivePubkey, generateSecretKey } from "../credentials/keys.mjs";

export async function runJoin({
  link,
  store,
  stateDir,
  // FIX-136 (hive402#4). WHICH identity, when the machine has more than one.
  //
  // `up` has always honoured `node.privateKeyRef`; this command did not, and
  // resolved the node identity from the credential store's default entry
  // whatever config it was pointed at. On a box that also runs a production
  // node, that entry IS the production identity — so standing up a throwaway
  // rig joined a throwaway community as the real node, spent a single-use
  // invite and left a registration behind (2026-08-30).
  //
  // A declared reference is now obeyed and the store is not consulted at all.
  // Not "preferred": consulting it is precisely what picked the wrong key, and
  // a fallback would put the same mistake one failure away. An unset reference
  // therefore fails loudly, which is the correct outcome — the alternative is
  // acting as somebody else.
  privateKeyRef = null,
  // WHICH hive (AC-72). The config's `node.pubkey` when there is a config;
  // absent for a brand-new one, which is the only case that mints.
  nodePubkey = null,
  resolveKey = null,
  consent,
  // AC-46's half of the flow: a node that has joined and has no name shows up
  // in the member list as 64 characters of hex. Asked here rather than in a
  // separate command, because this is the moment a person is looking at the
  // community they just joined. Both are injected so the join stays runnable
  // without a terminal or a relay.
  askName = null,
  publishProfile = null,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  log = console.log,
  generate = generateSecretKey,
}) {
  // Parse first. A typo in the link should not mint an identity.
  const { origin } = parseInviteLink(link);

  // A config that names an identity is an instruction, not a hint. "keychain"
  // is the schema's own default and means the store, so it takes the ordinary
  // path below; anything else is resolved and the store is never touched.
  const declared = privateKeyRef && privateKeyRef !== "keychain" ? privateKeyRef : null;
  if (declared) {
    const resolve = resolveKey ?? (await import("../node/runtime.mjs")).makeKeyResolver();
    const privateKeyHex = await resolve(declared, { role: "node" });
    return await joinAs({
      link,
      origin,
      privateKeyHex,
      stateDir,
      consent,
      fetchImpl,
      now,
      log,
      askName,
      publishProfile,
    });
  }

  // WHICH hive is joining (AC-72, DD-61)? In order: the config's declared
  // identity, then a join record in THIS state directory naming a hive that
  // already lives here. With neither, this is a brand-new hive and an identity
  // is minted for it. There is no machine-wide "the node key" any more — that
  // slot is exactly what made a second hive impossible.
  //
  // A config that NAMES an identity this machine cannot sign for is an error,
  // never a silent mint: minting there would produce a node whose pubkey
  // disagrees with the file that describes it, which is the "Unnamed member"
  // shape (FIX-127) with a config to make it durable. `setup` is the path for
  // a fresh hive — it mints and writes the config together.
  const known = nodePubkey ?? readJoinRecord(stateDir)?.pubkey ?? null;
  let privateKeyHex = known ? await store.getNodePrivateKey(known) : null;
  if (!privateKeyHex && nodePubkey) {
    throw new Error(
      `this config names hive ${nodePubkey.slice(0, 12)}… but no key for it is in the OS credential ` +
        `store, so this machine cannot sign as that node.\n` +
        `  It is not minted here: a new key would have a different pubkey and the config would be wrong.\n` +
        `  For a NEW hive run "hive402 setup --config <this config>", which mints and writes it together.`,
    );
  }
  if (!privateKeyHex) {
    privateKeyHex = generate();
    // `create` rather than `set`: if two setups race, the loser is refused
    // rather than told it succeeded with a key the other one replaced
    // (DD-32, F-017). Scoped to this identity, so a second HIVE is not a race.
    await store.createNodePrivateKey(derivePubkey(privateKeyHex), privateKeyHex);
    log(`hive402: this node had no identity, so one was generated for it`);
    log(`  pubkey:  ${derivePubkey(privateKeyHex)}`);
    log(`  stored:  OS credential store (never a file, never the network)`);
    log(`  This is the NODE's identity, not yours. You were not asked for your`);
    log(`  own key and never will be.`);
    log("");
  }

  return await joinAs({
    link,
    origin,
    privateKeyHex,
    stateDir,
    consent,
    fetchImpl,
    now,
    log,
    askName,
    publishProfile,
  });
}

// Everything the join does ONCE the identity is settled. One tail for both
// ways in, so the config-declared path cannot drift from the credential-store
// path — a second copy of this is how the two would come to disagree about
// what a join records, which is the failure `runJoin` was extracted to avoid
// in the first place.
async function joinAs({
  link,
  origin,
  privateKeyHex,
  stateDir,
  consent,
  fetchImpl,
  now,
  log,
  askName,
  publishProfile,
}) {
  const previous = readJoinRecord(stateDir);
  if (previous && previous.origin !== origin) {
    // Not refused — a node may legitimately be moved — but silence here would
    // leave `join.json` describing a community this node is no longer set up
    // for, and the next command would read it and be wrong.
    log(`hive402: note — this node already has a join record for ${previous.origin}.`);
    log(`  Joining ${origin} replaces it.`);
    log("");
  }

  const result = await joinCommunity({ link, privateKeyHex, consent, fetchImpl, now, stateDir, log });

  log("");
  log(`  community:  ${result.communityId ?? "(unnamed)"} at ${result.host}`);
  log(`  as:         ${result.pubkey}`);
  log(`  role:       ${result.role}`);
  if (result.policyVersion) {
    log(`  accepted:   join policy ${result.policyVersion}${result.ageConfirmed ? " (with age attestation)" : ""}`);
    log(`              recorded in ${path.join(stateDir, JOIN_RECORD_FILE)}`);
  }
  const named = await nameTheNode({ result, stateDir, askName, publishProfile, privateKeyHex, log });

  log("");
  if (!named) {
    log(`Next: give this node a display name so the member list shows a hive`);
    log(`      rather than a bare key:`);
    log(`        hive402 profile --name "<your name>'s hive"`);
  }
  return { ...result, displayName: named };
}

// Ask, publish, record. Every step is allowed to be skipped or to fail without
// taking the join with it: the membership is real either way, and a command
// that reports a failed JOIN because a profile publish failed would send
// someone to re-run the one part that already worked.
async function nameTheNode({ result, stateDir, askName, publishProfile, privateKeyHex, log }) {
  if (!askName || !publishProfile) return null;

  let name;
  try {
    name = (await askName(result)) ?? "";
  } catch {
    return null;
  }
  if (String(name).trim() === "") {
    log("");
    log(`  No name given — this node will show as its public key for now.`);
    return null;
  }

  try {
    await publishProfile({ name, privateKeyHex, origin: result.origin });
  } catch (err) {
    log("");
    log(`  ! joined, but the name could not be published: ${err.message}`);
    log(`    The membership is real. Set the name when you can:`);
    log(`      hive402 profile --name "${String(name).replace(/"/g, '\\"')}"`);
    return null;
  }

  rememberDisplayName({ stateDir, name: String(name).trim() });
  return String(name).trim();
}
