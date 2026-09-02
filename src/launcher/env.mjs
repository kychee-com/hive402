// buildAgentEnv — assemble the explicit environment for a hand-launched
// buzz-acp agent. Replacing Buzz Desktop's managed launch means we forfeit
// every launch-time policy Desktop supplies, so this builder re-supplies each
// one deliberately (spec AC-38, AC-41, AC-42; issue #1).
//
// Env var names are verified against buzz source @ df9e773a
// (crates/buzz-acp/src/config.rs). Values are strings — this is a process env.

import { readdirSync } from "node:fs";
import { resolveModel } from "../config/schema.mjs";
import path from "node:path";

import { composeInstructions } from "./instructions.mjs";

const VALID_RESPOND_TO = new Set(["owner-only", "allowlist", "anyone", "nobody"]);

// PATH separator: ";" on Windows, ":" elsewhere.
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// Policy defaults hive402 sets so the harness never runs on its own defaults.
// One audited table (re-checked at every Buzz version pin — AC-42).
const LIFETIME_POLICY = {
  BUZZ_ACP_LAZY_POOL: "true", // required for idle-pool-sleep to apply (issue #1)
  BUZZ_ACP_IDLE_POOL_SLEEP: "900", // seconds; matches Desktop's managed value
  BUZZ_ACP_EXIT_AFTER_INACTIVITY: "3600", // seconds; re-supplied, not defaulted
  BUZZ_ACP_NO_PRESENCE: "false", // explicit presence policy
  BUZZ_ACP_NO_TYPING: "false", // presence-class policy, same audit
  BUZZ_ACP_MAX_TURNS_PER_SESSION: "50", // proactive session rotation, not unbounded
  BUZZ_ACP_IDLE_TIMEOUT: "600", // seconds of silence before a turn is killed
  BUZZ_ACP_MAX_TURN_DURATION: "1800", // absolute per-turn wall-clock cap
  // ONE TURN, ONE REQUESTER (DD-24, fix cycle 3).
  //
  // The harness default here is `steer`, and its own documentation says what
  // that does: "Cancel the in-flight turn and re-dispatch a merged prompt…
  // Fires for any author the inbound author gate admits." So a second person's
  // request gets folded into a turn already running for somebody else.
  //
  // hive402 cannot allow that. Authority is per-turn, and after a merge there
  // is one turn, one prompt id and one authority — so a non-owner's request
  // would execute under whatever the owner's turn was granted. That is F-009's
  // shape, and no amount of per-event bookkeeping can separate two requesters
  // once the harness has made them one prompt. Found by re-attacking the race
  // live on 2026-08-16, after the earlier fixes were already in.
  //
  // `queue` makes new events wait for the current turn to finish, so every
  // request gets its own turn, its own authority and its own approval.
  BUZZ_ACP_MULTIPLE_EVENT_HANDLING: "queue",
  // Pinned alongside it: the harness refuses a cancel-mode with dedup=drop, and
  // pinning both means the pair can never drift into a refused combination.
  BUZZ_ACP_DEDUP: "queue",
  // Explicit, not inherited. Capability enforcement does NOT rely on this —
  // deny rules in the agent's own settings dir win over the mode (DD-11) — but
  // an unset mode is exactly the kind of inherited default AC-42 exists to
  // forbid. Bypassing the per-tool prompt is required for a headless agent:
  // `default` would block forever waiting for a human to click.
  BUZZ_ACP_PERMISSION_MODE: "bypass-permissions",
};

// The audited table, exported so a test can assert the WHOLE set is present
// rather than spot-checking the three the spec happens to name today. Re-checked
// at every Buzz version pin (AC-42).
export const LIFETIME_POLICY_KEYS = Object.freeze(Object.keys(LIFETIME_POLICY));

// The same policy again, as CLI flags (DD-18, fix cycle 2).
//
// Why twice? Because AC-42 says the node sets these deliberately, and for two
// cycles running nobody could check it. The harness's own startup line
// (`Config::summary()`) prints 21 settings and none of these three — not even
// at their zero default — so an env-only policy is invisible from outside the
// process. Cycle 1 read the command line and was told that was the wrong
// surface; cycle 2 read the log line we named instead and found it silent.
// Passing flags makes the ordinary surface correct: `Get-CimInstance
// Win32_Process | Select CommandLine` now shows the policy, with no product
// cooperation and nobody's word to take. clap gives CLI flags precedence over
// env, so the two can never disagree in effect — and the test below asserts
// they never disagree on paper either.
//
// Presence and typing are deliberately NOT here: `--no-presence` / `--no-typing`
// are bare on/off flags with no way to spell "on", and the startup line already
// prints `presence=true typing=true`, so they are observable already.
const LIFETIME_FLAGS = [
  { flag: "--lazy-pool", env: "BUZZ_ACP_LAZY_POOL", boolean: true },
  { flag: "--idle-pool-sleep", env: "BUZZ_ACP_IDLE_POOL_SLEEP" },
  { flag: "--exit-after-inactivity", env: "BUZZ_ACP_EXIT_AFTER_INACTIVITY" },
  // This one IS printed by the harness's own startup line (`meh=…`), so it is
  // observable either way — but it is the most security-relevant setting in the
  // table (DD-24), and a flag makes it checkable with a standard OS tool
  // without trusting anything we wrote.
  { flag: "--multiple-event-handling", env: "BUZZ_ACP_MULTIPLE_EVENT_HANDLING" },
];

export function lifetimePolicyArgs() {
  const args = [];
  for (const { flag, env, boolean: isBool } of LIFETIME_FLAGS) {
    const value = LIFETIME_POLICY[env];
    if (isBool) {
      if (value === "true") args.push(flag);
      continue;
    }
    args.push(flag, value);
  }
  return args;
}

// What `hive402 doctor` reports, and what it looks for on the live process.
export function lifetimePolicyReport() {
  return LIFETIME_FLAGS.map(({ flag, env, boolean: isBool }) => ({
    flag,
    env,
    value: LIFETIME_POLICY[env],
    boolean: Boolean(isBool),
  }));
}

// Derive the agent's inbound author gate from its own policy (AC-38).
//
// This is load-bearing, and it became so the moment agent profiles were
// published: the relay now resolves "@name" for ANY sender and delivers a
// p-tagged event straight to the agent. An agent on `anyone` is therefore woken
// before the node can gate the request — which is cycle 1's F-003 exactly.
//
// So when the owner requires approval, the agent admits only its owner and this
// node; everyone else's messages are discarded by the harness and reach the
// agent only as a node-published wake, after the gate has run. When the owner
// auto-allows, there is nothing to enforce and the direct path is faster.
//
// ── The owner is NAMED now, and FIX-131 is why ─────────────────────────────
//
// This list used to hold the node alone, and the comment above used to say the
// owner was admitted "implicit in the harness". That was true: buzz-acp admits
// `allowlist.contains(author) || is_owner_or_sibling(author)`, and it resolves
// that owner from BUZZ_AUTH_TAG — which the HUMAN signed, before FIX-117.
//
// FIX-117 moved the attestation to the node, and measured on Barry's machine the
// harness now logs `owner resolved from BUZZ_AUTH_TAG: bead5b81…` (the node)
// while the config's ownerPubkey is `800fab4d…` (Barry). The human quietly
// stopped being anybody the harness would listen to.
//
// The node went on believing otherwise and suppressed its own relay on that
// belief, so Barry wrote to his own agent, in his own room, with everything
// healthy, and NEITHER component delivered it — the node thought the harness
// had it, the harness had dropped it. Only while the agent was RUNNING, because
// a dead one is relayed to regardless, which is why it looked intermittent.
//
// An implicit guarantee from another component is a guarantee that can be
// withdrawn without anybody noticing. This says it out loud, in the one function
// that configures both sides.
export function inboundGateFor({ agent, nodePubkey }) {
  if (agent.crossOwnerAsks === "auto-allow") {
    return { respondTo: "anyone" };
  }
  return {
    respondTo: "allowlist",
    respondToAllowlist: [nodePubkey, agent.ownerPubkey].filter(Boolean),
  };
}

// How much conversation the agent sees per wake (AC-11). buzz-acp defaults to
// 12 messages — too short for a room where two humans and two agents work
// together, so a reply would reflect the triggering line rather than the
// discussion. Overridable per room.
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 100;

export function buildAgentEnv({
  agent,
  room,
  secrets,
  // The hive this agent belongs to, so its model choice can be resolved
  // (AC-74/AC-75, DD-62). Optional: a caller that omits it gets hive402's own
  // default, which is the fail-SAFE direction — the one thing that must never
  // happen is falling back to the owner's machine-wide setting.
  node = null,
  toolPaths = {},
  configDir = null,
  // The owner's own text for this agent (AC-55, DD-45), already resolved from
  // `instructions` or `instructionsFile` by launcher/instructions.mjs. Null for
  // an agent whose owner has written none — the house rules still apply.
  instructions = null,
  // The absolute path the instructions were READ from, when they came from a
  // file (`instructionsFilePath`). Passed in already resolved so this module
  // never re-derives it against a different base.
  instructionsPath = null,
  // Where this agent will actually run. Only needed to refuse an
  // `instructionsFile` the agent could rewrite; see below.
  workDir = null,
  // Injected so the PATH check below is testable without a real filesystem.
  readdir = (dir) => readdirSync(dir),
}) {
  // The agent's NIP-OA owner attestation travels with its identity.
  const authTag = agent.authTag ?? null;
  // The command names a run402 launcher can appear under, on either platform.
const RUN402_LAUNCHERS = /^run402(\.(cmd|exe|ps1|bat))?$/i;

// DD-27: an agent must never be able to execute run402, so the honest place to
// enforce that is the agent's PATH — not a shell-string classifier.
//
// The tool gate refuses every run402 call it can RECOGNISE, which is every
// ordinary spelling including an absolute path. What no classifier can see is
// the binary reached through a wrapper whose command line is quoted data
// (`sh -c "run402 …"`), because quoted data is exactly what must NOT be read as
// commands — that is F-010, and reading it the other way makes the agent mute.
//
// So the gate is defence in depth and this is the control: if run402 is not on
// the process's PATH, no spelling reaches it. The node runs run402 itself, from
// an absolute path it resolves in its own process, so nothing legitimate needs
// it here. Refusing to launch is deliberate — silently dropping a directory the
// owner configured would be a policy change nobody could see.
function refuseReachableRun402({ agent, pathDirs, readdir }) {
  for (const dir of pathDirs) {
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      continue; // a directory we cannot read holds nothing we can promise about
    }
    const found = entries.find((name) => RUN402_LAUNCHERS.test(name));
    if (!found) continue;
    throw new Error(
      `agent "${agent.name}": refusing to launch with run402 reachable on its PATH ` +
        `(found "${found}" in ${dir}). hive402 runs run402 itself, on the node's own account — ` +
        `an agent process must never be able to spend it. Remove that directory from tools.extraDirs.`,
    );
  }
}

// AC-55: "An agent never edits its own instructions." The tool gate makes that
// true for the config file — a write there is a `build`, a withheld turn holds
// nothing, and an owner's automatic grant deliberately excludes `build`.
//
// It cannot make it true for an `instructionsFile` the owner points INTO the
// agent's own working directory, because writes there are composition by
// design (`insideScratch`) — that is what lets a contained agent draft
// anything at all. So a character file living there is a character the agent
// can rewrite, and the next respawn would read it back in.
//
// Refusing to launch is deliberate, and it is the same choice as
// `refuseReachableRun402` above: quietly ignoring the field would be a policy
// change nobody could see, and quietly honouring it would break an absolute
// criterion.
// `instructionsPath` is the ALREADY-RESOLVED absolute path, from
// `instructionsFilePath` — never re-derived here. Resolving it a second time
// against the working directory is exactly the bug a real launch caught: an
// ordinary `"./spike.md"` sitting next to the config resolved, in this guard,
// to a file inside the agent's scratch space, and the node refused to start.
function refuseWritableInstructionsFile({ agent, workDir, instructionsPath }) {
  if (!workDir || !instructionsPath) return;

  const normal = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const root = normal(workDir);
  const resolved = normal(path.resolve(instructionsPath));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return;

  throw new Error(
    `agent "${agent.name}": instructionsFile "${agent.instructionsFile}" is inside ${agent.name}'s own working ` +
      `directory, where the agent may write freely. An agent never edits its own instructions ` +
      `(AC-55), so hive402 will not start one that could. Move the file next to your config.`,
  );
}

// buzz-acp connects over a websocket. An http:// URL is accepted at parse
  // time and only fails at connect — after the agent pool is already ready —
  // which reads as a runtime crash rather than a config mistake. Fail fast.
  // (Spike finding, 2026-08-15.)
  if (!/^wss?:\/\//i.test(room.relayUrl ?? "")) {
    throw new Error(
      `relayUrl must be a websocket url (ws:// or wss://), got "${room.relayUrl}"`,
    );
  }

  const respondTo = room.respondTo;
  if (!VALID_RESPOND_TO.has(respondTo)) {
    throw new Error(
      `invalid respond_to "${respondTo}" — hive402 sets an explicit gate, never the harness default`,
    );
  }
  // hive402 never launches an agent on the owner-only default: cross-owner
  // addressing (AC-5/AC-38) requires anyone or an allowlist. owner-only/nobody
  // are refused at this layer so they can't slip in by omission.
  if (respondTo === "owner-only" || respondTo === "nobody") {
    throw new Error(
      `respond_to "${respondTo}" would deny cross-owner addressing — choose "anyone" or "allowlist"`,
    );
  }

  // The agent speaks by RUNNING `buzz messages send` — Buzz discards an
  // agent's plain text output. So the child needs the CLI on PATH plus the
  // auth env the CLI reads (BUZZ_RELAY_URL / BUZZ_PRIVATE_KEY, already set
  // below). Without this the agent wakes and stays mute forever.
  // (Spike finding, 2026-08-15.)
  const pathDirs = [toolPaths.buzzDir, toolPaths.nodeDir, ...(toolPaths.extraDirs ?? [])]
    .filter((d) => typeof d === "string" && d.length > 0);
  refuseReachableRun402({ agent, pathDirs, readdir });
  refuseWritableInstructionsFile({ agent, workDir, instructionsPath });

  const env = {
    // identity + CLI auth (the harness and the buzz CLI read the same vars)
    BUZZ_PRIVATE_KEY: secrets.agentPrivateKey,
    BUZZ_RELAY_URL: room.relayUrl,
    BUZZ_ACP_AGENT_OWNER: agent.ownerPubkey,
    // author gate — explicit, never defaulted
    BUZZ_ACP_RESPOND_TO: respondTo,
    // re-supplied Desktop launch-time policies
    ...LIFETIME_POLICY,
    // conversation context per wake (AC-11)
    BUZZ_ACP_CONTEXT_MESSAGE_LIMIT: String(
      room.contextMessageLimit ?? DEFAULT_CONTEXT_MESSAGE_LIMIT,
    ),
    // Who this agent is, and how this room works (AC-55/AC-18, DD-45).
    //
    // TEAM instructions, not a system prompt: the harness renders this as its
    // own `[Team Instructions]` section AFTER the base prompt, which stays
    // upstream's and keeps upstream's guards. hive402 sets no system prompt and
    // never opts out of the base prompt — see launcher/instructions.mjs.
    //
    // Always set, even with no owner text: AC-49/50/53/54 are properties of the
    // room rather than preferences of an owner, so every agent gets them.
    BUZZ_ACP_TEAM_INSTRUCTIONS: composeInstructions({ ownerText: instructions }),
    // Which model this agent runs on (AC-74/AC-75, DD-62).
    //
    // Set EXPLICITLY from the config, never inherited: `ANTHROPIC_MODEL` is
    // deliberately absent from HOME_VARS below, so an ambient value in the
    // node's own environment cannot reach a child. That was the rejected
    // alternative in DD-62 — widening the allowlist would work against AC-3
    // and would tie the model to how the node was launched rather than to
    // what its config says.
    ANTHROPIC_MODEL: resolveModel(agent, node).model,
    // curated PATH: only the tool dirs the agent needs, never the ambient env
    PATH: pathDirs.join(PATH_SEP),
  };

  if (respondTo === "allowlist") {
    const list = room.respondToAllowlist ?? [];
    if (list.length === 0) {
      throw new Error("respond_to allowlist mode requires a non-empty allowlist");
    }
    env.BUZZ_ACP_RESPOND_TO_ALLOWLIST = list.join(",");
  }

  // The agent's own owner attestation, injected by the buzz CLI into every
  // event the agent signs (AC-35). Without it the agent's messages carry no
  // verifiable owner and the room is back to trusting display names.
  if (!Array.isArray(authTag) || authTag[0] !== "auth") {
    throw new Error(
      `agent "${agent.name}": refusing to launch without a NIP-OA owner attestation`,
    );
  }
  env.BUZZ_AUTH_TAG = JSON.stringify(authTag);

  // Where the agent's capability-scoped runtime settings live (DD-11). Each
  // agent gets its own, so one agent's enabled capability never widens
  // another's. Only set when the caller genuinely wants the runtime's whole
  // config directory redirected — capability policy travels through the
  // working directory instead (see capabilities.mjs for why).
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  // The agent's model runtime has to find ITS OWNER'S credential store, which
  // lives under the owner's home. These vars are the OS's own scaffolding, not
  // secrets, and without them the runtime cannot locate the owner's login at
  // all — the agent wakes and every turn dies with "Authentication required"
  // (observed live, 2026-08-15).
  //
  // This is an explicit, named list, NOT `...process.env`: the isolation
  // invariant (AC-3) is that one agent's credentials can never appear in
  // another's process, and a blanket inherit would carry a stray
  // BUZZ_PRIVATE_KEY or ANTHROPIC_API_KEY straight through it.
  for (const key of HOME_VARS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }

  return env;
}

// OS scaffolding the child needs to resolve its owner's home and temp dirs.
// Deliberately excludes anything that could carry credentials.
const HOME_VARS = Object.freeze([
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);
