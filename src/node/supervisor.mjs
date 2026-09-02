// The hive402 node.
//
// This is the process cycle 1 said did not exist. Everything Phases 2-4 built —
// the launcher, the mention resolver, the action gate, the capability compiler,
// the turn cap, the loop guard, the audit log, the identity publisher — is
// reachable ONLY through here, so "is the policy layer in the path?" is a
// structural fact rather than a launch-time habit (DD-9).
//
// Responsibilities, in start order:
//   1. publish each agent's identity so the room can address it   (AC-5, AC-35, AC-39)
//   2. compile its capabilities into a runtime settings dir       (AC-17, AC-22)
//   3. launch it with the full explicit policy env                (AC-1, AC-38, AC-41, AC-42)
//   4. watch the room and relay gated wakes                       (AC-6, AC-7, AC-12, AC-14, AC-16)
//   5. record everything                                          (AC-27)

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildAgentEnv, inboundGateFor, lifetimePolicyArgs } from "../launcher/env.mjs";
import { instructionsFilePath, resolveInstructions } from "../launcher/instructions.mjs";
import { agentWorkDir, writeAgentRuntimeConfig } from "../launcher/capabilities.mjs";
import { buildAndDeploy, formatDeployMessage } from "../workshop/run402.mjs";
import { makeRun402Cli } from "../workshop/cli.mjs";
import { writeWorkshopGuide } from "../workshop/guide.mjs";
import { DEPLOY_DIR, deployDirIn } from "../workshop/site.mjs";
import { trustWorkspace } from "../launcher/workspace.mjs";
import { IdentityPublisher } from "../identity/publisher.mjs";
import { cliRelayUrl } from "../relay/buzzcli.mjs";
import { KIND_MANAGED_AGENT, publishManagedAgent } from "../identity/managedagent.mjs";
import { nip98Header } from "../identity/nip98.mjs";
import { queryEvents as queryRelayEvents, submitEvent as submitRelayEvent } from "../relay/query.mjs";
import { membershipDelta, readMemberships } from "../registry/membership.mjs";
import { Dispatcher } from "../listener/dispatch.mjs";
import { CoverTracker } from "./cover.mjs";
import { HandoffTracker } from "./handoff.mjs";
import { foreignAgentsIn, managedAgentsFrom } from "../listener/foreign.mjs";
import { attributionLine, composeWake, HIVE_MARKER } from "../listener/attribution.mjs";
import {
  backlogDropNotice,
  backlogDropReports,
  handoffNote,
  overflowNotice,
  replayNote,
} from "../listener/notices.mjs";
import { replyAnchor, replyTargetOf, threadRootOf } from "../listener/threads.mjs";
import { describeAgentFailure, lastAgentTurn } from "./agenterrors.mjs";
import { buildLiveness, Heartbeat, KIND_USER_STATUS, LIVENESS_D, livenessOf } from "./heartbeat.mjs";
import { partitionOnResume, reconcileDrops } from "./backlog.mjs";
import {
  addressesAgent,
  capPromises,
  isDispatched,
  markDispatched,
  promisesIn,
  threadVerdict,
} from "./promises.mjs";
import { BACKLOG_DEFAULTS, COVER_DEFAULTS, HANDOFF_DEFAULTS } from "../config/schema.mjs";
import { readHeldFor, readResumePoint, writeHeldFor, writeResumePoint } from "./resumepoint.mjs";
import { credentialLocation, inspectStore } from "../credentials/keychain.mjs";
import { TurnCap } from "../safety/turncap.mjs";
import { LoopGuard } from "../safety/loopguard.mjs";
import { AuditLog } from "../audit/log.mjs";
import { auditFile } from "../audit/file.mjs";
import { pruneAuthorities, readAuthority, writeGrant, writeWithheld } from "../runtime/grants.mjs";
import { drainPauseRecords, readTurnRecord, remainingTurns } from "../runtime/turngate.mjs";
import { classifyRecorded, isPidAlive, makeIdentifier } from "./liveness.mjs";
import { agentClassifier, agentProcessState, waitForAgentReady } from "./respawn.mjs";

const PID_FILE = "hive402.pid.json";
const DEFAULT_POLL_MS = 2000;

// How a pubkey is named in the room: enough to identify, short enough to read.
const short = (pubkey) => String(pubkey ?? "").slice(0, 8);

// The two runtime hooks the node declares in every agent's settings, resolved
// from this module so they keep working from a global install.
//   • the tool gate (DD-15) decides what a turn may DO
//   • the turn gate (DD-19) records what a turn IS — which room event caused
//     it — because the node cannot see turns the harness delivers directly
const TOOLGATE = fileURLToPath(new URL("../runtime/toolgate.mjs", import.meta.url));
const TURNGATE = fileURLToPath(new URL("../runtime/turngate.mjs", import.meta.url));

export class Supervisor {
  #config;
  #configDir;
  #stateDir;
  #spawn;
  #makeCli;
  #resolveKey;
  #log;
  #pid;
  #identify;
  #trustWorkspace;
  #children = new Map(); // agent name -> child process
  #rooms = []; // { room, cli, dispatcher, publisher, seen:Set }
  // agent name -> the channels the RELAY says it belongs to (AC-48, FIX-120).
  // This is the watch set. A config file no longer decides it, because a list
  // the room cannot see is a list that can silently disagree with the room.
  #membership = new Map();
  #membershipCheckedAt = 0;
  // agent name -> resolved private key. Resolved once at start, because
  // membership discovery asks the relay AS each agent and a keychain round trip
  // per agent per re-check would be a lot of OS calls for an answer that cannot
  // change while the process lives.
  #agentKeys = new Map();
  #membershipRecheckMs = 60_000;
  #timer = null;
  #triggers = new Map(); // event id -> { event, requester } for the turn it triggers
  #run402;
  // agent name -> the respawn currently in flight for it (DD-34). Two wakes
  // arriving during one relaunch must produce ONE process, both delivered after
  // it: two buzz-acp processes under one identity answer every message twice,
  // which is the F-008 duplicate class in a new place.
  #respawns = new Map();
  #awaitAgentReady;
  // pubkey -> display name (or null when the relay has none). AC-5 allows the
  // room 30 seconds and a lookup per wake spends relay round trips inside it,
  // so a name is fetched once per person and then remembered.
  #names = new Map();
  // Failures already announced in the room, keyed by agent and failure time, so
  // one broken agent cannot turn every message into the same red banner.
  #announcedFailures = new Set();
  // The node's own liveness beat (AC-60, DD-53). Started with the node, told to
  // say "offline" on a graceful stop; a hard death just stops beating and the
  // relay's expiry does the rest.
  #heartbeat = null;
  // The relay's HTTP query door (S30-3), injected so the cover path is
  // testable without a relay — exactly like `makeCli`.
  #queryEvents;
  // …and its write half, for the liveness record (AC-60).
  #submitEvent;

  // `readAttestation` is a property (not private) so a test or an operator tool
  // can substitute the source; it defaults to the state file `register` writes.
  readAttestation;

  constructor({
    config,
    // Where an agent's `instructionsFile` is resolved from (AC-55, DD-45). It
    // is the CONFIG FILE's directory, not the process working directory: the
    // owner writes a path next to the config they are editing, and `hive402 up`
    // may be run from anywhere.
    configDir = null,
    stateDir,
    spawn,
    makeCli,
    resolveKey,
    readAttestation,
    audit,
    isAlive,
    // How a recorded pid is identified. Left undefined in production so
    // `start()` can batch one probe across the whole pid file; tests inject it
    // ONLY to model the probe being unable to answer.
    identify,
    pid = process.pid,
    trustWorkspace: trust = trustWorkspace,
    // How often to re-ask the relay which channels each agent belongs to
    // (AC-48). Adding an agent to a channel in any Buzz client is meant to be
    // sufficient, so the node has to look again — this is how long "sufficient"
    // takes. Upstream caches a channel roster for five minutes, so a shorter
    // interval buys nothing but relay traffic. `0` re-checks every tick (tests);
    // a negative number turns it off.
    membershipRecheckMs = 60_000,
    // The run402 client the NODE uses (DD-27). It lives here, in the node's own
    // process, and never in an agent's — that is the whole reason the tool gate
    // refuses run402 rather than gating it. Injectable so a test can drive the
    // deploy path end to end without spending anything.
    run402 = null,
    // How the node decides a relaunched harness is listening (DD-34). Injected
    // so a test can hold a respawn open and prove the second wake arriving
    // during it does not start a second process.
    awaitAgentReady = waitForAgentReady,
    // The relay's HTTP query door (F-11). Injectable for the same reason
    // `makeCli` is; production uses the real one.
    queryEvents = queryRelayEvents,
    submitEvent = submitRelayEvent,
    log = console.error,
  }) {
    this.#queryEvents = queryEvents;
    this.#submitEvent = submitEvent;
    this.#awaitAgentReady = awaitAgentReady;
    this.#run402 = run402 ?? makeRun402Cli({ cliPath: config?.tools?.run402Cli ?? null });
    this.#membershipRecheckMs = membershipRecheckMs;
    this.#trustWorkspace = trust;
    this.#pid = pid;
    // Default to the file-backed log rooted in THIS node's state dir. An
    // in-memory default would silently drop every entry the tool gate writes
    // from the agent's own process, which is the half of the record that exists
    // to catch what the node's own classifier missed (DD-16).
    this.audit = audit ?? new AuditLog(auditFile(stateDir));
    if (isAlive) this.#isAlive = isAlive;
    this.#identify = identify ?? null;
    this.#config = config;
    this.#configDir = configDir ?? process.cwd();
    this.#stateDir = stateDir;
    this.#spawn = spawn;
    this.#makeCli = makeCli;
    this.#resolveKey = resolveKey;
    this.#log = log;
    this.readAttestation = readAttestation ?? ((agent) => readAttestationFile(stateDir, agent));
  }

  get stateDir() {
    return this.#stateDir;
  }

  #pidFilePath() {
    return path.join(this.#stateDir, PID_FILE);
  }

  // TR-003 / AC-41: a node that cannot reconcile leaves orphans. Cycle 1 found a
  // buzz-acp process still connected 7.5 hours after the session that started
  // it, under the same identity as the live agent. `up` must therefore be
  // idempotent: adopt or clear what a previous run left behind rather than
  // stacking a second copy on top of it.
  #readPidFile() {
    const file = this.#pidFilePath();
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  // FOUND BY RUNNING THE MEMBERSHIP TEST ON A LIVE COMMUNITY (2026-08-26).
  //
  // This used to be called ONCE, at the end of `start()`. Every relaunch after
  // that — a respawn, or a channel change — replaced the child without
  // rewriting the file, so the record named a pid that was already dead while
  // the real process ran untracked. Measured after two channel changes: two
  // live `buzz-acp` processes, and a pid file naming a third that was gone.
  //
  // Both halves of that are serious. `hive402 down` stops what the pid file
  // RECORDS (it runs in a different process and cannot hold child handles), so
  // an untracked agent cannot be stopped at all — TR-003, the buzz-acp still
  // running 7.5 hours after the session that started it. And two live harnesses
  // under one identity answer every message twice, which is the F-008 duplicate
  // class that FIX-120's own comment claims this design prevents.
  //
  // So it is written wherever `#children` changes, not once at the end.
  #writePidFile() {
    mkdirSync(this.#stateDir, { recursive: true });
    const agents = [...this.#children.entries()].map(([name, child]) => ({ name, pid: child.pid }));
    writeFileSync(
      this.#pidFilePath(),
      // `startedAt` is WHEN THIS RECORD WAS WRITTEN, not when the node booted —
      // `classifyRecorded` compares it against each pid's real start time to
      // catch a recycled pid ("it started after we wrote this, so it cannot be
      // ours"). Stamping it once at construction, as a first attempt at this
      // fix did, makes every child look like it started AFTER the record and
      // reports a healthy agent as `stale-record`. The probe caught that
      // immediately, which is the probe doing exactly its job (DD-25, O-1).
      `${JSON.stringify({ node: this.#pid, startedAt: Date.now(), agents }, null, 2)}\n`,
      "utf8",
    );
  }

  // The bare "does a process hold this number" check. Kept only as the
  // fallback `classifyRecorded` uses when the real probe cannot answer — it is
  // not, on its own, an answer to "is my node running" (DD-25).
  #isAlive = isPidAlive;

  // O-4: resolve EVERY identity's key before starting anything.
  //
  // Resolution used to happen lazily, as each identity was first needed, so a
  // config missing three keys reported them one per run — three failed `up`s to
  // learn one fact, at the moment the room is already down. Nothing here is
  // side-effecting: it asks the resolver for each key and throws the whole set
  // of failures at once. The values are deliberately not retained; the callers
  // below re-resolve at the point of use so a key still lives in exactly one
  // place (AC-32).
  async #preflightKeys() {
    const refs = [{ label: "node", ref: this.#config.node.privateKeyRef, opts: { role: "node" } }];
    for (const room of this.#config.rooms) {
      for (const agent of room.agents) {
        refs.push({ label: `agent "${agent.name}"`, ref: agent.privateKeyRef, opts: { agent: agent.name } });
      }
    }

    const problems = [];
    // Absent and unreadable are DIFFERENT, and telling them apart is the whole
    // point of `ABSENT_EXIT`. The first cut of FIX-127 collapsed them into one
    // sentence while shortening the message, which is the same mistake one layer
    // up: "I could not read it" and "there is nothing there" need different
    // answers, and a reader given the absent answer for a read failure goes
    // looking for a key that was never missing.
    let anyAbsent = false;
    let anyUnreadable = false;
    for (const { label, ref, opts } of refs) {
      try {
        await this.#resolveKey(ref, opts);
      } catch (err) {
        // The label, plus the REF when the ref is the actionable part. For an
        // `env:` reference the thing the reader needs is the VARIABLE NAME, and
        // `agent "spike"` does not tell anybody to set HIVE402_SPIKE_KEY.
        // `keychain` adds nothing, so it is left off.
        problems.push(ref && ref !== "keychain" ? `${label} (${ref})` : label);
        if (/^no key for/.test(err.message)) anyAbsent = true;
        else anyUnreadable = true;
      }
    }
    if (problems.length === 0) return;

    // FIX-127. This used to print each resolver error in full and end with "Set
    // all of them" — fourteen lines whose loudest advice was `hive402 keygen
    // --node`. Barry reported it as "too verbose!!!", and the length was the
    // smaller half of what was wrong with it.
    //
    // `up` MUST NOT advise creating an identity. By the time it runs, the config
    // already names a pubkey for every identity here. A new key would not match
    // that pubkey, so the agent the room can see and the agent this node holds
    // would be two different identities — which is precisely how an "Unnamed
    // member" appeared in Barry's own community on 2026-08-26, and the reason
    // `keychain.mjs` learned to tell absent from unreadable.
    //
    // SAY WHERE IT LOOKED. Barry hit this on a machine whose key files were on
    // disk and whose `hive402 keys list` said "key stored", which is a flat
    // contradiction the product gave him no way to resolve — because nothing it
    // printed named the place it had searched. On Windows that place comes from
    // `$env:LOCALAPPDATA` in the shell running the command, so a session with a
    // different one looks at a different, empty directory and truthfully reports
    // nothing there.
    //
    // This is not the path dump he objected to on the config error. That listed
    // three SPECULATIVE candidates; this names the ONE place actually used, and
    // it is the fact that resolves the contradiction.
    // CONFIRMED ON BARRY'S MACHINE, 2026-08-27: his process printed the correct
    // store path and then saw ZERO entries in it, where another process on the
    // same machine sees two files. So "no key" was never the finding — the
    // process could not look. That is absent-versus-unreadable one level further
    // out again: at the DIRECTORY rather than at the entry.
    //
    // Asked before any per-identity verdict is reported, because if the store
    // cannot be read then all of them are meaningless and the remedy has nothing
    // to do with keys.
    const store = inspectStore();
    if (store.unreadable) {
      throw new Error(
        `cannot start: the credential store is UNREADABLE from this process (${store.reason}).\n` +
          `  ${credentialLocation()}\n` +
          `  Your keys are probably fine: nothing could be read, so nothing was found.\n` +
          `  Do NOT create or import keys. Run from a shell with normal access to your own AppData.`,
      );
    }

    const where = anyAbsent ? `\n  Looked in: ${credentialLocation()}` : "";
    const diagnosis = anyUnreadable
      ? `  The credential store could not be READ. The keys are probably fine; run up again.`
      : `  Check with: hive402 keys list\n` +
        `  If that says "key stored", this shell is looking somewhere else. Compare the path above.`;
    throw new Error(
      `cannot start: no usable key for ${problems.join(", ")}.\n` +
        `  Your config already names these identities, so do NOT create new keys for them.${where}\n` +
        diagnosis,
    );
  }

  async start() {
    mkdirSync(this.#stateDir, { recursive: true });
    await this.#preflightKeys();

    const previous = this.#readPidFile();
    if (previous) {
      const recordedAt = previous.startedAt ?? null;
      const recorded = [previous.node, ...(previous.agents ?? []).map((a) => a.pid)].filter(Boolean);
      // One probe for every recorded pid: `up` is a hand-run command, but there
      // is no reason to pay for a sub-process per line of the pid file.
      const identify = this.#identify ?? makeIdentifier(recorded);
      const classify = (pid, kind) =>
        classifyRecorded({ pid, kind, recordedAt, identify, isAlive: this.#isAlive });

      // A live node from a previous run is a HARD stop, not something to
      // reconcile around. Two nodes watching one room relay the same message
      // twice, dispatch the same turn twice, and burn the turn cap twice —
      // observed live on 2026-08-15 as three identical wakes from three nodes.
      //
      // But "a process holds that number" is not the same claim as "my node is
      // still running", and treating them as one wedged the rig for a morning
      // (O-1). So the number is checked against who actually holds it (DD-25),
      // and only a confirmed — or unconfirmable — node stops the start.
      if (previous.node && previous.node !== this.#pid) {
        const verdict = classify(previous.node, "node");
        if (verdict.state === "ours") {
          throw new Error(
            `another hive402 node is already running (pid ${previous.node}) and watching this room. ` +
              `Run "hive402 down" first — two nodes would relay every message twice.`,
          );
        }
        if (verdict.state === "unconfirmed") {
          throw new Error(
            `a previous node was recorded as pid ${previous.node} and that process is still running, but ` +
              `hive402 could not confirm it is a node (${verdict.detail}). Refusing to start a second one — ` +
              `two nodes would relay every message twice. Check the process, then run "hive402 down".`,
          );
        }
        // gone | reused — reclaim it, and SAY SO. A silent reclaim is how an
        // operator ends up not knowing their node died overnight.
        // Kept, but said in English (FIX-128). "Clearing a stale node record"
        // describes what the code is doing; what the person needs to know is
        // that their node had stopped without them noticing, which is exactly
        // the thing a silent reclaim would hide.
        this.#log(`hive402: the previous node had already stopped.`);
      }

      // Adopt only agents we can still recognise. An adopted entry is one
      // `stop()` will later kill by number, so adopting a recycled pid would
      // turn `hive402 down` into a way to kill an unrelated process.
      const live = [];
      for (const a of previous.agents ?? []) {
        const verdict = classify(a.pid, "agent");
        if (verdict.state === "ours" || verdict.state === "unconfirmed") live.push(a);
        else if (verdict.state === "reused") this.#log(`hive402: clearing a stale ${a.name} record — ${verdict.detail}.`);
      }

      if (live.length > 0) {
        this.#log(
          `hive402: ${live.length} agent process(es) from a previous run are still alive ` +
            `(${live.map((a) => `${a.name}:${a.pid}`).join(", ")}). Adopting them — ` +
            `run "hive402 down" first to restart cleanly.`,
        );
        // `recordedAt` travels with the adopted entry so a later liveness check
        // keeps the start-time half of DD-25 — without it, a pid recycled onto
        // another buzz-acp would read as "still ours" forever.
        for (const a of live) {
          this.#children.set(a.name, { pid: a.pid, adopted: true, recordedAt, kill: () => killPid(a.pid) });
        }
      } else {
        rmSync(this.#pidFilePath(), { force: true });
      }
    }

    // Every agent's key, once. Membership discovery asks the relay AS each
    // agent, so the keys are needed before the watch set exists.
    for (const agent of this.#config.rooms.flatMap((room) => room.agents)) {
      this.#agentKeys.set(agent.name, await this.#resolveKey(agent.privateKeyRef, { agent: agent.name }));
    }

    // AC-48: the relay decides which channels are watched, not the config.
    const discovered = await this.#discoverRooms();
    const broughtUp = new Set();

    for (const room of discovered) {
      const nodeCli = this.#makeCli({
        role: "node",
        privateKey: await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" }),
        authTag: null, // the node is a plain member, not an agent
      });

      // Lookups are identity-neutral, so the node's client reads the directory.
      const publisher = new IdentityPublisher({ cli: nodeCli });

      for (const agent of room.agents) {
        // ONCE per agent, not once per channel: an agent is one process
        // subscribed to every channel it belongs to (`--channels` is a list).
        // Launching per channel would put two buzz-acp processes under one
        // identity, which answers every message twice — the F-008 duplicate
        // class in a new place.
        if (broughtUp.has(agent.name)) continue;
        broughtUp.add(agent.name);
        await this.#bringUpAgent({
          agent,
          room: { ...room, workshop: this.#workshopFor(agent.name, discovered) },
          channels: this.#membership.get(agent.name) ?? [room.channel],
          publisher,
        });
      }

      this.#rooms.push(await this.#watchRoom(room, { nodeCli, publisher }));
    }

    // Say "online" as the NODE, and keep saying it (AC-60). After the rooms so
    // a node that fails to start never advertises a liveness it does not have,
    // and unconditionally — a node watching zero channels is still a node
    // other rooms' cover logic asks about (DD-53). The record goes through
    // the `/events` door, NOT relay presence: presence is connection-bound
    // and a one-shot publisher's is erased on disconnect (see heartbeat.mjs).
    const nodeKey = await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" });
    this.#heartbeat = new Heartbeat({
      publish: (status) =>
        this.#submitEvent({
          origin: cliRelayUrl(this.#config.relayUrl),
          event: buildLiveness({ privateKeyHex: nodeKey, status }),
          privateKeyHex: nodeKey,
          nip98: nip98Header,
        }),
      log: this.#log,
    });
    await this.#heartbeat.start();

    this.#writePidFile();
    return { agents: [...this.#children.keys()] };
  }

  // ONE recipe for starting to watch a channel, used by `start()` and by the
  // membership re-check. A second construction site is how a channel discovered
  // later quietly gets a different dispatcher configuration from one discovered
  // at start — the same reasoning that keeps the agent launch to a single call
  // site (DD-34).
  async #watchRoom(room, { nodeCli = null, publisher = null } = {}) {
    const cli =
      nodeCli ??
      this.#makeCli({
        role: "node",
        privateKey: await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" }),
        authTag: null,
      });
    const entry = {
      room,
      cli,
      publisher: publisher ?? new IdentityPublisher({ cli }),
      seen: new Set(),
      // FIX-124: null means NOT ESTABLISHED, which is not the same as empty.
      // The tick loop refuses to dispatch from a room whose history it could not
      // read, and retries — see `#establishWatermark`.
      watermark: null,
      // What the node missed while it was down, oldest first. Dispatched once,
      // on the first tick, ahead of live traffic.
      backlog: [],
      // Peer cover (F-11, DD-52..54): who else's agents live in this channel,
      // which nodes host them, and the taken-message promises this node may
      // owe. Refreshed from the world-readable registry alongside membership.
      cover: new CoverTracker(),
      // What this node handed straight to a running harness, and has not yet
      // seen an answer to (FIX-135, F-023). Room-local like the cover set: it
      // is a receipt for live traffic, not durable state.
      handoff: new HandoffTracker(),
      foreign: [],
      registryAgents: new Set(),
      knownNodes: new Set(),
      foreignAt: 0,
      presenceAt: 0,
      presence: { ok: false, map: new Map() },
      // The promises OTHER nodes made for THIS node's agents while it was off
      // (F-11, DD-55): collected once per watched channel, dispatched ahead of
      // the FIX-124 backlog, oldest first.
      promised: [],
      promisesCollected: false,
      // FIX-164 (F-031, DD-65): which messages each backlog bound dropped, held
      // until the promise set is known so the AC-66 report can subtract the
      // ones this start is about to answer. Cleared once posted.
      pendingDrops: null,
      dispatcher: new Dispatcher({
          nodePubkey: this.#config.node.pubkey,
          agents: room.agents,
          // The runtime keeps the tally (DD-23); the node reads it, so the
          // pause notice and `/turns` describe the same budget the fuse uses.
          turnCap: new TurnCap({
            ...this.#config.turnCap,
            ledger: {
              used: (agent) =>
                (this.#config.turnCap?.limit ?? 20) -
                remainingTurns({
                  stateDir: this.#stateDir,
                  agent,
                  limit: this.#config.turnCap?.limit ?? 20,
                  windowMs: this.#config.turnCap?.windowMs ?? 3600000,
                }),
            },
          }),
          loopGuard: new LoopGuard(),
          audit: this.audit,
          // FIX-78. The dispatcher suppresses the wake when the harness would
          // have delivered the message itself, which is the normal case for an
          // agent's own owner — and that reasoning only holds while the harness
          // is up. The supervisor is the only party holding the processes, so it
          // answers the question.
          isAgentRunning: (agent) => this.#agentState(agent.name).alive,
          // The dispatcher must know how each agent is reachable so it can tell
          // "already delivered" from "dropped by the harness".
          respondTo: "allowlist",
          respondToAllowlist: [this.#config.node.pubkey],
          // Which run402 project this room deploys to, if any (DD-27). The
          // project is named here, by the owner, and never by an agent or by
          // whoever asked it for something.
          workshop: room.workshop ?? null,
        }),
    };
    await this.#establishWatermark(entry);
    return entry;
  }


  // ── Where the watch set comes from (AC-48, DD-48, FIX-120) ──────────────
  //
  // Not from the config. A per-room channel list is invisible to the room, and
  // it disagrees with the relay in both directions: an agent added to a channel
  // in Buzz Desktop stays deaf there until someone edits JSON and restarts the
  // node, and an agent REMOVED there keeps being launched with it. So the
  // channels are the ones the RELAY says each agent is a member of, read as
  // that agent (`buzz channels list --member`).
  //
  // The config keeps two jobs it is still the right place for: WHICH agents
  // this node hosts, and how to behave in a channel it finds itself in
  // (`workshop`, `respondTo`). It no longer says WHERE.
  //
  // ── The one case that still reads the config ────────────────────────────
  //
  // A relay that cannot be read must not mean "this agent belongs nowhere". A
  // network blip would take a working room down and call it configuration. So a
  // failed reading falls back to that agent's configured channels and says so
  // loudly. This is the deprecation window DD-48 describes — the config channel
  // is a last-known-good, not a second source of truth, and it is what makes
  // the field removable later without a flag day.
  #configuredChannelsFor(agentName) {
    return this.#config.rooms
      .filter((room) => room.agents.some((a) => a.name === agentName))
      .map((room) => room.channel);
  }

  #agentCli(agent, authTag) {
    return this.#makeCli({
      role: "agent",
      publishesFor: agent.name,
      privateKey: this.#agentKeys.get(agent.name),
      authTag,
    });
  }

  async #discoverRooms() {
    const agents = this.#config.rooms.flatMap((room) => room.agents);
    const settings = new Map(this.#config.rooms.map((room) => [room.channel, room]));

    const { memberships, failures } = await readMemberships({
      agents,
      cliFor: (agent) => this.#agentCli(agent, this.readAttestation(agent)),
    });
    for (const failure of failures) {
      this.#log(
        `hive402: could not read ${failure.agent}'s channel memberships (${failure.reason}) — ` +
          `falling back to the channels in the config for it`,
      );
    }

    const byChannel = new Map();
    for (const agent of agents) {
      // Fallback order matters, and getting it wrong is a real defect rather
      // than a cosmetic one. LAST KNOWN first: on a re-check, the config is
      // stale by construction — an agent added to a channel an hour ago is in
      // the current membership and not in the file — so falling back to the
      // config would silently DROP a live channel every time the relay
      // hiccuped. The config is only the cold-start answer, when there is no
      // last-known reading to keep.
      const channels =
        memberships.get(agent.name) ?? this.#membership.get(agent.name) ?? this.#configuredChannelsFor(agent.name);
      this.#membership.set(agent.name, channels);
      for (const channel of channels) {
        if (!byChannel.has(channel)) byChannel.set(channel, []);
        byChannel.get(channel).push(agent);
      }
    }

    this.#membershipCheckedAt = Date.now();
    return [...byChannel].map(([channel, roomAgents]) => {
      const configured = settings.get(channel);
      return {
        channel,
        respondTo: configured?.respondTo ?? "anyone",
        respondToAllowlist: configured?.respondToAllowlist,
        // Per-channel, as before. A channel the config has never heard of has
        // no workshop, which is the safe answer: a workshop is a run402 project
        // and a public subdomain on the owner's account, and it is named by the
        // owner or not at all (DD-27).
        workshop: configured?.workshop ?? null,
        agents: roomAgents,
      };
    });
  }

  // An agent's workshop is the one belonging to a channel it is in. Ambiguity
  // is possible now that membership is discovered — two channels, two projects,
  // one working directory — so it is reported rather than resolved silently.
  #workshopFor(agentName, rooms) {
    const found = rooms.filter((room) => room.workshop && room.agents.some((a) => a.name === agentName));
    if (found.length > 1) {
      this.#log(
        `hive402: WARNING ${agentName} is in ${found.length} channels with a run402 workshop ` +
          `(${found.map((r) => r.workshop.project).join(", ")}). It has one working directory, so ` +
          `"${found[0].workshop.project}" is the one it will deploy to.`,
      );
    }
    return found[0]?.workshop ?? null;
  }

  async #bringUpAgent({ agent, room, channels = null, publisher }) {
    const authTag = this.readAttestation(agent);
    if (!authTag) {
      throw new Error(
        `agent "${agent.name}" has no owner attestation on file — run ` +
          `"hive402 register --agent ${agent.name}" first (AC-35)`,
      );
    }

    // 1. Publish, so any client can resolve "@name" (the F-001 root cause).
    //
    // This MUST happen under the agent's own identity: `buzz users set-profile`
    // updates the CALLING identity's profile. Publishing through the node's
    // client renames the node, leaving the agent unpublished and "@name"
    // pointing at the wrong pubkey — which the AC-39 check below caught live
    // on 2026-08-15 before it could reach a test cycle.
    const agentCli = this.#makeCli({
      role: "agent",
      publishesFor: agent.name,
      privateKey:
        this.#agentKeys.get(agent.name) ?? (await this.#resolveKey(agent.privateKeyRef, { agent: agent.name })),
      authTag,
    });
    const agentPublisher = new IdentityPublisher({ cli: agentCli });
    // The node is a legitimate attester since FIX-117, so say so: without this
    // the publisher falls back to comparing against `ownerPubkey` alone, and an
    // agent re-registered under the node is refused by its own node.
    await agentPublisher.publish({
      agent: { ...agent, authTag },
      authTag,
      attestedBy: this.#config.node.pubkey,
    });

    // The workshop's source directory, created up front so the agent has an
    // obvious place to build into and the room's first deploy attempt is not
    // "there is no such directory". It sits inside the agent's own scratch
    // working directory, so writing into it is composition rather than an
    // action on the world (the gate's `insideScratch` rule) — a contained agent
    // can still build the thing it is asking permission to publish.
    if (room.workshop) {
      mkdirSync(this.#siteDir(agent.name), { recursive: true });
      // And say what it is FOR. Without this the agent never reaches for
      // run402, the gate never refuses one, and the whole deploy path — caller
      // and all — is never triggered by anything (found live, 2026-08-18).
      writeWorkshopGuide({
        workDir: agentWorkDir({ root: path.join(this.#stateDir, "work"), agent: agent.name }),
        agent,
        workshop: room.workshop,
      });
    }

    // 1b. The record a client's @ picker is built from (AC-51, FIX-123).
    //
    // Publishing kind 0 makes `@name` RESOLVE; it does not make the agent
    // appear in the menu. Barry's picker listed four Desktop-managed agents,
    // three of them "not in channel", and not `smith` — which was in the
    // channel. The difference is a kind-30177 record, which hive402 never wrote.
    //
    // Never fatal. An agent attested by a HUMAN cannot have one written by this
    // node (the author must be the verified owner, and AC-43 forbids holding a
    // human's key), so an agent registered before FIX-117 will land here and be
    // told what to do rather than blocking its own launch.
    try {
      await publishManagedAgent({
        agent,
        authTag,
        ownerPrivateKeyHex: await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" }),
        origin: cliRelayUrl(this.#config.relayUrl),
        respondTo: "anyone",
        nip98: nip98Header,
      });
    } catch (err) {
      this.#log(
        `hive402: ${agent.name} will not appear in a client's @ picker (${err.message}) — ` +
          `it can still be addressed by typing the name in full`,
      );
    }

    // Verify through the node's own client — a lookup, not a claim.
    const report = await publisher.check({ agent });
    if (!report.addressable) {
      this.#log(`hive402: WARNING ${report.problems.join("; ")}`);
    }

    if (this.#children.has(agent.name)) return; // adopted from a previous run

    await this.#launchAgentProcess({ agent, room, channels, authTag, kind: "launch" });
  }

  // THE launch recipe — the one place in this product that starts an agent.
  //
  // Split out of `#bringUpAgent` for DD-34: a wake that finds its agent gone has
  // to start it again with the IDENTICAL recipe, and a second spawn site is how
  // a respawned agent quietly loses a policy flag or an env var that `up`
  // supplies. `respawn.test.mjs` asserts there is exactly one spawn call site
  // left in this file, so the two can never drift apart.
  //
  // The publish/attest half stays in `#bringUpAgent`: an agent's kind-0 profile
  // is relay-side state that outlives its process, so a relaunch does not need
  // to re-advertise — and every relay round-trip skipped here is a second the
  // human is waiting.
  async #launchAgentProcess({ agent, room, channels = null, authTag, kind = "launch" }) {
    // 2. Compile capabilities into a runtime the agent cannot argue with.
    //    These are PROJECT settings, applied by launching the agent in its own
    //    working directory — see capabilities.mjs for why not CLAUDE_CONFIG_DIR.
    //
    //    Two layers, doing two different jobs. The deny lists say what the
    //    OWNER enabled and never change while the process lives. The tool gate
    //    says what THIS TURN may do, and is the layer F-007 was missing: spike's
    //    `research` was genuinely on, so no static list had anything to say when
    //    a non-owner's request slipped past the verb lexicon.
    const { workDir } = writeAgentRuntimeConfig({
      agent,
      root: path.join(this.#stateDir, "work"),
      gate: {
        nodeBin: this.#nodeBin(),
        script: TOOLGATE,
        turnScript: TURNGATE,
        turnCap: this.#config.turnCap,
        stateDir: this.#stateDir,
        // AC-55 through the gate (DD-56): the agent's own instructions file is
        // never the agent's to edit, on any turn, whatever the grant carries.
        governedPaths: [instructionsFilePath({ agent, configDir: this.#configDir })].filter(Boolean),
      },
    });

    // Contained from the first instant. Between "the process is up" and "the
    // node has seen a message about it" there must still be a record on disk,
    // or that window is the one place a turn could run unjudged.
    writeWithheld({
      stateDir: this.#stateDir,
      agent: agent.name,
      reason: "launched — no turn has been authorised yet",
    });
    // The runtime gates unseen directories behind a trust prompt a headless
    // agent cannot answer — it just fails every turn (live, 2026-08-15).
    this.#trustWorkspace({ workDir });

    // 3. Launch with the full explicit policy env.
    const gate = inboundGateFor({ agent, nodePubkey: this.#config.node.pubkey });
    const env = buildAgentEnv({
      agent: { ...agent, authTag },
      room: { ...room, relayUrl: this.#config.relayUrl, ...gate },
      secrets: { agentPrivateKey: await this.#resolveKey(agent.privateKeyRef, { agent: agent.name }) },
      // This hive, so the agent runs on the model this hive named (AC-74/75).
      node: this.#config.node,
      // Who this agent is (AC-55, DD-45), read fresh on every launch so an
      // owner's edit takes effect on the next restart or respawn. A missing
      // instructionsFile throws here and fails the launch loudly, rather than
      // starting an agent with a character its owner thinks it has.
      instructions: resolveInstructions({ agent, configDir: this.#configDir }),
      // The path they came FROM, resolved once, so the launcher's "could the
      // agent rewrite this?" guard asks about the same file that was read.
      instructionsPath: instructionsFilePath({ agent, configDir: this.#configDir }),
      workDir,
      toolPaths: {
        buzzDir: this.#config.tools.buzzDir,
        nodeDir: this.#config.tools.nodeDir,
        extraDirs: this.#config.tools.extraDirs,
      },
    });

    // Capture the harness's output per agent. Two reasons: an operator needs
    // somewhere to look when an agent misbehaves, and the harness's own
    // `buzz-acp starting:` line prints the EFFECTIVE policy it resolved —
    // which is the authoritative surface for verifying AC-41/AC-42. Cycle 1
    // read the process command line instead, which cannot show env-supplied
    // policy at all (see the Blue Team Response on F-005).
    const logFile = path.join(this.#stateDir, "logs", `${agent.name}.log`);
    mkdirSync(path.dirname(logFile), { recursive: true });
    // Where THIS run's output starts. The file is opened for append, so a
    // readiness check that read the whole thing would find the PREVIOUS run's
    // `agent_pool_ready` and return immediately (DD-34).
    const logFromByte = existsSync(logFile) ? statSync(logFile).size : 0;
    const logFd = openSync(logFile, "a");

    const child = this.#spawn(
      path.join(this.#config.tools.buzzDir ?? "", "buzz-acp.exe"),
      [
        // Every channel this agent belongs to, in ONE process. `--channels`
        // takes a comma-delimited list (buzz-acp config.rs, `value_delimiter =
        // ','`), and one agent identity must have exactly one harness — two
        // would answer every message twice.
        "--channels", (channels?.length ? channels : [room.channel]).join(","),
        "--agent-command", "node",
        "--agent-args", this.#config.tools.adapter,
        // AC-41/AC-42 as explicit FLAGS as well as env (DD-18). The harness's
        // own startup line prints 21 settings and none of these three, so env
        // alone leaves the policy unverifiable from outside the process — which
        // is exactly what F-005/TR-004 ran into, twice. A flag is visible in the
        // process command line to anyone with a standard OS tool.
        ...lifetimePolicyArgs(),
      ],
      // `windowsHide` FOUND BY BARRY, THE HARD WAY: a console window appeared on
      // his desktop, he closed it, and smith stopped answering.
      //
      // It was never the node. While the node ran in the foreground it shared
      // the operator's console and `buzz-acp.exe` quietly reused it. The moment
      // the node became a background process with no console of its own
      // (FIX-128), the harness had nowhere to attach and Windows gave it a NEW
      // one: a visible window, titled with its working directory, that looks
      // exactly like a stray terminal somebody should tidy away. Closing it
      // killed the agent.
      { env, cwd: workDir, stdio: ["ignore", logFd, logFd], detached: false, windowsHide: true },
    );
    child.logFile = logFile;
    child.logFromByte = logFromByte;
    this.#children.set(agent.name, child);
    // Record it NOW. A child the pid file does not name cannot be stopped by
    // `hive402 down`, which runs in a different process and knows only this file.
    this.#writePidFile();
    this.audit.action({
      agent: agent.name,
      actor: "node",
      kind,
      detail: `respond_to=${gate.respondTo} research=${agent.research} build=${agent.build}`,
    });
    return child;
  }

  // Is this agent's process still there, and if not, bring it back before the
  // wake is published (DD-34).
  //
  // Deliberately NOT async: everything from reading the in-flight map to writing
  // it back runs in one synchronous block, so two wakes cannot both decide to
  // spawn. The second one awaits the first one's promise and its wake is
  // published after the relaunch, in order.
  // The one place that answers "is this agent's process there?", so the wake
  // path, the dispatcher's delivery reasoning and `status` cannot disagree.
  #agentState(name) {
    const child = this.#children.get(name);
    return agentProcessState(child, {
      classify: agentClassifier({
        recordedAt: child?.recordedAt ?? null,
        identify: this.#identify,
        isAlive: this.#isAlive,
      }),
    });
  }

  // What to call the person who asked (AC-49, DD-41).
  //
  // Best effort by design. A wake that cannot be published because a profile
  // lookup failed would be the attribution costing more than it adds, so every
  // failure resolves to "no name" and the line falls back to the short pubkey —
  // which is the part that actually identifies someone anyway. The name is
  // convenience; the key is the fact.
  //
  // Whatever comes back is untrusted text: `safeDisplayName` (in
  // attribution.mjs) flattens it before it reaches a line.
  async #displayName(entry, pubkey) {
    if (!pubkey) return null;
    if (this.#names.has(pubkey)) return this.#names.get(pubkey);

    let name = null;
    try {
      const profile = await entry.cli.getUser({ pubkey });
      name = profile?.display_name ?? profile?.name ?? null;
    } catch (err) {
      this.#log(`hive402: could not look up ${short(pubkey)}…'s name: ${err.message}`);
    }
    // Bounded: a busy room sees many authors, and this map outlives all of them.
    if (this.#names.size > 500) this.#names.delete(this.#names.keys().next().value);
    this.#names.set(pubkey, name);
    return name;
  }

  #ensureAgentRunning({ agent, entry }) {
    const inflight = this.#respawns.get(agent.name);
    if (inflight) return inflight;

    const state = this.#agentState(agent.name);
    if (state.alive) return Promise.resolve({ respawned: false, ...state });

    const task = this.#respawnAgent({ agent, entry, state }).finally(() => this.#respawns.delete(agent.name));
    this.#respawns.set(agent.name, task);
    return task;
  }

  async #respawnAgent({ agent, entry, state }) {
    this.#log(
      `hive402: ${agent.name} is not running (${state.detail}) — relaunching it for the message that just addressed it`,
    );
    this.audit.action({ agent: agent.name, actor: "node", kind: "respawn", detail: state.detail });

    // No room notice here any more (DD-43). The relaunch is a mechanism, not
    // news: the addressed agent's own client-side working indicator is what
    // tells the waiting human something is happening, and a second line from
    // the node duplicates it for that human while costing every other member of
    // the room a line to read. The audit row above keeps the fact recoverable.
    let child;
    try {
      const authTag = this.readAttestation(agent);
      if (!authTag) throw new Error(`no owner attestation on file (run "hive402 register --agent ${agent.name}")`);
      child = await this.#launchAgentProcess({ agent, room: entry.room, authTag, kind: "respawn" });
    } catch (err) {
      this.#log(`hive402: could not relaunch ${agent.name}: ${err.message}`);
      this.audit.action({ agent: agent.name, actor: "node", kind: "respawn-failed", detail: err.message });
      await entry.cli
        .send({
          channel: entry.room.channel,
          content: `${agent.name} is not running and hive402 could not restart it: ${err.message}`,
          mentions: [],
        })
        .catch(() => {});
      throw err;
    }

    // The pid file is what `down`, `status` and the next `up` read. Leaving the
    // old number in it turns `hive402 down` into a way to miss the live agent
    // and possibly signal a recycled pid instead.
    this.#writePidFile();

    const ready = await this.#awaitAgentReady({
      logFile: child.logFile,
      fromByte: child.logFromByte ?? 0,
      channel: entry.room.channel,
    });
    if (!ready.ready) {
      this.#log(`hive402: ${agent.name} was relaunched but ${ready.detail} — publishing the wake anyway`);
    }
    return { respawned: true, ready, pid: child.pid };
  }

  // Everything already in the room when we started is history, not a backlog.
  // Without this, restarting the node re-answers every message it can see.
  //
  // FIX-124 keeps that rule and cuts one window in it: a message ADDRESSED TO
  // ONE OF THIS NODE'S AGENTS, newer than where this node got to last time, and
  // inside a bounded age, is not history — it is what the node missed while the
  // machine was off, and answering it is the whole point of AC-2. See
  // `backlog.mjs` for why the boundary is a resume point rather than a shutdown
  // time (short version: the case that matters is the one where nothing gets to
  // run at shutdown).
  //
  // FIX-124 also closes the opposite failure, which was live and undocumented:
  // this used to swallow a failed relay read and return an EMPTY set. Empty does
  // not mean "no history" to the tick loop — it means every mention visible in
  // the room is unseen, and gets answered. A network blip at startup was enough
  // to flush a room. So a watermark that could not be read is now NULL, the tick
  // loop declines to dispatch from that room, and it retries.
  //
  // Returns true when the room is ready to dispatch from.
  async #establishWatermark(entry) {
    if (entry.watermark) return true;
    const { cli, room } = entry;

    let events;
    try {
      events = await cli.getMessages({ channel: room.channel, limit: 100 });
    } catch (err) {
      this.#log(
        `hive402: could not read ${room.channel} history (${err.message}) — ` +
          `not dispatching from it until that read succeeds`,
      );
      return false;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const { watermark, backlog, agedOutIds, droppedIds } = partitionOnResume({
      events,
      resumeFrom: readResumePoint({ stateDir: this.#stateDir, channel: room.channel }),
      agents: room.agents,
      now: nowSec,
      maxAgeSec: Math.floor(this.#backlog().maxAgeMs / 1000),
      maxItems: this.#backlog().maxItems,
    });

    entry.watermark = watermark;
    entry.backlog = backlog;

    // "1 message", not "1 message(s)". The parenthesised plural is the shape of
    // a string built by somebody who did not want to think about the reader, and
    // these lines are read by a person starting their node (FIX-128).
    const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (backlog.length) {
      this.#log(
        `hive402: answering ${count(backlog.length, "message")} that arrived while it was off.`,
      );
    }

    // ── FIX-164 (F-031, DD-65): what was dropped is not decided HERE ───────
    //
    // This used to compose and publish both AC-66 reports inline. It cannot: at
    // this point in the tick the node knows only what the two BOUNDS dropped,
    // and "dropped" is not the same fact as "not answered". A message with a
    // standing AC-61 promise is answered by `#collectPromises`'s replay about a
    // second later, and the spec says so in as many words — AC-63 answers a
    // promised message "regardless of the message's age", and AC-66's subject
    // is a message that "was promised nothing".
    //
    // So the ids are held and `#reportBacklogDrops` publishes them once the
    // promise set for this start is known. Deliberately NOT the other order:
    // moving `#collectPromises` above this would gate the WATERMARK on a relay
    // query succeeding, and DD-64/FIX-160 decided the opposite in as many words.
    // Holding the report is not the same act as holding the dispatch, and only
    // the report is wrong.
    entry.pendingDrops = { agedOutIds, droppedIds };
    return true;
  }

  // ── FIX-164 (F-027, F-031, AC-66): the drop reports reach the ROOM ───────
  //
  // Never silent, and — before FIX-142 — never anywhere the owner could read.
  // Both bounds were computed correctly and handed to `this.#log`, which is a
  // file on the machine running the node. From the room a dropped question is
  // indistinguishable from a question nobody asked, which is precisely the
  // failure `backlog.mjs` says these counts exist to end.
  //
  // Parity with AC-64's overflow notice is the specification, since AC-66 fixes
  // no wording of its own: same publish (`entry.cli.send` at the channel root,
  // no `replyTo`, no `mentions`), same audit row, same swallowed failure. The
  // console lines stay too — the operator at a terminal loses nothing.
  //
  // Called from the tick loop AFTER the promise set is known and BEFORE the
  // replay empties it, so the room still reads the report ahead of the wakes it
  // is about.
  //
  // Known and accepted: a node that posts this and dies before its first tick
  // advances the resume point announces once more on the next start. The count
  // is re-derived from the resume point rather than persisted, and AC-66's
  // failure direction is silence, not repetition.
  async #reportBacklogDrops(entry) {
    const pending = entry.pendingDrops;
    if (!pending) return;
    // Cleared whether or not anything is published, so this posts once per
    // start rather than once per tick.
    entry.pendingDrops = null;

    const { dropped, agedOut } = reconcileDrops({
      ...pending,
      promisedIds: entry.promised.map((p) => p.id),
    });

    for (const report of backlogDropReports({ dropped, agedOut, limit: this.#backlog().maxItems })) {
      this.#log(`hive402: ${report.text}`);
      try {
        await entry.cli.send({
          channel: entry.room.channel,
          content: backlogDropNotice(report),
        });
      } catch (err) {
        // A room that cannot be posted to must not stop the node dispatching,
        // or one relay blip becomes a room that never answers anything. Same
        // swallow as AC-64's notice, for the same reason.
        this.#log(
          `hive402: could not post the ${report.bound}-bound backlog report: ${err.message}`,
        );
      }
      this.audit.action({
        agent: "node",
        actor: "node",
        kind: "backlog-dropped",
        detail:
          report.bound === "count"
            ? `${report.count} backlogged message(s) beyond the count bound of ${this.#backlog().maxItems}`
            : `${report.count} backlogged message(s) past the age bound of ${this.#backlog().maxAgeMs}ms`,
      });
    }
  }

  // The backlog bounds, for a config that may not have come through the schema.
  // Every test builds one by hand, and so does any tool constructing a
  // Supervisor directly, so the defaults come from the one place that defines
  // them rather than being repeated as literals here.
  #backlog() {
    return { ...BACKLOG_DEFAULTS, ...(this.#config.backlog ?? {}) };
  }

  // How far this node has got in a channel, so the next start knows what it
  // missed. Written while alive, on every tick, because a machine that is
  // switched off runs no shutdown code (FIX-124).
  //
  // `created_at` is chosen by the sender, so a future-dated event is ignored
  // here as well as in the partition: letting one set the mark to 2099 would
  // permanently suppress every future backlog window, which turns a hostile
  // timestamp into a silent off switch for this whole feature.
  #advanceResume(entry, events) {
    const nowSec = Math.floor(Date.now() / 1000);
    let newest = null;
    for (const event of events) {
      const at = event?.created_at;
      if (!Number.isFinite(at) || at > nowSec) continue;
      if (newest == null || at > newest) newest = at;
    }
    if (newest == null) return;

    // FIX-132: HOLD the point back while an agent in this room has a live
    // failure, so what it could not answer is retried once on the next start.
    //
    // The point means "I have SEEN up to here", which is not "the agent
    // ANSWERED up to here". Barry asked smith twice while its model backend was
    // refusing to log in: the node saw both, relayed both, advanced past both,
    // and the questions were left permanently unanswered with nothing to retry
    // them. Same blind spot as FIX-129 and FIX-130 — the node not knowing what
    // the agent did — in a third place.
    //
    // Bounded to ONE retry by `heldFor`, which records the failure the hold was
    // made for. A persistently broken agent re-attempts its questions once and
    // then the room moves on, rather than re-asking everything on every restart
    // of something that is going to fail again.
    const failure = this.#liveFailureIn(entry);
    if (failure) {
      const already = readHeldFor({ stateDir: this.#stateDir, channel: entry.room.channel });
      if (already !== failure) {
        writeHeldFor({ stateDir: this.#stateDir, channel: entry.room.channel, failureAt: failure });
        this.#log(
          `hive402: holding this room's place — an agent could not answer, so those messages are retried on the next start`,
        );
        return; // the point stays where it is; the backlog window covers the rest
      }
      // Held once for this failure already. Advancing now is what stops a broken
      // agent looping over the same questions forever.
    }

    writeResumePoint({ stateDir: this.#stateDir, channel: entry.room.channel, at: newest });
  }

  // The timestamp of a LIVE failure for any agent in this room, or null.
  //
  // "Live" is the same judgement `doctor` makes: a failure the agent has not
  // come back from. A failure it HAS recovered from is history and must not hold
  // the room's place, or a single bad turn last Tuesday would pin the point
  // forever.
  #liveFailureIn(entry) {
    for (const agent of entry.room.agents ?? []) {
      try {
        const log = path.join(this.#stateDir, "logs", `${agent.name}.log`);
        if (!existsSync(log)) continue;
        const turn = lastAgentTurn(readFileSync(log, "utf8"));
        if (turn?.failed && !turn.restarted) return turn.at ?? "unknown";
      } catch {
        // A log that cannot be read is not evidence of anything. The point
        // advances as it always did.
      }
    }
    return null;
  }

  // Which node binary runs the tool gate. `process.execPath` is the node
  // already running this supervisor, so it is guaranteed to exist and to work;
  // the configured tools dir is only a fallback for an unusual install.
  #nodeBin() {
    return process.execPath || path.join(this.#config.tools.nodeDir ?? "", "node");
  }

  // Refusals written by the tool gate, which runs inside the agent's runtime
  // and cannot talk to the room itself.
  //
  // This is the return path that makes containment visible rather than merely
  // silent. F-007's fetch produced no approval request, no owner notification
  // and no audit entry; the same request now produces all three, and the
  // trigger for them is the agent REACHING FOR A TOOL, not anything anyone
  // wrote in a sentence.
  #drainBlocked() {
    const dir = path.join(this.#stateDir, "blocked");
    if (!existsSync(dir)) return [];
    const records = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        records.push(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        /* unreadable — drop it rather than re-reading it every 2s */
      }
      // Consume it either way: the directory is re-scanned on every tick, and
      // a record left behind would re-ask the owner forever.
      try {
        unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
    return records;
  }

  // One poll cycle. Separated from the timer so tests drive it directly.
  // Ask the relay again which channels each agent is in, and act on what
  // changed (AC-48). This is what makes "add the agent to a channel in your own
  // client" sufficient: nothing on the node's machine has to be edited, and
  // nothing has to be restarted by hand.
  async #recheckMembership() {
    if (this.#membershipRecheckMs < 0) return;
    if (this.#membershipRecheckMs > 0 && Date.now() - this.#membershipCheckedAt < this.#membershipRecheckMs) return;

    const before = new Map(this.#membership);
    let discovered;
    try {
      discovered = await this.#discoverRooms();
    } catch (err) {
      // Keep watching what we were watching. A re-check that fails must never
      // be the reason a live room goes quiet.
      this.#log(`hive402: channel membership re-check failed (${err.message}) — keeping the current channels`);
      return;
    }

    const watched = new Set(this.#rooms.map((entry) => entry.room.channel));
    const found = new Set(discovered.map((room) => room.channel));

    // Channels this node is no longer in. Dropped before the additions so a
    // move between two channels never has the node watching both.
    for (const entry of [...this.#rooms]) {
      if (found.has(entry.room.channel)) continue;
      this.#rooms = this.#rooms.filter((r) => r !== entry);
      this.#log(`hive402: no longer a member of ${entry.room.channel} — stopped watching it`);
      this.audit.action({ agent: "node", actor: "node", kind: "unwatch", detail: entry.room.channel });
    }

    for (const room of discovered) {
      const existing = this.#rooms.find((entry) => entry.room.channel === room.channel);
      if (existing) {
        // Same channel, possibly a different roster: the dispatcher decides who
        // may be addressed there, so it has to learn about an agent that just
        // joined.
        existing.room = room;
        existing.dispatcher.setAgents?.(room.agents);
        continue;
      }
      this.#rooms.push(await this.#watchRoom(room, discovered));
      if (!watched.has(room.channel)) {
        this.#log(`hive402: now a member of ${room.channel} — watching it`);
        this.audit.action({ agent: "node", actor: "node", kind: "watch", detail: room.channel });
      }
    }

    // An agent whose channel SET changed needs its harness restarted: the
    // subscription is a process argument, so a running agent is subscribed to
    // the list it was launched with and nothing else.
    for (const [name, channels] of this.#membership) {
      const delta = membershipDelta(before.get(name) ?? [], channels);
      if (!delta.changed || !before.has(name)) continue;
      const agent = this.#config.rooms.flatMap((r) => r.agents).find((a) => a.name === name);
      if (!agent) continue;
      this.#log(
        `hive402: ${name}'s channels changed` +
          `${delta.joined.length ? ` (+${delta.joined.join(", ")})` : ""}` +
          `${delta.left.length ? ` (-${delta.left.join(", ")})` : ""}` +
          ` — restarting it so the subscription matches`,
      );
      await this.#relaunchForChannels({ agent, channels, rooms: discovered });
    }
  }

  async #relaunchForChannels({ agent, channels, rooms }) {
    const child = this.#children.get(agent.name);
    try {
      child?.kill?.();
    } catch {
      /* already gone — the relaunch is what matters */
    }
    this.#children.delete(agent.name);
    const room = rooms.find((r) => r.agents.some((a) => a.name === agent.name)) ?? { channel: channels[0] };
    await this.#launchAgentProcess({
      agent,
      room: { ...room, workshop: this.#workshopFor(agent.name, rooms) },
      channels,
      authTag: this.readAttestation(agent),
      kind: "rechannel",
    });
  }

  async tick() {
    await this.#recheckMembership();

    // Authority is one record per message now (DD-20), so the directory would
    // grow without a sweep. Records are TTL-bound; expired ones can authorise
    // nothing, so removing them changes no decision.
    for (const entry of this.#rooms) {
      for (const agent of entry.room.agents) {
        try {
          pruneAuthorities({ stateDir: this.#stateDir, agent: agent.name });
        } catch (err) {
          this.#log(`hive402: could not prune ${agent.name}'s authorities: ${err.message}`);
        }
      }
    }

    // Turns the runtime refused on AC-26 grounds. The node is the only party
    // that can speak in the room about them.
    for (const entry of this.#rooms) {
      for (const agent of entry.room.agents) {
        for (const record of drainPauseRecords({ stateDir: this.#stateDir, agent: agent.name })) {
          for (const effect of entry.dispatcher.announcePause(record)) {
            await this.#apply({ entry, effect });
          }
        }
      }
    }

    for (const raw of this.#drainBlocked()) {
      const entry = this.#rooms.find((r) => r.room.agents.some((a) => a.name === raw.agent));
      if (!entry) continue;
      // Attribute it before the dispatcher sees it: which turn was refused is a
      // question only the runtime's own record can answer (DD-19), and getting
      // it wrong is how F-009 asked the owner to approve their own request under
      // somebody else's name.
      const record = this.#attribute(raw);
      for (const effect of entry.dispatcher.handleBlockedAction(record)) {
        await this.#apply({ entry, effect });
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    for (const entry of this.#rooms) {
      // FIX-124: a room whose history could not be read has NO watermark, and
      // dispatching from it would answer everything it can see. Retry here, and
      // stay silent in that room until the retry works.
      if (!(await this.#establishWatermark(entry))) continue;

      // Everything this tick sees for the first time, kept aside for the cover
      // pass below (F-11). Observed AFTER dispatching, deliberately: cover
      // must never add a millisecond in front of a wake, and its own pending
      // window is minutes wide.
      const fresh = [];

      // ── FIX-160 (F-030, DD-64): collect BEFORE the backlog drains ────────
      //
      // This used to sit at the END of the tick, with the backlog dispatching
      // at the TOP — so on the first tick after a restart the backlog always
      // won, `entry.seen` swallowed the promise, and a message the room was
      // explicitly told would be answered came back as an ordinary catch-up
      // wake: no replay note, and no AC-65 acknowledge-briefly instruction, so
      // a question a human had already answered got the full duplicate answer
      // AC-65 forbids in as many words.
      //
      // The comment that defended the late position is about not standing in
      // front of a LIVE wake. There is no live traffic at startup — the
      // backlog is itself minutes to hours old and the promises are older
      // still — so the one collection round trip costs nothing that matters.
      //
      // A FAILED collection releases the backlog anyway rather than holding it
      // behind a retrying query: FIX-124's failure direction (silence in a
      // room that could not be read) must not be widened into "a failed
      // promise query silences the backlog too".
      if (!entry.promisesCollected) {
        try {
          entry.promised = await this.#collectPromises(entry);
          entry.promisesCollected = true;
          if (entry.promised.length) {
            this.#log(
              `hive402: ${entry.promised.length} promised message(s) were taken for this node's ` +
                `agents while it was off — answering them now`,
            );
          }
        } catch (err) {
          this.#log(`hive402: could not collect promised messages: ${err.message} — retrying next tick`);
          // FIX-164 (DD-65): and the AC-66 report waits with it. The node
          // cannot subtract a promise set it does not have, so publishing now
          // would state the same number F-031 was about — derived from age
          // alone. A held report is announced on a later tick; a wrong one is
          // never taken back.
          if (entry.pendingDrops) {
            this.#log(
              `hive402: holding the backlog drop report for ${entry.room.channel} until the ` +
                `promise collection succeeds — it would otherwise count messages this node is ` +
                `about to answer`,
            );
          }
        }
      }

      // FIX-164 (F-031, DD-65): the AC-66 reports, now that the promise set for
      // this start is known and BEFORE the replay below empties it. Only ever
      // after a SUCCESSFUL collection — `promisesCollected` is the flag that
      // says the promise set is real rather than an empty default.
      if (entry.promisesCollected) await this.#reportBacklogDrops(entry);

      // Promised replay runs FIRST — these are the oldest debts, and the room
      // was explicitly told they would be answered. Same dispatcher, same
      // policy path, as every turn (DD-9); the only addition is the node's
      // replay note inside the wake.
      if (entry.promised.length) {
        const promised = entry.promised;
        entry.promised = [];
        for (const { id, original, agent, answeredByHuman } of promised) {
          if (entry.seen.has(original.id)) {
            // FIX-159 (DD-64): NO mark. `entry.seen` records dispatch
            // ATTEMPTS, not deliveries, so "another path touched this event"
            // is not evidence the promise was kept — and when that other path
            // was the silently-forked backlog drain, marking here retired a
            // promise the room never heard answered. Skipping the second
            // dispatch is still right (one delivery per message per start);
            // the promise simply stays owed, and the next start's
            // `threadVerdict` retires it if the agent really did answer.
            continue;
          }
          entry.seen.add(original.id);
          // FIX-158 (F-030): `forceRelay`, for the same reason the recovery
          // path already passes it, and on stronger evidence. Re-evaluating
          // `deliveredDirectly` here asks a question whose answer is already
          // known: the node was OFF when this message arrived, so no harness
          // ever saw it. `#isAgentRunning` answers a DIFFERENT question — is
          // the process alive — and `start()` launches every agent before the
          // tick loop, so on the first tick after a restart every promised
          // message from an agent's OWN OWNER read as "already delivered" and
          // was handed to buzz-acp with nothing published: no wake, no line in
          // the room, folded into a turn that was already running. The promise
          // the room was given, silently broken.
          const effects = entry.dispatcher.handle(original, { forceRelay: true });
          let published = false;
          for (const effect of effects) {
            // Rides the effect into `#apply`'s one wake-composition site, so
            // the note lands inside the same publish every other wake uses.
            effect.note = replayNote({ answered: answeredByHuman });
            // FIX-143: and says outright that this is not the message's first
            // delivery, so the answer-check receipt is not recorded for it. A
            // promise replayed once is FIX-132's posture; a receipt here would
            // relay it a second time under a different name.
            effect.redelivery = "replay";
            const landed = await this.#apply({ entry, effect });
            if (effect.type === "wake" && landed) published = true;
          }
          // FIX-159 (DD-64): the mark means *this promise has been kept, or
          // the room was told why not*. It used to be written unconditionally,
          // whatever `handle()` returned and whether or not anything reached
          // the room — so a dispatch that published nothing retired the
          // promise forever, on disk, while the only net that could have
          // caught it lived in memory.
          //
          // Three outcomes, and only one of them is a swallow:
          //   • a wake that PUBLISHED — kept, mark it;
          //   • a handoff receipt and no wake — the receipt owns the message
          //     from here, so the promise must not be retired behind its back
          //     (unreachable while both re-delivery arms force the relay, and
          //     stated anyway so a fourth call site cannot get it wrong);
          //   • no wake to publish at all — genuinely nothing to deliver, so
          //     mark it, or a promise that can never produce a wake would be
          //     re-collected on every start forever.
          const handedOff = effects.some((e) => e.type === "handoff");
          const wakeAttempted = effects.some((e) => e.type === "wake");
          if (!handedOff && (published || !wakeAttempted)) {
            markDispatched({ stateDir: this.#stateDir, id, agent: agent.name, at: nowSec });
          }
        }
      }

      // What the node missed while it was down, dispatched once and oldest
      // first so a conversation replays in the order it was said. Ahead of live
      // traffic for the same reason.
      if (entry.backlog.length) {
        const missed = entry.backlog;
        entry.backlog = [];
        for (const event of missed) {
          if (entry.seen.has(event.id)) continue;
          entry.seen.add(event.id);
          fresh.push(event);
          // FIX-158 (F-030): the SECOND re-delivery arm, and it needs the flag
          // for exactly the reason the promise arm above does — this event is
          // in the backlog because the node was DOWN when it arrived. Named
          // separately from the promise arm on purpose: this fork has split
          // four of this product's fixes in half by being fixed on one side.
          for (const effect of entry.dispatcher.handle(event, { forceRelay: true })) {
            await this.#apply({ entry, effect });
          }
        }
      }

      let events;
      try {
        events = await entry.cli.getMessages({ channel: entry.room.channel, limit: 50 });
      } catch (err) {
        this.#log(`hive402: relay read failed: ${err.message}`);
        continue;
      }

      for (const event of events) {
        if (entry.watermark.has(event.id) || entry.seen.has(event.id)) continue;
        entry.seen.add(event.id);
        fresh.push(event);

        for (const effect of entry.dispatcher.handle(event)) {
          await this.#apply({ entry, effect });
        }
      }

      // After the room has been read, not before: the mark means "handled up to
      // here", and moving it first would lose everything this tick if the
      // process died mid-loop.
      this.#advanceResume(entry, events);

      // The cover promises this node may now owe (F-11: AC-61, AC-62).
      await this.#coverPass(entry, fresh, nowSec);

      // The messages this node handed to the harness and never saw answered
      // (FIX-135, F-023, AC-7). At the END of the tick, like cover and for the
      // same reason: recovery is a minutes-wide question and must never stand
      // a millisecond in front of a live wake. It costs no relay round trip —
      // the replies it reads are the events this tick already polled.
      await this.#handoffPass(entry, fresh, nowSec);

      // The promise collection used to be HERE, at the end of the tick. It
      // moved to the top of this loop in FIX-160 (F-030): from here it could
      // never beat the backlog, which drains above, so every promised message
      // that was also inside the catch-up window was delivered as an ordinary
      // backlog wake — losing the replay note and AC-65's acknowledge-briefly
      // instruction. See the comment at the new call site for why the round
      // trip is free at startup.
    }

  }

  // ── Peer cover: taking messages for offline neighbours (F-11) ────────────
  //
  // The registry read and the presence read both go through the room's OWN
  // primitives — the world-readable managed-agent record for "who is an
  // agent, and whose node answers for it" (DD-53), and the relay's signed
  // presence synthesis for "is that node reachable". Nothing here holds a key
  // for anyone, and nothing here ever wakes an agent: the only thing this
  // path can do is say one fixed sentence in a thread.

  async #refreshForeign(entry) {
    if (this.#membershipRecheckMs < 0) return;
    if (this.#membershipRecheckMs > 0 && Date.now() - entry.foreignAt < this.#membershipRecheckMs) return;
    try {
      const rows = await this.#queryEvents({
        origin: cliRelayUrl(this.#config.relayUrl),
        filters: [{ kinds: [KIND_MANAGED_AGENT] }],
        privateKeyHex: await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" }),
        nip98: nip98Header,
      });
      const members = (await entry.cli.channelMembers({ channel: entry.room.channel })).map(
        (m) => m?.pubkey ?? m,
      );
      const records = managedAgentsFrom(rows);
      entry.registryAgents = new Set(records.map((r) => r.pubkey));
      entry.knownNodes = new Set(records.map((r) => r.node));
      entry.foreign = foreignAgentsIn({
        records,
        members,
        ownAgentPubkeys: entry.room.agents.map((a) => a.pubkey),
        selfNode: this.#config.node.pubkey,
      });
    } catch (err) {
      // Keep the last reading, exactly like a failed membership re-check: a
      // network blip must never decide there are no agents to cover for.
      this.#log(`hive402: could not read the agent registry: ${err.message} — keeping the last reading`);
    }
    entry.foreignAt = Date.now();
  }

  // The replay bounds, for a config that may not have come through the schema
  // — the same shape, and the same reason, as `#backlog()`.
  #cover() {
    return { ...COVER_DEFAULTS, ...(this.#config.cover ?? {}) };
  }

  // What was promised for THIS node's agents while it was off (F-11, DD-55).
  //
  // Trust is the load-bearing filter: only notices authored by a registry
  // node (or this node itself) count as promises, because anyone can type the
  // sentence — a forged notice must not let a member resurrect arbitrary old
  // mentions on our next start. The forged notice's only effect is dedup
  // (which believes anyone, deliberately), so its cost is a message falling
  // back to the AC-66 window rather than a replay-by-forgery.
  async #collectPromises(entry) {
    await this.#refreshForeign(entry);
    const self = String(this.#config.node.pubkey).toLowerCase();
    const trusted = [...new Set([...entry.knownNodes, self])];
    const origin = cliRelayUrl(this.#config.relayUrl);
    const key = await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" });
    const query = (filters) =>
      this.#queryEvents({ origin, filters, privateKeyHex: key, nip98: nip98Header });

    // The standing promises for this channel, minus the ones a previous start
    // already kept (one replay per promise, ever — the FIX-132 posture).
    const notices = await query([
      { kinds: [9], "#h": [entry.room.channel], authors: trusted, limit: 500 },
    ]);
    const standing = promisesIn({
      events: notices,
      agents: entry.room.agents,
      trustedAuthors: trusted,
    }).filter((p) => !isDispatched({ stateDir: this.#stateDir, id: p.id, agent: p.agent.name }));
    if (standing.length === 0) return [];

    // The promised messages themselves — by id, because a promise has no age
    // bound and the recent window may no longer hold them (S30-3). A notice
    // whose target never addressed the agent is a mistake or a forgery, and
    // dies here.
    const originals = await query([{ ids: standing.map((p) => p.id) }]);
    const byId = new Map(originals.map((e) => [String(e.id).toLowerCase(), e]));
    const joined = standing
      .map((p) => ({ ...p, original: byId.get(p.id) }))
      .filter((p) => p.original && addressesAgent({ event: p.original, agent: p.agent }));
    if (joined.length === 0) return [];

    // What each thread already holds. One query, all threads; replies are
    // re-matched locally by their thread root.
    const anchors = [...new Set(joined.map((p) => String(replyAnchor(p.original)).toLowerCase()))];
    const replies = await query(anchors.map((a) => ({ kinds: [9], "#e": [a], limit: 100 })));
    const machineAuthors = [
      ...entry.knownNodes,
      ...entry.registryAgents,
      self,
      ...entry.room.agents.map((a) => a.pubkey),
    ];

    const undone = [];
    for (const p of joined) {
      const anchor = String(replyAnchor(p.original)).toLowerCase();
      const inThread = replies.filter((r) => {
        const thread = threadRootOf(r) ?? replyTargetOf(r);
        return String(thread ?? "").toLowerCase() === anchor;
      });
      const verdict = threadVerdict({
        replies: inThread,
        agentPubkey: p.agent.pubkey,
        machineAuthors,
        afterSec: p.original.created_at ?? 0,
      });
      if (verdict.answeredByAgent) {
        // The agent already answered this thread — the promise is complete,
        // and marking it is what makes that stick across restarts.
        markDispatched({
          stateDir: this.#stateDir,
          id: p.id,
          agent: p.agent.name,
          at: Math.floor(Date.now() / 1000),
        });
        continue;
      }
      undone.push({ ...p, answeredByHuman: verdict.answeredByHuman });
    }

    const { kept, dropped } = capPromises({ promises: undone, cap: this.#cover().replayCapPerAgent });
    for (const [name, waiting] of dropped) {
      const answered = kept.filter((p) => p.agent.name === name).length;
      // Named in the room, never silent (AC-64) — and the dropped are marked
      // so the next restart does not re-announce them forever. "Ask again" is
      // the recovery path, and a fresh ask is a fresh message.
      let told = false;
      try {
        await entry.cli.send({
          channel: entry.room.channel,
          content: overflowNotice({ name, waiting, answered }),
        });
        told = true;
      } catch (err) {
        this.#log(`hive402: could not post the overflow notice for ${name}: ${err.message}`);
      }
      this.audit.action({
        agent: "node",
        actor: "node",
        kind: "replay-overflow",
        detail: `${waiting} promised message(s) for ${name} beyond the cap of ${this.#cover().replayCapPerAgent}`,
      });
      // FIX-159 (DD-64): retiring a promise the node never delivered is
      // legitimate here for exactly one reason — the room was TOLD. If the
      // notice did not post, it was not told, and marking would be the same
      // silent swallow F-030 was, one layer up. The failure direction is a
      // repeated announcement on the next start, which is this product's
      // stated preference over silence (see AC-66's own note).
      if (!told) continue;
      for (const p of undone.filter((x) => x.agent.name === name && !kept.includes(x))) {
        markDispatched({
          stateDir: this.#stateDir,
          id: p.id,
          agent: p.agent.name,
          at: Math.floor(Date.now() / 1000),
        });
      }
    }
    return kept;
  }

  // ── The handoff receipt: a direct delivery that nobody answered ──────────
  //
  // The whole of FIX-135's node-side work. Three steps, none of which reads a
  // message's text or touches the security boundary:
  //
  //   1. offer this tick's events to the pending handoffs as possible answers;
  //   2. ask `threadVerdict` — the product's ONE answer to "did the agent
  //      reply to this?" — about each one;
  //   3. relay the unanswered ones through the ordinary wake path, exactly as
  //      a non-owner's message is already relayed successfully.
  //
  // The recovery is audited whichever way it goes, so a message that used to
  // disappear without trace now leaves a row either way.
  #handoff() {
    return { ...HANDOFF_DEFAULTS, ...(this.#config.handoff ?? {}) };
  }

  async #handoffPass(entry, fresh, nowSec) {
    for (const event of fresh) entry.handoff.observe({ event });
    if (!entry.handoff.hasPending()) return;

    // The same roster `#collectPromises` builds: everything in this room that
    // is not a person. `threadVerdict` uses it to tell a human's reply from a
    // machine's; the recovery decision itself turns only on the AGENT's.
    const machineAuthors = [
      ...entry.knownNodes,
      ...entry.registryAgents,
      String(this.#config.node.pubkey).toLowerCase(),
      ...entry.room.agents.map((a) => a.pubkey),
    ];

    for (const effect of entry.handoff.decide({
      nowSec,
      graceSec: this.#handoff().graceSec,
      machineAuthors,
    })) {
      const { agent, event, route } = effect;
      // FIX-143: how the message reached the agent the FIRST time. Left as one
      // fixed phrase, this row would be false for every relayed recovery — the
      // right boolean inside the wrong sentence, which this document has caught
      // us on before.
      const routed = route === "relayed" ? `relayed to ${agent.name}` : `delivered directly to ${agent.name}`;
      // `forceRelay` declines the direct-delivery shortcut for this one
      // message, on evidence. Everything else — the authority record, the
      // thread anchor, the respawn, the gate — is computed by the same code
      // that serves every other relayed message.
      const effects = entry.dispatcher.handle(event, { forceRelay: true });
      const woke = effects.some((e) => e.type === "wake");
      if (!woke) {
        // The dispatcher declined for a reason of its own — the turn cap, the
        // loop guard, a roster change. Stop asking rather than retrying every
        // tick forever, and leave the row that says so.
        entry.handoff.confirmRecovered({ event, agent });
        this.audit.action({
          agent: agent.name,
          actor: "node",
          kind: "handoff-dropped",
          detail: `a message ${routed} went unanswered, and could not be relayed`,
        });
        continue;
      }
      for (const e of effects) {
        // Rides the effect into `#apply`'s one wake-composition site, the same
        // rail the replay note uses (F-11, AC-63) — never a second composition
        // site, which is what broke the respawn-before-send guard once already.
        if (e.type === "wake") {
          e.note = handoffNote({ route });
          // A recovery is a RE-delivery. Without this the recovery wake would
          // record a receipt of its own and recover itself on a loop (FIX-143).
          e.redelivery = "recovery";
        }
        await this.#apply({ entry, effect: e });
      }
      entry.handoff.confirmRecovered({ event, agent });
      this.audit.action({
        agent: agent.name,
        actor: short(event.pubkey),
        kind: "handoff-recovered",
        detail: `a message ${routed} drew no reply within ${this.#handoff().graceSec}s — relayed`,
      });
    }
  }

  #observeCover(entry, event, nowSec) {
    entry.cover.observe({
      event,
      foreign: entry.foreign,
      nowSec,
      isEligibleAuthor: (pubkey) => this.#coverEligible(entry, pubkey),
    });
  }

  // Whose mentions deserve cover: humans'. An agent's chatter is loop-guard
  // territory, and a node's wakes QUOTE the "@name" they relay — reading one
  // as a fresh ask would promise answers to machine lines forever.
  #coverEligible(entry, pubkey) {
    const pk = String(pubkey ?? "").toLowerCase();
    if (pk === String(this.#config.node.pubkey).toLowerCase()) return false;
    if (entry.knownNodes.has(pk)) return false;
    if (entry.registryAgents.has(pk)) return false;
    if (entry.room.agents.some((a) => String(a.pubkey).toLowerCase() === pk)) return false;
    return true;
  }

  // How stale a presence reading may get while promises are pending. Five
  // poll ticks — far under the pending window, far over the poll interval.
  static #COVER_PRESENCE_MS = 10_000;

  async #coverPass(entry, fresh, nowSec) {
    // Nothing new and nothing owed: touch neither the registry nor presence.
    // This is what keeps cover entirely off the wake path's clock — a quiet
    // room costs zero extra relay calls per tick.
    if (fresh.length === 0 && !entry.cover.hasPending()) return;

    await this.#refreshForeign(entry);
    for (const event of fresh) this.#observeCover(entry, event, nowSec);

    if (!entry.cover.hasPending()) return;

    if (Date.now() - entry.presenceAt > Supervisor.#COVER_PRESENCE_MS) {
      // One read covers both questions: the pending targets' owner-nodes
      // (offline?) and every known node (who else is covering, for rank).
      // Liveness RECORDS, not relay presence — presence is connection-bound
      // and one-shot publishers cannot hold it (see heartbeat.mjs). The
      // reader enforces the records' expiry itself, so a lazily-purging
      // relay cannot serve a stale "online".
      const nodes = [...new Set([...entry.cover.pendingNodes(), ...entry.knownNodes])];
      try {
        const rows = await this.#queryEvents({
          origin: cliRelayUrl(this.#config.relayUrl),
          filters: [{ kinds: [KIND_USER_STATUS], authors: nodes, "#d": [LIVENESS_D] }],
          privateKeyHex: await this.#resolveKey(this.#config.node.privateKeyRef, { role: "node" }),
          nip98: nip98Header,
        });
        entry.presence = { ok: true, map: livenessOf(rows, { nowSec }) };
      } catch (err) {
        // Unreadable is WAIT, never "everyone is offline": a network blip must
        // not put a false promise in a shared room.
        entry.presence = { ok: false, map: new Map() };
        this.#log(`hive402: liveness read failed: ${err.message} — holding cover notices`);
      }
      entry.presenceAt = Date.now();
    }

    const presence = entry.presence.ok
      ? (node) => entry.presence.map.get(String(node).toLowerCase()) ?? "offline"
      : () => null;
    const self = String(this.#config.node.pubkey).toLowerCase();
    const rankOf = (agent) => {
      const target = String(agent.node).toLowerCase();
      const online = [...entry.knownNodes].filter((n) => n !== target && presence(n) === "online");
      const covering = [...new Set([...online, self])].sort();
      return Math.max(0, covering.indexOf(self));
    };

    for (const effect of entry.cover.decide({ nowSec, presence, rankOf })) {
      try {
        await entry.cli.send({
          channel: entry.room.channel,
          content: effect.content,
          // Onto the SPECIFIC mention: the CLI derives the thread root and the
          // mention survives as the notice's reply marker — the pointer the
          // owner's node replays from (S30-2, DD-54).
          replyTo: effect.replyTo,
        });
        entry.cover.confirmPosted({ event: effect.event, agent: effect.agent });
        this.audit.action({
          agent: "node",
          actor: "node",
          kind: "cover-notice",
          detail:
            `${effect.agent.name} offline — promised ${short(effect.event.id)}…, ` +
            `asked by ${short(effect.event.pubkey)}…`,
        });
      } catch (err) {
        // Unconfirmed: the tracker keeps the promise pending and the next tick
        // retries, which is the failure direction that never loses a message.
        this.#log(
          `hive402: could not post the taken-message notice for ${effect.agent.name}: ${err.message} — retrying`,
        );
      }
    }
  }

  // Tell the ROOM when the agent it just addressed cannot answer (FIX-130).
  //
  // The node cannot answer FOR the agent, and must not try. What it can do is
  // stop the room from waiting on something that is not coming, which is the
  // difference between a product that looks asleep and one that looks broken.
  //
  // Bounded to ONE notice per distinct failure, per agent. A room where every
  // message produced the same red banner would be worse than the silence: the
  // notice would become the noise, and the next real one would be ignored.
  async #warnIfAgentIsBroken({ entry, agent, replyTo }) {
    let turn = null;
    try {
      const log = path.join(this.#stateDir, "logs", `${agent.name}.log`);
      if (!existsSync(log)) return;
      turn = lastAgentTurn(readFileSync(log, "utf8"));
    } catch {
      // The log is a diagnostic, not a dependency. If it cannot be read the
      // wake still goes out, which is the behaviour that existed before this.
      return;
    }

    const failure = describeAgentFailure({ agent: agent.name, turn });
    if (!failure) return;

    // Keyed on the failure's own timestamp, so a NEW failure is announced and
    // the same one never is twice — including across the respawns that a broken
    // agent produces constantly.
    const key = `${agent.name}@${turn.at ?? "unknown"}`;
    if (this.#announcedFailures.has(key)) return;
    this.#announcedFailures.add(key);
    if (this.#announcedFailures.size > 50) {
      this.#announcedFailures.delete(this.#announcedFailures.values().next().value);
    }

    try {
      await entry.cli.send({
        channel: entry.room.channel,
        // Marked, like every line the node writes, so the strip rule keeps
        // holding and a human cannot forge one (see attribution.mjs).
        content: `${HIVE_MARKER} ${agent.name} cannot answer right now. ${failure.detail}`,
        replyTo: replyTo ?? null,
      });
    } catch (err) {
      this.#log(`hive402: could not post ${agent.name}'s failure notice: ${err.message}`);
    }
  }

  // Write one authority record, keyed to the event that will trigger the turn
  // it authorises (DD-20). Everything about which event that is has already
  // been decided by the dispatcher; this only puts it on disk.
  // Which room message caused the turn that a given event id triggers.
  //
  // The runtime tells us which EVENT a turn belongs to (turngate.mjs); this is
  // the other half of the join — what that event actually was, so a refusal can
  // be described to the owner in terms of the request that caused it. Bounded:
  // a room can run for days and only recent turns can still be blocked.
  #rememberTrigger(eventId, { event, requester }) {
    if (!eventId) return;
    this.#triggers.set(eventId, { event, requester });
    if (this.#triggers.size > 500) {
      // Map preserves insertion order, so the oldest key is the first one.
      this.#triggers.delete(this.#triggers.keys().next().value);
    }
  }

  // Turn a raw blocked record into one that knows whose turn it was.
  //
  // …and WHAT RELEASED IT (DD-35). The authority record read here already
  // carries the proposal that let this turn run, when an approval is what let
  // it run; the dispatcher needs that to tell "the owner already confirmed this
  // build, and the deploy it is now reaching for is part of the same run" from
  // "a fresh turn is asking to deploy". Carrying a field this function already
  // has in its hand is the whole change: the join is the turn's own event id,
  // the same one DD-19/DD-20 use to attribute the requester, so a deploy can
  // never ride an approval that released some other turn.
  #attribute(record) {
    const turn = readTurnRecord({ stateDir: this.#stateDir, agent: record.agent, promptId: record.promptId });
    if (!turn?.eventId) return record;
    const remembered = this.#triggers.get(turn.eventId);
    const authority = readAuthority({ stateDir: this.#stateDir, agent: record.agent, eventId: turn.eventId });
    const requester = remembered?.requester ?? authority?.requester ?? null;
    // The gate writes this itself when it can (it is the only party that knows
    // which record the turn really held — FIX-87); this is the fallback for a
    // record written before that, and for the ordinary attributable case.
    const proposalId =
      record.proposalId ?? (authority?.kind === "grant" ? (authority.proposalId ?? null) : null);
    if (!requester && !remembered?.event && !proposalId) return record;
    return { ...record, requester, proposalId, triggerEvent: remembered?.event ?? null };
  }

  #writeAuthority({ authority, eventId }) {
    const common = {
      stateDir: this.#stateDir,
      agent: authority.agent.name,
      eventId,
      reason: authority.reason,
      requester: authority.requester,
    };
    if (authority.kind === "grant") {
      writeGrant({
        ...common,
        capabilities: authority.capabilities,
        proposalId: authority.proposalId ?? null,
        signature: authority.signature ?? null,
      });
    } else {
      writeWithheld(common);
    }
  }

  // Where the workshop deploys FROM: a fixed subdirectory of the agent's own
  // scratch working directory. Fixed on purpose — the agent decides the
  // content, never the location, and `.claude/settings.json` (which lives in
  // the working directory itself) must never be published to the web.
  //
  // The name comes from `workshop/site.mjs` because the TOOL GATE needs the
  // same name (DD-36): this is the one part of the agent's workspace that is
  // not scratch paper, and a gate guarding a directory the node does not
  // publish would guard nothing.
  #siteDir(agentName) {
    return deployDirIn(agentWorkDir({ root: path.join(this.#stateDir, "work"), agent: agentName }));
  }

  // The deploy the dispatcher authorised (DD-27). This is the one place in
  // hive402 that runs run402, and it runs in the NODE's process, with the
  // node's client — which is why the tool gate can refuse the command outright
  // in every agent process without taking the feature away.
  async #deploy({ entry, effect }) {
    const agent = effect.agent;
    // The same record type, written by the same function, as every wake's
    // authority — keyed by the proposal token instead of by an event id. There
    // is no boolean anywhere on this path: `buildAndDeploy` reads this back off
    // disk and re-checks it against the signature of the call it is about to
    // make.
    this.#writeAuthority({ authority: effect.authority, eventId: effect.token });

    const dir = this.#siteDir(agent.name);
    const identity =
      `the run402 account of ${agent.name}'s owner (${short(agent.ownerPubkey)}…)`;

    let result;
    if (!existsSync(dir) || readdirSync(dir).length === 0) {
      // Say what is actually wrong. A deploy of an empty directory would
      // succeed at run402 and replace a live site with nothing.
      result = {
        ok: false,
        reason:
          `there is nothing to deploy: ${agent.name} has not put any files in the "${DEPLOY_DIR}" folder ` +
          `of its working directory`,
      };
    } else {
      result = await buildAndDeploy({
        stateDir: this.#stateDir,
        agent,
        project: effect.project,
        subdomain: effect.subdomain ?? null,
        dir,
        token: effect.token,
        signature: effect.signature,
        run402: this.#run402,
      });
    }

    this.audit.action({
      agent: agent.name,
      actor: "node",
      kind: "deploy",
      detail: result.ok
        ? `deployed ${effect.project} to ${result.url ?? "(no public url bound)"} ` +
          `(receipt ${result.receipt}) as ${identity}`
        : `deploy did not happen: ${result.reason}`,
    });

    await entry.cli.send({
      channel: entry.room.channel,
      content: result.ok
        ? formatDeployMessage({
            project: effect.project,
            url: result.url,
            receipt: result.receipt,
            warning: result.warning,
            identity,
          })
        : `@${agent.name}'s deploy did not happen: ${result.reason}`,
      mentions: effect.requester ? [effect.requester] : [],
    });
  }

  // Returns whether this effect actually LANDED — for a wake, whether the room
  // has it.
  //
  // FIX-159 (F-030, DD-64). A publish failure is swallowed here by design: one
  // bad send must not stop a tick. But the promise path retires a DURABLE mark
  // on the strength of a dispatch, and a caller that cannot tell a publish from
  // a swallow will retire a promise the room never heard about. So the fact is
  // returned rather than left to be assumed.
  async #apply({ entry, effect }) {
    let landed = false;
    try {
      if (effect.type === "deploy") {
        await this.#deploy({ entry, effect });
        return true;
      }
      // A message the harness delivered directly: the trigger is that message,
      // so its id is already known and the record can go down immediately.
      if (effect.type === "authority") {
        this.#writeAuthority({ authority: effect, eventId: effect.eventId });
        this.#rememberTrigger(effect.eventId, { event: effect.event ?? null, requester: effect.requester ?? null });
        return true;
      }
      // FIX-135 (F-023): the receipt for a message handed straight to the
      // harness. Nothing is published and nothing is decided here — the node
      // simply stops forgetting what it gave away, so it can find out later
      // whether anyone answered.
      if (effect.type === "handoff") {
        entry.handoff.record({
          event: effect.event,
          agent: effect.agent,
          nowSec: Math.floor(Date.now() / 1000),
        });
        return true;
      }
      if (effect.type === "wake") {
        // FIX-74 / DD-34: an agent that exited on the AC-42 inactivity policy is
        // brought back HERE, by the message that addresses it — before the wake
        // is published, because a harness that is not listening yet loses it.
        // The authority record below is untouched by this: it is still keyed to
        // the id the relay gives the wake, so a respawned turn holds exactly the
        // authority a warm one would have held.
        await this.#ensureAgentRunning({ agent: effect.agent, entry });

        // The wake is a p-tagged message under the NODE's identity: the p tag
        // is the whole wake mechanism (spike S2), and node authorship is what
        // gets it past the agent's inbound allowlist. It quotes the trigger so
        // the agent's prompt reads naturally; the dispatcher ignores the node's
        // own events, so this cannot feed back.
        // AC-49 / DD-41: the wake OPENS with the node's own attribution line,
        // because the agent otherwise sees a message from the node and answers
        // the node's owner. The body it prefixes has already had any
        // attribution-shaped line stripped by the dispatcher, so this line is
        // the only one of its kind in the message and the node is its author.
        // AC-68 (DD-58): an approval-released wake is attributed to the OWNER
        // whose word released it — the action runs as the owner's own request.
        // Every ordinary wake keeps the trigger's author.
        const attributee = effect.attributeTo?.pubkey ?? effect.event?.pubkey;
        const line = attributionLine({
          // FIX-125: the room reads this line too, so it says which agent is
          // being woken. The thread is NOT printed here — it travels as
          // `replyTo` on the send below, which is the tag the harness honours.
          agent: effect.agent?.name,
          name: await this.#displayName(entry, attributee),
          pubkey: attributee,
        });

        // FIX-130: if this agent's last turn FAILED for a reason it cannot
        // recover from, say so IN THE ROOM, to the person who just asked.
        //
        // Barry asked smith twice and got silence, then saw Buzz's own agent
        // answer the identical situation properly: "Fizz needs configuration —
        // complete Claude Code authentication by running the Claude CLI",
        // posted in the thread where he asked. Buzz tells the room. hive402
        // knew the same fact, in the same log, and told nobody.
        //
        // FIX-129 surfaced this in `doctor`, which helps the operator. It does
        // nothing for the person in the room, who is the one waiting — and the
        // room is where the question was asked.
        await this.#warnIfAgentIsBroken({ entry, agent: effect.agent, replyTo: effect.replyTo });

        // A wake that is not the message's first delivery carries the node's
        // note under the human's words — a replayed one (F-11, AC-63/AC-65) or
        // a recovered handoff (FIX-135). Appended here, in the one place a
        // wake is composed, never upstream of the respawn-before-send rule.
        const body = effect.note
          ? `${effect.content ?? effect.event?.content ?? ""}\n\n${effect.note}`
          : (effect.content ?? effect.event?.content);
        const sent = await entry.cli.send({
          channel: entry.room.channel,
          content: composeWake({ line, body }),
          mentions: [effect.agent.pubkey],
          // AC-50 / DD-42. The harness derives the agent's own `--reply-to`
          // from the THREAD TAGS OF THE EVENT THAT TRIGGERED ITS TURN, which
          // for a relayed message is this wake. Anchoring the wake to the
          // trigger's thread is therefore what puts the agent's answer where
          // the question was asked — there is nothing to ask the model to do.
          replyTo: effect.replyTo ?? null,
        });
        // The room HAS it. Recorded here rather than at the end of the branch
        // because everything below is bookkeeping about a wake that is already
        // published, and a promise must not be re-offered because a local
        // write threw after the send succeeded (FIX-159).
        landed = true;

        // ── FIX-143 (F-026, AC-7): the receipt for a RELAYED delivery ──────
        //
        // FIX-135 records one for a message handed straight to a running
        // harness. It emits that receipt on the `deliveredDirectly` branch
        // ONLY, so every stranger's message — and every message to an agent
        // whose worker is between lives — was woken and then never asked about
        // again. That is DD-34's asymmetry inverted, and the fourth time this
        // fork has split one of this product's fixes in half.
        //
        // Here rather than in the dispatcher, and AFTER the send, for the same
        // reason the authority record sits here: a wake that never published
        // delivered nothing, and a receipt for it would recover a message the
        // room never saw.
        //
        // FIRST deliveries only. A replay (F-11, AC-63) and a recovery
        // (FIX-135) are both re-deliveries: recording receipts for those would
        // relay a promised message a second time, against FIX-132's
        // one-replay-per-promise posture, and would let a recovery recover
        // itself forever. Both sites set `redelivery` explicitly — reading the
        // note's presence as a side-channel would break silently the first time
        // a wake variant carried a note for some other reason.
        if (!effect.redelivery) {
          entry.handoff.record({
            event: effect.event,
            agent: effect.agent,
            nowSec: Math.floor(Date.now() / 1000),
            route: "relayed",
          });
        }

        // The turn this wake is about to trigger is triggered BY this wake, so
        // its authority is keyed by the id the relay just gave us — which is
        // why the record follows the send rather than preceding it. The window
        // in between is safe: the tool gate waits while a turn has no record
        // and denies if none arrives, so the failure direction is a refusal,
        // never a free pass.
        if (effect.authority) {
          const eventId = sent?.event_id ?? sent?.eventId ?? null;
          if (eventId) {
            this.#writeAuthority({ authority: effect.authority, eventId });
            this.#rememberTrigger(eventId, {
              event: effect.event ?? null,
              requester: effect.authority.requester ?? null,
            });
          } else {
            // No id back from the relay means no turn can be authorised at all.
            // Say so rather than leaving the agent to wait out the gate.
            this.#log(
              `hive402: the relay returned no event id for ${effect.agent.name}'s wake — ` +
                `that turn will hold no authority`,
            );
          }
        }
      } else if (effect.type === "say") {
        await entry.cli.send({
          channel: entry.room.channel,
          content: effect.content,
          mentions: effect.mentions ?? [],
          // FIX-134: in the thread the notice is ABOUT. Every `say` used to land
          // at the channel root, so a refusal appeared next to nothing it
          // referred to while the agent's own reply sat correctly in the thread.
          replyTo: effect.replyTo ?? null,
        });
        landed = true;
      }
    } catch (err) {
      this.#log(`hive402: could not publish ${effect.type}: ${err.message}`);
    }
    return landed;
  }

  run({ pollMs = DEFAULT_POLL_MS } = {}) {
    const loop = async () => {
      await this.tick();
      this.#timer = setTimeout(loop, pollMs);
    };
    this.#timer = setTimeout(loop, pollMs);
    return this.#timer;
  }

  // The channels this node is watching RIGHT NOW (AC-48). Public because since
  // FIX-120 the answer is not in any file an operator can read: it comes from
  // the relay and changes while the node runs, so "where am I listening?" has
  // to be answerable from outside.
  watching() {
    return this.#rooms.map((entry) => entry.room.channel);
  }

  async status() {
    const agents = [];
    for (const entry of this.#rooms) {
      for (const agent of entry.room.agents) {
        const report = await entry.publisher.check({ agent });
        const child = this.#children.get(agent.name);
        // `!child.killed` used to stand for "running", and a process that exits
        // on its own was never killed — so the node's own status called an agent
        // that had idle-exited an hour ago "running" (FIX-75).
        const state = this.#agentState(agent.name);
        agents.push({
          name: agent.name,
          channel: entry.room.channel,
          running: state.alive,
          state: state.state,
          detail: state.detail,
          pid: child?.pid ?? null,
          addressable: report.addressable,
          problems: report.problems,
          research: agent.research,
          build: agent.build,
        });
      }
    }
    return { node: this.#config.node.pubkey, agents };
  }

  async stop() {
    if (this.#timer) clearTimeout(this.#timer);
    // Offline first, while the relay is certainly still reachable from here: a
    // graceful stop reads offline to peers immediately rather than at expiry.
    await this.#heartbeat?.stop();
    this.#heartbeat = null;
    const stopped = [];
    for (const [name, child] of this.#children) {
      try {
        child.kill();
        stopped.push({ name, pid: child.pid });
      } catch (err) {
        this.#log(`hive402: could not stop ${name}: ${err.message}`);
      }
    }
    this.#children.clear();
    rmSync(this.#pidFilePath(), { force: true });
    return stopped;
  }
}

function readAttestationFile(stateDir, agent) {
  const file = path.join(stateDir, "agents", `${agent.name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")).authTag ?? null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}
