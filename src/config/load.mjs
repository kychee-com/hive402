// Config discovery and editing.
//
// Cycle 1 (F-002) searched %USERPROFILE%\.hive402, %USERPROFILE%\.config\hive402,
// a project-local hive402.config.json and every HIVE402_* env var, and found
// nothing — because nothing read a config at all. Those are exactly the paths
// searched here, so the next person looking finds the file where they expected.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parseConfig, DEFAULT_AGENT_SETTINGS } from "./schema.mjs";

// `home`, `cwd` and `env` are parameters rather than reads of the ambient
// process so that WHERE a config goes becomes a testable decision. It was not
// one before, and the bug FIX-126 fixes lived exactly in the untestable part.
export function candidatePaths(explicit, { home = homedir(), cwd = process.cwd(), env } = {}) {
  if (explicit) return [path.resolve(explicit)];
  const pinned = env === undefined ? process.env.HIVE402_CONFIG : env;
  return [
    pinned,
    // FIRST, and it stays first. A project-local config is a real thing to want,
    // and every install made before FIX-126 has one, because that is where
    // `setup` used to write. Demoting it would strand all of them, which is a
    // worse bug than the one being fixed.
    path.join(cwd, "hive402.config.json"),
    // Where `setup` writes now, and the reason `hive402 up` works from any
    // directory at all (FIX-126).
    path.join(home, ".hive402", "config.json"),
    path.join(home, ".config", "hive402", "config.json"),
  ].filter(Boolean);
}

// Where `setup` should WRITE. Three rules, in order:
//
//   1. an explicit --config is the answer, always;
//   2. a config that already exists is reused, never duplicated. Re-running
//      setup is meant to be safe and resumable (AC-44), and a second config in
//      the home directory beside a real one in a project folder would leave the
//      machine with two, chosen between by whichever matched the cwd that day;
//   3. otherwise the user's home directory.
//
// Rule 3 is the fix. This used to be `path.resolve("hive402.config.json")` — the
// CURRENT WORKING DIRECTORY — so the config landed wherever the person happened
// to be standing, and every later command then worked from that one directory
// and nowhere else. Found by Barry running `hive402 up` one directory over from
// the one he set up in, on a machine with a working node and a live room.
export function setupConfigTarget({ explicit = null, found = null, home = homedir() } = {}) {
  if (explicit) return path.resolve(explicit);
  if (found) return found;
  return path.join(home, ".hive402", "config.json");
}

export function findConfigFile(explicit, locations = {}) {
  const searched = candidatePaths(explicit, locations);
  const found = searched.find((p) => existsSync(p));
  if (!found) {
    // FIX-126, the other half of the same report: "I want to get clean simple
    // answers, this is like debug data." This used to print three absolute paths
    // and end with "Create one", which describes the failure and names nothing
    // anybody can type.
    //
    // TWO different failures, which the first cut of this fix collapsed into one
    // and a pre-existing test correctly refused. Somebody who PASSED a path has
    // a typo in a specific file name and needs to see that file name; somebody
    // who passed nothing has no config at all and needs the command that makes
    // one. A single message cannot be the clean simple answer to both.
    const err = new Error(
      explicit
        ? `config not found: ${searched[0]}`
        : `no config found. Run \`hive402 setup\` to create one.\n` +
          `  It will be written to ${setupConfigTarget({ home: locations.home ?? homedir() })}, ` +
          `which works from any directory.\n` +
          `  Already have one elsewhere? Pass --config <path>, or set HIVE402_CONFIG.`,
    );
    err.searched = searched;
    throw err;
  }
  return found;
}

// Returns both the parsed config and the raw object, because `config set` must
// write back the file the human wrote — not a normalised version of it with
// every default materialised.
function readRaw(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: not valid JSON — ${err.message}`);
  }
}

export function loadConfig(explicit) {
  const file = findConfigFile(explicit);
  const raw = readRaw(file);
  let config;
  try {
    config = parseConfig(raw);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  return { file, raw, config };
}

// ── Which state directory is this? (F-038, DD-72) ─────────────────────────
//
// Red Team cycle 21: a throwaway node joined a policy-gated community with its
// own `--config`, whose config declared its own `stateDir`, and the acceptance
// record landed in Barry's PRODUCTION state directory. The throwaway's own
// `stateDir` was never created at all.
//
// The write site was never the problem — `writeJoinRecord({ stateDir, record })`
// has always taken a `stateDir`, and `cmdJoin` already called
// `defaultStateDir(config)`. The problem was one line below, at four commands:
//
//     try { config = resolveHive(flags).config; stateDir = defaultStateDir(config); }
//     catch { stateDir = path.join(homedir(), ".hive402"); }
//
// `parseConfig` REJECTS a config with no rooms; a room needs a registered
// agent; an agent cannot be registered until after the join. So at the moment
// `join` runs, a legitimately-authored config throws, and that `catch`
// swallowed it and relocated the write to the home directory — which is where
// the machine's FIRST node lives, because a config that declares no `stateDir`
// (Barry's does not) resolves there too.
//
// The catch collapsed three outcomes this module already tells apart. They are
// three different answers and only one of them is "carry on quietly":
//
//   no-config  nothing anywhere        → the home default, silently. A machine
//                                        with no config has one node and this
//                                        is its directory. Step one, by design.
//   unparsed   a file that is not yet
//              launch-ready            → ITS OWN declared stateDir, read from
//                                        the raw object. Reading one top-level
//                                        string must not require the config to
//                                        be ready to run agents.
//   parsed     a complete config       → the same answer, via the same seam.
//
// and one hard failure: an explicit `--config` that cannot be found, or any
// config file that is not readable JSON. The operator named a file, or a file
// is plainly there; writing somewhere else instead is not an interpretation of
// either.
export const STATE_DIR_NAME = ".hive402";

export function homeStateDir(home = homedir()) {
  return path.join(home, STATE_DIR_NAME);
}

// A relative `stateDir` belongs to the config that declares it, not to the
// directory the command happened to run from. Same class as FIX-126: a path
// resolved against the cwd follows the operator around, so one config means
// different directories on different days. An absolute path is left exactly as
// written — the operator's answer is not rewritten.
export function stateDirFrom({ declared = null, file = null, home = homedir() } = {}) {
  if (!declared) return homeStateDir(home);
  if (path.isAbsolute(declared)) return declared;
  return path.resolve(file ? path.dirname(path.resolve(file)) : process.cwd(), declared);
}

export function resolveStateDir(explicit = null, { mustExist = true, ...locations } = {}) {
  const home = locations.home ?? homedir();

  let file;
  try {
    file = findConfigFile(explicit, locations);
  } catch (err) {
    // An explicit --config that is not there is an ERROR: relocating the write
    // into another node's directory is the defect, not a fallback.
    //
    // Except for `setup`, which passes `mustExist: false` — naming a config
    // that does not exist yet is how you tell setup WHERE to create it.
    if (explicit && mustExist) throw err;
    return { stateDir: homeStateDir(home), file: null, raw: null, config: null, reason: "no-config" };
  }

  const raw = readRaw(file);

  let config = null;
  let reason = "parsed";
  try {
    config = parseConfig(raw);
  } catch {
    // Not launch-ready, which at join/setup/keygen time is the NORMAL state of
    // a real config rather than an error. The state directory is still known.
    reason = "unparsed";
  }

  return { stateDir: stateDirFrom({ declared: raw?.stateDir ?? null, file, home }), file, raw, config, reason };
}

// AC-20 — change a setting through the config file. The path is
// "<agent>.<setting>"; only the six owner-facing settings are addressable, and
// the value is validated by re-parsing the whole config before it is written,
// so a bad edit fails loudly instead of leaving an agent on a value its owner
// never chose.
export function setSetting({ file, raw, agentName, setting, value }) {
  if (!(setting in DEFAULT_AGENT_SETTINGS)) {
    throw new Error(
      `unknown setting "${setting}" — the owner-facing settings are: ` +
        `${Object.keys(DEFAULT_AGENT_SETTINGS).join(", ")}`,
    );
  }

  let target = null;
  for (const room of raw.rooms ?? []) {
    for (const agent of room.agents ?? []) {
      if (agent.name?.toLowerCase() === agentName.toLowerCase()) target = agent;
    }
  }
  if (!target) throw new Error(`no agent named "${agentName}" in this config`);

  const before = target[setting] ?? DEFAULT_AGENT_SETTINGS[setting];
  target[setting] = coerce(value);

  // Validate by re-parsing: one source of truth for what is legal.
  parseConfig(raw);

  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { agent: agentName, setting, from: before, to: target[setting] };
}

function coerce(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

// WHICH hive did this command just resolve? (AC-73.)
//
// One machine can run several hives (AC-72), and the config a command picks up
// is decided by a search order most people never read. The red team caught the
// shape of this before it cost anything: a bare `hive402` with no `--config`
// resolved to a LIVE production hive, and nothing in the output said so. With
// one node that is untidy; with three it is how a command lands on the wrong
// room, and the wrong room is somebody's.
//
// Two facts, because either alone can mislead: the FILE (did I point at the
// hive I meant?) and the IDENTITY that file names (is this the hive I think
// that file describes?). A config with no identity still gets the file — half
// an answer is the half that matters most.
export function hiveBanner({ configFile, config }) {
  const pubkey = config?.node?.pubkey ?? null;
  const which = pubkey ? `hive ${pubkey.slice(0, 12)}…` : "hive (no identity in this config)";
  return `hive402: ${which} · config ${configFile ?? "(none)"}`;
}

// Write the retirement down (AC-70, DD-60).
//
// Deliberately NOT `setSetting`: that function guards the six owner-facing
// settings (AC-18's closed set), and refusing anything else is that guard doing
// its job. Retirement is lifecycle state, so it gets its own door — with the
// same discipline: validate by re-parsing before writing, so a config that
// would not load is never left on disk.
//
// The entry is MARKED rather than deleted. The owner keeps the record of what
// was there — the pubkey included, which is the only way to identify the
// identity now wearing the dead name — and `retire` can tell "already retired"
// from "never existed", a distinction that reads as a bug when it collapses.
export function markRetired({ file, raw, agentName }) {
  let target = null;
  for (const room of raw.rooms ?? []) {
    for (const agent of room.agents ?? []) {
      if (agent.name?.toLowerCase() === agentName.toLowerCase()) target = agent;
    }
  }
  if (!target) throw new Error(`no agent named "${agentName}" in this config`);
  if (target.retired === true) return { agent: agentName, alreadyRetired: true };

  target.retired = true;
  parseConfig(raw);
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { agent: agentName, alreadyRetired: false };
}
