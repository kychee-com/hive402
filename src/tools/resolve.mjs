// Where the tools hive402 runs actually live.
//
// ONE module knows what a binary is called on this platform and where to look
// for it. Everything else — `up`, `doctor`, `setup`, `join`, `profile`,
// `register`, `retire` — asks here.
//
// ── Why this module exists (F-039, 2026-09-02) ────────────────────────────
//
// It did not, and the discovery lived in `src/registry/profilecommand.mjs` as
// `buzzBinPath`, resolving the single name `buzz`. Three other call sites
// needed a path and wrote their own:
//
//     path.join(config.tools.buzzDir ?? "", "buzz-acp.exe")   supervisor.mjs
//     path.join(config.tools.buzzDir ?? "", "buzz.exe")       runtime.mjs x3
//     config.tools.adapter                                    passed verbatim
//
// On a fresh machine `tools.buzzDir` is `null` — `setup` writes no `tools` key
// at all and the schema normalises the absence to nulls — so the first join
// yields a bare RELATIVE `buzz-acp.exe` and the spawn fails ENOENT, while the
// adapter reaches `child_process` as `null` and produces a raw
// `ERR_INVALID_ARG_TYPE`. `setup` printed "Setup is complete. Run: hive402 up"
// and `up` could not launch anything.
//
// The `.exe` is the second half: on macOS and Linux those joins are wrong even
// with a hand-written `tools` block, so an agent could not be launched there
// under ANY configuration.
//
// Generalising the resolver that already worked is the whole fix. Its header
// comment already recorded that it was written after this same class of bug bit
// `join` — three call sites hardcoded the Windows name anyway, which is why
// `test/toolresolve.test.mjs` pins the literals here structurally rather than
// asking the next author to remember.
//
// ── The two doctrines, carried over verbatim ──────────────────────────────
//
//   1. An explicit path is the operator's answer and is NOT second-guessed. A
//      configured `tools.buzzDir` or `tools.adapter` is used as given, and a
//      miss is reported against THAT path rather than silently replaced by a
//      discovered one. "It works but I cannot tell you which binary ran" is
//      not an improvement over a clear failure.
//   2. The bare name is the LAST resort, so PATH still wins for anyone who has
//      arranged it.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Where Buzz actually installs itself.
//
// FOUND BY BARRY RUNNING `hive402 join` (2026-08-26). This used to return a
// bare `buzz.exe` when no directory was configured, on the assumption that
// `execFile` would find it on PATH. Buzz does not put itself on PATH: on
// Windows it installs to `%LOCALAPPDATA%\Buzz`. So the join claimed the invite,
// recorded the policy acceptance, asked for a display name — and then:
//
//     ! joined, but the name could not be published: buzz users set-profile:
//       exit ENOENT
//
// on a machine with Buzz installed and working. `join` is the FIRST command
// anyone runs and it is the one command with no config to read `tools.buzzDir`
// from, so the bare-name assumption failed exactly where it hurt most.
//
// Order: what the config says, then where Buzz actually installs itself, then
// PATH, then the bare name so PATH still wins for anyone who has arranged it.
export const KNOWN_DIRS = {
  win32: (env) => [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Buzz"),
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Buzz"),
    env.APPDATA && path.join(env.APPDATA, "Buzz"),
  ],
  darwin: (env) => [
    "/Applications/Buzz.app/Contents/MacOS",
    env.HOME && path.join(env.HOME, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ],
  linux: (env) => [
    env.HOME && path.join(env.HOME, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/buzz",
  ],
};

// The ACP adapter hive402 launches every Claude agent through, and the exact
// command that installs it. Quoted into the refusal so the remedy is one paste.
export const ADAPTER_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const ADAPTER_ENTRY = ["@agentclientprotocol", "claude-agent-acp", "dist", "index.js"];

// Where `npm install -g` puts a package when nobody asked npm.
//
// Verified on this box (2026-09-02): `npm root -g` answers
// `C:\Users\volin\AppData\Roaming\npm\node_modules`, and the adapter is at
// exactly that join.
const NPM_ROOTS = {
  win32: (env) => [env.APPDATA && path.join(env.APPDATA, "npm", "node_modules")],
  darwin: (env) => [
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    env.HOME && path.join(env.HOME, ".npm-global", "lib", "node_modules"),
  ],
  linux: (env) => [
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    env.HOME && path.join(env.HOME, ".npm-global", "lib", "node_modules"),
  ],
};

const dirsFor = (table, platform, env) => (table[platform] ?? table.linux)(env).filter(Boolean);

// PATH, read the way the TARGET platform writes it rather than the way this
// process's own `path.delimiter` does — the whole point of injecting a platform
// is that a test on Linux can ask what Windows would do.
function pathDirs(platform, env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return String(raw)
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim())
    .filter(Boolean);
}

// What this binary is called here. The ONE place in the product that knows.
export function toolName(binary, platform) {
  return platform === "win32" ? `${binary}.exe` : binary;
}

// The full answer: the path, where it came from, whether it is really there,
// and every place that was looked at. `up` and `doctor` need all four — a
// refusal that cannot say where it looked is the "tools.buzzDir not set"
// message this fix replaces.
export function locateTool(
  binary,
  dir = null,
  { exists = existsSync, platform = process.platform, env = process.env } = {},
) {
  const name = toolName(binary, platform);

  // Doctrine 1. A configured directory is the operator's answer: if the binary
  // is not in it, THAT is the finding, and a Buzz discovered somewhere else
  // must not quietly take its place.
  if (dir) {
    const candidate = path.join(dir, name);
    return {
      tool: binary,
      path: candidate,
      // The operator's own string, byte for byte. `path.dirname(path.join(...))`
      // round-trips to the same DIRECTORY but re-spells it (on Windows
      // "/opt/buzz" comes back as "\opt\buzz"), and rewriting the value
      // someone typed is a small second-guess that doctrine 1 has no room for.
      configured: dir,
      source: "configured",
      exists: exists(candidate),
      searched: [candidate],
    };
  }

  const searched = [];
  for (const known of dirsFor(KNOWN_DIRS, platform, env)) {
    const candidate = path.join(known, name);
    // Two of the known directories can resolve to the same place (on a box
    // where %LOCALAPPDATA% and %APPDATA% agree, say). Listing it twice in the
    // refusal reads as a bug in the refusal.
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (exists(candidate)) return { tool: binary, path: candidate, configured: null, source: "known", exists: true, searched };
  }

  // Doctrine 2, honoured rather than merely asserted. A resolver that refuses
  // `up` without ever consulting PATH would break exactly the operator the
  // "PATH still wins" fallback was written for.
  for (const onPath of pathDirs(platform, env)) {
    const candidate = path.join(onPath, name);
    if (exists(candidate)) return { tool: binary, path: candidate, configured: null, source: "path", exists: true, searched };
  }

  // Nothing on disk. The bare name still gets the last word, so `execFile` has
  // its own chance (a shim, a PATHEXT variant) when a caller runs it anyway.
  return { tool: binary, path: name, configured: null, source: "none", exists: false, searched };
}

export function toolBinPath(binary, dir = null, opts = {}) {
  return locateTool(binary, dir, opts).path;
}

export const buzzBinPath = (dir = null, opts = {}) => toolBinPath("buzz", dir, opts);
export const buzzAcpPath = (dir = null, opts = {}) => toolBinPath("buzz-acp", dir, opts);

// `npm root -g`, asked at most once per process and ONLY when the adapter is
// not configured — so the common case (a `tools.adapter` in the config, which
// every hand-written block on this project's boxes has) spawns nothing.
//
// A custom npm prefix is the only case the platform fallbacks below cannot
// cover, and npm is the only thing that knows about it. When npm cannot be
// asked at all, the fallbacks are the answer, which is why the failure is a
// `null` rather than a throw.
let askedNpm = false;
let npmAnswer = null;
export function defaultNpmRoot() {
  if (askedNpm) return npmAnswer;
  askedNpm = true;
  try {
    const out = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      // npm is `npm.cmd` on Windows, which Node refuses to spawn without one.
      // The command and its arguments are literals here — nothing interpolated.
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    npmAnswer = out.trim() || null;
  } catch {
    npmAnswer = null; // npm absent or slow: the platform fallbacks answer instead
  }
  return npmAnswer;
}

// hive402 is itself an npm-global package on a fresh machine (`npm install -g
// hive402`), so the directory this very file was loaded from names the global
// root exactly, with no spawn and no guessing. Silent when hive402 is running
// from a checkout, which is the rig and this repo's own test runs.
function selfInstallRoot(moduleUrl) {
  try {
    const here = path.dirname(fileURLToPath(moduleUrl));
    const up = path.resolve(here, "..", "..", ".."); // src/tools → src → hive402 → node_modules
    return path.basename(up) === "node_modules" ? up : null;
  } catch {
    return null; // a non-file URL cannot name an install directory
  }
}

const asRoots = (npmRoot) => {
  const value = typeof npmRoot === "function" ? npmRoot() : npmRoot;
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
};

export function locateAdapter(
  configured = null,
  {
    exists = existsSync,
    platform = process.platform,
    env = process.env,
    npmRoot = defaultNpmRoot,
    moduleUrl = import.meta.url,
  } = {},
) {
  // Doctrine 1 again, and it matters more here than anywhere: `tools.adapter`
  // is the escape hatch for an adapter installed anywhere at all, so it is used
  // exactly as written and a miss is reported against it.
  if (configured) {
    return {
      tool: "adapter",
      path: configured,
      configured,
      source: "configured",
      exists: exists(configured),
      searched: [configured],
    };
  }

  const searched = [];
  const roots = [selfInstallRoot(moduleUrl), ...asRoots(npmRoot), ...dirsFor(NPM_ROOTS, platform, env)].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, ...ADAPTER_ENTRY);
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (exists(candidate)) return { tool: "adapter", path: candidate, configured: null, source: "known", exists: true, searched };
  }

  // Deliberately `null` rather than a best guess. Defect 2 was a path-shaped
  // value reaching `child_process` as an argument; a guess that does not exist
  // is the same failure with a longer error message.
  return { tool: "adapter", path: null, configured: null, source: "none", exists: false, searched };
}

export function adapterPath(configured = null, opts = {}) {
  return locateAdapter(configured, opts).path;
}

// Where Node is, for the AGENT's environment.
//
// FOUND BY THE LIVE CELL (FIX-190, 2026-09-02), and it is the half Phase 45
// deliberately excluded on a premise that turned out to be false. That note
// said `nodeDir` needed no discovery because "`--agent-command` is the bare
// `node`, which works because Node is on PATH by construction".
//
// It is not. `buildAgentEnv` CURATES the child's PATH — it is built from
// `tools.buzzDir`, `tools.nodeDir` and `tools.extraDirs` and nothing else, on
// purpose, so an agent cannot reach a tool nobody granted it. With no `tools`
// block all three are empty, so the agent's PATH is the empty string and the
// harness reports:
//
//     ERROR buzz_acp: agent failed to spawn: IO error: program not found
//
// The node comes up, the harness connects, the room shows the agent online,
// and every turn dies. Node being on the OPERATOR's PATH says nothing about
// the agent's.
//
// No heuristic is needed: hive402 IS a Node program, so the interpreter
// running this line is the one the agent should use. `process.execPath` is
// exact, and a configured `tools.nodeDir` still wins under doctrine 1.
export function locateNodeDir(configured = null, { execPath = process.execPath } = {}) {
  if (configured) {
    return { tool: "node", path: configured, configured, source: "configured", exists: true, searched: [configured] };
  }
  const dir = path.dirname(execPath);
  return { tool: "node", path: dir, configured: null, source: "self", exists: true, searched: [dir] };
}

// The three paths a launch needs, from one config, in one call.
export function resolveTools(config, opts = {}) {
  const buzzDir = config?.tools?.buzzDir ?? null;
  const buzz = locateTool("buzz", buzzDir, opts);
  const harness = locateTool("buzz-acp", buzzDir, opts);
  const adapter = locateAdapter(config?.tools?.adapter ?? null, opts);
  const node = locateNodeDir(config?.tools?.nodeDir ?? null, opts);
  return { buzz, harness, adapter, node, missing: [buzz, harness, adapter].filter((t) => !t.exists) };
}

const WHAT_IT_IS = {
  buzz: "hive402 talks to the relay through the Buzz CLI.",
  "buzz-acp": "hive402 runs each agent through the Buzz ACP harness.",
};

// The message an operator can act on. Never a bare ENOENT and never a raw
// ERR_INVALID_ARG_TYPE: it names the tool, where it was looked for, and the one
// command or one config key that fixes it.
export function describeMissingTool(entry, { configFile = null } = {}) {
  const where = configFile ?? "your hive402 config";
  const isAdapter = entry.tool === "adapter";
  const key = isAdapter ? "tools.adapter" : "tools.buzzDir";

  if (entry.source === "configured") {
    const head = isAdapter
      ? `ACP adapter not found at the path ${key} names:`
      : `${entry.tool} not found at the path ${key} names:`;
    const remedy = isAdapter
      ? `  Install it:  npm install -g ${ADAPTER_PACKAGE}\n  Or point ${key} in ${where} at its dist/index.js path.`
      : `  Install Buzz there, or point ${key} in ${where} at the directory that holds ${entry.tool}.`;
    return `${head}\n    ${entry.path}\n${remedy}`;
  }

  if (isAdapter) {
    return (
      "ACP adapter not found. hive402 launches agents through the Claude Code ACP adapter.\n" +
      `  Install it:  npm install -g ${ADAPTER_PACKAGE}\n` +
      `  Or set ${key} in ${where} to its dist/index.js path.`
    );
  }

  const looked = entry.searched.length ? `  Looked in:\n${entry.searched.map((p) => `    ${p}`).join("\n")}\n` : "";
  return (
    `${entry.tool} not found. ${WHAT_IT_IS[entry.tool] ?? ""}\n` +
    looked +
    `    (and on PATH)\n` +
    `  Install Buzz, or set ${key} in ${where} to the directory that holds ${entry.tool}.`
  );
}

// The directories an agent's curated PATH is built from, resolved rather than
// read raw — so a config with no `tools` block produces a PATH that can
// actually run the tools the agent is granted.
export function agentPathDirs(tools, config = null) {
  const buzzDir =
    tools.buzz.configured ?? (tools.buzz.exists && tools.buzz.path ? path.dirname(tools.buzz.path) : null);
  return {
    buzzDir,
    nodeDir: tools.node.path,
    extraDirs: config?.tools?.extraDirs ?? [],
  };
}

// The one-line form, for a report that prints one line per step.
export function summariseMissingTool(entry) {
  if (entry.tool === "adapter") return `ACP adapter not found — npm install -g ${ADAPTER_PACKAGE}`;
  return `${entry.tool} not found — install Buzz, or set tools.buzzDir to the directory that holds it`;
}

// What `setup` writes into the config it creates (AC-44, DD-71).
//
// The schema is UNCHANGED — `buzzDir` is still a directory and `adapter` still
// a file — so every hand-written block that already exists keeps working
// untouched. This only fills in the block that was never written at all.
//
// `null` where nothing was found, deliberately. A path invented from a bare
// name (`path.dirname("buzz") === "."`) is exactly the relative-path defect
// this fix exists to remove, and the schema treats a null and an absent key
// identically — so an honest null costs nothing and states the truth.
export function toolsBlock(tools) {
  // Doctrine 1, and it matters most HERE. Blanking a configured path because
  // the file is not there today would be the loudest possible second-guess:
  // the operator loses the setting AND the miss stops being reported against
  // the path they chose. So a configured value is kept whether or not it
  // exists; only a value nobody configured and nothing found becomes null.
  const dirOf = (entry) => (entry.exists && entry.path ? path.dirname(entry.path) : null);
  return {
    // One key names one directory and `up` spawns the HARNESS out of it, so the
    // harness decides when the two are somehow not co-located. `doctor` then
    // reports the CLI against the written directory, which is how a
    // disagreement becomes visible instead of silent.
    buzzDir: tools.harness.configured ?? tools.buzz.configured ?? dirOf(tools.harness) ?? dirOf(tools.buzz),
    adapter: tools.adapter.configured ?? (tools.adapter.exists ? tools.adapter.path : null),
  };
}

// The pre-flight. `up` calls this BEFORE anything is spawned, so a fresh
// machine gets the remedy rather than an ENOENT from a relative path or a
// TypeError from a null argument.
export function assertToolsPresent(tools, { configFile = null } = {}) {
  if (!tools.missing.length) return;
  const blocks = tools.missing.map((entry) => describeMissingTool(entry, { configFile }));
  const what = tools.missing.length === 1 ? "a tool it needs is" : "tools it needs are";
  throw new Error(`cannot start: ${what} missing.\n\n${blocks.join("\n\n")}`);
}
