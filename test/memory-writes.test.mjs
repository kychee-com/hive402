// An agent keeps no private memory (AC-54, DD-46, FIX-114).
//
// ── DD-46's premise was wrong, and that is the finding ──────────────────────
//
// The design note says this task "pins existing behaviour" — that memory writes
// already classify as `build` and the tests only make it guaranteed. Measured
// against the classifier, they did not. Two of the three ways an agent can
// persist something scored as CONVERSE, which is the capability that needs no
// grant at all, so a stranger's question was enough:
//
//     buzz mem set core "…"          -> converse   (`buzz` is blanket-converse)
//     echo "…" > CLAUDE.md           -> converse   (inside the scratch dir)
//     Write CLAUDE.md                -> build      (the one that was right)
//
// ── And sweeping the class found something worse ───────────────────────────
//
// The same `insideScratch` rule that made `> CLAUDE.md` free also made this
// free, on a turn holding no authority whatsoever:
//
//     echo x > .claude/settings.json     rewrite the tool gate's own config
//     rm .claude/settings.json           delete it
//
// That file is where `writeAgentRuntimeConfig` declares the PreToolUse and
// UserPromptSubmit hooks — it is what makes the gate run. Mitigations are real
// but partial: the live process has already loaded its settings, and every
// launch rewrites the file unconditionally, so a respawn repairs it. Whether
// the runtime re-reads settings mid-session was NOT verified here.
//
// The rule that fixes both is one already in the codebase. DD-36 established
// that the deploy folder sits inside the working directory and is not scratch
// paper, because what goes in it is published. The same sentence is true of a
// file that GOVERNS the agent: it lives in the scratch directory and is not
// scratch paper either.
//
// The error direction matters and is deliberately not symmetric. F-010 is the
// standing reminder that over-classifying makes the agent mute, which is worse
// than refusing it — so the list is a small, enumerable set of names, and
// ordinary scratch work is asserted to stay free.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyShell, classifyTool, decideTool } from "../src/runtime/toolgate.mjs";

const cwd = "C:/hive402/work/spike";
const now = 1_700_000_000_000;
const capability = (command) => classifyShell(command, { cwd }).capability;

// ── buzz mem: the writes are build, the reads are not ──────────────────────
//
// The six subcommands are exactly `MemCmd` in crates/buzz-cli/src/lib.rs
// (buzz @ a2d8be5ef): ls, get, hash, set, patch, rm.

test("buzz mem set is a build action", () => {
  assert.equal(capability('buzz mem set core "barry likes trains"'), "build");
});

test("buzz mem patch is a build action", () => {
  assert.equal(capability("buzz mem patch core --base-hash abc123"), "build");
});

test("buzz mem rm is a build action", () => {
  assert.equal(capability("buzz mem rm core"), "build");
});

test("reading memory is not writing it", () => {
  // AC-54 forbids KEEPING a private store. Reading one is not how it is kept,
  // and refusing a read buys nothing while adding a way to be wrong.
  for (const read of ["buzz mem ls", "buzz mem get core", "buzz mem hash core"]) {
    assert.equal(capability(read), "converse", read);
  }
});

test("the agent can still TALK — that is the F-010 line and it stays", () => {
  // An agent replies by RUNNING `buzz messages send`. Classifying the whole of
  // `buzz` as build would not contain it, it would silence it, and a mute agent
  // is indistinguishable from a broken one.
  for (const speech of [
    "buzz messages send --channel c --content hi",
    "buzz messages get --channel c",
    "buzz users get --pubkey aa",
    "buzz channels members --channel c",
  ]) {
    assert.equal(capability(speech), "converse", speech);
  }
});

test("a memory write is recognised however the binary is spelled", () => {
  for (const spelled of [
    "buzz.exe mem set core x",
    "C:\\Buzz\\buzz.exe mem set core x",
    "/usr/local/bin/buzz mem set core x",
  ]) {
    assert.equal(capability(spelled), "build", spelled);
  }
});

test("a memory write inside a substitution is still a memory write", () => {
  assert.equal(capability('echo "$(buzz mem set core x)"'), "build");
});

test("a memory write in a later pipeline segment counts", () => {
  assert.equal(capability("buzz mem get core | buzz mem set backup -"), "build");
});

test("an env prefix does not hide it", () => {
  assert.equal(capability("BUZZ_RELAY_URL=http://x buzz mem set core x"), "build");
});

// ── Files that govern the agent are not scratch paper ──────────────────────

test("harness memory files are a build even inside the scratch directory", () => {
  for (const file of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "MEMORY.md"]) {
    assert.equal(capability(`echo remember > ${file}`), "build", file);
    assert.equal(capability(`echo remember >> ./${file}`), "build", `./${file}`);
  }
});

test("the runtime's own settings directory is not writable by the agent", () => {
  // This is the serious one: .claude/settings.json is where the PreToolUse and
  // UserPromptSubmit hooks are declared. It is the file that makes the gate run.
  for (const command of [
    "echo x > .claude/settings.json",
    "echo x > ./.claude/settings.json",
    "echo x > .claude/settings.local.json",
    "echo x > .claude/anything.json",
  ]) {
    assert.equal(capability(command), "build", command);
  }
});

test("moving, copying or deleting a governed file is a build too", () => {
  // The path-scoped commands read insideScratch as well, so they get the same
  // answer for free — but only if the rule lives there rather than in the
  // redirect handling alone.
  for (const command of [
    "cp evil.json .claude/settings.json",
    "mv evil.json .claude/settings.json",
    "rm .claude/settings.json",
    "rm CLAUDE.md",
  ]) {
    assert.equal(capability(command), "build", command);
  }
});

test("an absolute path to a governed file is judged the same way", () => {
  assert.equal(capability(`echo x > ${cwd}/.claude/settings.json`), "build");
  assert.equal(capability(`echo x > ${cwd}/CLAUDE.md`), "build");
});

test("ORDINARY scratch work stays free — this is the half that must not break", () => {
  for (const command of [
    "echo draft > notes.txt",
    "printf hello > reply.md",
    "mkdir scratch",
    "cp a.txt b.txt",
    "mv a.txt b.txt",
    "rm notes.txt",
    "echo x > deep/nested/file.txt",
  ]) {
    assert.equal(capability(command), "converse", command);
  }
});

test("a file merely NAMED like memory elsewhere in a sentence is not a write", () => {
  // Classification is over structure, never prose. Saying the words is free.
  assert.equal(capability('buzz messages send --channel c --content "should I write CLAUDE.md?"'), "converse");
});

// ── The tool form was already right; keep it that way ──────────────────────

test("Write and Edit at a memory file are build", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(
      classifyTool({ toolName: tool, toolInput: { file_path: `${cwd}/CLAUDE.md` }, cwd }).capability,
      "build",
      tool,
    );
  }
});

// ── Refused when build is off, through the real gate ───────────────────────

test("REAL GATE: a memory write on a turn with no grant is refused", () => {
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: 'buzz mem set core "barry likes trains"' },
    grant: null,
    promptId: "p1",
    cwd,
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.capability, "build");
});

test("REAL GATE: a research grant does not unlock a memory write", () => {
  const grant = {
    kind: "grant",
    capabilities: ["research"],
    issuedAt: now,
    expiresAt: now + 60_000,
    boundPromptId: null,
  };
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: "buzz mem set core x" },
    grant,
    promptId: "p1",
    cwd,
    now,
  });
  assert.equal(verdict.decision, "deny");
});

test("REAL GATE: rewriting the gate's own settings is refused on a free turn", () => {
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: "echo {} > .claude/settings.json" },
    grant: null,
    promptId: "p1",
    cwd,
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.capability, "build");
});

test("REAL GATE: a build grant does allow it, which is DD-46's stated trade-off", () => {
  // "An agent with build on could still write memory after an approval names
  // it — acceptable: the owner approved that exact call, and the audit log
  // records it." Pinned so the trade-off stays a decision rather than a
  // surprise.
  const grant = {
    kind: "grant",
    capabilities: ["build"],
    issuedAt: now,
    expiresAt: now + 60_000,
    boundPromptId: null,
  };
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: "buzz mem set core x" },
    grant,
    promptId: "p1",
    cwd,
    now,
  });
  assert.equal(verdict.decision, "allow");
});

test("REAL GATE: the agent can still speak on a turn holding nothing", () => {
  const verdict = decideTool({
    toolName: "Bash",
    toolInput: { command: 'buzz messages send --channel c --content "hello"' },
    grant: null,
    promptId: "p1",
    cwd,
    now,
  });
  assert.equal(verdict.decision, "allow", "conversation is always free, and that is load-bearing");
});
