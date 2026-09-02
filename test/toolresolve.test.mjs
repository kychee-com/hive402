// F-039 — `setup` finishes, `up` cannot start: the tools block nobody writes.
//
// Found preparing the second-host test on Tal's machine (2026-09-02). On a
// fresh machine `hive402 setup` runs end to end and prints "Setup is complete.
// Run: hive402 up" — and `up` then cannot launch an agent at all, because the
// launcher reads a `tools` block that nothing ever writes:
//
//   supervisor.mjs:873  path.join(tools.buzzDir ?? "", "buzz-acp.exe")
//                       → buzzDir is null, so the join yields a bare RELATIVE
//                         "buzz-acp.exe"; spawn ENOENT
//   supervisor.mjs:881  tools.adapter passed verbatim as a spawn arg
//                       → null reaches child_process → ERR_INVALID_ARG_TYPE,
//                         a raw TypeError with no remedy in it
//   bin/cli.mjs doctor  same raw reads, same hardcoded names
//                       → "tools.buzzDir not set", accurate and useless
//
// Twenty cycles never hit it because every config on this box carries a
// hand-written `tools` block, so the one config shape nobody ever launched is
// the shape `setup` itself produces.
//
// ── Why the matrix is at the resolver seam and not end to end ─────────────
//
// A `setup`-to-`up` test would need a real Buzz install and a real relay, so it
// would be either a mock of the mechanism — which has shipped bugs in this
// product twice — or non-hermetic. `platform`, `env`, `exists` and `npmRoot`
// are all injected here, so nothing spawns and nothing touches the real
// filesystem; the live proof (FIX-190) is the other half of that split.
//
// ── The two doctrines being pinned ────────────────────────────────────────
//
//   1. An explicit path is the operator's answer and is NOT second-guessed. A
//      configured directory or adapter is used as given, and a miss is reported
//      against THAT path — never silently replaced by a discovered one.
//   2. The bare name is the LAST resort, so PATH still wins for anyone who
//      arranged it. That is also why "missing" consults PATH before it refuses:
//      a doctrine that says PATH wins, in a resolver that refuses without ever
//      looking at PATH, is not the doctrine it claims to be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  ADAPTER_PACKAGE,
  adapterPath,
  agentPathDirs,
  assertToolsPresent,
  buzzAcpPath,
  buzzBinPath,
  describeMissingTool,
  locateAdapter,
  locateNodeDir,
  locateTool,
  resolveTools,
  summariseMissingTool,
  toolBinPath,
  toolsBlock,
} from "../src/tools/resolve.mjs";

const NOTHING = () => false;
const only = (...paths) => (p) => paths.includes(p);

// ── The platform half: what is this binary CALLED here? ───────────────────
//
// The failing test written first (FIX-185). The hardcoded `.exe` makes an agent
// launch impossible on macOS/Linux under ANY configuration — a correct `tools`
// block does not save it — so this is the defect that would have stopped the
// second-host test at its first `up`.

test("buzzAcpPath on darwin with no configured dir resolves buzz-acp, not buzz-acp.exe", () => {
  const resolved = buzzAcpPath(null, { platform: "darwin", env: {}, exists: NOTHING });
  assert.equal(resolved, "buzz-acp");
  assert.doesNotMatch(resolved, /\.exe$/, "the Windows suffix must not survive onto a mac");
});

test("the platform name is decided in one place for every binary", () => {
  for (const [platform, suffix] of [["win32", ".exe"], ["darwin", ""], ["linux", ""]]) {
    for (const binary of ["buzz", "buzz-acp"]) {
      assert.equal(
        toolBinPath(binary, null, { platform, env: {}, exists: NOTHING }),
        `${binary}${suffix}`,
        `${binary} on ${platform}`,
      );
    }
  }
});

// ── Doctrine 1: an explicit path is not second-guessed ────────────────────

test("a configured directory is used as given, even when the binary is not in it", () => {
  // The miss must be reported against the operator's own path. Silently using a
  // different Buzz found somewhere else is how "it works on my machine and I
  // cannot tell you which binary ran" starts.
  const found = path.join("C:/Users/x/AppData/Local", "Buzz", "buzz.exe");
  const located = locateTool("buzz", "C:/operator/said/here", {
    platform: "win32",
    env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" },
    exists: only(found),
  });
  assert.equal(located.path, path.join("C:/operator/said/here", "buzz.exe"));
  assert.equal(located.source, "configured");
  assert.equal(located.exists, false, "it is genuinely not there, and that is what should be said");
  assert.notEqual(located.path, found, "a discovered binary must never displace the configured one");
});

test("a configured adapter is used as given, even when the file is not there", () => {
  const located = locateAdapter("/operator/said/here/index.js", {
    platform: "linux",
    env: {},
    exists: NOTHING,
    npmRoot: "/usr/lib/node_modules",
  });
  assert.equal(located.path, "/operator/said/here/index.js");
  assert.equal(located.source, "configured");
  assert.equal(located.exists, false);
});

// ── Doctrine 2: the bare name is the last resort, so PATH still wins ──────

test("with nothing configured it looks where the tool actually installs itself", () => {
  const found = path.join("C:/Users/x/AppData/Local", "Buzz", "buzz-acp.exe");
  assert.equal(
    buzzAcpPath(null, {
      platform: "win32",
      env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" },
      exists: only(found),
    }),
    found,
  );
});

test("PATH is consulted before anything is declared missing", () => {
  // The doctrine says PATH wins. A resolver that refuses `up` without ever
  // looking at PATH would break exactly the operator who arranged one.
  const onPath = path.join("/opt/custom/bin", "buzz-acp");
  const located = locateTool("buzz-acp", null, {
    platform: "linux",
    env: { PATH: ["/usr/bin", "/opt/custom/bin"].join(":") },
    exists: only(onPath),
  });
  assert.equal(located.path, onPath);
  assert.equal(located.source, "path");
  assert.equal(located.exists, true);
});

test("and falls back to the bare name when even PATH has nothing", () => {
  const located = locateTool("buzz", null, { platform: "linux", env: { PATH: "/usr/bin" }, exists: NOTHING });
  assert.equal(located.path, "buzz", "the last word still goes to the bare name");
  assert.equal(located.source, "none");
  assert.equal(located.exists, false);
  assert.ok(located.searched.length > 0, "and it must be able to say where it looked");
});

// ── The adapter: discovery, and a refusal that names the install command ──

test("the adapter is discovered under the global npm root", () => {
  const entry = path.join("C:/Users/x/AppData/Roaming/npm/node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  assert.equal(
    adapterPath(null, {
      platform: "win32",
      env: {},
      exists: only(entry),
      npmRoot: "C:/Users/x/AppData/Roaming/npm/node_modules",
      moduleUrl: "file:///C:/checkout/src/tools/resolve.mjs",
    }),
    entry,
  );
});

test("and under each platform's npm-global fallback when npm cannot be asked", () => {
  const cells = [
    ["win32", { APPDATA: "C:/Users/x/AppData/Roaming" }, "C:/Users/x/AppData/Roaming/npm/node_modules"],
    ["darwin", {}, "/opt/homebrew/lib/node_modules"],
    ["darwin", {}, "/usr/local/lib/node_modules"],
    ["linux", { HOME: "/home/tal" }, "/home/tal/.npm-global/lib/node_modules"],
    ["linux", {}, "/usr/local/lib/node_modules"],
  ];
  for (const [platform, env, root] of cells) {
    const entry = path.join(root, "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
    assert.equal(
      adapterPath(null, { platform, env, exists: only(entry), npmRoot: null, moduleUrl: "file:///checkout/src/tools/resolve.mjs" }),
      entry,
      `${platform} → ${root}`,
    );
  }
});

test("an absent adapter resolves to nothing rather than to a guess", () => {
  const located = locateAdapter(null, {
    platform: "darwin",
    env: {},
    exists: NOTHING,
    npmRoot: null,
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  assert.equal(located.path, null, "a path that does not exist is worse than no path: it reaches spawn as an arg");
  assert.equal(located.exists, false);
});

// ── The refusal itself (FIX-186) ──────────────────────────────────────────

test("a missing adapter names the exact install command, never a bare TypeError", () => {
  const located = locateAdapter(null, {
    platform: "darwin",
    env: {},
    exists: NOTHING,
    npmRoot: null,
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  const message = describeMissingTool(located, { configFile: "/home/tal/.hive402/config.json" });
  assert.match(message, /ACP adapter not found/);
  assert.ok(
    message.includes("npm install -g @agentclientprotocol/claude-agent-acp"),
    `the remedy has to be copy-pasteable:\n${message}`,
  );
  assert.match(message, /tools\.adapter/);
  assert.match(message, /\/home\/tal\/\.hive402\/config\.json/, "and it must name the file to edit");
  assert.doesNotMatch(message, /ERR_INVALID_ARG_TYPE/);
});

test("a missing harness names buzz-acp and says where it looked", () => {
  const located = locateTool("buzz-acp", null, {
    platform: "linux",
    env: { HOME: "/home/tal", PATH: "/usr/bin" },
    exists: NOTHING,
  });
  const message = describeMissingTool(located, { configFile: "/home/tal/.hive402/config.json" });
  assert.match(message, /buzz-acp/);
  assert.match(message, /Looked in/);
  assert.ok(
    message.includes(path.join("/usr/local/bin", "buzz-acp")),
    `the places it actually searched, not a generic apology:\n${message}`,
  );
  assert.match(message, /tools\.buzzDir/, "and the escape hatch for a Buzz installed somewhere else");
});

test("a configured-but-absent tool is reported against the operator's own path", () => {
  const located = locateTool("buzz-acp", "/operator/said/here", { platform: "linux", env: {}, exists: NOTHING });
  const message = describeMissingTool(located, { configFile: "/c.json" });
  assert.ok(message.includes(path.join("/operator/said/here", "buzz-acp")), message);
  assert.doesNotMatch(message, /Looked in/, "nothing else was searched, so claiming otherwise would be a lie");
});

// ── The whole matrix: platform x config x adapter ─────────────────────────

const CONFIGURED = {
  tools: {
    buzzDir: "/opt/buzz",
    nodeDir: null,
    adapter: "/opt/acp/dist/index.js",
    extraDirs: [],
  },
};
// Exactly what `src/config/schema.mjs` normalises a config with no `tools` key
// to — the fresh-machine shape, and the one nobody ever launched.
const UNSET = { tools: { buzzDir: null, nodeDir: null, adapter: null, extraDirs: [] } };

test("platform x config x adapter, at the seam", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const suffix = platform === "win32" ? ".exe" : "";
    const env = platform === "win32"
      ? { LOCALAPPDATA: "C:/Users/x/AppData/Local", APPDATA: "C:/Users/x/AppData/Roaming" }
      : { HOME: "/home/tal" };
    const installDir = platform === "win32" ? path.join("C:/Users/x/AppData/Local", "Buzz") : "/usr/local/bin";
    const npmRoot = platform === "win32" ? "C:/Users/x/AppData/Roaming/npm/node_modules" : "/usr/local/lib/node_modules";
    const discoveredAdapter = path.join(npmRoot, "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");

    for (const configured of [true, false]) {
      for (const adapterPresent of [true, false]) {
        const config = configured ? CONFIGURED : UNSET;
        const present = new Set();
        if (configured) {
          present.add(path.join("/opt/buzz", `buzz${suffix}`));
          present.add(path.join("/opt/buzz", `buzz-acp${suffix}`));
          if (adapterPresent) present.add("/opt/acp/dist/index.js");
        } else {
          present.add(path.join(installDir, `buzz${suffix}`));
          present.add(path.join(installDir, `buzz-acp${suffix}`));
          if (adapterPresent) present.add(discoveredAdapter);
        }
        const label = `${platform}/${configured ? "configured" : "unset"}/${adapterPresent ? "adapter" : "no-adapter"}`;

        const tools = resolveTools(config, {
          platform,
          env,
          exists: (p) => present.has(p),
          npmRoot,
          moduleUrl: "file:///checkout/src/tools/resolve.mjs",
          configFile: "/the/config.json",
        });

        // The binary NAME per platform — the whole of defect 1.
        assert.equal(path.basename(tools.buzz.path), `buzz${suffix}`, `${label}: buzz name`);
        assert.equal(path.basename(tools.harness.path), `buzz-acp${suffix}`, `${label}: harness name`);
        assert.equal(tools.buzz.exists, true, `${label}: buzz found`);
        assert.equal(tools.harness.exists, true, `${label}: harness found`);

        if (configured) {
          assert.equal(tools.buzz.source, "configured", `${label}: doctrine 1`);
          assert.equal(path.dirname(tools.harness.path), path.join("/opt/buzz"), `${label}: doctrine 1`);
        } else {
          assert.equal(tools.harness.source, "known", `${label}: discovered`);
        }

        if (adapterPresent) {
          assert.equal(tools.adapter.exists, true, `${label}: adapter found`);
          assert.equal(tools.adapter.path, configured ? "/opt/acp/dist/index.js" : discoveredAdapter, `${label}: adapter path`);
          assert.deepEqual(tools.missing, [], `${label}: nothing missing`);
        } else {
          assert.equal(tools.adapter.exists, false, `${label}: adapter absent`);
          assert.deepEqual(tools.missing.map((m) => m.tool), ["adapter"], `${label}: only the adapter is missing`);
          // The one literal every absent-adapter cell must carry.
          const refusal = describeMissingTool(tools.missing[0], { configFile: "/the/config.json" });
          assert.ok(
            refusal.includes(`npm install -g ${ADAPTER_PACKAGE}`),
            `${label}: the refusal must name the install command:\n${refusal}`,
          );
        }
      }
    }
  }
});

test("the fresh-machine config is the one that cannot launch, and it says so", () => {
  // Defect 2 in one assertion: `tools.adapter` is null, so today it reaches
  // child_process as an argument and the operator gets ERR_INVALID_ARG_TYPE.
  const tools = resolveTools(UNSET, {
    platform: "darwin",
    env: { HOME: "/home/tal" },
    exists: NOTHING,
    npmRoot: null,
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  assert.deepEqual(tools.missing.map((m) => m.tool).sort(), ["adapter", "buzz", "buzz-acp"]);
  assert.throws(
    () => assertToolsPresent(tools, { configFile: "/home/tal/.hive402/config.json" }),
    (err) => {
      assert.ok(err.message.includes(`npm install -g ${ADAPTER_PACKAGE}`), err.message);
      assert.match(err.message, /cannot start/);
      return true;
    },
  );
});

test("a fully resolved set does not throw", () => {
  const entry = path.join("/usr/local/lib/node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  const present = new Set([path.join("/usr/local/bin", "buzz"), path.join("/usr/local/bin", "buzz-acp"), entry]);
  const tools = resolveTools(UNSET, {
    platform: "linux",
    env: { HOME: "/home/tal" },
    exists: (p) => present.has(p),
    npmRoot: "/usr/local/lib/node_modules",
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  assert.deepEqual(tools.missing, []);
  assert.doesNotThrow(() => assertToolsPresent(tools, { configFile: "/c.json" }));
});

// ── The structural guard against a fourth caller (FIX-189) ────────────────
//
// The discovery already existed, one directory away, when this bug was written:
// `buzzBinPath` has resolved `buzz` platform-aware since 2026-08-26 and its own
// header comment records that it was written after exactly this class of bug bit
// `join`. Three more call sites hardcoded the Windows name anyway. A comment
// asking the next author not to is not a mechanism; this is.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

// Comments are where this product keeps its reasoning, and several of them have
// to quote the binary name to explain a bug. Only CODE is scanned.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SCANNED = [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "bin"))];

// Non-path uses of the literal, each with the reason it is not a path. A file
// added here without a reason is the thing this test exists to catch.
const NOT_A_PATH = {
  "src/tools/resolve.mjs": "the resolver — the one place a platform binary name belongs",
  "src/launcher/capabilities.mjs": "Claude Code permission patterns, which already carry BOTH names",
  "src/runtime/toolgate.mjs": "command-head classification, which already carries BOTH names",
  "src/node/doctor.mjs": "advice text quoting the buzzBuild pin's own key names",
};

test("no file outside the resolver builds a path out of a hardcoded binary name", () => {
  // The sharp guard, and the one that reddens if supervisor.mjs:873 comes back:
  // a `path.join(...)`/`path.resolve(...)` whose arguments include the literal.
  const offenders = [];
  for (const file of SCANNED) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "src/tools/resolve.mjs") continue;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const call of code.match(/path\.(?:join|resolve)\([^)]*\)/g) ?? []) {
      if (/"buzz(-acp)?\.exe"|'buzz(-acp)?\.exe'|`buzz(-acp)?\.exe`/.test(call)) offenders.push(`${rel}: ${call}`);
    }
  }
  assert.deepEqual(offenders, [], `platform binary names belong to src/tools/resolve.mjs alone:\n${offenders.join("\n")}`);
});

test("and the Windows binary name appears nowhere else in code without a recorded reason", () => {
  const offenders = [];
  for (const file of SCANNED) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (NOT_A_PATH[rel]) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    if (/buzz(-acp)?\.exe/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "add the file to NOT_A_PATH with the reason it is not a path, or route it through the resolver:\n" +
      offenders.join("\n"),
  );
});

test("the resolver is genuinely the only place, and the allowlist is not a hiding place", () => {
  // Each allowlisted file must still carry BOTH names or be advice text — a
  // Windows-only literal in one of them is the same bug wearing an exemption.
  for (const rel of Object.keys(NOT_A_PATH)) {
    if (rel === "src/tools/resolve.mjs" || rel === "src/node/doctor.mjs") continue;
    const code = stripComments(readFileSync(path.join(root, rel), "utf8"));
    // The bare name, in whatever string or pattern shape that file uses:
    // `"buzz"` in a command-head set, `"Bash(buzz:*)"` in a permission pattern.
    assert.match(code, /[("']buzz[:"',)]/, `${rel} must handle the non-Windows name too`);
  }
});


// ── What `setup` writes down (FIX-187) ────────────────────────────────────
//
// Discovery that is never written down is not inspectable: the config cannot be
// read to find out what will run, and an operator who needs to override has
// nothing to edit. The schema is unchanged — `buzzDir` a directory, `adapter` a
// file — so every hand-written block that already exists keeps working.

test("the block setup writes keeps the operator's own string, byte for byte", () => {
  const tools = resolveTools(
    { tools: { buzzDir: "/opt/buzz", adapter: "/opt/acp/index.js" } },
    { platform: "win32", env: {}, exists: NOTHING, npmRoot: null, moduleUrl: "file:///checkout/src/tools/resolve.mjs" },
  );
  // Configured AND absent, and still written back unchanged. Blanking a setting
  // its owner chose would lose it AND stop the miss being reported against the
  // path they picked; re-spelling it (Windows turns "/opt/buzz" into a
  // backslash form through dirname(join(...))) is the same second-guess smaller.
  assert.deepEqual(toolsBlock(tools), { buzzDir: "/opt/buzz", adapter: "/opt/acp/index.js" });
});

test("a discovered directory is recorded, so the file states what will run", () => {
  const entry = path.join("/usr/local/lib/node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  const present = new Set([path.join("/usr/local/bin", "buzz"), path.join("/usr/local/bin", "buzz-acp"), entry]);
  const tools = resolveTools(UNSET, {
    platform: "linux",
    env: {},
    exists: (p) => present.has(p),
    npmRoot: "/usr/local/lib/node_modules",
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  assert.deepEqual(toolsBlock(tools), { buzzDir: path.join("/usr/local/bin"), adapter: entry });
});

test("and null where nothing was configured and nothing was found", () => {
  // NOT "." — which is what `path.dirname` of a bare name gives, and a relative
  // "." in a config is the bare-relative-path defect this whole fix removes.
  const tools = resolveTools(UNSET, {
    platform: "darwin",
    env: {},
    exists: NOTHING,
    npmRoot: null,
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  assert.deepEqual(toolsBlock(tools), { buzzDir: null, adapter: null });
});

test("the one-line summary a step report can print still carries the remedy", () => {
  const tools = resolveTools(UNSET, {
    platform: "linux",
    env: {},
    exists: NOTHING,
    npmRoot: null,
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });
  const lines = tools.missing.map(summariseMissingTool);
  assert.equal(lines.length, 3);
  assert.ok(
    lines.some((l) => l.includes("npm install -g @agentclientprotocol/claude-agent-acp")),
    lines.join(" | "),
  );
  for (const line of lines) assert.equal(line.includes(String.fromCharCode(10)), false, "one line means one line");
});

// ── doctor and up ask the same question (FIX-188) ─────────────────────────
//
// `doctor` passing has to MEAN `up` can launch. It did not. Both commands read
// `config.tools.*` raw and joined the Windows binary names on inline, so on a
// fresh machine doctor reported "tools.buzzDir not set" and named no remedy,
// while `up` failed separately with an ENOENT and a TypeError. The command an
// operator consults when something is wrong was the one that could not act.

test("doctor and up both go through the one resolver", () => {
  // Comments quote the old message to explain it, so only CODE is read — the
  // same rule the structural guards above use.
  const doctor = stripComments(readFileSync(path.join(root, "bin", "cli.mjs"), "utf8"));
  const launcher = stripComments(readFileSync(path.join(root, "src", "node", "runtime.mjs"), "utf8"));
  assert.ok(doctor.includes("resolveTools("), "doctor must ask the resolver");
  assert.ok(launcher.includes("resolveTools("), "and so must the thing that launches");
  assert.ok(launcher.includes("assertToolsPresent("), "up refuses BEFORE it spawns");

  // The old shape, gone: an accurate report that named no remedy.
  assert.equal(doctor.includes("tools.buzzDir not set"), false);
  assert.equal(doctor.includes("tools.adapter not set"), false);
});

// ── The agent's PATH is CURATED, so Node has to be resolved too ───────────
//
// FOUND BY THE LIVE CELL, not by this file, and that is the point of having
// one. Phase 45 deliberately excluded `tools.nodeDir` on the premise that
// "`--agent-command` is the bare `node`, which works because Node is on PATH by
// construction". The premise is false: `buildAgentEnv` BUILDS the child's PATH
// from `tools.buzzDir`, `tools.nodeDir` and `tools.extraDirs` and nothing else,
// on purpose, so an agent cannot reach a tool nobody granted it.
//
// With no `tools` block all three were empty, so the agent's PATH was the empty
// string. The node came up, the harness connected, the room showed the agent
// online, and every turn died with:
//
//     ERROR buzz_acp: agent failed to spawn: IO error: program not found
//
// A launch that produces a mute agent is not a launch. AC-1 says the node
// launches an agent; this is the second half of making that true on a machine
// nobody hand-configured.

test("with no tools block, Node is still on the agent's PATH", () => {
  const located = locateNodeDir(null, { execPath: "/usr/local/bin/node" });
  assert.equal(located.path, path.dirname("/usr/local/bin/node"));
  assert.equal(located.source, "self", "the interpreter running hive402 IS the one the agent should use");
  assert.equal(located.exists, true);
});

test("a configured nodeDir is still the operator's answer", () => {
  const located = locateNodeDir("/opt/node/bin", { execPath: "/usr/local/bin/node" });
  assert.equal(located.path, "/opt/node/bin");
  assert.equal(located.source, "configured");
});

test("the agent's PATH is never empty on a fresh machine", () => {
  // The literal failure: every entry null, so `pathDirs.join(sep)` was "".
  const installDir = path.join("/usr/local/bin");
  const entry = path.join("/usr/local/lib/node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  const present = new Set([path.join(installDir, "buzz"), path.join(installDir, "buzz-acp"), entry]);
  const tools = resolveTools(UNSET, {
    platform: "linux",
    env: {},
    exists: (p) => present.has(p),
    npmRoot: "/usr/local/lib/node_modules",
    moduleUrl: "file:///checkout/src/tools/resolve.mjs",
  });

  const dirs = agentPathDirs(tools, UNSET);
  assert.equal(dirs.buzzDir, installDir, "so the agent can run `buzz messages send` and not be mute");
  assert.equal(dirs.nodeDir, path.dirname(process.execPath), "so the harness can find node to run the adapter");
  assert.deepEqual(dirs.extraDirs, []);

  const joined = [dirs.buzzDir, dirs.nodeDir, ...dirs.extraDirs].filter((d) => typeof d === "string" && d.length > 0);
  assert.equal(joined.length, 2, "an empty PATH is a mute agent");
});

test("a configured buzzDir is what the agent's PATH carries, unmodified", () => {
  const tools = resolveTools(
    { tools: { buzzDir: "/opt/buzz", adapter: "/opt/acp/index.js", nodeDir: null, extraDirs: ["/x"] } },
    { platform: "linux", env: {}, exists: NOTHING, npmRoot: null, moduleUrl: "file:///checkout/src/tools/resolve.mjs" },
  );
  const dirs = agentPathDirs(tools, {
    tools: { buzzDir: "/opt/buzz", adapter: "/opt/acp/index.js", nodeDir: null, extraDirs: ["/x"] },
  });
  assert.equal(dirs.buzzDir, "/opt/buzz", "byte for byte, same doctrine as everywhere else");
  assert.deepEqual(dirs.extraDirs, ["/x"], "and the granted extras are carried through untouched");
});
