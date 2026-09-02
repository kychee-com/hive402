// Building the AC-56 name check for a command that may have almost nothing.
//
// `keygen` is the earliest command in the flow. It may run before there is a
// config, before this node has joined anything, and offline. So this assembles
// whatever IS available — a relay from the config or the join record, the
// node's key from the credential store, a channel and an owner from the config
// if the agent is already listed there — and returns a checker that reports
// honestly when it could not ask.
//
// It never throws. A name check that fails the command it is helping would make
// AC-56 a reason people stop running `keygen`, and the refusal that matters
// (AC-37, at the room) still stands at `register`.

import { BuzzCli, cliRelayUrl } from "../relay/buzzcli.mjs";
import { checkAgentName, describeNameFindings } from "./namecheck.mjs";
import { readJoinRecord } from "./joinrecord.mjs";
import { buzzBinPath } from "./profilecommand.mjs";

// What the config lets us NARROW the question with, if this name appears there
// at all. A name being checked is usually NOT there yet — that is the normal
// case, and it simply means there is no channel or owner to narrow with.
//
// ── Two facts, and the third that used to be here (F-037, DD-70) ──────────
//
// This also returned `selfPubkey: agent.pubkey`, and `checkAgentName` honours
// `selfPubkey` as an EXCLUSION in both questions that can refuse. So a config
// declaring this name with the pubkey that really holds it turned the
// strongest possible collision signal into an exemption: `keygen` answered
// `"<name>" is free in this room and on this relay` and minted a real key.
//
// `channel` and `ownerPubkey` NARROW — they say which room to ask about and
// whose collision it would be. A pubkey found here does not narrow anything:
// it is an ANSWER, and DD-69's rung 1 (`ownerFromConfig`) reads this same
// config to attribute the holder the relay names. The name of this helper and
// of what it returns is the guard — there is nothing here to exclude with.
function narrowingFromConfig(config, name) {
  const wanted = String(name ?? "").toLowerCase();
  for (const room of config?.rooms ?? []) {
    const agent = (room.agents ?? []).find((a) => String(a.name).toLowerCase() === wanted);
    if (agent) return { channel: room.channel, ownerPubkey: agent.ownerPubkey };
  }
  return { channel: null, ownerPubkey: null };
}

export async function makeNameCheck({
  config = null,
  stateDir = null,
  store,
  makeCli = null,
  // FIX-170, same reason as `runProfile`'s: a test can drive the declared
  // path without an OS keychain. Real callers pass nothing.
  resolveKey = null,
  // DD-69 rung 2's door, same seam as `registerAgent`'s. BOTH callers get the
  // ladder or AC-56's "before the agent exists" half regresses to the later
  // moment — `keygen` would keep the ownership-blind message and `register`
  // would be the only place the owner is ever told whose agent it is.
  queryEvents = undefined,
  log = console.log,
}) {
  const joined = readJoinRecord(stateDir);
  const relayUrl = config?.relayUrl ?? joined?.origin ?? null;

  let cli = null;
  let unavailable = null;
  // What rung 2 needs, kept beside the CLI it is built with. Both are null
  // until the key resolves, so a node that cannot ask the relay anything
  // cannot half-ask it either.
  let nodeKey = null;
  if (!relayUrl) {
    unavailable = "this node has not joined a community yet, so there is no relay to ask";
  } else {
    try {
      // WHICH hive is asking (AC-72)? The config names it; a machine may run
      // several and there is no machine-wide node key any more.
      const nodePubkey = config?.node?.pubkey ?? null;
      // ── …and WHERE its key lives, which the config also says (FIX-170) ────
      //
      // The FOURTH instance of F-033's defect, and the one the Red Team could
      // not see from outside: this read the credential store directly, so on an
      // env-configured node it found nothing and reported "this node has no
      // identity yet, so it cannot ask the relay anything". That sentence is
      // false on a node whose identity is in an environment variable, and it
      // silently degrades AC-56 into a warning nobody can act on. It is also
      // exactly the arm T-211's own caveat says was never tested.
      //
      // Same semantics as `join` (FIX-136) and `profile`: a declared
      // non-keychain reference is an INSTRUCTION and the store is not consulted
      // at all. `"keychain"` is the schema default and means the store.
      const ref = config?.node?.privateKeyRef ?? null;
      const declared = ref && ref !== "keychain" ? ref : null;
      let privateKey = null;
      if (declared) {
        const resolve =
          resolveKey ?? (await import("../node/runtime.mjs")).makeKeyResolver({ store, nodePubkey });
        // Throwing here is correct: the catch below turns it into `unavailable`,
        // which is reported as "could not check … (<why>)" naming the reference.
        // That is F-008's rule — "we could not ask" must never render as "there
        // is nothing there" — applied to a reference that did not resolve.
        privateKey = await resolve(declared, { role: "node", nodePubkey });
      } else {
        privateKey = nodePubkey ? await store.getNodePrivateKey(nodePubkey) : null;
      }
      if (!privateKey) {
        unavailable = "this node has no identity yet, so it cannot ask the relay anything";
      } else {
        const build = makeCli ?? ((opts) => new BuzzCli(opts));
        cli = build({ binPath: buzzBinPath(config?.tools?.buzzDir ?? null), relayUrl, privateKey });
        nodeKey = privateKey;
      }
    } catch (err) {
      unavailable = err.message;
    }
  }

  return async (name) => {
    // No `selfPubkey`, ever, from here (DD-70). Only a caller that already HAS
    // an identity may pass one — `registerAgent` does, and passes
    // `agent.pubkey`. `keygen` is minting a key that does not exist yet, so it
    // has no self: a config-declared agent of this name is a DIFFERENT
    // identity that already holds it.
    const narrowing = narrowingFromConfig(config, name);
    const findings = cli
      ? await checkAgentName({
          cli,
          name,
          ...narrowing,
          config,
          origin: cliRelayUrl(relayUrl),
          privateKeyHex: nodeKey,
          ...(queryEvents ? { queryEvents } : {}),
        })
      : { checked: false, reason: unavailable, refusals: [], warnings: [] };
    // ── "Continuing anyway." is a claim about what happens next (FIX-179) ──
    //
    // This rendered with `describeNameFindings`'s default `continuing: true`,
    // and `keygen` prints every warning BEFORE it throws on the error. So a
    // run that carried both a warning and a refusal printed "Continuing
    // anyway." directly above "No key was generated." One flag, chosen from
    // the findings, rather than a second copy of the sentence.
    const refusing = (findings.refusals ?? []).length > 0;
    const said = describeNameFindings({ name, findings, continuing: !refusing });
    if (log && said.warnings.length === 0 && findings.checked && !said.error) {
      // Say what was actually ASKED (FIX-180). With no channel resolved,
      // `checkAgentName` skips the room block entirely — and this line still
      // claimed the room, which is the same false assurance as F-037's in the
      // same sentence.
      const asked = narrowing.channel ? "in this room and on this relay" : "on this relay";
      log(`  name check: "${name}" is free ${asked}`);
    }
    return said;
  };
}
