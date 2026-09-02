// Capability enforcement (spec AC-17, AC-12, AC-22).
//
// The `research` and `build` toggles are not advice to the model. They compile
// into a per-agent Claude Code settings directory whose `permissions.deny` list
// removes the matching tools from the runtime, so a research-disabled agent has
// no web tool to call however the request is phrased, and whoever asks.
//
// Cycle 1 (F-003) is the argument for doing it this way: with nothing enforcing
// the toggles, a non-owner asked for research and got a live Open-Meteo call
// back 42 seconds later. Asked about its own capabilities, the agent answered
// that it could find no toggle at all — "gated by the session permission mode
// on your side rather than by a feature flag I can see". A prompt-level rule is
// exactly as strong as the model's willingness to follow it; a missing tool is
// not negotiable.
//
// Deny rules win over every allow rule and over the permission mode, so this
// holds even though the harness runs with permissions bypassed (which it must,
// or a headless agent would block forever on an interactive prompt).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Tool denials per capability. Kept as data so the audited list is readable and
// so `lifted` in the tests can prove enabling one capability does not loosen
// the other.
//
// WebSearch/WebFetch are the ONLY web tools, so denying them is a complete
// block on research; curl and wget are denied too so the shell is not a way
// around it.
const RESEARCH_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Bash(curl:*)",
  "Bash(wget:*)",
  // Mirrored onto PowerShell: `Bash(curl:*)` says nothing about a PowerShell
  // tool reaching the same binary, and a rule for a tool that does not exist
  // costs nothing.
  "PowerShell(curl:*)",
  "PowerShell(wget:*)",
  "PowerShell(Invoke-WebRequest:*)",
  "PowerShell(Invoke-RestMethod:*)",
];

// Build is different, and the honest reason is worth stating: a general shell
// cannot be perfectly contained by a denylist — `echo x > file` writes a file
// whatever we list here. So this is DEFENCE IN DEPTH, not the primary control.
// The primary control is the authority gate, which never dispatches an
// unapproved action turn in the first place (src/listener/dispatch.mjs).
//
// Note what is NOT here: a bare `Bash` denial. It would be stronger, and it
// would also make the agent MUTE — Buzz discards an agent's plain text and an
// agent replies by RUNNING `buzz messages send`. Denying all of Bash produces
// exactly the "wakes and never speaks" failure the launcher fix exists to
// prevent. Verified live on 2026-08-15.
const BUILD_BINARIES = ["git", "npm", "npx", "node", "python", "py", "pip", "cargo", "make", "docker", "run402"];

const BUILD_TOOLS = [
  "Write",
  "Edit",
  "NotebookEdit",
  ...BUILD_BINARIES.map((b) => `Bash(${b}:*)`),
  ...BUILD_BINARIES.map((b) => `PowerShell(${b}:*)`),
];

// Always denied, whatever the capabilities: an agent must never be able to
// rewrite the file that constrains it, or `build` would silently imply "may
// grant itself research". Also keeps it out of the node's own state.
const ALWAYS_DENY = [
  "Read(**/settings.json)",
  "Edit(**/settings.json)",
  "Write(**/settings.json)",
  "Read(**/.hive402/**)",
  "Write(**/.hive402/**)",
];

// The agent speaks by RUNNING the buzz CLI — Buzz discards an agent's plain
// text output (spike finding, 2026-08-15). So a build-disabled agent still
// needs this one command, or it wakes and stays mute forever.
const ALWAYS_ALLOW = [
  "Bash(buzz:*)",
  "Bash(buzz.exe:*)",
  "PowerShell(buzz:*)",
  "PowerShell(buzz.exe:*)",
];

// The per-turn tool gate (DD-15, fix cycle 2).
//
// The denial lists above express what the OWNER enabled. They are read once,
// when the runtime session starts, so they cannot express "…and only when this
// turn is authorised" — which is the dimension F-007 walked through. spike's
// `research` was genuinely enabled, so the capability wall had nothing to say
// when a non-owner's request evaded the verb lexicon and reached the model.
//
// This hook adds that dimension. The runtime calls it immediately before every
// tool call; it reads the node's per-turn grant and refuses when the turn is
// not entitled to that capability. Measured working on this exact runtime
// (adapter 0.63.0 → claude-agent-sdk 0.3.220): a project-settings PreToolUse
// hook fires and denies even under `permission_mode=bypassPermissions`, which
// is the mode a headless agent must run in.
function gateHook({ agent, gate }) {
  // The enabled list travels with the hook so a refusal can say WHICH kind it
  // is: a capability the owner switched off (AC-17, no approval will help) or
  // one that simply has no grant this turn (AC-14, the owner is being asked).
  // Without it the agent cannot tell a dead end from a wait, and a live re-test
  // showed it picking the dead end and stopping there.
  const enabled = ["research", "build"].filter((c) => agent[c] === true).join(",");
  const base = `--agent ${agent.name} --state "${gate.stateDir}"`;
  // Per-agent files no grant can unlock (DD-56, AC-55) — today the agent's own
  // instructions file. `;`-separated inside one quoted value, because Windows
  // paths carry drive colons. The gate adds its own state dir by itself.
  const governed = (gate.governedPaths ?? []).filter(Boolean).join(";");
  const command =
    `"${gate.nodeBin}" "${gate.script}" ${base}` +
    (enabled ? ` --enabled ${enabled}` : "") +
    (governed ? ` --governed "${governed}"` : "");

  // The turn gate lives beside the tool gate, so one path derives from the
  // other rather than being configured twice and drifting apart.
  const turnScript = gate.turnScript ?? gate.script.replace(/toolgate\.mjs$/, "turngate.mjs");
  // AC-26 travels to the runtime, because the runtime is the only place that
  // sees every turn — including the ones the harness hands the owner directly,
  // which is the whole of F-011 (DD-23).
  const cap =
    gate.turnCap?.limit > 0
      ? ` --turn-cap ${gate.turnCap.limit} --turn-window ${gate.turnCap.windowMs ?? 3600000}`
      : "";
  const turnCommand = `"${gate.nodeBin}" "${turnScript}" ${base}${cap}`;

  return {
    PreToolUse: [
      {
        // Every tool, with no exceptions. A matcher listing "the dangerous
        // ones" would be another enumeration to keep in step with a runtime we
        // do not control; the gate classifies the tool itself and lets
        // conversation through in one line.
        matcher: "*",
        hooks: [{ type: "command", command, timeout: 20 }],
      },
    ],
    // Every turn, likewise. This is the only place the product can see a turn
    // the harness delivered straight to an agent's owner — which is precisely
    // the blind spot F-009 and F-011 both lived in (DD-19, DD-23).
    UserPromptSubmit: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: turnCommand, timeout: 15 }],
      },
    ],
  };
}

export function buildClaudeSettings({ agent, gate = null }) {
  const deny = [...ALWAYS_DENY];
  if (agent.research !== true) deny.push(...RESEARCH_TOOLS);
  if (agent.build !== true) deny.push(...BUILD_TOOLS);

  const settings = {
    // Recorded so an operator reading the file can see WHY a tool is missing.
    $hive402: {
      agent: agent.name,
      owner: agent.ownerPubkey,
      capabilities: { research: agent.research === true, build: agent.build === true },
      note: "generated by hive402 — edit the node config, not this file",
    },
    permissions: {
      deny,
      allow: [...ALWAYS_ALLOW],
    },
  };
  if (gate) settings.hooks = gateHook({ agent, gate });
  return settings;
}

// Names are unique per room (AC-37) and already validated, but they reach the
// filesystem here, so strip anything that could climb out of the root.
function safeDirName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, "_");
}

// Where an agent runs. Exported because the node needs the same answer for a
// second reason now — the workshop's source directory is a fixed subdirectory
// of it (DD-27) — and two places deriving one path from one rule is how they
// come to disagree.
export function agentWorkDir({ root, agent }) {
  return path.join(root, safeDirName(agent));
}

// Write the agent's per-agent PROJECT settings and return the working directory
// to launch it in.
//
// These are project settings (`<workDir>/.claude/settings.json`), not user
// settings, and that is load-bearing. The obvious alternative — point
// CLAUDE_CONFIG_DIR at a fresh per-agent directory — was tried on 2026-08-15
// and broke the agent completely: the runtime's CREDENTIALS live in that same
// config directory, so redirecting it cut the agent off from its owner's Claude
// login and every turn failed with "Authentication required". The owner's
// config dir is exactly where AC-3 wants the agent to look (its own owner's
// account, nobody else's), so it stays untouched and per-agent policy travels
// through the working directory instead.
//
// Truncating rather than merging is deliberate: the node config is the source
// of truth for capabilities, so a stale denial from a previous launch must not
// survive the owner turning a capability on.
// `gate` is REQUIRED here, and its absence throws rather than producing a file
// without the hook. A settings file with no `hooks` block looks entirely
// normal — there is nothing in it to notice — so an ungated launch would be a
// silent, total loss of per-turn containment. The pure builder above still
// accepts `gate: null` because tests exercise the denial lists on their own.
export function writeAgentRuntimeConfig({ agent, root, gate }) {
  if (!gate?.nodeBin || !gate?.script || !gate?.stateDir) {
    throw new Error(
      `agent "${agent.name}": refusing to write a runtime config without tool-gate wiring ` +
        `(nodeBin, script, stateDir) — an ungated agent has no per-turn capability containment`,
    );
  }
  // A hook whose script is not on disk is the same failure as no hook at all,
  // only quieter: the command runs, fails, and the runtime carries on ungated
  // with a settings file that reads as completely normal.
  const turnScript = gate.turnScript ?? gate.script.replace(/toolgate\.mjs$/, "turngate.mjs");
  for (const script of [gate.script, turnScript]) {
    if (!existsSync(script)) {
      throw new Error(
        `agent "${agent.name}": gate script does not exist at "${script}" — a hook pointing at a ` +
          `missing file fails silently, leaving the agent with no containment at all`,
      );
    }
  }
  const workDir = agentWorkDir({ root, agent: agent.name });
  const settingsDir = path.join(workDir, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, "settings.json");
  writeFileSync(
    settingsFile,
    `${JSON.stringify(buildClaudeSettings({ agent, gate }), null, 2)}\n`,
    "utf8",
  );
  return { workDir, settingsDir, settingsFile };
}
