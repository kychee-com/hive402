#!/usr/bin/env node
// The hive402 node's command line.
//
// Cycle 1 found this file implementing `--version` and nothing else: every other
// invocation, including `--help`, printed one identical line and exited 1
// (F-002). The library underneath was complete and tested; there was simply no
// way to run it. This is that way.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

import { loadConfig, setSetting, candidatePaths, setupConfigTarget, hiveBanner } from "../src/config/load.mjs";
import { resolveInstructions } from "../src/launcher/instructions.mjs";
import { WATCHING_MARKER } from "../src/node/detach.mjs";
import { PACKAGE_VERSION } from "../src/version.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// WHICH hive is this command about to act on? (AC-73.)
//
// One machine can run several hives (AC-72), and which config a command picks
// up is decided by a search order most people never read. So resolving a
// config and SAYING which one are one act, done here — a command that loaded
// a config on its own could act on somebody's live room in silence, which is
// the near-miss the red team filed before it cost anything.
//
// `announce: false` is for output a machine parses (`status` is JSON, and a
// banner line above it would break every caller); those commands carry the
// same two facts as fields instead.
function resolveHive(flags, { announce = true } = {}) {
  const loaded = loadConfig(flags?.config);
  if (announce) console.log(hiveBanner({ configFile: loaded.file, config: loaded.config }));
  return loaded;
}
// FIX-145: ONE reader for "which build is this", shared with `status`. Two
// readers of the same manifest is how a report starts disagreeing with the
// command that printed it.
const pkg = { version: PACKAGE_VERSION };

const USAGE = `hive402 ${pkg.version} — run your agents in a Buzz hive room

Usage: hive402 <command> [options]

Commands:
  setup         Do the whole of setup in one command (start here)
  keygen        Create an identity and store the key in the OS credential store
                  keygen --agent <name>     a new identity for an agent
                  keygen --node             a new identity for you (see below)
  keys          Manage stored keys
                  keys import --agent <name> | --node
                  keys list
                  keys remove --agent <name> | --node
                  keys migrate-node   (one-shot, for a pre-0.9.0 install)
  join          Join a Buzz community from an invite link, as this node
  profile       Set the display name this node shows in the member list
  up            Start the node: publish agents, launch them, watch the room.
                Starts it and returns; "hive402 down" stops it. Add
                --foreground to hold the terminal and watch instead.
  down          Stop every agent this node started
  status        Show each agent: running, addressable, capabilities
  config        View or change the six owner-facing settings
                  config show
                  config set <agent>.<setting> <value>
  register      Register an agent into a room (sponsored admission)
  retire        Retire an agent and give its name back to the room
  audit         Print this node's audit log
  doctor        Check config, tools and relay reachability

Options:
  --config <path>   Config file (default: ./hive402.config.json,
                    ~/.hive402/config.json, ~/.config/hive402/config.json)
  --help, -h        Show this help
  --version, -v     Show the version

Docs: the owner-facing settings are name, replyMode, crossOwnerAsks,
selfInitiated, research, build. New agents start with research=off, build=off.

Getting started is one command:
  hive402 setup --invite <link> --agent <name> --owner <your npub1…>

It does the lot — this node's identity, joining the community, its name, your
agent, and the first channel — and you can re-run it any time: every step
checks whether it is already done.

Your own Buzz identity stays yours. hive402 generates the node an identity of
its own and that is what signs everything hive402 signs, so the node can be
revoked without revoking you. The only thing of yours it ever asks for is your
PUBLIC key, because that is who approves what your agent does.`;

const RETIRE_USAGE = `hive402 retire — retire an agent and give its name back

Usage: hive402 retire <agent> [--config <path>]

Registering an agent claims its name in that room, and until now nothing ever
un-claimed one: an agent you finished with kept its name forever, and nobody —
including you — could use that name again.

Retiring releases BOTH things registration created:
  · the display-name claim, which is what actually refuses the next
    registration, and
  · the managed-agent record in the room's registry.

The identity keeps a dead name ("retired-<agent>-<key>") rather than vanishing.
That is deliberate: a profile that disappears and one that was renamed look
identical to anyone checking whether a name is free, and only one of them
really freed it.

Afterwards the name is verified free — in the room AND at the relay's global
index — before this reports success. What it cannot free, it says so about: a
name whose signing key is gone stays taken, because the claim is signed and
nothing can un-sign it. You will be told who holds it.

Options:
  --config <path>  Config file
  --help           Show this help`;

const JOIN_USAGE = `hive402 join — join a Buzz community as this node

Usage: hive402 join <invite-link> [--config <path>] [--show-terms]

  <invite-link>    The link you were sent, whole:
                     https://<relay-host>/invite/<code>

Options:
  --show-terms     Print the community's full terms and privacy text instead
                   of a summary. They can run to tens of thousands of
                   characters, which is why it is not the default.
  --help           Show this help

The node joins with ITS OWN identity, which hive402 generates here if it does
not have one yet. You are never asked for your Nostr secret key — not to join,
not to add an agent, not ever. Your key is yours; a node that borrowed it could
not be switched off without switching you off too.

If the community has a join policy, hive402 shows it and asks you to accept it
in your own words. Nothing is sent until you do, and hive402 never makes an
age statement on your behalf. The version you accepted is written down.`;

const SETUP_USAGE = `hive402 setup — the whole of setup, in one command

Usage: hive402 setup --agent <name> --owner <npub1…> [options]

Options:
  --agent <name>    What people will type to address your agent.
  --owner <npub…>   YOUR Buzz PUBLIC key. This is who approves what your agent
                    does — the public half, one paste from your profile screen.
                    hive402 never wants your secret key, here or anywhere.
  --invite <link>   An invite link, if this node has not joined yet.
  --name <name>     The name this node shows in the member list.
  --channel <id>    Which channel to put the agent in first. Omit it if you are
                    in exactly one; setup uses that.
  --config <path>   Where to write the config. The default is
                    ~/.hive402/config.json, which every hive402 command finds
                    from any directory. Pass this only if you want the config
                    kept somewhere specific, and remember you will then need
                    --config on later commands too.
  --help            Show this help

Run it again any time. Every step checks whether it is already done, so a setup
that stopped halfway picks up where it left off rather than starting over.

If the community has a join policy, hive402 shows it and you accept it in your
own words. There is no flag that accepts for you — not for a script, and not
for a coding agent running this on your behalf. If something else is driving
this command, run "hive402 join <invite-link>" yourself first; setup will find
the node already joined and carry on.`;

const PROFILE_USAGE = `hive402 profile — the name this node wears in the community

Usage: hive402 profile [--name <name>] [--avatar <url>] [--about <text>]

Options:
  --name <name>    The display name. This is what the member list shows
                   instead of 64 characters of hex — "Barry's hive", say.
                   Spaces and apostrophes are fine; it is not a file name.
  --avatar <url>   A full http(s) URL to a picture. EXPLORATORY: hive402
                   publishes it, but whether a Buzz client draws it is not
                   something hive402 can confirm. Look and see.
  --about <text>   A line of description.
  --config <path>  Config file
  --help           Show this help

With no options it shows what this node is, and does not change anything.

The profile is published under the NODE's identity — the one hive402 made when
it joined. You are never asked for your own key.`;

const KEYGEN_USAGE = `hive402 keygen — create an identity and store its key

Usage: hive402 keygen (--agent <name> | --node) [--force]

Options:
  --agent <name>   Create a new identity for this agent. Up to 64 characters
                   of letters, digits, dot, dash and underscore: the name
                   becomes part of a file name in the OS credential store,
                   so a name that could not be written is refused before any
                   key is generated for it.
  --node           Create an identity for THIS NODE. Not for you: the node is
                   a community member in its own right, and yours stays yours.
                   You rarely need this — "hive402 join" makes one — and you
                   should not put your own Buzz key here. A node holding your
                   secret cannot be switched off without switching you off.
  --force          Replace an existing key. The old identity is unrecoverable.
  --help           Show this help

The secret key is written to the OS credential store and is never printed,
never returned and never written to a file. Only the public key is shown —
that is the value that goes in your config.`;

const KEYS_USAGE = `hive402 keys — manage the keys in the OS credential store

Usage: hive402 keys <import|list|remove|migrate-node> [options]

  keys import (--agent <name> | --node) [--force]
      Store a key you already have. Paste it in either form it is written in:
      the "nsec1…" from Buzz's own private-key backup screen, or 64 characters
      of hex. They are the same key, and hive402 stores the hex.
      The key is typed at a prompt with echo off — there is deliberately no
      flag that takes the value, because an argument would land in your shell
      history and the process table.

  keys list [--config <path>]
      Show which identities in your config have a key stored. Presence only:
      this command cannot print a key, by design.

  keys remove (--agent <name> | --node) [--config <path>]
      Forget a key. There is no copy anywhere else.
      A NODE key is stored under that node's own pubkey, because one machine
      can run several hives. So --config is what says which node you mean, and
      the command names that hive before it removes anything. An AGENT key is
      keyed by name and needs no config.

  keys migrate-node --config <path>
      One-shot, for an install that predates per-hive key storage. Run
      "hive402 keys migrate-node --help" for what it moves and when to use it.`;

const MIGRATE_NODE_USAGE = `hive402 keys migrate-node — move a pre-0.9.0 node key

Usage: hive402 keys migrate-node [--config <path>]

Before 0.9.0 a machine held exactly one node key, in a single fixed slot. That
is the reason a second hive could not exist here. A node key is now stored
under that node's own pubkey, so several hives can share a machine without
competing for one slot.

This moves the key in the old slot under the identity your config names. It is
a one-shot: an install set up on 0.9.0 or later has nothing to migrate, and
this says so rather than pretending it did something.

  --config <path>  The config of the hive whose key is being migrated. Required
                   in effect: the pubkey it names is the identity the key moves
                   to, and nothing else can supply it.
  --help           Show this help

Nothing else changes: same identity, same membership, same agents.

Two refusals worth knowing about. If the old slot holds a DIFFERENT identity
than your config names, nothing is moved and you are told both pubkeys, because
adopting it would silently give this hive somebody else's identity. If the key
has already been migrated, this reports that and stops.`;

const REGISTER_USAGE = `hive402 register — register an agent into a room

Usage: hive402 register --agent <name> [options]

Options:
  --agent <name>       Agent from the config to register (required)
  --config <path>      Config file
  --sponsor <keyref>   Override the sponsoring key: "env:VAR" or "keychain".
                       For a dev relay. You do not need this: the node
                       sponsors its own agents.
  --owner-key <keyref> Override the key that signs the attestation. Same:
                       for a dev relay only.
  --help               Show this help

Nothing here asks for your key. Once this node has joined a community
("hive402 join"), it is a member like any other, so it vouches for the agents
it hosts with its OWN identity — the attestation and the relay admission are
both signed by the node.

Who approves is a different question and a different key. The "ownerPubkey" in
your config names the HUMAN whose approval releases an action; that never
becomes the node, because a node cannot be asked and cannot answer.

This is the headless path: Buzz's own "agents draft-create" only opens a
prefilled form in Desktop, which cannot be driven from a script.`;


// ── FIX-165 (F-032, DD-66): the six commands that used to IGNORE --help ────
//
// `up` and `down` started and stopped Barry's real production node when asked
// for their usage, because the flag fell straight through to a handler whose
// first statement resolves a config. `config set … --help` wrote the config
// file for the same reason. `status`, `audit` and `doctor` only read, but a
// usage request that reaches a relay is still a usage request that did work.
//
// Each one now has a text to answer WITH, because a check with nothing to print
// is not an answer.

const UP_USAGE = `hive402 up — start the node: publish agents, launch them, watch the room

Usage: hive402 up [--foreground] [--config <path>]

Starts the node and RETURNS; the node keeps running in the background and
"hive402 down" stops it. It prints which hive it resolved before it does
anything, so you can stop it if that is not the one you meant.

Options:
  --foreground     Hold this terminal and watch instead of detaching. This is
                   also what the detached child runs — the child IS the node.
  --poll <ms>      How often to read the room (default 2000)
  --config <path>  Config file (default: ./hive402.config.json, then
                   ~/.hive402/config.json)
  --help, -h       Show this help`;

const DOWN_USAGE = `hive402 down — stop every agent this node started

Usage: hive402 down [--config <path>]

Stops the node and the agent processes recorded in its pid file. A process that
already died is reported as already gone rather than as stopped, and one that
refused to stop is reported as refused: three different things happened and
they are not reported as one.

Options:
  --config <path>  Config file
  --help, -h       Show this help`;

const STATUS_USAGE = `hive402 status — show each agent: running, addressable, capabilities

Usage: hive402 status [--config <path>]

Prints one JSON document: which config was resolved, whether the node is up,
and for every agent whether its process is alive, whether the room can reach
it, and what it is allowed to do.

Options:
  --config <path>  Config file
  --help, -h       Show this help`;

const CONFIG_USAGE = `hive402 config — view or change the owner-facing settings

Usage: hive402 config show [--config <path>]
       hive402 config set <agent>.<setting> <value> [--config <path>]

Settings: name, replyMode, crossOwnerAsks, selfInitiated, research, build.
New agents start with research=off and build=off.

"config set" WRITES the config file, which is why it answers --help before it
does anything else.

Options:
  --config <path>  Config file
  --help, -h       Show this help`;

const AUDIT_USAGE = `hive402 audit — print this node's audit log

Usage: hive402 audit [--limit <n>] [--config <path>]

Every action the node and its agents took, oldest of the tail first. The log
lives in the node's state directory and is written by both the node and the
tool gate in the agent's own process.

Options:
  --limit <n>      How many of the most recent rows to print (default 50)
  --config <path>  Config file
  --help, -h       Show this help`;

const DOCTOR_USAGE = `hive402 doctor — check config, tools and relay reachability

Usage: hive402 doctor [--config <path>]

Says which build is speaking, which config it resolved and where it looked,
whether the tools it needs are on this machine, and whether the relay answers.
Exits 0 when everything it checked is well and 1 when anything is not.

Options:
  --config <path>  Config file
  --help, -h       Show this help`;

// FIX-165 (F-032, DD-66): four flags are BOOLEAN, and the rest are key/value.
//
// The rule below is "any `--x` followed by a non-`--` token is a pair", which
// is right for `--config <path>` and wrong for `--help`:
// `hive402 retire --help spike` set `flags.help = "spike"` and LOST the name
// from `positional`. Every reader tests truthiness, so nothing breaks today —
// and that is exactly the trap. One `flags.help === true` written later turns
// this into a command that acts when asked for its usage, which is the failure
// FIX-165 exists to remove.
const BOOLEAN_FLAGS = new Set(["help", "h", "version", "v"]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else if (arg === "-h") flags.help = true;
    else if (arg === "-v") flags.version = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function die(message, code = 1) {
  console.error(`hive402: ${message}`);
  process.exit(code);
}

function defaultStateDir(config) {
  return config.stateDir ?? path.join(homedir(), ".hive402");
}

// --- commands --------------------------------------------------------------

// Which identity a key command is about. Exactly one of --agent/--node, so a
// slip of the hand cannot silently act on the wrong identity.
function keyTarget(flags) {
  const hasAgent = typeof flags.agent === "string" && flags.agent.trim() !== "";
  const hasNode = flags.node === true;
  if (hasAgent && hasNode) die("pass either --agent <name> or --node, not both");
  if (hasAgent) return { kind: "agent", name: flags.agent.trim() };
  if (hasNode) return { kind: "node" };
  if (flags.agent === true) die("--agent needs a name, e.g. --agent blitz");
  die("name an identity: --agent <name> for an agent, or --node for your own");
  return null;
}

async function cmdKeygen({ flags }) {
  if (flags.help) {
    console.log(KEYGEN_USAGE);
    return;
  }
  const target = keyTarget(flags);
  const { CredentialStore } = await import("../src/credentials/store.mjs");
  const { keygen } = await import("../src/credentials/keys.mjs");
  const { makeNameCheck } = await import("../src/registry/namecheckcommand.mjs");
  const store = new CredentialStore();

  // AC-56: ask before the identity exists. `keygen` runs at the very start of
  // setup, so a config is optional here — the checker reports what it could not
  // ask rather than pretending the name is free.
  let config = null;
  let stateDir = path.join(homedir(), ".hive402");
  try {
    config = resolveHive(flags).config;
    stateDir = defaultStateDir(config);
  } catch {
    /* no config yet — normal at this point in setup */
  }

  await keygen({
    store,
    target,
    force: flags.force === true,
    nameCheck: await makeNameCheck({ config, stateDir, store }),
  });
}

// Per-action help (TR-014). `hive402 --help` lists `keys migrate-node`, so a
// reader who finds it there and asks it for its own help has to get something
// about migrate-node. It used to fall through to the generic keys text and exit
// 0, which is a dead end for exactly the person the top-level help just sent.
// A map rather than a branch: an action added later either gets an entry here
// or keeps the generic text as a deliberate choice.
const KEYS_ACTION_USAGE = { "migrate-node": MIGRATE_NODE_USAGE };

async function cmdKeys({ flags, positional }) {
  const [action] = positional;
  if (flags.help || !action) {
    console.log(KEYS_ACTION_USAGE[action] ?? KEYS_USAGE);
    if (!action && !flags.help) process.exitCode = 1;
    return;
  }

  const { CredentialStore } = await import("../src/credentials/store.mjs");
  const store = new CredentialStore();

  // AC-72: one-shot, for an install that predates per-hive key storage.
  if (action === "migrate-node") {
    const { config, file } = resolveHive(flags);
    const { migrateNodeKey } = await import("../src/credentials/keys.mjs");
    const result = await migrateNodeKey({ store, nodePubkey: config?.node?.pubkey });
    if (result.migrated) {
      console.log(`  config:  ${file}`);
      console.log(`  Nothing else changes: same identity, same membership, same agents.`);
    }
    return;
  }

  if (action === "import") {
    const target = keyTarget(flags);
    const { importPrivateKey } = await import("../src/credentials/keys.mjs");
    const { readSecret } = await import("../src/credentials/prompt.mjs");
    const label = target.kind === "node" ? "your own Nostr secret key" : `the secret key for "${target.name}"`;
    await importPrivateKey({
      store,
      target,
      force: flags.force === true,
      // Naming both forms AT THE PROMPT is half the fix (F-022). The owner is
      // looking at an "nsec1…" on Buzz's backup screen at this exact moment,
      // and a prompt that says only "64-char hex" is what sent them looking for
      // a decoder.
      readSecret: () => readSecret({ prompt: `Paste ${label} — nsec1… or 64-char hex, not echoed: ` }),
    });
    return;
  }

  if (action === "list") {
    const { config, file } = resolveHive(flags);
    const { listKeys } = await import("../src/credentials/keys.mjs");
    const rows = await listKeys({ store, config });
    console.log(`config: ${file}`);
    for (const row of rows) {
      // An env: reference is not a keychain question. Reporting it as
      // "missing" would call a perfectly good dev setup broken.
      const state =
        row.present === null ? `uses ${row.ref}` : row.present ? "key stored" : "NO KEY STORED";
      console.log(`  ${row.label.padEnd(28)} ${state}`);
    }
    if (rows.some((r) => r.present === false)) {
      console.log(`\nMissing keys: run "hive402 keygen --agent <name>" or "hive402 keys import --node".`);
    }
    return;
  }

  if (action === "remove") {
    const target = keyTarget(flags);

    // AC-72/AC-73 (F-028). A node key is stored under that node's own pubkey,
    // so a REMOVE has to say which node it means — and the config the operator
    // already passed is where that pubkey lives. This branch used to hand
    // `keyTarget`'s answer straight to the store, which by design carries no
    // pubkey, so `--config` was never even OPENED: a correct path and a typo
    // produced byte-identical "which hive?" refusals, and no AC-73 banner was
    // printed at all. `list` and `migrate-node` have always resolved first;
    // `remove` was the one member of the family that did not.
    //
    // Resolved HERE, inside the node branch, and deliberately NOT at the top of
    // `cmdKeys`: an agent key is keyed by NAME and needs no hive, so
    // `keys remove --agent <name>` must keep working on a machine with no
    // config anywhere. Hoisting this would break that.
    if (target.kind === "node") {
      const { config } = resolveHive(flags);
      target.pubkey = config?.node?.pubkey ?? null;
    }

    const { removePrivateKey } = await import("../src/credentials/keys.mjs");
    const removed = await removePrivateKey({ store, target });
    // Which hive, not "the owner identity" — that wording is stale since
    // FIX-117 split the node's identity from the owner's, and it named no hive
    // at all, which is what AC-73 exists to forbid once one machine runs
    // several.
    const what =
      target.kind === "node"
        ? `the node identity of hive ${String(target.pubkey).slice(0, 12)}…`
        : `agent "${target.name}"`;
    console.log(
      removed
        ? `hive402: removed the stored key for ${what}. There is no copy — that identity is gone.`
        : `hive402: no key was stored for ${what}; nothing to remove.`,
    );
    return;
  }

  // All four, or the help and the error disagree about what this command can
  // do, and the reader is sent back to a surface that was already wrong.
  die(`unknown keys action "${action}" — try "import", "list", "remove" or "migrate-node"`);
}

// The agent's instructions, as `config show` prints them (AC-55).
//
// A file that cannot be read is REPORTED rather than skipped: "no instructions"
// and "the character file you configured is missing" are different facts, and
// the second one is the reason an agent is not behaving as its owner expects.
function printInstructions(agent, configDir) {
  if (!agent.instructions && !agent.instructionsFile) {
    console.log(`    instructions:   (none)`);
    return;
  }
  const from = agent.instructionsFile ? `file ${agent.instructionsFile}` : "config";
  let text;
  try {
    text = resolveInstructions({ agent, configDir });
  } catch (err) {
    console.log(`    instructions:   ! ${err.message}`);
    return;
  }
  console.log(`    instructions:   (${from})`);
  for (const line of String(text).split("\n")) console.log(`      ${line}`);
}

function cmdConfig({ flags, positional }) {
  // FIX-165: the third state-changer, and the one the incident did not find.
  // `config set <agent>.<setting> <value> --help` WROTE the config file.
  if (flags.help) {
    console.log(CONFIG_USAGE);
    return;
  }
  const [action, keyPath, value] = positional;
  const { file, raw, config } = resolveHive(flags);

  if (!action || action === "show") {
    console.log(`config: ${file}`);
    console.log(`relay:  ${config.relayUrl}`);
    console.log(`node:   ${config.node.pubkey}`);
    console.log(`turnCap: limit=${config.turnCap.limit} windowMs=${config.turnCap.windowMs}`);
    for (const room of config.rooms) {
      console.log(`\nroom ${room.channel}`);
      for (const a of room.agents) {
        console.log(`  agent ${a.name}  (${a.pubkey.slice(0, 12)}…, owner ${a.ownerPubkey.slice(0, 12)}…)`);
        console.log(`    replyMode:      ${a.replyMode}`);
        console.log(`    crossOwnerAsks: ${a.crossOwnerAsks}`);
        console.log(`    selfInitiated:  ${a.selfInitiated}`);
        console.log(`    research:       ${a.research}`);
        console.log(`    build:          ${a.build}`);
        // AC-55: the owner can READ their agent's character at any time, so it
        // is printed in full rather than summarised. An agent whose character
        // its owner cannot see is the private identity F-9 exists to forbid.
        printInstructions(a, path.dirname(file));
      }
    }
    return;
  }

  if (action === "set") {
    if (!keyPath || value === undefined) {
      die('usage: hive402 config set <agent>.<setting> <value>');
    }
    const dot = keyPath.lastIndexOf(".");
    if (dot < 1) die(`"${keyPath}" should look like <agent>.<setting>, e.g. spike.research`);
    const change = setSetting({
      file,
      raw,
      agentName: keyPath.slice(0, dot),
      setting: keyPath.slice(dot + 1),
      value,
    });
    console.log(`${change.agent}.${change.setting}: ${change.from} → ${change.to}`);
    console.log(`written to ${file}`);
    console.log(`(restart the node with "hive402 down && hive402 up" to apply)`);
    return;
  }

  die(`unknown config action "${action}" — try "show" or "set"`);
}

async function cmdUp({ flags }) {
  // FIX-165 (F-032, DD-66): FIRST, ahead of `resolveHive`. This handler used
  // to resolve a config and start a node when asked for its usage — with no
  // `--config` that is the PRODUCTION config, which is how a usage request
  // started Barry's real node, published his agents and launched them.
  if (flags.help) {
    console.log(UP_USAGE);
    return;
  }
  const { config, file, raw } = resolveHive(flags);

  // FIX-128: by default this starts the node and RETURNS. `--foreground` is the
  // old behaviour, and it is what the detached child itself runs — the child IS
  // the node, so it must not detach in turn.
  //
  // The config notes are printed by whichever process actually goes on to run,
  // and NOT here. The parent echoes the child's output, so printing them before
  // the fork showed every one of them twice.
  if (!flags.foreground) {
    await startDetached({ flags, stateDir: defaultStateDir(config) });
    return;
  }

  const { makeSupervisor } = await import("../src/node/runtime.mjs");
  const sup = makeSupervisor({ config, configFile: file, stateDir: defaultStateDir(config) });

  await sup.start();

  // WHAT A PERSON STARTING THE NODE ACTUALLY NEEDS (FIX-128).
  //
  // Barry, after one start too many: "I don't want to see 'note'!! The rest is
  // also vague. Give HUMAN READABLE SIMPLE AND NEEDED lines of text only."
  //
  // He is right, and what was here is a fair example of writing output for the
  // author rather than the reader. A channel UUID, a pid, `research=true
  // build=false` and a config deprecation paragraph are all TRUE, and none of
  // them answer the only question a start has: is my agent live?
  //
  //   • the config note moved to `doctor`, where a "this field no longer
  //     decides" belongs. It cannot be acted on and it is not about this run.
  //   • the channel id is gone. `status` and `doctor` have it; it is 36
  //     characters of noise to somebody who just wants their agent up.
  //   • the settings and pids are gone for the same reason.
  //
  // What survives is one line saying it worked, and everything that says it did
  // NOT — because a start that half-worked is exactly what must not be quiet.
  const status = await sup.status();
  const live = status.agents.filter((a) => a.addressable).map((a) => a.name);
  const broken = status.agents.filter((a) => !a.addressable);

  for (const a of broken) {
    console.log(`hive402: ${a.name} is NOT reachable by name yet.`);
    for (const p of a.problems) console.log(`  ${p}`);
  }
  // AC-48: the watch set comes from the relay, so an empty one is a real
  // failure and the only thing worth saying about channels at all.
  if (sup.watching().length === 0) {
    console.log(`hive402: this node is not in any channel. Add your agent to one in Buzz.`);
  }
  if (live.length) {
    console.log(`hive402: ${sentence(live)} live. Say @${live[0]} in Buzz to talk to it.`);
  }

  // The marker the detached parent waits for (FIX-128). It is the child's proof
  // that the node is really watching rather than merely spawned, so the wording
  // up to the full stop is shared with `detach.mjs` and must not drift.
  console.log(`hive402: ${WATCHING_MARKER} Ctrl-C to stop.`);

  const shutdown = async () => {
    console.log("\nhive402: stopping agents…");
    await sup.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  sup.run({ pollMs: Number(flags.poll ?? 2000) });
}

// "smith is", "smith and blitz are", "a, b and c are". Written out because
// "1 agent(s) up — smith" is machine grammar, and the line it appears in is read
// by a person who just wanted to know whether their agent works.
function sentence(names) {
  if (names.length === 1) return `${names[0]} is`;
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(", ")} and ${last} are`;
}

// FIX-128 — start the node in its own process and come back.
//
// The parent's job is not just to spawn: it is to say honestly whether the node
// came up. "Started" with no confirmation is how a broken start goes unnoticed,
// and `up` refusing for a real reason is something this must never swallow — an
// afternoon was spent on exactly such a refusal. So the parent watches the
// child's own output, prints it, and exits nonzero if the child died first.
async function startDetached({ flags, stateDir }) {
  const { spawn } = await import("node:child_process");
  const { mkdirSync, openSync, readFileSync, existsSync, statSync } = await import("node:fs");
  const { relaunchArgv, spawnOptions, readStartup, tailFrom } = await import("../src/node/detach.mjs");

  const logFile = path.join(stateDir, "logs", "node.log");
  mkdirSync(path.dirname(logFile), { recursive: true });
  // Where THIS run's output starts. The file is opened for append, so reading
  // the whole thing would show a PREVIOUS run's "watching the room" and report
  // success for a child that never started — the same trap `#bringUpAgent`
  // documents for the agent logs (DD-34).
  const from = existsSync(logFile) ? statSync(logFile).size : 0;
  const logFd = openSync(logFile, "a");

  const child = spawn(process.execPath, relaunchArgv({ cli: fileURLToPath(import.meta.url), flags }), spawnOptions({ logFd }));
  // Released, or this process's event loop stays alive waiting for the child —
  // which is the exact thing being removed.
  child.unref();

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  // Sliced as BYTES, then decoded. `statSync().size` is a byte count and
  // `readFileSync(…, "utf8").slice(n)` is a CHARACTER index, so with any
  // multi-byte character already in the log the two disagree — and the log is
  // full of em-dashes. The first symptom was a startup line printed as
  // "2: note — …", six bytes of "hive40" eaten by the drift.
  const since = () => tailFrom(readFileSync, logFile, from);

  // Bounded. A node that has not said it is watching within this long is not
  // going to, and hanging here would reproduce the very problem being fixed.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const seen = readStartup({ text: since(), exited });
    if (seen.started) {
      // The child's own words, then ONE line about stopping it. The pid and the
      // log path were here and are gone: `status` has the pid, and the log is
      // only worth naming when something went wrong — which is exactly where it
      // is still named, below (FIX-128).
      if (seen.output) console.log(seen.output);
      console.log(`hive402: running in the background. Stop it with "hive402 down".`);
      return;
    }
    if (seen.failed) {
      if (seen.output) console.error(seen.output);
      die(`the node exited during startup. Full output: ${logFile}`);
    }
    if (Date.now() > deadline) {
      if (seen.output) console.error(seen.output);
      die(`the node did not report that it is watching within 60s. Check ${logFile}, then "hive402 down".`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function cmdDown({ flags }) {
  // FIX-165: the same defect pointing the other way — this one STOPS every
  // agent the node started.
  if (flags.help) {
    console.log(DOWN_USAGE);
    return;
  }
  const { config } = resolveHive(flags);
  const { stopFromPidFile } = await import("../src/node/runtime.mjs");
  const results = stopFromPidFile(defaultStateDir(config));
  if (results.length === 0) {
    console.log("hive402: nothing to stop.");
    return;
  }

  // Three different things happened here and they must not be reported as one
  // (O-2). "stopped node:36916" for a process that died overnight is a false
  // statement handed to an operator who is mid-debug.
  const label = (rows) => rows.map((s) => `${s.name}:${s.pid}`).join(", ");
  const by = (state) => results.filter((s) => s.state === state);

  const stopped = by("stopped");
  const gone = by("gone");
  const stale = by("stale");

  if (stopped.length > 0) console.log(`hive402: stopped ${label(stopped)}`);
  if (gone.length > 0) {
    console.log(`hive402: cleared ${gone.length} stale record(s) — ${label(gone)} had already exited.`);
  }
  for (const s of stale) {
    console.log(`hive402: LEFT ALONE ${s.name}:${s.pid} — ${s.detail}`);
  }
  if (stopped.length === 0 && stale.length === 0) {
    console.log(`hive402: nothing was running.`);
  }
}

async function cmdStatus({ flags }) {
  // FIX-165: read-only, but a usage request that reaches a relay is still a
  // usage request that did work.
  if (flags.help) {
    console.log(STATUS_USAGE);
    return;
  }
  // `file` is the path the loader resolved — which is not necessarily
  // `flags.config`, and is the whole point when there wasn't one (FIX-141).
  const { config, file } = resolveHive(flags, { announce: false });
  const { readStatus } = await import("../src/node/runtime.mjs");
  const status = await readStatus({ config, stateDir: defaultStateDir(config), configFile: file });
  console.log(JSON.stringify(status, null, 2));
}

async function cmdRegister({ flags }) {
  if (flags.help) {
    console.log(REGISTER_USAGE);
    return;
  }
  const { config, file, raw } = resolveHive(flags);
  if (!flags.agent) die('register needs --agent <name> (see "hive402 register --help")');

  // No sponsor flag needed since FIX-117 (AC-47): the node is a community
  // member in its own right and vouches for the agents it hosts, so adding an
  // agent needs nothing secret from a person. The flags remain for a dev relay
  // that signs with an `env:` reference.
  const { registerAgent } = await import("../src/node/runtime.mjs");
  const result = await registerAgent({
    config,
    configFile: file,
    raw,
    stateDir: defaultStateDir(config),
    agentName: flags.agent,
    // Null, not "keychain" (FIX-136): absent means "the config decides", and
    // the config's `node.privateKeyRef` is what `up` already obeys. A flag is
    // still an instruction and still wins.
    sponsorRef: flags.sponsor ?? null,
    ownerKeyRef: flags["owner-key"] ?? flags.sponsor ?? null,
  });
  console.log(`hive402: registered ${result.name}`);
  console.log(`  attestation: ${result.attestationFile}`);
  console.log(`  relay role:  ${result.relayRole} · channel role: ${result.channelRole}`);
  // Two different identities, said separately on purpose: the room can verify
  // which node hosts this agent, and the config declares which human's approval
  // releases its actions (DD-51).
  console.log(`  hosted by:   ${result.attestedBy} (this node — it signed the attestation)`);
  console.log(`  approved by: ${result.ownerPubkey} (the human whose word releases an action)`);
  // The name is only reserved once it is published — that is what another
  // owner's node checks against (AC-37).
  console.log(`  name claim:  ${result.published ? "published — the name is now taken in this room" : "NOT PUBLISHED"}`);
  for (const warning of result.nameWarnings ?? []) console.log(`  ! ${warning}`);
  if (result.warning) console.log(`  ! ${result.warning}`);
}

async function cmdRetire({ flags, positional }) {
  if (flags.help) {
    console.log(RETIRE_USAGE);
    return;
  }
  const name = flags.agent ?? positional[0];
  if (!name) die('retire needs the agent name: hive402 retire <agent> (see "hive402 retire --help")');
  const { config, file, raw } = resolveHive(flags);

  const { runRetire } = await import("../src/node/runtime.mjs");
  const result = await runRetire({
    config,
    configFile: file,
    raw,
    stateDir: defaultStateDir(config),
    agentName: name,
  });

  if (result.alreadyRetired) {
    console.log(`hive402: ${name} is already retired — nothing to do.`);
    return;
  }

  if (!result.ok) {
    // Not a crash: parts of it may well have succeeded, and which parts is the
    // whole of what the operator needs to know next.
    console.log(`hive402: ${name} was NOT fully retired.`);
    console.log(`  ${result.reason}`);
    console.log(`  name given back: ${result.released ? `yes, now "${result.releasedAs}"` : "no"}`);
    console.log(`  registry record: ${result.retired ? "retired" : "still published"}`);
    process.exitCode = 1;
    return;
  }

  console.log(`hive402: retired ${name}`);
  console.log(`  name:     "${name}" is free again in this room — verified at both scopes (room, relay)`);
  console.log(`  identity: now published as "${result.releasedAs}" (it keeps a dead name; it does not vanish)`);
  console.log(`  record:   managed-agent record retired`);
  if (result.configMarked) console.log(`  config:   marked retired in ${file} — "up" will not relaunch it`);
  if (result.stillRunning) {
    console.log(
      `  ! ${name} is still RUNNING as pid ${result.stillRunning}. It answers under the dead name until ` +
        `the node restarts: "hive402 down" then "hive402 up".`,
    );
  }
}

async function cmdJoin({ flags, positional }) {
  if (flags.help) {
    console.log(JOIN_USAGE);
    return;
  }
  const [link] = positional;
  if (!link) die('join needs the invite link: hive402 join <invite-link> (see "hive402 join --help")');

  // A join happens BEFORE there is a config — it is step one — so a missing
  // config file is normal here and only the state directory matters.
  //
  // When there IS one, it decides WHICH identity joins (FIX-136). `up` has
  // always honoured `node.privateKeyRef`; this command read the credential
  // store's default entry instead, which on a box running a production node is
  // the production identity.
  let stateDir;
  let config = null;
  try {
    config = resolveHive(flags).config;
    stateDir = defaultStateDir(config);
  } catch {
    stateDir = path.join(homedir(), ".hive402");
  }

  const { CredentialStore } = await import("../src/credentials/store.mjs");
  const { terminalConsent, lineReader } = await import("../src/registry/consent.mjs");
  const { runJoin } = await import("../src/registry/joincommand.mjs");
  const { publishNodeProfile } = await import("../src/registry/profile.mjs");
  const { buzzBinPath } = await import("../src/registry/profilecommand.mjs");

  // AC-46 lives inside the join: the moment after a person joins a community is
  // the moment they can say what their hive should be called. One reader for
  // both questions, or the answer to the second is eaten by the first.
  const reader = lineReader({});
  await runJoin({
    link,
    store: new CredentialStore(),
    stateDir,
    // The config's declaration, when there is one. Absent (or "keychain") the
    // store is used exactly as before, which is the fresh-machine path AC-44
    // describes.
    privateKeyRef: config?.node?.privateKeyRef ?? null,
    // WHICH hive, when a config names one (AC-72). This machine may run
    // several, and each keeps its key under its own pubkey.
    nodePubkey: config?.node?.pubkey ?? null,
    consent: terminalConsent({ showTerms: flags["show-terms"] === true, reader }),
    askName: () =>
      reader.ask(
        `\nWhat should this node be called in the member list?\n` +
          `  (e.g. "Barry's hive" — press Enter to skip and set it later)\n> `,
      ),
    publishProfile: ({ name, privateKeyHex, origin }) =>
      publishNodeProfile({
        name,
        privateKeyHex,
        relayUrl: origin,
        binPath: buzzBinPath(config?.tools?.buzzDir ?? null),
        log: () => {},
      }),
  });
  reader.close();
}

async function cmdSetup({ flags }) {
  if (flags.help) {
    console.log(SETUP_USAGE);
    return;
  }
  let config = null;
  let found = null;
  let stateDir = path.join(homedir(), ".hive402");
  try {
    const loaded = resolveHive(flags);
    config = loaded.config;
    found = loaded.file;
    stateDir = defaultStateDir(config);
  } catch {
    /* no config yet — that is what this command is for */
  }
  // FIX-126. This used to be `path.resolve("hive402.config.json")`, so a fresh
  // setup wrote its config into whatever directory the person was standing in,
  // and every later command then worked from that directory and nowhere else.
  // The rules now live in one testable place beside the search that has to agree
  // with them.
  const configFile = setupConfigTarget({
    explicit: typeof flags.config === "string" ? flags.config : null,
    found,
    home: homedir(),
  });

  const { CredentialStore } = await import("../src/credentials/store.mjs");
  const { terminalConsent, lineReader } = await import("../src/registry/consent.mjs");
  const { runJoin } = await import("../src/registry/joincommand.mjs");
  const { runSetup, starterConfig } = await import("../src/setup/run.mjs");
  const { BuzzCli } = await import("../src/relay/buzzcli.mjs");

  const store = new CredentialStore();
  const reader = lineReader({});

  await runSetup({
    invite: typeof flags.invite === "string" ? flags.invite : null,
    nodeName: typeof flags.name === "string" ? flags.name : null,
    agentName: typeof flags.agent === "string" ? flags.agent : null,
    ownerPubkey: typeof flags.owner === "string" ? flags.owner : null,
    channel: typeof flags.channel === "string" ? flags.channel : null,
    store,
    stateDir,
    config,
    configFile,
    makeCli: (opts) => new BuzzCli(opts),
    // The join keeps its own consent conversation — this command does not get
    // to shortcut it, and there is no flag here that could (AC-45).
    join: ({ link }) =>
      runJoin({
        link,
        store,
        stateDir,
        consent: terminalConsent({ showTerms: flags["show-terms"] === true, reader }),
      }),
    writeConfig: ({ file, ...rest }) => {
      writeFileSync(file, `${JSON.stringify(starterConfig(rest), null, 2)}\n`, "utf8");
      return file;
    },
  });
  reader.close();
}

async function cmdProfile({ flags }) {
  if (flags.help) {
    console.log(PROFILE_USAGE);
    return;
  }
  let config = null;
  let stateDir;
  try {
    const loaded = resolveHive(flags);
    config = loaded.config;
    stateDir = defaultStateDir(config);
  } catch {
    // A profile can be published before there is a config — that file is
    // written later in setup. The join record is the only source that could be
    // right at that moment, and `resolveRelay` reads it.
    stateDir = path.join(homedir(), ".hive402");
  }

  const { CredentialStore } = await import("../src/credentials/store.mjs");
  const { runProfile } = await import("../src/registry/profilecommand.mjs");

  await runProfile({
    name: typeof flags.name === "string" ? flags.name : null,
    avatar: typeof flags.avatar === "string" ? flags.avatar : null,
    about: typeof flags.about === "string" ? flags.about : null,
    config,
    stateDir,
    store: new CredentialStore(),
  });
}

async function cmdAudit({ flags }) {
  // FIX-165.
  if (flags.help) {
    console.log(AUDIT_USAGE);
    return;
  }
  const { config } = resolveHive(flags);
  const file = path.join(defaultStateDir(config), "audit.jsonl");
  if (!existsSync(file)) {
    console.log(`hive402: no audit log yet at ${file}`);
    return;
  }
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const limit = Number(flags.limit ?? 50);
  for (const line of lines.slice(-limit)) {
    const row = JSON.parse(line);
    console.log(`${new Date(row.at).toISOString()}  ${row.type.padEnd(16)} ${JSON.stringify(row)}`);
  }
}

async function cmdDoctor({ flags }) {
  // FIX-165: ahead of the build banner too. Usage is not a diagnostic.
  if (flags.help) {
    console.log(DOCTOR_USAGE);
    return;
  }
  let ok = true;
  const say = (good, text) => {
    console.log(`${good ? "ok  " : "FAIL"}  ${text}`);
    if (!good) ok = false;
  };

  // WHICH BUILD IS SPEAKING. First line, always.
  //
  // Added after an afternoon of chasing a `hive402 up` failure where the output
  // Barry pasted turned out to have come from the PREVIOUS build — so the
  // diagnostics added to explain it had never run, and two rounds of reasoning
  // were spent on a message that no longer existed. A version and a path cost
  // one line and remove that whole class of confusion. It also catches the real
  // version of the same problem: a second, older install earlier on PATH.
  say(true, `hive402 ${pkg.version} running from ${root}`);

  // WHERE THE CREDENTIAL STORE LIVES, as the child process computes it. On
  // Windows that is built from %LOCALAPPDATA% inside the child, so a shell
  // carrying a different one searches a different, empty directory and
  // truthfully reports no keys — which looks exactly like having no keys.
  const { credentialLocation } = await import("../src/credentials/keychain.mjs");
  const where = credentialLocation();
  say(!/NOT SET/.test(where), `credential store: ${where}`);

  let loaded = null;
  try {
    loaded = resolveHive(flags);
    say(true, `config: ${loaded.file}`);
  } catch (err) {
    say(false, `config: ${err.message.split("\n")[0]}`);
    console.log(`      searched:\n        ${candidatePaths(flags.config).join("\n        ")}`);
    process.exit(1);
  }

  const { config, raw } = loaded;
  say(/^wss?:\/\//i.test(config.relayUrl), `relay url is a websocket url: ${config.relayUrl}`);

  // Config deprecations belong HERE, not on every `up` (FIX-128). "This field no
  // longer decides anything" is a fact about the file, not about this run, and
  // it cannot be acted on in the moment — so printing a paragraph of it every
  // time somebody starts their node is pure noise. `doctor` is the command whose
  // job is telling you about your setup.
  const { configDeprecations } = await import("../src/config/schema.mjs");
  for (const warning of configDeprecations(raw)) console.log(`note  ${warning}`);

  // THE SAME RESOLVER `up` USES (F-039). "doctor passing" has to mean "up can
  // launch", and these three lines used to read `tools.*` raw with the Windows
  // binary names joined on inline — so on a fresh machine they reported
  // `tools.buzzDir not set` / `tools.adapter not set`: accurate, useless, and
  // naming no remedy, on a box where discovery would have succeeded. Worse, on
  // macOS and Linux they asked about a `.exe` that is not what the file is
  // called, so a correctly configured host failed here too.
  const { resolveTools, describeMissingTool } = await import("../src/tools/resolve.mjs");
  const tools = resolveTools(config, { configFile: loaded.file });
  const TOOL_LABEL = { buzz: "buzz CLI", "buzz-acp": "buzz-acp harness", adapter: "ACP adapter" };
  for (const entry of [tools.buzz, tools.harness, tools.adapter]) {
    say(entry.exists, `${TOOL_LABEL[entry.tool]}: ${entry.path ?? "not found"}`);
    // The remedy, indented under its own FAIL. `up` refuses with this exact
    // text; printing it here is what makes doctor actionable rather than merely
    // correct.
    if (!entry.exists) {
      for (const line of describeMissingTool(entry, { configFile: loaded.file }).split("\n")) {
        console.log(`      ${line}`);
      }
    }
  }

  const stateDir = defaultStateDir(config);
  for (const room of config.rooms) {
    for (const agent of room.agents) {
      const att = path.join(stateDir, "agents", `${agent.name}.json`);
      say(existsSync(att), `attestation for ${agent.name}: ${att}`);
    }
  }

  // AC-76 in prose. `status` answers in JSON for machine callers; this is what
  // a human reads. Always `ok` — naming a model is a fact to report, not a
  // health check: hive402 cannot tell a typo'd model from a new one without a
  // network call, and a wrong name already surfaces through AC-57's failed-turn
  // report rather than as a FAIL here.
  {
    const { resolveModel } = await import("../src/config/schema.mjs");
    const WHERE = {
      agent: "named by the agent",
      node: "named by this hive",
      default: "hive402's default — no one named a model",
    };
    for (const room of config.rooms) {
      for (const agent of room.agents) {
        const { model, source } = resolveModel(agent, config.node);
        say(true, `model for ${agent.name}: ${model} (${WHERE[source]})`);
      }
    }
  }

  // DID THE AGENT'S LAST TURN ACTUALLY WORK? (FIX-129.)
  //
  // Barry asked smith a question and got nothing back, while every line above
  // this one was green — because every line above this one is about hive402, and
  // hive402 was fine. The failure was one layer further out: the model backend
  // refused to log in, said so in the harness log, and nothing read it.
  //
  // A node that reports itself healthy while its agent cannot answer is telling
  // a true fact and leaving the operator with a silent room.
  {
    const { lastAgentTurn, describeAgentFailure, describeStaleFailure } = await import(
      "../src/node/agenterrors.mjs"
    );
    for (const room of config.rooms) {
      for (const agent of room.agents) {
        const log = path.join(stateDir, "logs", `${agent.name}.log`);
        if (!existsSync(log)) continue;
        const turn = lastAgentTurn(readFileSync(log, "utf8"));

        const failure = describeAgentFailure({ agent: agent.name, turn });
        if (failure) {
          say(false, failure.headline);
          console.log(`      ${failure.detail}`);
          continue;
        }
        // Restarted since the failure: worth mentioning, not worth failing on.
        // Saying FAIL here is what this check did an hour after it shipped, to
        // an agent that was working perfectly.
        const stale = describeStaleFailure({ agent: agent.name, turn });
        say(true, stale ?? `${agent.name}'s last turn completed`);
      }
    }
  }

  // Can every identity actually get to its key? (FIX-52.)
  //
  // `privateKeyRef` defaults to "keychain", so this is the check for the path
  // a new owner takes by doing nothing — and until fix cycle 7 a missing key
  // there surfaced only as a failed `up`, several commands after the mistake.
  // A setup problem belongs in `doctor`, next to the remedy.
  {
    const { CredentialStore } = await import("../src/credentials/store.mjs");
    const { listKeys } = await import("../src/credentials/keys.mjs");
    const store = new CredentialStore();
    const rows = await listKeys({ store, config });

    // Which command would fix each one. `listKeys` walks the config in a fixed
    // order — the node, then each agent in each room — so the remedies are
    // built the same way rather than parsed back out of a label.
    //
    // FIX-127: which remedy is safe DEPENDS, and doctor is the one command that
    // can tell, because it already knows whether an identity has been registered.
    //
    // `keygen --agent X` mints a NEW key, so it produces a pubkey that is not
    // the one the config names. For an agent that has never been registered that
    // is fine — keygen prints the new pubkey and says to put it in the config,
    // and nothing else knows the old one. For an agent that IS registered it is
    // destructive: the room, the picker record and the attestation all name the
    // old identity, and the owner would be minting a stranger over a live agent.
    // That is the shape of the "Unnamed member" incident of 2026-08-26.
    //
    // The attestation file written by `register` is exactly that distinction,
    // and it is checked a few lines above for its own reason. `keys import` is
    // safe either way, because it stores a key that already exists.
    const agentRemedy = (name) =>
      existsSync(path.join(stateDir, "agents", `${name}.json`))
        ? `hive402 keys import --agent ${name}` // registered: minting would replace a live identity
        : `hive402 keygen --agent ${name}`; // never registered: a new key is free
    const remedies = [
      `hive402 keys import --node`,
      ...config.rooms.flatMap((room) => room.agents.map((a) => agentRemedy(a.name))),
    ];

    // Can this process see the store AT ALL? Asked before any per-identity
    // verdict, because if the answer is no then every one of those verdicts is
    // meaningless (FIX-127).
    //
    // Barry's doctor reported NO KEY for both identities and then, from the
    // diagnostic added the round before, `this process sees 0 entries there` —
    // at a path where another process on the same machine sees two files. So the
    // keys were never missing; the process could not look. Telling him to import
    // or create keys on the strength of that would have been the same wrong
    // advice, arrived at from a new direction.
    const { inspectStore } = await import("../src/credentials/keychain.mjs");
    const store_ = inspectStore();
    if (store_.unreadable) {
      say(false, `credential store is UNREADABLE from this process (${store_.reason}) — ${where}`);
      console.log(`      Every "no key" below is meaningless: nothing could be read, so nothing was found.`);
      console.log(`      Do NOT import or create keys. Run this from a shell with normal access to`);
      console.log(`      your own AppData, outside any sandbox, and compare.`);
    }

    rows.forEach((row, i) => {
      if (row.present === null) {
        // An env: reference is a different question entirely, and reporting it
        // as a missing keychain entry would call a working dev setup broken.
        const name = row.ref.slice(4);
        const set = Boolean(process.env[name]);
        say(set, `key for ${row.label}: ${row.ref} ${set ? "is set" : "is NOT set in this shell"}`);
        return;
      }
      say(
        row.present,
        row.present
          ? `key for ${row.label}: stored in the OS credential store`
          : `key for ${row.label}: NO KEY in the OS credential store — run "${remedies[i]}"`,
      );
    });

    // WHAT THIS PROCESS ACTUALLY SEES, printed only when something is missing.
    //
    // Barry's doctor reported NO KEY for both identities while the same command,
    // same build, same store path, run from another process on the same machine
    // minutes earlier, reported both stored. Everything checkable from outside
    // had been checked and eliminated — config, build, shell, store path, load,
    // and the entry names, which match the files on disk exactly — leaving one
    // question that only his process can answer.
    //
    // An empty list means this process cannot see the directory at all, which is
    // a permission or environment problem and NOT a missing key. A list holding
    // the very entries just called missing means the READ is failing, and no
    // amount of creating keys will help. Either way the next step stops being a
    // guess.
    if (rows.some((row) => row.present === false) && store_.entries !== null && !store_.unreadable) {
      const { entries } = store_;
      console.log(
        `      this process sees ${entries.length} entr${entries.length === 1 ? "y" : "ies"} there` +
          `${entries.length ? `: ${entries.join(", ")}` : " (the store is empty)"}`,
      );
    }
  }

  // AC-40 — the Buzz build this room is verified against (FIX-21).
  //
  // Cycle 2 could not re-check the pin: `Get-Item .VersionInfo` returns no
  // FileVersion or ProductVersion for these binaries on this install, so
  // "verified against the pinned build" was an assertion nobody could repeat.
  // A content hash is repeatable, by anyone, with no vendor cooperation.
  const { buildPinCheck, fingerprintBinary, harnessLifecycleEvidence, lifecycleCheck, lifecycleSubjects } =
    await import("../src/node/doctor.mjs");
  // FIX-97: the pin is COMPARED, never merely printed. The old shape hashed
  // the binaries and said `ok` unconditionally — Buzz silently updated
  // mid-project and doctor blessed both builds with different hashes.
  const pinnedNames = Object.keys(config.buzzBuild?.sha256 ?? {});
  // The binaries are named by the resolver, not spelled out here (F-039): on a
  // mac the files really are `buzz` and `buzz-acp`, so a hardcoded `.exe` made
  // this check unrunnable there. An existing pin keyed the Windows way is still
  // honoured — `pinnedNames` is unioned in, so what a config already records is
  // still fingerprinted and still compared.
  const fingerprintNames = [
    ...new Set([path.basename(tools.buzz.path), path.basename(tools.harness.path), ...pinnedNames]),
  ];
  // Where the binaries were actually found, so a discovered Buzz is pinnable
  // too — not only a configured one.
  const binDir =
    config.tools.buzzDir ?? (tools.buzz.source === "none" ? null : path.dirname(tools.buzz.path));
  const fingerprints = {};
  for (const name of fingerprintNames) {
    const fp = binDir ? fingerprintBinary(path.join(binDir, name)) : null;
    if (fp) fingerprints[name] = fp;
    else say(false, `buzz build pin — ${name} not found under tools.buzzDir`);
  }
  const pin = buildPinCheck({ pin: config.buzzBuild, fingerprints });
  if (pin.state === "unpinned") {
    console.log(`warn  buzz build pin — ${pin.detail}`);
    for (const [name, fp] of Object.entries(fingerprints)) {
      console.log(`      ${name}: sha256 ${fp.sha256} (${fp.size} bytes, ${fp.modified})`);
    }
  } else {
    for (const r of pin.results) {
      if (r.state === "match") {
        say(true, `buzz build pin — ${r.name} matches the pinned build (${pin.version}): sha256 ${r.actual.slice(0, 16)}…`);
      } else if (r.state === "missing") {
        say(false, `buzz build pin — ${r.name} is pinned (${pin.version}) but not on disk under tools.buzzDir`);
      } else {
        say(
          false,
          `buzz build pin — ${r.name} DRIFTED from the pinned build (${pin.version}): ` +
            `pinned sha256 ${r.expected} but the binary on disk is ${r.actual}. ` +
            `Re-audit the AC-42 lifetime/presence policy list against the new build, then update buzzBuild — ` +
            `a pin bump is a checklist, not a sentiment.`,
        );
      }
    }
  }

  // AC-41 / AC-42 — the lifecycle policy, on three surfaces (FIX-19, DD-18).
  const { lifetimePolicyReport } = await import("../src/launcher/env.mjs");
  console.log(
    `ok    lifecycle policy this node sets: ` +
      lifetimePolicyReport().map((p) => `${p.env}=${p.value}`).join(" "),
  );

  // O-3: diagnose the node BEFORE the agents. A dead node's pid file still
  // lists agents, and checking their policy asks the OS about numbers that no
  // longer name anything — which produced a FAIL per agent for a rig whose
  // actual condition was simply "not started".
  const pidFile = path.join(stateDir, "hive402.pid.json");
  const record = existsSync(pidFile) ? readPidRecord(pidFile) : null;
  const subjects = lifecycleSubjects({ record, stateDir });

  if (subjects.nodeDown) {
    console.log(`      no hive402 node is running — ${subjects.detail}`);
    console.log(`      start one with "hive402 up" to confirm the policy on the live process`);
  } else {
    for (const { name, pid } of subjects.agents) {
      const check = lifecycleCheck({ commandLine: liveCommandLine(pid) });
      say(check.ok, `lifecycle policy for ${name} (pid ${pid}): ${check.detail}`);
    }
    // An agent that exited on the idle policy is not damage and is not a stale
    // record: the node brings it back on the next @mention (DD-34). Saying so
    // is the difference between an operator restarting the rig and an operator
    // simply talking to the room.
    for (const s of subjects.idleExited) {
      console.log(`      ${s.name} is idle-exited (will respawn on next address) — ${s.detail}`);
    }
    for (const s of subjects.stale) {
      console.log(`      stale record for ${s.name} — ${s.detail}`);
    }
    if (subjects.agents.length === 0) {
      console.log(
        `      the node is up and no agent process is running right now` +
          (subjects.idleExited.length > 0 ? ` — the idle-exited ones above come back when addressed` : ``),
      );
    }
  }

  // The harness's own words are worth more than ours: this line comes out of
  // buzz-acp, and it is only reachable when the policy it names is in force.
  for (const room of config.rooms) {
    for (const agent of room.agents) {
      const logFile = path.join(stateDir, "logs", `${agent.name}.log`);
      if (!existsSync(logFile)) continue;
      const evidence = harnessLifecycleEvidence({ logText: readFileSync(logFile, "utf8") });
      if (evidence.quote) {
        console.log(`ok    harness confirms lazy pool + idle sleep for ${agent.name}: "${evidence.quote}"`);
      } else if (evidence.deferredPoolStartMs != null) {
        console.log(
          `ok    harness deferred ${agent.name}'s pool start by ${evidence.deferredPoolStartMs}ms ` +
            `(consistent with lazy pool; the sleep line appears after ${lifetimePolicyReport().find((p) => p.flag === "--idle-pool-sleep")?.value}s idle)`,
        );
      }
    }
  }

  process.exit(ok ? 0 : 1);
}

// A pid file that cannot be parsed says nothing about the node, which is the
// same position as having none at all — and `doctor` exists to survive a broken
// setup and describe it, not to die on one.
function readPidRecord(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The live process's command line, which is where AC-41/AC-42 policy is now
// visible from OUTSIDE the product (DD-18). Read with the OS's own tool so the
// answer does not depend on trusting hive402.
function liveCommandLine(pid) {
  const { spawnSync } = createRequire(import.meta.url)("node:child_process");
  const probe =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { encoding: "utf8" },
        )
      : spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  const text = (probe.stdout ?? "").trim();
  return text.length > 0 ? text : null;
}

// --- entry -----------------------------------------------------------------

const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const command = positional[0];

if (flags.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (flags.help && !command) {
  console.log(USAGE);
  process.exit(0);
}
if (!command) {
  // Deliberately NOT the full usage text: cycle 1's F-002 was that every
  // invocation produced one identical blob, so a bare call and `--help` are
  // distinguishable here on purpose.
  console.log(`hive402 ${pkg.version}`);
  console.error(
    `hive402: no command given. Usage: hive402 <setup|keygen|keys|join|profile|up|down|status|config|register|retire|audit|doctor>\n` +
      `         Run "hive402 --help" for the full list.`,
  );
  process.exit(1);
}

const COMMANDS = {
  keygen: cmdKeygen,
  setup: cmdSetup,
  join: cmdJoin,
  profile: cmdProfile,
  keys: cmdKeys,
  up: cmdUp,
  down: cmdDown,
  status: cmdStatus,
  config: cmdConfig,
  register: cmdRegister,
  retire: cmdRetire,
  audit: cmdAudit,
  doctor: cmdDoctor,
};

const handler = COMMANDS[command];
if (!handler) {
  die(`unknown command "${command}" — try "hive402 --help" for the list.`);
}

try {
  await handler({ flags, positional: positional.slice(1) });
} catch (err) {
  // An operator wants the reason, not our stack.
  die(err.message);
}
