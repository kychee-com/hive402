// Production wiring for the node.
//
// The supervisor takes every side-effecting dependency by injection so the
// policy logic is testable without a relay, a keychain or a spawned process.
// This module is where those injections become real — and it is deliberately
// thin, because anything with a decision in it belongs somewhere testable.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";

import { Supervisor } from "./supervisor.mjs";
import { PACKAGE_VERSION } from "../version.mjs";
import { classifyRecorded, makeIdentifier } from "./liveness.mjs";
import { agentStateFromVerdict, readAgentLog } from "./respawn.mjs";
import { BuzzCli, cliRelayUrl } from "../relay/buzzcli.mjs";
import { AuditLog } from "../audit/log.mjs";
import { auditFile } from "../audit/file.mjs";
import { CredentialStore } from "../credentials/store.mjs";
import { confirmedAbsent } from "../credentials/absence.mjs";
import {
  ENV_VAR_NAME,
  NOT_PRINTED,
  describeRefusedValue,
  looksLikeKeyMaterial,
} from "../credentials/refusal.mjs";
import { explainKeyRefusal, normalizePrivateKey } from "../credentials/keyforms.mjs";
import { computeAuthTag } from "../identity/nipoa.mjs";
import { validateRegistration } from "../registry/registration.mjs";
import { claimedNamesInRoom } from "../registry/roomnames.mjs";
import { authorizeRetire, retireAgent } from "../registry/retire.mjs";
import { markRetired } from "../config/load.mjs";
import { resolveModel } from "../config/schema.mjs";
import { checkAgentName, describeNameFindings } from "../registry/namecheck.mjs";
import { IdentityPublisher } from "../identity/publisher.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;

// Resolve a key from where the config SAYS it lives. The config never holds a
// key itself (schema refuses one), so this is the only path from a reference to
// actual secret material — AC-32: the OS credential store, never a plaintext
// file, never the network.
//
// ASYNC on purpose (DD-28). This used to be synchronous and read through
// `store.getAgentPrivateKeySync?.(which)` — a method that exists nowhere in the
// repo. The optional call made the missing method `undefined`, `?? null` made
// that "no key", and the resolver reported an empty credential store. Since
// `"keychain"` is the schema DEFAULT, the path a new owner takes by doing
// nothing could not work, and said so in a way that sent them looking in the
// wrong place. The store shells out to the OS, so it is inherently async; the
// sync accessor was fiction. Note there is no `?.` below: a store that cannot
// read must fail loudly.
// `nodePubkey` binds this resolver to ONE hive (AC-72, DD-61). The node key is
// stored under that node's own pubkey now, so "the node key" is not a question
// this resolver can answer on its own — and answering it anyway, from a
// machine-wide slot, is exactly how a second hive would have inherited the
// first one's identity. Callers bind it from `config.node.pubkey`, which the
// comment below has always said every config carries.
export function makeKeyResolver({ store = new CredentialStore(), nodePubkey = null } = {}) {
  return async (ref, { agent, role, nodePubkey: forThisCall = null } = {}) => {
    if (!ref || ref === "keychain") {
      // An agent has its own identity, one per name. Every other role here —
      // running the node, sponsoring a registration, signing the attestation —
      // is the NODE, which holds one identity of its own (FIX-115/117). Before
      // those, this slot held the owner's key and the comment here said all
      // three roles were "the same person"; they are the same MACHINE now, and
      // no human's key is involved on any of these paths (AC-43).
      const forAgent = typeof agent === "string" && agent !== "";
      const node = forThisCall ?? nodePubkey;
      if (!forAgent && !node) {
        throw new Error(
          `cannot resolve the ${role ?? "node"} key: WHICH HIVE? this machine may run several, so a ` +
            `node key is stored under that node's own pubkey and there is no machine-wide one. ` +
            `The caller must name the node (config "node.pubkey").`,
        );
      }
      // FIX-127: an absent answer is CONFIRMED before it is believed. A read is
      // a process spawn and a flaky one returns null, which never entered
      // `keychain.child`'s retry because it is not a rejection. One bad
      // observation used to become a fact, and the fact's consumer is a command
      // that offers to mint an identity. See `absence.mjs`.
      const { value } = await confirmedAbsent({
        read: () => (forAgent ? store.getAgentPrivateKey(agent) : store.getNodePrivateKey(node)),
      });

      if (!value) {
        // Short, and deliberately WITHOUT a "create one" remedy (FIX-127).
        //
        // This used to spend four lines telling the reader to run `hive402
        // keygen --node` or `hive402 join`. That advice is only ever right on a
        // machine with no identity yet — and NO CALLER OF THIS RESOLVER IS EVER
        // THAT MACHINE. Reaching here requires a config, and a config names a
        // pubkey for every identity in it, so a new key would not match the one
        // the room already knows. `setup` is the path for a fresh machine and it
        // mints directly, never through here.
        //
        // What that advice actually produced, when Barry hit a flaky read on
        // 2026-08-27: a working node being told to mint a second identity over
        // itself, which is the "Unnamed member" incident of the day before.
        //
        // The AC-43 sentence stays. It is not a remedy, it is the warning that
        // this slot is not a place to put a human's key, and it was the only
        // part of the old block worth keeping.
        throw new Error(
          forAgent
            ? `no key for agent "${agent}" in the OS credential store`
            : `no key for the node identity (role: ${role ?? "node"}) in the OS credential store. ` +
              `That slot holds the NODE's own identity, never your own Buzz key (AC-43)`,
        );
      }
      if (!HEX64.test(value)) {
        throw new Error(
          // "the node identity", matching the sibling branch immediately above
          // — which was corrected when FIX-117 split the node's identity from
          // the owner's, while this one was missed (FIX-152).
          `the stored key for ${forAgent ? `agent "${agent}"` : "the node identity"} ` +
            `is not a 64-char hex private key — the credential store entry looks corrupt.`,
        );
      }
      return value;
    }
    // `startsWith("env:")` alone used to be enough here, while `schema.mjs`
    // required a real variable name. Two validators disagreeing about the same
    // string is how the stricter one gets bypassed: `--sponsor env:<a pasted
    // key>` reached this branch and the "is not set" message printed the
    // suffix. They agree now (DD-31), the way the three identity-name checks
    // were made to agree in DD-30.
    if (ref.startsWith("env:")) {
      const name = ref.slice(4);
      if (!ENV_VAR_NAME.test(name)) throw refuseKeyReference(ref);
      const held = process.env[name];
      if (!held) throw new Error(`${ref}: environment variable ${name} is not set`);

      // Both written forms, same as `keys import` (F-022, DD-40). A dev relay
      // or a CI box is exactly where an owner exports the key Buzz handed them,
      // and Buzz hands out an `nsec1…`. Fixing only the import command would
      // have moved the wall rather than removed it.
      const given = normalizePrivateKey(held);
      if (!given.ok) {
        // The REFERENCE may be named — `ENV_VAR_NAME` caps it at 48 characters
        // precisely so a key cannot fit inside one (DD-31) — but the VALUE it
        // holds may not be, and neither may anything decoded from it.
        const described = describeRefusedValue(held);
        throw new Error(`${ref}: ${explainKeyRefusal({ reason: given.reason, described })}`);
      }
      return given.hex;
    }
    throw refuseKeyReference(ref);
  };
}

// Never echo the ref (DD-31, the F-016 class). This refusal is reached by
// `register --sponsor <keyref>` / `--owner-key <keyref>`, whose own help text
// says "key" — so an owner with their key on the clipboard pastes it HERE, and
// this message used to print it back verbatim, in full, at ANY length. That is
// not F-016's near-miss: it is a valid, immediately usable key, which is F-014's
// original severity through a third code path. Kind and length are what an
// operator needs; the value is not.
function refuseKeyReference(ref) {
  // Two branches, matching `schema.mjs`'s `refuseKeyRef` exactly (F-022). This
  // one used to give the generic sentence to everything, including a pasted
  // key — so an owner who put their key here was told only that it was "neither
  // keychain nor env:", with no hint that the thing they were holding has a
  // home. Both branches are equally safe; this one is better ADVICE, and since
  // fix cycle 13 the command it names accepts the `nsec1…` they are looking at.
  if (looksLikeKeyMaterial(ref)) {
    return new Error(
      `that is a private KEY, not a reference to one. --sponsor and --owner-key say WHERE ` +
        `your key lives; they never carry it. Store it once with "hive402 keys import --node" ` +
        `— it takes the "nsec1…" from Buzz's backup screen exactly as it is written — then ` +
        `pass "keychain" here, or "env:VAR_NAME" for a dev relay. ${NOT_PRINTED}`,
    );
  }
  return new Error(
    `a key reference must be "keychain" or "env:VAR_NAME" — got ` +
      `${describeRefusedValue(ref)}, which is neither. It names where the key lives, ` +
      `it is never the key itself. ${NOT_PRINTED}`,
  );
}

export function makeSupervisor({
  config,
  configFile = null,
  stateDir,
  // Bound to THIS hive's identity (AC-72): the resolver cannot answer "the
  // node key" on its own any more, and must not be able to.
  resolveKey = makeKeyResolver({ nodePubkey: config?.node?.pubkey }),
}) {
  const buzzBin = path.join(config.tools.buzzDir ?? "", "buzz.exe");
  return new Supervisor({
    config,
    // An `instructionsFile` is written relative to the config that names it.
    configDir: configFile ? path.dirname(path.resolve(configFile)) : null,
    stateDir,
    spawn,
    resolveKey,
    audit: new AuditLog(auditFile(stateDir)),
    makeCli: ({ privateKey, authTag }) =>
      new BuzzCli({ binPath: buzzBin, relayUrl: config.relayUrl, privateKey, authTag }),
  });
}

// `hive402 down` runs in a DIFFERENT process from `hive402 up`, so it cannot
// hold child handles — it stops what the PID file records. This is the missing
// half of TR-003: cycle 1 found a buzz-acp process still running 7.5 hours
// after the session that started it, because nothing could stop it.
//
// Each entry comes back with its own outcome (O-2, DD-25):
//   stopped  it was running, and now it is not
//   gone     the record outlived the process; nothing to do
//   stale    that number now belongs to SOMEBODY ELSE, so it was left alone
//
// Reporting all three as "stopped" told the operator a false thing at the exact
// moment they were debugging — and the kill-by-number that produced it would
// have terminated an unrelated process on a recycled pid.
export function stopFromPidFile(stateDir, { identify } = {}) {
  const file = path.join(stateDir, "hive402.pid.json");
  if (!existsSync(file)) return [];
  let state;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    rmSync(file, { force: true });
    return [];
  }

  // Agents first, then the node itself. Stopping only the agents leaves the
  // supervisor watching the room with nothing to wake — and the next `up` then
  // adds a SECOND watcher, so every message is relayed twice. Observed live on
  // 2026-08-15 (three nodes, three identical wakes for one human message).
  const entries = [
    ...(state.agents ?? []).filter((a) => a?.pid).map((a) => ({ name: a.name, pid: a.pid, kind: "agent" })),
    ...(state.node && state.node !== process.pid ? [{ name: "node", pid: state.node, kind: "node" }] : []),
  ];
  const lookup = identify ?? makeIdentifier(entries.map((e) => e.pid));
  const recordedAt = state.startedAt ?? null;

  const results = [];
  for (const { name, pid, kind } of entries) {
    const verdict = classifyRecorded({ pid, kind, recordedAt, identify: lookup });

    if (verdict.state === "gone") {
      results.push({ name, pid, state: "gone", detail: verdict.detail });
      continue;
    }
    if (verdict.state === "reused") {
      results.push({ name, pid, state: "stale", detail: verdict.detail });
      continue;
    }

    // "ours" or "unconfirmed". `down` was asked to stop things, so a live pid
    // we cannot positively identify is still stopped — the opposite default
    // from `up`, deliberately (DD-25).
    try {
      process.kill(pid);
      results.push({ name, pid, state: "stopped", detail: verdict.detail });
    } catch (err) {
      results.push({ name, pid, state: "gone", detail: `could not signal pid ${pid}: ${err.message}` });
    }
  }

  rmSync(file, { force: true });
  return results;
}

// FIX-141 — `configFile` is the path the loader RESOLVED, not the flag the
// caller typed, and it is reported for the same reason `doctor` reports it: on a
// box running more than one node, every other field here is ambiguous without
// it. `status` had the fact and discarded it, which is this codebase's most
// frequent defect shape (a known fact nobody consumes).
export async function readStatus({ config, stateDir, configFile = null, identify }) {
  const file = path.join(stateDir, "hive402.pid.json");
  const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const recordedAt = state?.startedAt ?? null;
  const lookup =
    identify ?? makeIdentifier([state?.node, ...(state?.agents ?? []).map((a) => a.pid)].filter(Boolean));
  // A pid file is a record, not a running process. `running: Boolean(state)`
  // reported an overnight-dead rig as up — the same lie as O-2, one command over.
  const present = (pid, kind) => {
    const verdict = classifyRecorded({ pid, kind, recordedAt, identify: lookup });
    return verdict.state === "ours" || verdict.state === "unconfirmed";
  };

  // `alive: false` is the right fact in the wrong vocabulary: since DD-34 an
  // agent whose process is gone comes BACK the moment somebody addresses it, and
  // an operator reading "not alive" has no way to know that. So each agent also
  // carries the state word and, when its process is gone, the harness's own
  // reason for going. `alive` stays as-is — `rig-lib.ps1` reads it.
  const describe = (a) => {
    const verdict = classifyRecorded({ pid: a.pid, kind: "agent", recordedAt, identify: lookup });
    const logText =
      verdict.state === "gone" ? readAgentLog(path.join(stateDir, "logs", `${a.name}.log`)) : null;
    const view = agentStateFromVerdict(verdict, { pid: a.pid, logText });
    return { ...a, alive: view.alive, state: view.state, detail: view.detail };
  };

  return {
    // First, because it is what tells you whether the rest of this report is
    // about the node you meant.
    configFile,
    stateDir,
    // FIX-145 — and which BUILD it came from. `status` used to describe a node
    // without naming the code that answered, so a stale install on PATH read as
    // a product that had lost a feature (F-025). Read from the package manifest
    // (`src/version.mjs`), never written as a literal here: a second copy of a
    // version number is a number that can disagree with its own build.
    version: PACKAGE_VERSION,
    node: config.node.pubkey,
    running: Boolean(state?.node) && present(state.node, "node"),
    nodePid: state?.node ?? null,
    startedAt: state?.startedAt ?? null,
    agents: (state?.agents ?? []).map(describe),
    configuredAgents: config.rooms.flatMap((r) =>
      r.agents.map((a) => ({
        name: a.name,
        channel: r.channel,
        research: a.research,
        build: a.build,
        crossOwnerAsks: a.crossOwnerAsks,
        // AC-76: which model this agent runs on, and which rung of
        // agent → node → default answered. The source matters as much as the
        // value: an owner looking at a surprising bill needs to know whether
        // the agent chose it, the hive chose it, or nobody did.
        ...(({ model, source }) => ({ model, modelSource: source }))(resolveModel(a, config.node)),
        attested: existsSync(path.join(stateDir, "agents", `${a.name}.json`)),
      })),
    ),
  };
}

// TR-001 — the headless registration path.
//
// Buzz's own route (`buzz agents draft-create`) only opens a prefilled form in
// the owner's Desktop for a human to complete, so a test cycle could not
// exercise AC-33/36/37 at all. This does the same job from a script: verify the
// sponsor is a member, sign the owner attestation once, store it, and admit the
// agent to the relay and channel.
// `makeCli` is injected for the same reason the supervisor injects it: without
// a seam here, the only way to exercise registration was against a live relay,
// and F-008 (a duplicate name admitted from a second owner's node) shipped past
// a green suite because nothing tested this function at all.
//
// ── AC-47, and the thing it must NOT change ────────────────────────────────
//
// `sponsorRef` and `ownerKeyRef` default to the NODE's key. Before FIX-117 both
// were required flags reading one credential slot documented as "the OWNER's
// Nostr identity", so `register --sponsor keychain --owner-key keychain` had a
// human's key doing three jobs at once. Since FIX-115 the node has an identity
// of its own and is a community member like any other, so it can sponsor and
// attest the agents it hosts — and adding an agent after the join needs nothing
// secret from a person (AC-43).
//
// What did NOT move is who APPROVES. `agent.ownerPubkey` is the human; the
// dispatcher reads it directly for AC-14/15/16 and AC-24/25. Making the node
// the attester must not make the node the approver, because a machine cannot be
// asked and cannot answer. Attester and approver are separate here on purpose
// (DD-51).
export async function registerAgent({
  config,
  stateDir,
  agentName,
  // FIX-136 (hive402#4). Null means "the config has not been overridden", NOT
  // "the credential store". These two defaulted to `"keychain"`, so a config
  // declaring `node.privateKeyRef: "env:RIG_NODE_KEY"` still sponsored and
  // attested with the store's default entry — the production identity on any
  // box that runs a real node. `up` had always honoured the declaration; these
  // silently did not, and the disagreement published an agent record hosted by
  // a node that would never serve it.
  //
  // An explicit flag still wins: it is an instruction, and the documented
  // workaround (`--sponsor env:VAR`) has to keep working.
  sponsorRef = null,
  ownerKeyRef = null,
  resolveKey = makeKeyResolver({ nodePubkey: config?.node?.pubkey }),
  makeCli = null,
  // DD-69 rung 2's door, injected the way `retireAgent` injects `submitEvent`
  // so the ladder is testable without a relay. Real callers pass nothing and
  // `checkAgentName` uses the real `/query`.
  queryEvents = undefined,
}) {
  const declaredNodeRef = config?.node?.privateKeyRef ?? "keychain";
  const sponsorReference = sponsorRef ?? declaredNodeRef;
  const attesterReference = ownerKeyRef ?? sponsorRef ?? declaredNodeRef;
  const room = config.rooms.find((r) => r.agents.some((a) => a.name === agentName));
  if (!room) throw new Error(`no agent named "${agentName}" in this config`);
  const agent = room.agents.find((a) => a.name === agentName);

  const buzzBin = path.join(config.tools.buzzDir ?? "", "buzz.exe");
  const cliFor = makeCli ?? ((opts) => new BuzzCli({ binPath: buzzBin, relayUrl: config.relayUrl, ...opts }));
  const sponsorKey = await resolveKey(sponsorReference, { role: "sponsor" });
  const sponsorCli = cliFor({ role: "sponsor", privateKey: sponsorKey });

  // AC-36: sponsorship is what makes this self-service rather than an operator
  // favour — and an unsponsored registration must be refused, so membership is
  // checked against the room's real roster, not asserted.
  let members = new Set(
    (await sponsorCli.channelMembers({ channel: room.channel })).map((m) => m.pubkey),
  );

  // ── Two memberships, and only one of them the join gives you ─────────────
  //
  // FOUND BY RUNNING THE WHOLE FLOW (2026-08-25). Claiming an invite makes the
  // node a member of the COMMUNITY. Sponsoring a registration requires the
  // sponsor to be a member of the TARGET CHANNEL. Those are different things,
  // and nothing in between put the node in a channel — so a node that had just
  // joined, done everything asked of it, and existed precisely to host an
  // agent, was refused at the moment it tried to register that agent:
  //
  //     registration refused: registration must be sponsored by an existing
  //     community member
  //
  // which names the one thing the node demonstrably WAS. Measured against the
  // live relay: a freshly joined member can add itself to a channel, so the
  // node does that rather than making a person go and do it in another app
  // halfway through a one-command setup.
  //
  // Only when it is not already in. Re-joining every registration would put a
  // membership event on the relay for nothing.
  const sponsorPubkeyForMembership = derivePubkey(sponsorKey);
  if (!members.has(sponsorPubkeyForMembership)) {
    try {
      await sponsorCli.joinChannel({ channel: room.channel });
      members = new Set(
        (await sponsorCli.channelMembers({ channel: room.channel })).map((m) => m.pubkey),
      );
    } catch (err) {
      // Not fatal here: the refusal below says the useful thing, and this adds
      // WHY the sponsor is still not a member — a channel may be closed, or
      // invite-only, and then a human has to add the node from their own client.
      throw new Error(
        `this node is not a member of channel ${room.channel} and could not add itself ` +
          `(${err.message}).\n` +
          `  Add it in your Buzz client — it is a community member like any other — ` +
          `then run this again.`,
      );
    }
  }

  // AC-37 (DD-17): ask the ROOM who already holds this name, never the local
  // config. F-008 admitted a second "probe1" from a separate owner's node
  // because a config file lists only its own author's agents — the other node
  // was structurally invisible. This throws if the relay cannot be read, so a
  // failed check refuses rather than silently reporting "no clash".
  const existingAgents = await claimedNamesInRoom({
    cli: sponsorCli,
    channel: room.channel,
    exceptPubkey: agent.pubkey,
    name: agent.name,
  });

  // AC-56's warning half. The refusals below cover the room and the relay; this
  // covers the owner colliding with THEMSELVES — an agent of the same name they
  // already made in Buzz Desktop, attested by their own key, which is in
  // neither of the other two answers. Not a refusal: they may mean to move it
  // here, and that is theirs to decide. Never fatal, because a warning that can
  // fail the command is a reason to stop running the command.
  //
  // The FINDINGS are kept, not just their success-path sentences (FIX-171).
  // This block used to render straight to `ownerNameWarnings`, and the refusal
  // path below then threw those away — so the answer to "is this the owner's
  // own agent?" was computed for every registration and reached the one branch
  // that needed it in exactly no cases. Keeping the findings lets the refusal
  // ask the same question again, in its own wording.
  let ownerFindings = null;
  try {
    ownerFindings = await checkAgentName({
      cli: sponsorCli,
      name: agent.name,
      channel: null, // the room is covered by `claimedNamesInRoom` above
      selfPubkey: agent.pubkey,
      ownerPubkey: agent.ownerPubkey,
      // DD-69's ladder. `--owner` alone can only ever answer for a Buzz
      // Desktop agent, so without these two the same-owner case this block
      // exists for reads byte-for-byte like a stranger's (F-036).
      config,
      origin: cliRelayUrl(config.relayUrl),
      privateKeyHex: sponsorKey,
      ...(queryEvents ? { queryEvents } : {}),
    });
  } catch {
    ownerFindings = null;
  }
  const ownerNameWarnings = ownerFindings
    ? describeNameFindings({ name: agent.name, findings: ownerFindings }).warnings
    : [];

  const sponsorPubkey = derivePubkey(sponsorKey);
  const verdict = validateRegistration({
    agent: { name: agent.name, pubkey: agent.pubkey, ownerPubkey: agent.ownerPubkey },
    sponsorPubkey,
    members,
    existingAgents,
  });
  // ── Say WHOSE agent holds the name, when it is the caller's own (F-036) ──
  //
  // `validateRegistration` is ownership-blind by construction: it is handed a
  // list of claims from the relay and prints a bare pubkey prefix, so it cannot
  // tell the caller's own agent from a stranger's. The owner-scoped answer was
  // fetched nine lines above and, until FIX-171, discarded here — which is why
  // a same-owner collision read byte-for-byte like a cross-owner one.
  //
  // Appended rather than substituted, deliberately. The cross-owner wording is
  // unchanged and a test pins it byte for byte: this adds a sentence in the one
  // case it is true, and adds nothing in every other case, including the case
  // where the check could not run at all. An ownership claim hive402 could not
  // verify is exactly F-008's mistake pointed the other way.
  if (!verdict.ok) {
    const owned = ownerFindings
      ? describeNameFindings({ name: agent.name, findings: ownerFindings, continuing: false }).warnings
      : [];
    throw new Error(
      `registration refused: ${verdict.reason}` + (owned.length ? `\n  ${owned.join("\n  ")}` : ""),
    );
  }

  // AC-35/AC-47: the attestation is signed by the NODE, which is what makes the
  // agent verifiably an agent hosted HERE. The key is used once, here, and the
  // SIGNATURE is the durable artifact — it is public and it is what the room
  // checks.
  const attesterKey = await resolveKey(attesterReference, { role: "attester" });
  const attesterPubkey = derivePubkey(attesterKey);
  const authTag = computeAuthTag({ ownerPrivateKey: attesterKey, agentPubkey: agent.pubkey });

  const dir = path.join(stateDir, "agents");
  mkdirSync(dir, { recursive: true });
  const attestationFile = path.join(dir, `${agent.name}.json`);
  writeFileSync(
    attestationFile,
    `${JSON.stringify({ agent: agent.name, pubkey: agent.pubkey, authTag }, null, 2)}\n`,
    "utf8",
  );

  await sponsorCli.addChannelMember({
    channel: room.channel,
    pubkey: agent.pubkey,
    role: verdict.admit.channelRole,
  });

  // Claim the name where the next owner's node can see it (DD-17).
  //
  // Until fix cycle 2 the profile was only published at `hive402 up`, so a
  // registered-but-not-yet-started agent held its name nowhere the relay could
  // report — which is why F-008's first `probe1` was invisible to the second
  // registration even after this check started asking the relay. Publishing
  // here also completes AC-34's "addressable there" half at registration time,
  // rather than leaving it to a later `up`.
  //
  // Published under the AGENT's own identity: `buzz users set-profile` updates
  // the CALLING identity, so doing this through the sponsor's client would
  // rename the sponsor (the cycle-1 defect that renamed the node "spike").
  let published = false;
  let publishWarning = null;
  try {
    const agentCli = cliFor({
      role: "agent",
      publishesFor: agent.name,
      privateKey: await resolveKey(agent.privateKeyRef, { agent: agent.name }),
      authTag,
    });
    await new IdentityPublisher({ cli: agentCli }).publish({
      agent: { ...agent, authTag },
      authTag,
      attestedBy: attesterPubkey,
    });
    published = true;
  } catch (err) {
    // The agent IS registered at this point; a publish failure is a warning,
    // not a rollback. `hive402 up` republishes, and `doctor` reports it.
    publishWarning = `registered, but publishing the profile failed (${err.message}) — ` +
      `run "hive402 up" to publish it, or the name will not resolve`;
  }

  return {
    name: agent.name,
    attestationFile,
    relayRole: verdict.admit.relayRole,
    channelRole: verdict.admit.channelRole,
    // Reported separately and deliberately: these are two different people.
    // `attestedBy` is the node, and it is what the relay can verify;
    // `ownerPubkey` is the human whose approval releases an action, and it is
    // what the dispatcher enforces (DD-51).
    attestedBy: attesterPubkey,
    ownerPubkey: agent.ownerPubkey,
    sponsoredBy: verdict.admit.sponsoredBy,
    published,
    warning: publishWarning,
    nameWarnings: ownerNameWarnings,
  };
}

// `hive402 retire <agent>` — give the name back (AC-70, AC-71, DD-60).
//
// The mirror of `registerAgent`, and it undoes the two things registration
// does: the kind-0 name claim and the kind-30177 record. The order and the
// read-back live in `registry/retire.mjs`; this is the part that knows about
// configs, keys and the running node.
//
// The config entry is marked LAST and only on success. Marked first, a failed
// release would leave an agent the node no longer launches, still holding its
// name, with nothing left in `room.agents` for a retry to find — the name burnt
// by the very command that exists to prevent that.
export async function runRetire({
  config,
  configFile,
  raw,
  stateDir,
  agentName,
  resolveKey = makeKeyResolver({ nodePubkey: config?.node?.pubkey }),
  makeCli = null,
  identify,
}) {
  const room = config.rooms.find((r) => r.agents.some((a) => a.name === agentName));
  const agent = room?.agents.find((a) => a.name === agentName) ?? null;

  // Already retired reads as success, not as "no such agent": re-running a
  // command that finished is not an error, and the alternative wording sends
  // the operator looking for a config problem that does not exist.
  if (!agent) {
    const retiredHere = config.rooms.some((r) => (r.retiredAgents ?? []).some((a) => a.name === agentName));
    if (retiredHere) return { ok: true, agent: agentName, alreadyRetired: true };
  }

  const verdict = authorizeRetire({
    agent,
    // The CLI runs where the node runs and holds the node's key, so the actor
    // IS the node. The owner branch is the library's, for a caller that can
    // prove a human asked — there is no flag here that would let anyone else
    // assert an identity they do not hold.
    actorPubkey: config.node?.pubkey,
    nodePubkey: config.node?.pubkey,
  });
  if (!verdict.ok) throw new Error(`cannot retire "${agentName}": ${verdict.reason}`);

  const buzzBin = path.join(config.tools.buzzDir ?? "", "buzz.exe");
  const result = await retireAgent({
    agent,
    channel: room.channel,
    nodePubkey: config.node.pubkey,
    nodeKeyRef: config.node.privateKeyRef ?? "keychain",
    origin: cliRelayUrl(config.relayUrl),
    resolveKey,
    makeCli:
      makeCli ?? ((opts) => new BuzzCli({ binPath: buzzBin, relayUrl: config.relayUrl, ...opts })),
  });

  if (result.ok && configFile && raw) {
    const marked = markRetired({ file: configFile, raw, agentName });
    result.configMarked = !marked.alreadyRetired;
  }

  // A running agent still answers under a dead name until the node restarts.
  // Reported rather than acted on: this command does not own the supervisor's
  // processes, and killing one out from under a live node is how a `down` that
  // did not happen becomes an orphan (the cycle-1 finding).
  const pidFile = path.join(stateDir, "hive402.pid.json");
  let record = null;
  if (existsSync(pidFile)) {
    try {
      record = JSON.parse(readFileSync(pidFile, "utf8"));
    } catch {
      record = null; // an unreadable pid file is not a reason to fail a retire
    }
  }
  const live = (record?.agents ?? []).find((a) => a.name === agentName);
  if (live) {
    const verdictFor = classifyRecorded({
      pid: live.pid,
      kind: "agent",
      recordedAt: record?.startedAt ?? null,
      identify: identify ?? makeIdentifier([live.pid]),
    });
    if (verdictFor.state === "ours" || verdictFor.state === "unconfirmed") {
      result.stillRunning = live.pid;
    }
  }
  return result;
}

function derivePubkey(privateKeyHex) {
  const bytes = Uint8Array.from(Buffer.from(privateKeyHex, "hex"));
  return Buffer.from(schnorr.getPublicKey(bytes)).toString("hex");
}
