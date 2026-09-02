// `hive402 profile` — set or show the name this node wears in the community.
//
// This is the command half of AC-46. It exists separately from `join` for one
// reason a test cannot state: a name is the thing people most often get wrong
// on the first try and want to change on the second, and "re-run the join" is
// not an answer when the join is idempotent-but-scary.
//
// ── Where the relay comes from before there is a config ────────────────────
//
// A profile can be published the moment the node has joined, which is BEFORE
// `hive402.config.json` exists — that file is written later in setup, once
// there are agents and rooms. So the community's address is taken from the
// join record when there is no config, which is also the only source that
// could be right at that moment.

import { existsSync } from "node:fs";
import path from "node:path";

import { publishNodeProfile } from "./profile.mjs";
import { readJoinRecord, rememberDisplayName } from "./joinrecord.mjs";

// Where is buzz?
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
// the bare name so PATH still wins for anyone who has arranged it.
const KNOWN_DIRS = {
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

export function buzzBinPath(
  buzzDir = null,
  { exists = existsSync, platform = process.platform, env = process.env } = {},
) {
  const name = platform === "win32" ? "buzz.exe" : "buzz";
  // An explicit directory is the operator's answer and is not second-guessed:
  // if they named a directory and the binary is not in it, the error should say
  // that rather than silently using a different Buzz.
  if (buzzDir) return path.join(buzzDir, name);

  for (const dir of (KNOWN_DIRS[platform] ?? KNOWN_DIRS.linux)(env)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name; // let PATH have the last word
}

// The relay this node belongs to, and the binary that talks to it.
export function resolveRelay({ config = null, stateDir }) {
  const joined = readJoinRecord(stateDir);
  const relayUrl = config?.relayUrl ?? joined?.origin ?? null;
  if (!relayUrl) {
    throw new Error(
      "this node has not joined a community yet, and there is no config to read a relay from.\n" +
        "  Run: hive402 join <invite-link>",
    );
  }
  return { relayUrl, binPath: buzzBinPath(config?.tools?.buzzDir ?? null), joined };
}

export async function runProfile({
  name = null,
  avatar = null,
  about = null,
  config = null,
  stateDir,
  store,
  makeCli,
  // FIX-170 (F-033). Injected only so a test can drive the declared-reference
  // path without an OS keychain; the real caller passes nothing and gets the
  // same resolver `up`, `join` and `doctor` already use.
  resolveKey = null,
  log = console.log,
}) {
  const { relayUrl, binPath, joined } = resolveRelay({ config, stateDir });

  // Nothing to set: report, rather than failing on an empty update. Someone
  // typing `hive402 profile` is asking a question, not making a change.
  if (name === null && avatar === null && about === null) {
    log(`hive402: this node`);
    log(`  community  ${joined?.host ?? relayUrl}`);
    log(`  pubkey     ${joined?.pubkey ?? "(not joined yet)"}`);
    log(`  name       ${joined?.displayName ?? "(none published by hive402)"}`);
    log("");
    log(`Set one with:  hive402 profile --name "<your name>'s hive"`);
    return { shown: true };
  }

  // WHICH hive's profile (AC-72)? The config names one; before there is a
  // config, the join record does. A machine may run several.
  const nodePubkey = config?.node?.pubkey ?? joined?.pubkey ?? null;
  if (!nodePubkey) {
    throw new Error(
      "this node has no identity yet, so there is nothing to publish a profile for.\n" +
        "  Run: hive402 join <invite-link>   (it creates one)",
    );
  }
  // ── WHERE the key lives, which the config also says (F-033, FIX-170) ─────
  //
  // This command used to read the credential store directly, so an
  // env-configured node — the shape this project's own dev rig has used since
  // cycle 1 — was told "no key for this hive … in the OS credential store"
  // while `doctor`, run in the same shell moments earlier, resolved the same
  // variable correctly. The message named a place the key was never going to
  // be, which is worse than failing.
  //
  // `profile` is the THIRD command in this family to have this defect; `join`
  // was the second (FIX-136) and its comment is the scar. The semantics here
  // are join's, deliberately: a declared non-keychain reference is an
  // INSTRUCTION and the store is not consulted at all. Not "preferred" —
  // consulting the store is precisely what picked the production identity in
  // FIX-136, and a fallback would put that mistake one failure away.
  //
  // `"keychain"` is the schema's own default and means the store, so it takes
  // the path below unchanged, message included. So does the pre-config path
  // (a join record, no config, therefore no reference to honour), which is the
  // reason this command exists before `hive402.config.json` does.
  const declared =
    config?.node?.privateKeyRef && config.node.privateKeyRef !== "keychain"
      ? config.node.privateKeyRef
      : null;

  let privateKeyHex;
  if (declared) {
    const resolve = resolveKey ?? (await import("../node/runtime.mjs")).makeKeyResolver({ store, nodePubkey });
    // The resolver's own wording names the REFERENCE and never its value
    // (DD-31, the F-016 class), so it is surfaced rather than replaced.
    privateKeyHex = await resolve(declared, { role: "node", nodePubkey });
  } else {
    privateKeyHex = await store.getNodePrivateKey(nodePubkey);
    if (!privateKeyHex) {
      throw new Error(
        `no key for this hive (${nodePubkey.slice(0, 12)}…) in the OS credential store, so its ` +
          `profile cannot be signed.\n` +
          `  This machine may run several hives; each keeps its own key under its own pubkey.`,
      );
    }
  }

  const result = await publishNodeProfile({ name, avatar, about, privateKeyHex, relayUrl, binPath, makeCli, log });
  if (result.name) rememberDisplayName({ stateDir, name: result.name });
  return result;
}

