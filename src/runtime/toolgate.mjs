#!/usr/bin/env node
// The tool gate — hive402's answer to F-007.
//
// This runs INSIDE the agent's model runtime, as a `PreToolUse` hook declared
// in the per-agent settings the node writes (see launcher/capabilities.mjs). It
// is the last thing that happens before a tool executes, and it can refuse.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Cycle 1 decided "is this an action request?" by matching verbs in a human
// sentence (DD-12). Cycle 2's F-007 defeated that with one ordinary rephrasing:
// a non-owner asked for "the top story headline on Hacker News' front page at
// this moment", which contains none of the lexicon's verbs, and a fully capable
// agent performed a live web fetch for them — no approval, no proposal, and
// (because the audit write lived in the same branch) no record either.
//
// Adding verbs loses to the next rephrasing. Natural language is an open set.
// But the action does not happen when a human phrases a sentence — it happens
// when the agent runs a TOOL, and tools are a closed set that we can enumerate
// and that the runtime hands us by name. So the gate classifies the TOOL, reads
// the node's per-turn capability grant, and refuses when the turn is not
// entitled. Nothing here reads the request text at all.
//
// ── The invariant ──────────────────────────────────────────────────────────
//
// A turn triggered by a non-owner runs with an explicit "withheld" record, so
// no phrasing can produce an action. A turn triggered by the owner (AC-16) or
// released by the owner's approval (AC-14) runs with a grant naming exactly the
// capabilities it may use, for exactly one turn.
//
// Fail closed everywhere: unknown tool, unknown shell command, missing grant,
// unreadable state, malformed payload — all deny. The one thing that must never
// fail closed is the agent's own voice, because Buzz discards an agent's plain
// text and an agent replies by RUNNING `buzz messages send`; denying that
// produces an agent that wakes and stays mute (observed live, 2026-08-15).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  bindGrant,
  claimAuthority,
  claimReleasedAuthority,
  consumeAuthority,
  coversCapability,
  readGrant,
} from "./grants.mjs";
import { readTurnRecord } from "./turngate.mjs";
import { redact } from "../audit/log.mjs";
import { DEPLOY_DIR } from "../workshop/site.mjs";

const CONVERSE = "converse";

// Tools that only look at things. These are the agent's senses, not its hands.
const CONVERSE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "TodoWrite", "NotebookRead",
  "BashOutput", "KillShell", "ToolSearch", "ExitPlanMode", "AskUserQuestion",
]);

const RESEARCH_TOOLS = new Set(["WebSearch", "WebFetch"]);

const BUILD_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// The shell tools, whose classification depends on the command, not the tool.
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell"]);

// Command heads the agent needs in order to TALK and to look around. This list
// is deliberately tiny: everything not on it needs a grant.
// `buzz` is NOT here. It is decided by its subcommand in a branch of its own
// (see BUZZ_FREE_SUBCOMMANDS) — a blanket entry here would answer first and
// wave `moderation ban` through with `messages send`.
const CONVERSE_COMMANDS = new Set([
  "echo", "printf", "cat", "type", "head", "tail", "ls", "dir", "pwd", "cd",
  "find", "findstr", "grep", "wc", "sort", "uniq", "where", "which",
  "date", "hostname", "whoami", "true", "false", "sleep", "test",
]);

const RESEARCH_COMMANDS = new Set([
  "curl", "curl.exe", "wget", "http", "https", "httpie", "xh",
  "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "lynx", "w3m",
]);

const BUILD_COMMANDS = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "node", "deno", "bun",
  "python", "python3", "py", "pip", "pip3", "uv", "cargo", "rustc",
  "make", "cmake", "docker", "podman", "kubectl", "terraform",
  "run402", "gh", "aws", "gcloud", "dotnet", "go", "mvn", "gradle", "tsc",
  "rm", "del", "mv", "move", "cp", "copy", "mkdir", "touch", "chmod", "icacls",
]);

// Commands hive402 runs ON THE AGENT'S BEHALF, never inside the agent's
// process (DD-27, fix cycle 6).
//
// `run402` spends the owner's run402 account and commits a public subdomain, so
// it is not a capability an approval can hand over — it is work that belongs to
// a different principal. The gate therefore refuses it UNCONDITIONALLY, even on
// a turn holding a full `build` grant, and marks the refusal with the delegate
// name. The node reads that mark off the blocked record and is the only thing
// that can start a deploy.
//
// Note what this is not: a lexicon. Nothing here reads the request text. The
// key is the command the agent actually reached for, which the runtime hands us
// by name — the same closed set DD-15 and DD-22 rest on.
const DELEGATED_COMMANDS = new Map([
  ["run402", "run402"],
  ["run402.cmd", "run402"],
  ["run402.exe", "run402"],
  ["run402.ps1", "run402"],
  ["run402.bat", "run402"],
]);

// ── Files inside the scratch directory that are NOT scratch paper ──────────
//
// DD-36 established this idea for the deploy folder: it lives inside the
// agent's working directory, and writing there is acting on the world rather
// than composing, because what goes in it is published. Two more kinds of file
// have exactly the same property, and until FIX-114 both were free.
//
// 1. AGENT MEMORY (AC-54). An agent keeps no private store, and writing one is
//    a build action refused outright when `build` is off. `CLAUDE.md` and its
//    siblings are how the model runtime persists context across sessions, so a
//    write there is the store the criterion forbids.
//
// 2. THE RUNTIME'S OWN SETTINGS. `.claude/settings.json` is where
//    `writeAgentRuntimeConfig` declares the PreToolUse and UserPromptSubmit
//    hooks. It is the file that makes the gate run at all, and it sat inside
//    the scratch directory being treated as scratch paper: `echo x >
//    .claude/settings.json` and `rm .claude/settings.json` both scored
//    `converse`, needing no grant of any kind. Mitigations existed and were
//    partial — the live process has already loaded its settings, and every
//    launch rewrites the file unconditionally so a respawn repairs it — but
//    "the config that enables the gate is editable by the thing being gated"
//    is not a property to leave standing on the strength of a respawn.
//
// Deliberately a SMALL, enumerable set of names. F-010 is the standing reminder
// that over-classifying does not contain an agent, it silences one, and a mute
// agent is indistinguishable from a broken one. Ordinary scratch work must stay
// free, and a test asserts that half explicitly.
const MEMORY_FILES = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "memory.md",
]);

// Any path under the runtime's settings directory, anywhere in the tree.
const RUNTIME_CONFIG_DIR = ".claude";

function isGovernedFile(normalisedPath) {
  const segments = String(normalisedPath).split("/").filter(Boolean);
  if (segments.some((s) => s === RUNTIME_CONFIG_DIR)) return true;
  const base = segments[segments.length - 1];
  return base ? MEMORY_FILES.has(base) : false;
}

// ── Surfaces NO member of this room can ask for (AC-52, F-034, DD-68) ──────
//
// `isGovernedFile` has always been computed — inside `insideScratch`, to decide
// that a memory write is a build rather than composition — and then thrown
// away. This asks the same question for a different consumer: not "what
// capability does this need?" but "could anybody in this room have asked for
// it?"
//
// The answer is no, twice over, and the spec says so in both cases:
//
//   • an agent's own memory / self-persistence surface — AC-54, "an agent keeps
//     no private memory". A request for one is a request for the single thing
//     the product forbids;
//   • the files that define or govern the agent — AC-55, "an agent never edits
//     its own instructions". That is `verdict.governed`, which the gate has
//     decided since DD-56 and, until FIX-169, never wrote down.
//
// This classifies SURFACES, never intent. Reading the sentence to guess what
// the agent meant is the verb lexicon, and DD-26 deleted it for cause.
//
// No cwd resolution is needed here: the basename rule and the `.claude` segment
// rule give the same answer for `CLAUDE.md` and for `<workDir>/CLAUDE.md`,
// which is precisely the property `insideScratch` has to resolve a path to get.
function isMemoryTarget(target) {
  if (!target) return false;
  const t = String(target)
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/^['"]|['"]$/g, "");
  // A target we cannot resolve is a target we cannot vouch for — the rule
  // `insideScratch` and `isGovernedTarget` both already apply. Such a call
  // stays a build; it just does not get to claim nobody asked for it.
  if (/[$`*?[\]]/.test(t)) return false;
  return isGovernedFile(t);
}

// ── Files no grant can unlock (DD-56's counterweight; AC-55, F-6) ──────────
//
// Under DD-35 every write to these surfaced as a signature-bound confirmation
// the owner was SHOWN, because `build` never rode a blanket grant. DD-56 puts
// build on every owner turn, so the protection has to be stated rather than
// inherited by accident: a write to the files that DEFINE or GOVERN an agent
// is refused before any record is consulted, exactly as delegated commands
// are — no grant can widen a branch it never reaches, and no approval can
// unlock it.
//
//   • `.claude/**` — the runtime settings that make this very gate run.
//   • `.hive402/**` and the live state dir — grants, audit, node config: an
//     agent writing its own authority records is self-authorisation.
//   • the agent's own instructions file (AC-55: "an agent never edits its own
//     instructions" — never), passed per-agent by the launcher.
//
// Memory files (CLAUDE.md and siblings) are deliberately NOT here: AC-54 pegs
// them to build's own rules — "the same approval as any other build" — so
// they ride an owner's turn exactly as any build does now.
const GOVERNED_DIRS = new Set([RUNTIME_CONFIG_DIR, ".hive402"]);

function isGovernedTarget(target, cwd, governedPaths = []) {
  if (!target) return false;
  const normal = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const t = normal(target).replace(/^['"]|['"]$/g, "");
  // The segment rule needs no resolution: the governed directory's NAME marks
  // it wherever it lives — which also catches the `~/` and `$HOME/` spellings
  // a strict resolver has to give up on.
  //
  // With one carve-out, because the node deliberately houses the agents'
  // sandboxes INSIDE its own state dir (`<state>/work/<agent>/…`): a governed
  // segment whose immediate child is `work` opens the sandbox subtree, which
  // is exactly where composition must stay free (DD-33). A later governed
  // segment inside the sandbox — its `.claude` runtime config — still counts.
  const segments = t.split("/").filter(Boolean);
  const governedIdxs = segments.flatMap((s, i) => (GOVERNED_DIRS.has(s) ? [i] : []));
  if (governedIdxs.some((i) => segments[i + 1] !== "work")) return true;
  if (!governedPaths.length) return false;
  // Per-agent exact paths (the instructions file, the state dir) are matched
  // on the resolved target, the same way `insideScratch` judges one. A target
  // we cannot resolve to a particular place cannot be vouched governed — the
  // capability classification still applies to it as before.
  if (t.startsWith("~") || t.includes("..") || /[$`*?[\]]/.test(t)) return false;
  const trim = (p) => p.replace(/\/+$/, "");
  const absolute = /^([a-z]:\/|\/)/.test(t);
  if (!absolute && !cwd) return false;
  const here = absolute ? trim(t) : trim(`${trim(normal(cwd))}/${t.replace(/^\.\//, "")}`);
  return governedPaths.some((p) => {
    const g = trim(normal(p));
    if (!g) return false;
    if (here !== g && !here.startsWith(`${g}/`)) return false;
    // The same sandbox carve-out for a state dir under any name.
    return !here.startsWith(`${g}/work/`);
  });
}

// ── `buzz` is how the agent TALKS, but most of what `buzz` does is not talking ─
//
// `buzz` is here because an agent replies by RUNNING it: Buzz discards an
// agent's plain text output, so treating the whole command as a build does not
// contain the agent, it silences one (F-010, observed live 2026-08-15). But the
// CLI is 22 command groups, and only a handful of their subcommands are speech
// or a read. The rest change durable state — the roster, the moderation queue,
// a profile, a repo — and AC-12 says those need a human to have asked.
//
// FIX-114 saw this for `mem` and gated three verbs by name. FIX-122 measured
// the rest: on a turn holding NO authority, `users set-profile` renamed the
// calling identity (the cycle-1 F-001 mechanism, reachable again),
// `channels add-member` changed the roster, `moderation ban` banned a member,
// and `upload file` put any readable path on the relay.
//
// ── Why this is an allow-list, where FIX-114 used a deny-list ──────────────
//
// FIX-114's reasoning was that over-classifying silences an agent, so keep the
// gated list "small and enumerable". That is right for one group and wrong for
// twenty-two: with a deny-list, every subcommand nobody enumerated is FREE, and
// upstream adds subcommands continuously. The hole is silent and it grows.
//
// So the enumerated set is the FREE one and everything else is a build. The
// failure direction flips to the recoverable one: a subcommand we have not seen
// is refused, which is visible and which the agent says out loud in the room,
// rather than free and unnoticed. The F-010 line itself is untouched —
// `messages send` is free, and a test asserts it on a turn holding nothing.
//
// Transcribed from `Cmd` and its `*Cmd` enums in crates/buzz-cli/src/lib.rs,
// read at buzz `origin/main` 29f2054c (2026-08-25). NOT at a2d8be5ef, which
// FIX-114 cited and which is now well behind.
const BUZZ_HEADS = new Set(["buzz", "buzz.exe"]);

// Reads, plus the agent's own voice. Everything absent from this set is a build.
//
// Two entries are gated although they mostly read, and both for the same
// reason: `media get --output <path>` and `emoji export --out <path>` write
// bytes to a caller-chosen path, which is the arbitrary write FIX-114 closed at
// `.claude/settings.json`. They are gated on the write, not on the read.
//
// Two are free although they publish: `messages send` and `send-diff` ARE the
// agent's voice, and `messages edit` revises what the agent itself already
// said. AC-12 gates non-conversational actions; that is the conversation.
const BUZZ_FREE_SUBCOMMANDS = new Set([
  "agents archived",
  "messages send", "messages send-diff", "messages edit",
  "messages get", "messages thread", "messages search",
  "channels list", "channels get", "channels search", "channels members",
  "canvas get",
  "reactions get",
  "emoji list",
  "dms list",
  "users get", "users presence",
  "workflows list", "workflows get", "workflows runs",
  "feed get",
  "social event", "social notes", "social contacts", "social list",
  "notes get", "notes ls",
  "repos get", "repos list",
  "projects get", "projects list",
  "patches get", "patches list",
  "pr get", "pr list",
  "issues get", "issues list",
  "mem ls", "mem get", "mem hash",
  "pack validate", "pack inspect",
  "moderation reports", "moderation restricted", "moderation audit",
]);

// The subcommands that ARE the agent speaking. Used only to pick the wording of
// a refusal (see `speechAttempt`), never to soften one.
const BUZZ_SPEECH_SUBCOMMANDS = new Set([
  "messages send", "messages send-diff", "messages edit",
]);

// Global flags that take a SEPARATE value, from the `Cli` struct at the same
// commit. Their value is not flag-shaped, so it lands in the word list and
// shifts every following word by one — which is exactly how the `mem` gate came
// to be bypassable by anyone who passed a flag:
//
//     buzz mem set core x                       -> "mem set"        gated
//     buzz --relay http://localhost:3000 mem set core x
//                                               -> "http mem"       free
//
// A flag we do NOT know here eats nothing, so its value becomes the group word,
// the pair matches nothing, and the call is refused. That is the safe direction:
// a new upstream flag costs a visible refusal, never a silent hole.
const BUZZ_VALUED_GLOBALS = new Set(["--relay", "--private-key", "--auth-tag", "--format"]);

// The group and subcommand, lowercased: "mem set". Flags are dropped, and the
// value of a known valued flag is dropped with it. Returns "" for the usage
// forms (`buzz`, `buzz --help`), and null when the line cannot be read as a
// group plus a subcommand.
function buzzSubcommand(segment) {
  const text = commandText(segment);
  if (!text) return null;
  const tokens = text.split(/\s+/).slice(1).filter(Boolean);
  const words = [];
  for (let i = 0; i < tokens.length && words.length < 2; i += 1) {
    const token = tokens[i].toLowerCase();
    if (token.startsWith("-")) {
      // `--relay=x` carries its own value; `--relay x` eats the next token.
      if (!token.includes("=") && BUZZ_VALUED_GLOBALS.has(token)) i += 1;
      continue;
    }
    words.push(token);
  }
  if (words.length === 0) return "";
  return words.length === 2 ? `${words[0]} ${words[1]}` : null;
}

// Free when we can read the line AND the pair is a read or the agent's voice.
// Anything we cannot read — an unknown group, a group with no subcommand, a
// word list shifted by a flag we do not know — is a build, because a `buzz`
// call we cannot classify could be any of the ones we just gated.
function classifyBuzz(segment) {
  const pair = buzzSubcommand(segment);
  if (pair === "") return CONVERSE;
  return pair !== null && BUZZ_FREE_SUBCOMMANDS.has(pair) ? CONVERSE : "build";
}

function isBuzzSpeech(segment) {
  return BUZZ_SPEECH_SUBCOMMANDS.has(buzzSubcommand(segment));
}

// File commands whose capability depends on WHERE they point, exactly as a
// redirect's does (FIX-29). `mkdir` was build unconditionally, so spike2 asking
// for a scratch subdirectory of its own working directory was refused as though
// it were changing the world. Judging the target rather than the verb is the
// same rule already applied to `printf … > msg.txt`, and it keeps the teeth:
// every path must be inside the agent's own scratch directory, or it is a
// build.
const PATH_SCOPED_COMMANDS = new Set(["mkdir", "touch", "cp", "copy", "mv", "move", "rm", "del"]);

// Splitting a shell line into segments. We do not need a real parser — we need
// every command head that could run, and a bias toward "I do not recognise
// this", which is the safe answer.
const SEGMENT_SPLIT = /\|\||&&|[|;\n&]/;

// Shell control structure. These are not commands — they run nothing on their
// own — so they contribute no capability and the classifier reads past them to
// whatever they guard.
//
// FOUND BY RUNNING IT (2026-08-15): spike tried to tell the room it was refusing
// a delegation, and wrote the reply as `for pk in <a> <b> <c>; do buzz messages
// send …; done`. The head of the first segment is `for`, an unrecognised
// command, so the whole reply scored as build and never left the machine.
const STRUCTURAL = new Set([
  "for", "while", "until", "do", "done", "if", "then", "elif", "else", "fi",
  "case", "esac", "in", "function", "select", "time", "{", "}", "(", ")", "!",
]);

// Strip everything that is not the command itself — env prefixes and shell
// control keywords — and hand back what actually runs. Both the head and its
// arguments are read from this same result, so `do rm $f` cannot have its
// keyword counted as the command by one reader and as an argument by the other.
function commandText(segment) {
  let text = String(segment).trim();
  if (!text) return null;
  // Drop leading `VAR=value` env prefixes (`FOO=bar curl …`).
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
    text = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "");
    if (!/\s/.test(text) && /=/.test(text)) return null;
  }
  // A loop or case HEADER names a variable and a word list, not a command:
  // `for pk in aaa bbb ccc` runs nothing, and reading `pk` as a command head is
  // how an ordinary reply came to be scored as a build. Any substitution in the
  // word list has already been classified on its own.
  if (/^(for|select|case)\s/i.test(text)) return null;

  // Read past the remaining control keywords to the command they guard:
  // `do buzz messages send …` becomes `buzz`, `then git push` becomes `git`.
  for (;;) {
    const word = text.match(/^(\S+)(\s+|$)/);
    if (!word || !STRUCTURAL.has(word[1].toLowerCase())) break;
    text = text.slice(word[0].length).trim();
    if (!text) return null;
  }
  return text;
}

function commandHead(segment) {
  const text = commandText(segment);
  if (!text) return null;
  const first = text.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (!first) return null;
  const raw = first[1] ?? first[2] ?? first[3] ?? "";
  // `/usr/bin/curl` and `C:\…\buzz.exe` are curl and buzz.
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.toLowerCase();
}

// Most privileged segment wins. `curl x | git apply -` is a build.
const RANK = { converse: 0, research: 1, build: 2 };

// Where a redirect may point without being a build.
//
// FOUND BY RUNNING IT (2026-08-15): a model composing a multi-line reply writes
// `printf … > msg.txt && buzz messages send --content "$(cat msg.txt)"`.
// Scoring that as build makes the agent MUTE on every contained turn — the one
// failure mode the launcher exists to prevent — and worse, the room then never
// learns anything was refused at all.
//
// So a write into the agent's OWN scratch working directory (which the node
// created, whose only other content is the settings file, and which the agent
// is relaunched into) is not an action on the world. A write anywhere else is,
// and with no cwd known every redirect is, because an unknown location has an
// unknown blast radius.
// FOUND BY FIXING SOMETHING ELSE (2026-08-16): this only understood an
// optionally DOUBLE-quoted target, so `cat > '/c/Users/…/note.md'` yielded a
// target beginning with an apostrophe, which does not look absolute, which made
// it read as relative — that is, as inside the scratch directory. A write to
// the owner's home scored as conversation. It was hidden until now because the
// heredoc that followed it was being misparsed into a build; correcting the
// heredoc uncovered it.
function redirectTargets(segment) {
  const text = String(segment).replace(/\d?>&\d?/g, " "); // 2>&1 is a dup, not a write
  const targets = [];
  const re = />>?\s*(?:'([^']*)'|"([^"]*)"|([^\s'"|;&<>]+))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    targets.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return targets;
}

// Characters that separate or redirect. Inside a quoted string they are just
// letters, so they get masked one-for-one — offsets, command heads and quoted
// binary paths all survive.
const QUOTED_OPERATORS = new Set(["|", ";", "&", ">", "<", "\n", "`", "(", ")"]);

const mask = (text) =>
  [...String(text)].map((c) => (QUOTED_OPERATORS.has(c) ? "_" : c)).join("");

// What a backslash can actually escape.
//
// FOUND BY WRITING FIX-43 (2026-08-18): the scanner treated `\` + ANY character
// as an escape and masked both, which destroys every Windows absolute path —
// `C:\Users\x\run402.cmd` became `C:__sers__\…`, with no separator left for
// `commandHead` to split on. Three consequences, all live before this:
//
//   • `C:\…\run402.cmd up -y` carried no delegate mark, so it escalated as an
//     ordinary build; an owner approving it would have released the agent to
//     run run402 itself, with the owner's wallet. That is the exact thing
//     DD-27 exists to prevent.
//   • `cat notes > C:\Users\volin\note.md` scored CONVERSE, because the
//     mangled target no longer looks absolute and a non-absolute target reads
//     as "inside the scratch directory". A write to the owner's home was free
//     on a withheld turn. Same defect as the quoted-target bug fixed in cycle
//     3, one spelling over.
//   • `C:\Buzz\buzz.exe messages send …` scored build, so an agent that
//     invoked buzz by absolute path went MUTE on every contained turn — F-010.
//
// A POSIX shell drops the backslash and keeps the character, so `\U` is just
// `U`; the mangling was never right for either shell. Restricting escapes to
// the characters an escape is actually FOR keeps every quoting fix from cycle 3
// intact and lets a path stay a path.
const ESCAPABLE = new Set([
  "\\", '"', "'", "$", "`", "|", "&", ";", "<", ">", "(", ")", "!", "*", "?", "#", "~", " ", "\t", "\n",
]);

// The paths a path-scoped command would touch: every argument that is not a
// flag. Deliberately includes sources as well as destinations — `cp
// /etc/passwd ./x` reaches outside the sandbox even though it only writes
// inside it. An empty list (no paths at all) is not composition either; a
// command with nothing to point at is not one we understand.
function pathArguments(segment) {
  const text = commandText(segment);
  if (!text) return [null];
  const words = text
    .split(/\s+/)
    .slice(1) // drop the command itself
    .filter((word) => word && !word.startsWith("-"));
  if (words.length === 0) return [null];
  return words.map((word) => word.replace(/^['"]|['"]$/g, ""));
}

function insideScratch(target, cwd) {
  if (!cwd) return false;
  if (!target) return false;
  const normal = (p) => String(p).replace(/\\/g, "/").toLowerCase();
  const trim = (p) => p.replace(/\/+$/, "");
  const t = normal(target);
  // `~` is the owner's home, never scratch.
  if (t.startsWith("~")) return false;
  if (t.includes("..")) return false;
  // A target we cannot resolve is a target we cannot vouch for. `rm $f` and
  // `rm *` name no particular place, so they get the same answer as a command
  // with no working directory at all: not scratch, therefore build.
  if (/[$`*?[\]~]/.test(t)) return false;
  // Absoluteness is decided BEFORE trailing slashes are trimmed. Trimming
  // first turns "/" into "", which reads as a bare relative name — and made
  // `rm -rf /` score as composition inside the scratch directory.
  const absolute = /^([a-z]:\/|\/)/.test(t);
  const root = trim(normal(cwd));
  const temp = trim(normal(process.env.TEMP ?? process.env.TMP ?? "/tmp"));
  // A relative target is resolved against the working directory before it is
  // judged, rather than waved through as "relative, therefore scratch". The
  // answer is the same for every path that used to take that shortcut — the
  // point is that `site/index.html` and `<workDir>/site/index.html` now get the
  // same answer, which is what DD-36 is about.
  const here = absolute ? trim(t) : trim(`${root}/${t.replace(/^\.\//, "")}`);

  // The deploy folder is inside the working directory and is NOT scratch paper
  // (DD-36, answering TR-008). Whatever sits in it is what the node publishes,
  // so writing there is acting on the world, not composing — and that is true
  // for the agent's own owner as much as for a stranger. Without this, a turn
  // holding no authority at all could put bytes on a public URL by redirect.
  const deploy = `${root}/${DEPLOY_DIR.toLowerCase()}`;
  if (here === deploy || here.startsWith(`${deploy}/`)) return false;

  // Agent memory and the runtime's own settings (AC-54, FIX-114). Same
  // reasoning as the deploy folder immediately above: inside the working
  // directory, and not scratch paper. Checked on the RESOLVED path, so a bare
  // `CLAUDE.md` and `<workDir>/CLAUDE.md` get the same answer.
  if (isGovernedFile(here)) return false;

  if (!absolute) return true; // a bare name is relative to cwd, which IS scratch
  return here === root || here.startsWith(`${root}/`) || here.startsWith(`${temp}/`);
}

// ── Reading a shell line the way a shell reads it (DD-22, fix cycle 3) ─────
//
// Cycle 2's scanner looked for shell-flavoured substrings anywhere in the
// command. That is the same mistake as the verb lexicon, one layer down: it
// classifies TEXT rather than structure, and an agent's own sentences are text.
// F-010 is the bill for it — a heredoc body split into "commands" one English
// line at a time, the `1` in `2>&1` read as a command, a backtick inside single
// quotes treated as a live substitution. The agent went mute, which is worse
// than being refused: the room cannot tell a contained agent from a broken one.
//
// So this models the actual language. Three rules carry it, and each is a plain
// fact about POSIX shells rather than a heuristic:
//
//   • Inside '…' NOTHING expands. No substitution, no variable, no operator.
//   • Inside "…" substitutions DO expand, so they are still classified.
//   • A heredoc body is data. `<<'EOF'` is literal; `<<EOF` expands, so only
//     then can it run anything.
//
// And one more that reads like leniency but is not: an unterminated quote runs
// to end of line as literal, because a shell reading an unclosed string is
// still reading a string — it cannot start a new command there. That single
// fact is what stops one apostrophe in "I can't" from turning the rest of a
// sentence into a list of unknown commands.
//
// The error direction is unchanged: anything this cannot read, it refuses.

// A heredoc body is stdin data, not a command list. Returns the command with
// bodies removed, plus the bodies that can still expand something.
function extractHeredocs(text) {
  const marker = /<<-?\s*(?:'([^']*)'|"([^"]*)"|\\([A-Za-z_][\w]*)|([A-Za-z_][\w]*))/;
  let rest = String(text);
  let out = "";
  const expanding = [];

  for (let guard = 0; guard < 10; guard += 1) {
    const found = marker.exec(rest);
    if (!found) break;
    const [matched, single, double, escaped, bare] = found;
    const delimiter = single ?? double ?? escaped ?? bare;
    // Quoting the delimiter — any of the three ways — makes the body literal.
    const literal = single !== undefined || double !== undefined || escaped !== undefined;

    const afterMarker = found.index + matched.length;
    const bodyStart = rest.indexOf("\n", afterMarker);
    if (bodyStart < 0) {
      // The body has not started yet (a truncated capture, or the marker is the
      // last thing on the line). Nothing to excise.
      out += rest.slice(0, afterMarker);
      rest = rest.slice(afterMarker);
      continue;
    }

    const lines = rest.slice(bodyStart + 1).split("\n");
    const endLine = lines.findIndex((line) => line.trim() === delimiter);
    const body = (endLine < 0 ? lines : lines.slice(0, endLine)).join("\n");
    if (!literal) expanding.push(body);

    out += rest.slice(0, bodyStart);
    rest = endLine < 0 ? "" : lines.slice(endLine + 1).join("\n");
  }
  return { text: out + rest, expanding };
}

// Walk the line once, honouring quotes. Returns the substitutions that would
// really run, and a masked copy of the line whose operators are only the ones
// that really separate commands.
function scanShell(text) {
  const source = String(text ?? "");
  const substitutions = [];
  let masked = "";
  let i = 0;

  // `$(…)`, or `$((…))` which is arithmetic and runs nothing itself.
  const readParen = (start) => {
    const arithmetic = source[start + 2] === "(";
    let depth = 0;
    let j = start + 1;
    for (; j < source.length; j += 1) {
      if (source[j] === "(") depth += 1;
      else if (source[j] === ")") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    return { body: source.slice(start + 2, j - 1), end: j, arithmetic };
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "\\" && i + 1 < source.length) {
      // An escaped operator is a literal, and must not separate anything.
      if (ESCAPABLE.has(source[i + 1])) {
        masked += "__";
        i += 2;
        continue;
      }
      // Not an escape at all: a Windows path separator. Keep it, so the path
      // survives to `commandHead` and to `insideScratch`, both of which already
      // understand `\`. The character after it is read normally on the next
      // pass, so nothing is skipped.
      masked += c;
      i += 1;
      continue;
    }

    if (c === "'") {
      const close = source.indexOf("'", i + 1);
      if (close < 0) {
        // Unterminated: the shell is still reading a string, so the rest of the
        // line is data and can never begin a command.
        masked += mask(source.slice(i));
        break;
      }
      masked += `'${mask(source.slice(i + 1, close))}'`;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const close = (() => {
        for (let j = i + 1; j < source.length; j += 1) {
          if (source[j] === "\\") j += 1;
          else if (source[j] === '"') return j;
        }
        return -1;
      })();
      if (close < 0) {
        masked += mask(source.slice(i));
        break;
      }
      // Substitutions inside double quotes really do run.
      const inner = source.slice(i + 1, close);
      const scanned = scanShell(inner);
      substitutions.push(...scanned.substitutions);
      masked += `"${mask(inner)}"`;
      i = close + 1;
      continue;
    }

    if (c === "$" && source[i + 1] === "(") {
      const { body, end, arithmetic } = readParen(i);
      if (arithmetic) {
        // `$(( … ))` computes; only what is nested inside it can run.
        substitutions.push(...scanShell(body).substitutions);
      } else {
        substitutions.push(body);
      }
      masked += " ".repeat(end - i);
      i = end;
      continue;
    }

    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      if (close < 0) {
        masked += mask(source.slice(i));
        break;
      }
      substitutions.push(source.slice(i + 1, close));
      masked += " ".repeat(close - i + 1);
      i = close + 1;
      continue;
    }

    masked += c;
    i += 1;
  }

  return { substitutions, masked };
}

// The shell classifier, in full: what capability this line needs, and whether
// any part of it reaches for a command hive402 runs on the agent's behalf.
//
// `classifyCommand` below is the capability half on its own, which is what most
// callers and every pre-cycle-6 test want.
export function classifyShell(command, { cwd = null, depth = 0, governedPaths = [] } = {}) {
  let worst = CONVERSE;
  let delegate = null;
  let governed = false;
  // Whether any target on this line is a surface nobody in the room could have
  // asked for (DD-68). Carried beside `governed` because it is the same kind of
  // fact about the same targets, decided at the same moment.
  let memory = false;
  const raise = (capability) => {
    if (RANK[capability] > RANK[worst]) worst = capability;
  };
  // First one wins; there is only one delegate today and a second would still
  // have to be refused, so which name is reported changes nothing but wording.
  const delegateTo = (name) => {
    if (name && !delegate) delegate = name;
  };
  // A target that touches a governed file marks the whole line (DD-56): the
  // deny it produces is unconditional, so there is nothing softer to prefer.
  const guard = (target) => {
    if (isGovernedTarget(target, cwd, governedPaths)) governed = true;
    if (isMemoryTarget(target)) memory = true;
  };

  const { text: withoutHeredocs, expanding } = extractHeredocs(command ?? "");
  const { substitutions, masked } = scanShell(withoutHeredocs);

  // Bounded recursion so a pathological string cannot spin the gate.
  if (depth < 5) {
    const inner = (body) => {
      const scanned = classifyShell(body, { cwd, depth: depth + 1, governedPaths });
      raise(scanned.capability);
      delegateTo(scanned.delegate);
      if (scanned.governed) governed = true;
      if (scanned.memory) memory = true;
    };
    for (const body of substitutions) inner(body);
    // An unquoted heredoc body expands, so what it expands can run — but its
    // own lines are data on stdin, never a command list.
    for (const body of expanding) {
      for (const sub of scanShell(body).substitutions) inner(sub);
    }
  }

  // `2>&1` duplicates a descriptor; it neither writes anywhere nor separates
  // anything. Removing it before the split stops the `1` being read as a
  // command (observed live: a read-only `buzz users get … 2>&1` scored build).
  const outer = masked.replace(/\d?>&\d?/g, " ");
  for (const segment of outer.split(SEGMENT_SPLIT)) {
    for (const target of redirectTargets(segment)) {
      guard(target);
      if (!insideScratch(target, cwd)) raise("build");
    }
    const head = commandHead(segment);
    if (head === null) continue;
    // Delegated first, and it still scores `build`: a deploy IS a build, and
    // saying otherwise would make the refusal look like a classification
    // accident rather than the decision it is.
    if (DELEGATED_COMMANDS.has(head)) {
      delegateTo(DELEGATED_COMMANDS.get(head));
      raise("build");
      continue;
    }
    // `buzz` is decided by its SUBCOMMAND, not by its name (FIX-114, widened by
    // FIX-122). This branch owns the whole command — `buzz` is deliberately
    // absent from CONVERSE_COMMANDS below, so there is exactly one place that
    // answers for it and no blanket entry that could answer first.
    if (BUZZ_HEADS.has(head)) {
      raise(classifyBuzz(segment));
      continue;
    }
    if (CONVERSE_COMMANDS.has(head)) raise(CONVERSE);
    else if (RESEARCH_COMMANDS.has(head)) raise("research");
    else if (PATH_SCOPED_COMMANDS.has(head)) {
      for (const target of pathArguments(segment)) guard(target);
      raise(pathArguments(segment).every((target) => insideScratch(target, cwd)) ? CONVERSE : "build");
    } else if (BUILD_COMMANDS.has(head)) raise("build");
    // Unrecognised: could do anything, so it takes the most privileged
    // capability rather than the most convenient one. This is what closes the
    // `echo x > file` hole cycle 1 documented as unclosable — on a withheld
    // turn, an unknown command simply does not run. Its arguments are still
    // scanned for governed targets (`tee`, `Set-Content` and the next spelling
    // nobody enumerated must not slip a governed write past a granted turn).
    else {
      for (const target of pathArguments(segment)) guard(target);
      raise("build");
    }
  }

  // A shell call whose command we could not read at all is still a shell call.
  if (worst === CONVERSE && !String(command ?? "").trim()) {
    return { capability: "build", delegate, governed, memory };
  }
  return { capability: worst, delegate, governed, memory };
}

export function classifyCommand(command, options = {}) {
  return classifyShell(command, options).capability;
}

// A stable name for one specific tool call (DD-21, fix cycle 3).
//
// This is what an owner's approval binds to. F-009's leak was that an approval
// carried a capability and nothing else, so any call of that kind could spend
// it; the owner read one target in the prompt and a different one executed.
// With a signature, the approval and the action are the same object.
//
// Normalisation is narrow on purpose. It absorbs the things a model varies
// between the blocked call and its re-run after the re-wake — a trailing slash,
// host casing — and nothing else. Anything that changes WHAT is fetched or WHICH
// tool does the fetching produces a different signature, and is refused.
//
// The signature is REDACTED at construction, not at display. A shell
// signature is the whole command line, which routinely carries an API key in a
// header; the audit log is queryable from chat, so an unredacted signature
// would put that key in the room (caught by an existing test the moment the
// signature reached the log). Redaction is deterministic, so both sides of a
// comparison redact identically and matching is unaffected — and what the owner
// approves is the redacted call they were actually shown.
export function toolSignature({ toolName, toolInput = {} }) {
  const name = String(toolName ?? "");
  const raw = String(
    toolInput?.url ?? toolInput?.query ?? toolInput?.command ?? toolInput?.file_path ?? toolInput?.path ?? "",
  ).trim();

  let target = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      url.hostname = url.hostname.toLowerCase();
      // "https://lobste.rs" and "https://lobste.rs/" are the same page.
      if (url.pathname === "/") url.pathname = "";
      target = url.toString().replace(/\/$/, "");
    }
  } catch {
    target = raw;
  }
  return redact(`${name}|${target}`);
}

export function classifyTool({ toolName, toolInput = {}, cwd = null, governedPaths = [] }) {
  const name = String(toolName ?? "");
  if (!name) return { capability: "build", detail: "(no tool name)" };

  if (SHELL_TOOLS.has(name)) {
    const command = toolInput?.command ?? "";
    const { capability, delegate, governed, memory } = classifyShell(command, { cwd, governedPaths });
    // Did the agent mean to TALK? The first thing it runs says so. Used only to
    // pick the wording of a refusal — never to soften the refusal itself.
    //
    // The SUBCOMMAND has to decide this too (FIX-122). The advice this flag
    // selects says the line "looks like an attempt to speak" and that
    // "conversation is never gated", and invites the agent to send it again in
    // different quoting. Attached to a refused `moderation ban` — which is a
    // `buzz` command like any other — that is an instruction to route around
    // the refusal, in the one message the agent is guaranteed to read.
    const segment = scanShell(extractHeredocs(command).text).masked.split(SEGMENT_SPLIT)[0] ?? "";
    const head = commandHead(segment);
    return {
      capability,
      delegate,
      governed,
      memory,
      detail: `${name}: ${String(command).slice(0, 160)}`,
      speechAttempt: BUZZ_HEADS.has(head) && isBuzzSpeech(segment),
    };
  }
  if (CONVERSE_TOOLS.has(name)) return { capability: CONVERSE, detail: name };
  if (RESEARCH_TOOLS.has(name)) {
    const target = toolInput?.url ?? toolInput?.query ?? "";
    return { capability: "research", detail: `${name} ${String(target).slice(0, 160)}`.trim() };
  }
  if (BUILD_TOOLS.has(name)) {
    const target = toolInput?.file_path ?? toolInput?.path ?? "";
    return {
      capability: "build",
      governed: isGovernedTarget(target, cwd, governedPaths),
      memory: isMemoryTarget(target),
      detail: `${name} ${String(target).slice(0, 160)}`.trim(),
    };
  }
  // Unknown tool — including any MCP tool that appears later. Fail closed.
  return { capability: "build", detail: `${name} (unrecognised tool)` };
}

// Which authority is THIS turn entitled to? (DD-19/DD-20, fix cycle 3.)
//
// The turn gate wrote down, at the start of this turn, which room event caused
// it. That is the key: the node writes one authority per event, so a turn can
// only ever reach the authority issued for its own trigger. Before this, there
// was a single per-agent slot and whichever message the node processed last
// owned it — which is how a non-owner's withhold came to deny the owner's own
// running turn, and how the owner's approval came to release the non-owner's
// fetch (F-009).
//
// Claiming here rather than after the decision is deliberate: the claim is what
// makes the authority worth one turn, and it must happen even on the call that
// ends up denied for some other reason.
function resolveAuthority({ stateDir, agent, promptId, now = Date.now() }) {
  const turn = readTurnRecord({ stateDir, agent, promptId });
  if (turn?.eventId) {
    return {
      eventId: turn.eventId,
      grant: claimAuthority({ stateDir, agent, eventId: turn.eventId, promptId }),
      keyed: true,
    };
  }
  // No turn record: either the turn gate has not run on this runtime, or the
  // prompt carried no event header — which is what a queued or steered message
  // looks like when it is folded into a turn that was already running (FIX-87).
  //
  // Before the per-agent fallback, let this turn claim an authority a human
  // explicitly APPROVED, if one is sitting unclaimed. Without it, an approval
  // posted while the agent was mid-turn released a grant nothing could ever
  // reach: the owner said yes, the grant hit the disk, and the very next Write
  // was refused as withheld. Only approval-released records are eligible, and
  // `coversCapability` still holds them to the one call they named.
  const released = claimReleasedAuthority({ stateDir, agent, promptId, now });
  if (released) return { eventId: released.eventId ?? null, grant: released, keyed: false };

  // Nothing approved is outstanding. Fall back to the per-agent record, which
  // is cycle-2 behaviour — degraded, but not mute.
  return { eventId: null, grant: readGrant({ stateDir, agent }), keyed: false };
}

export function decideTool({ toolName, toolInput, grant, promptId, cwd = null, now = Date.now(), governedPaths = [] }) {
  const {
    capability,
    detail,
    speechAttempt = false,
    delegate = null,
    governed = false,
    memory = false,
  } = classifyTool({
    toolName,
    toolInput,
    cwd,
    governedPaths,
  });

  // Could any member of this room have asked for this call? (AC-52, DD-68.)
  //
  // Decided HERE because this is where the surface is already resolved, and
  // carried on the verdict so the node never has to re-derive it from a detail
  // string. It changes no decision at this layer: a refusal is a refusal. It
  // changes where the refusal is REPORTED, which is the whole of AC-52.
  const selfInitiated = governed || memory;

  // DD-27: a delegated command is refused before any record is consulted,
  // because no record could permit it. This branch can only ever turn an allow
  // into a deny — it never reaches the grant, so it can never widen one.
  if (delegate) {
    return {
      decision: "deny",
      capability,
      detail,
      delegate,
      selfInitiated,
      signature: toolSignature({ toolName, toolInput }),
      reason: `hive402 runs ${delegate} for this room; an agent never runs it itself`,
      // Nothing the node might write next would change this answer, so there is
      // no race to wait out.
      waitable: false,
    };
  }

  // DD-56's counterweight (AC-55, F-6): the files that define or govern this
  // agent are refused the same way — before the grant, so no grant can widen
  // it and no approval can unlock it. See `isGovernedTarget`.
  if (governed) {
    return {
      decision: "deny",
      capability,
      detail,
      governed: true,
      selfInitiated: true,
      signature: toolSignature({ toolName, toolInput }),
      reason: "that file defines or governs this agent, and is never the agent's to edit",
      waitable: false,
    };
  }

  if (capability === CONVERSE) {
    return { decision: "allow", capability, detail, reason: "conversation is always free" };
  }

  const signature = toolSignature({ toolName, toolInput });
  const verdict = coversCapability({ grant, capability, promptId, signature, now });
  if (verdict.ok) {
    return {
      decision: "allow",
      capability,
      detail,
      reason: verdict.reason,
      signature,
      proposalId: verdict.proposalId ?? null,
      // Only an approval-bound grant is spent by a single use; a turn grant is
      // bound to its turn and covers every call that turn makes.
      singleUse: Boolean(grant?.signature),
    };
  }
  return {
    decision: "deny",
    capability,
    detail,
    signature,
    speechAttempt,
    selfInitiated,
    reason: verdict.reason,
    // Wait only when the node may simply not have spoken yet. A FRESH withheld
    // record means it has spoken, so denying immediately costs nothing.
    waitable: !verdict.fresh,
  };
}

// What the agent is told when a call is refused.
//
// FOUND BY RUNNING IT (2026-08-15): the first live re-test contained F-007
// correctly, and then dead-ended. spike implemented "what's on the HN front
// page?" as `curl … | node -e …`; `node` is a build tool, spike has build=false,
// so the refusal was AC-17's permanent kind — no approval token, owner never
// asked. spike had `research=true` the entire time and never reached for
// WebFetch. The requester got a flat no and the owner never learned anyone had
// asked for anything.
//
// The node knows which capabilities the agent actually has. Passing that in
// costs nothing and turns a dead end into the approval AC-14 is about.
function denialAdvice({ capability, enabled, speechAttempt = false, delegate = null, governed = false }) {
  const has = new Set(enabled ?? []);
  const dontRouteAround =
    "Do not retry it and do not route around it. Say in the room, briefly, what you " +
    "were about to do and why you stopped.";

  // The governance deny (DD-56, AC-55). Distinct advice on purpose: the
  // ordinary build refusal says "your owner has been asked", and for this one
  // nobody will be — no approval unlocks it, ever.
  if (governed) {
    return (
      "That file defines or governs you — your instructions, the runtime settings that run " +
      "this gate, or hive402's own state — and it is never yours to edit, on any turn. This " +
      "cannot be approved from chat; your owner edits it directly if it needs to change. " +
      dontRouteAround
    );
  }

  // The third kind of "no" (DD-27). The first two say the agent is contained;
  // this one says the work is somebody else's to do. Saying so matters: an
  // agent told only "refused" reasonably tries another spelling of the same
  // command, and every one of them is refused too.
  if (delegate) {
    return (
      `hive402 runs ${delegate} for this room, on the node's own account and against the project its ` +
      `owner configured, so this is not something an approval can hand to an agent. You do not need ` +
      `to run it: put the files you want published in the "${DEPLOY_DIR}" directory inside your working ` +
      `directory, and hive402 will deploy them and post the live URL and the receipt into the room ` +
      `itself. ${dontRouteAround}`
    );
  }

  // The one refusal that could leave an agent with no way to comply with the
  // instruction in that very sentence: a `buzz messages send` whose own quoting
  // makes the line unrunnable (an apostrophe closing a single-quoted body, say).
  // Telling it to "say what happened" without saying HOW is what silence is
  // made of, so name the two forms that always work.
  if (speechAttempt) {
    return (
      "That looks like an attempt to speak, but the command as written is not a single safe " +
      "invocation — quoting inside it would run or break something. Send the message again with " +
      "the body in a quoted heredoc (`--content - <<'EOF' … EOF`) or in double quotes with no " +
      "substitutions, and it will go through: conversation is never gated."
    );
  }

  if (!has.has(capability)) {
    // AC-17: not something an approval can unlock — the owner switched it off.
    const alternative =
      capability === "build" && has.has("research")
        ? " If you only need to READ something from the web, use the WebFetch tool instead: " +
          "research IS enabled for you, and that request will be put to your owner for approval."
        : "";
    return (
      `The "${capability}" capability is disabled for this agent by its owner, so this cannot be ` +
      `approved from chat.${alternative} ${dontRouteAround}`
    );
  }

  return (
    `This turn holds no approval to ${capability}. hive402 has already asked your owner, ` +
    `in the room, and will re-run your request if they approve. ${dontRouteAround}`
  );
}

function auditLine({ stateDir, agent, verdict, promptId, sessionId, now }) {
  mkdirSync(stateDir, { recursive: true });
  const entry = {
    type: "action",
    via: "toolgate",
    agent,
    actor: "runtime",
    kind: verdict.capability,
    decision: verdict.decision,
    // Which party is expected to do this work instead (DD-27). Recorded on the
    // audit row as well as the blocked record, so `/audit` can show a deploy
    // being handed to the node rather than an unexplained build refusal.
    delegate: verdict.delegate ?? null,
    detail: redact(`${verdict.detail} — ${verdict.decision}: ${verdict.reason}`),
    // The proposal this call answers, and the identity of the call itself.
    // Cycle 3's T-027 caveat: reading F-009 out of the log meant comparing the
    // proposal's named target against the executed one by hand, with nothing
    // recording the correspondence. Now the log states it (DD-21).
    proposalId: verdict.proposalId ?? null,
    signature: verdict.signature ?? null,
    promptId: promptId ?? null,
    sessionId: sessionId ?? null,
    at: now,
  };
  appendFileSync(path.join(stateDir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

function blockedRecord({ stateDir, agent, verdict, promptId, now, proposalId = null }) {
  const dir = path.join(stateDir, "blocked");
  mkdirSync(dir, { recursive: true });
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    agent,
    capability: verdict.capability,
    detail: redact(verdict.detail),
    // Set when the refusal is not "you may not", but "this is the node's job"
    // (DD-27). This field is the node's ONLY trigger for a deploy: without it
    // there is nothing to tell a deploy attempt from any other build refusal.
    delegate: verdict.delegate ?? null,
    // Whether the refused call touched a file that defines or governs this
    // agent (AC-55). Computed at the gate since DD-56 and, until FIX-169, not
    // written down — so the node could not tell one refusal from another.
    governed: verdict.governed ?? false,
    // Could any member of this room have asked for this? (AC-52, DD-68.)
    //
    // The node routes on this: a refusal nobody asked for is audited and never
    // published, because announcing one reads as a fault to every member who
    // asked for nothing and it puts `detail` — the actual call the gate refused
    // — into a shared room. AC-52's "at most, raised with its owner" is what
    // makes the audit row a sufficient answer.
    selfInitiated: verdict.selfInitiated ?? false,
    // The exact call that was refused, so the owner's approval can release
    // this and nothing else (DD-21).
    signature: verdict.signature ?? null,
    // Which approval, if any, this turn was already running under (DD-35).
    //
    // The node needs it to tell "the owner confirmed this build a moment ago
    // and the deploy is part of the same run" from "a fresh turn wants to
    // deploy" — the difference between one confirmation and two. It is written
    // HERE rather than derived by the node because the gate is the only party
    // that knows which record the turn actually held: on a turn the runtime
    // could not attribute (FIX-87) there is no turn record for the node to join
    // through, and that is precisely the case where an approval is in play.
    proposalId,
    promptId: promptId ?? null,
    at: now,
  };
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The gate, end to end. Injectable clock and sleep so tests run instantly.
export async function runGate({
  stateDir,
  agent,
  enabled = [],
  input,
  now = Date.now(),
  waitMs = 2500,
  pollMs = 200,
  sleep = sleepMs,
  governedPaths = [],
}) {
  // The gate's own state dir is governed wherever it lives and whatever it is
  // named — an agent writing its own authority records is self-authorisation.
  const governedAll = [stateDir, ...governedPaths].filter(Boolean);
  const deny = (reason, capability = null, speechAttempt = false, delegate = null, governed = false) => ({
    decision: "deny",
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: capability
          ? `${reason} ${denialAdvice({ capability, enabled, speechAttempt, delegate, governed })}`
          : `${reason} Do not retry it and do not route around it. Say in the room what you were about to do.`,
      },
    },
  });

  if (!input || typeof input !== "object" || !input.tool_name) {
    return deny("hive402: the tool gate could not read this tool call.");
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const promptId = input.prompt_id ?? null;
  const sessionId = input.session_id ?? null;
  // The agent runs in the scratch working directory the node created for it;
  // a redirect that stays inside it is composition, not an action on the world.
  const cwd = input.cwd ?? null;

  let verdict;
  let eventId = null;
  // The approval this turn is running under, if any — recorded on a refusal so
  // the node can tell one run from a fresh one (DD-35).
  let proposalId = null;
  try {
    // A turn's authority is decided once, by its trigger. Waiting is now a
    // single, simple rule: we wait only while there is NO record for this
    // turn's event — because that means the node has not spoken about it yet.
    // As soon as a record exists, grant or withheld, the answer is final.
    const decide = (at) => {
      const resolved = resolveAuthority({ stateDir, agent, promptId, now: at });
      eventId = resolved.eventId;
      proposalId = resolved.grant?.kind === "grant" ? (resolved.grant.proposalId ?? null) : null;
      const decided = decideTool({
        toolName,
        toolInput,
        grant: resolved.grant,
        promptId,
        cwd,
        now: at,
        governedPaths: governedAll,
      });
      // "No record yet" normally means the node may simply not have spoken, so
      // the gate waits. A delegated call is the exception: the node has nothing
      // to say about it, so waiting only delays the refusal — and with it the
      // deploy the node is about to run. A governed file is the other: no
      // record could ever change that answer.
      if (decided.delegate || decided.governed) return { ...decided, waitable: false };
      return { ...decided, waitable: resolved.grant ? decided.waitable === true : true };
    };

    verdict = decide(now);

    // The owner's own message reaches the agent directly, so the node's 2s poll
    // may not have written the authority yet. Re-read briefly rather than
    // denying a turn the owner is entitled to (AC-16).
    if (verdict.decision === "deny" && verdict.waitable && waitMs > 0) {
      const deadline = now + waitMs;
      for (let t = now; t < deadline; t += pollMs) {
        await sleep(pollMs);
        const retry = decide(Date.now());
        if (retry.decision === "allow" || retry.waitable === false) {
          verdict = retry;
          break;
        }
      }
    }
  } catch (err) {
    // Anything we cannot evaluate is refused. A gate that fails open is not one.
    return deny(`hive402: the tool gate could not evaluate this call (${err.message}).`);
  }

  // Conversation short-circuits the whole recording path — but a delegated call
  // must never take that exit, or the record the node reads would not exist.
  if (verdict.capability === CONVERSE && !verdict.delegate) return { decision: "allow", output: null };

  try {
    // The event-keyed path claims when it resolves; only the legacy per-agent
    // record still needs binding here.
    if (verdict.decision === "allow" && !eventId) bindGrant({ stateDir, agent, promptId });
    // An approval is worth one action. Spend it the moment it is used, so a
    // retry of the same approved call is refused rather than silently repeated.
    if (verdict.decision === "allow" && verdict.singleUse && eventId) {
      consumeAuthority({ stateDir, agent, eventId, now });
    }
    auditLine({ stateDir, agent, verdict, promptId, sessionId, now });
    if (verdict.decision === "deny") blockedRecord({ stateDir, agent, verdict, promptId, now, proposalId });
  } catch (err) {
    // Recording failed. An action we cannot record is an action we do not
    // permit (DD-16) — the audit trail is not optional decoration.
    return deny(`hive402: the tool gate could not record this call (${err.message}).`);
  }

  if (verdict.decision === "allow") return { decision: "allow", output: null, verdict };
  return {
    ...deny(
      `hive402: refused — ${verdict.reason}.`,
      verdict.capability,
      verdict.speechAttempt,
      verdict.delegate,
      verdict.governed ?? false,
    ),
    verdict,
  };
}

// --- hook entry point -------------------------------------------------------
//
// Invoked as: node toolgate.mjs --agent <name> --state <stateDir>
// stdin: the runtime's PreToolUse payload. stdout: a permission decision, or
// nothing at all when the call is ordinary conversation.

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isEntryPoint) {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    payload = null;
  }
  const result = await runGate({
    stateDir: argOf("state") ?? process.env.HIVE402_STATE_DIR ?? ".hive402",
    agent: argOf("agent") ?? process.env.HIVE402_AGENT ?? "unknown",
    enabled: (argOf("enabled") ?? "").split(",").filter(Boolean),
    // Per-agent governed files (the instructions file), `;`-separated because
    // Windows paths carry drive colons. The launcher quotes the whole value.
    governedPaths: (argOf("governed") ?? "").split(";").map((p) => p.trim()).filter(Boolean),
    input: payload,
  });
  if (result.output) process.stdout.write(JSON.stringify(result.output));
  process.exit(0);
}
