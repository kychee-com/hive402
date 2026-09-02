import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyTool, decideTool, runGate } from "../src/runtime/toolgate.mjs";
import { readGrant, writeGrant, writeWithheld } from "../src/runtime/grants.mjs";

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-gate-"));
const now = 1_700_000_000_000;
const nowait = { sleep: async () => {}, waitMs: 0 };

const capabilityOf = (toolName, toolInput = {}) => classifyTool({ toolName, toolInput }).capability;

// ── Classification is over TOOLS, never over prose ─────────────────────────
//
// This is the whole point of DD-15. F-007 evaded a verb lexicon with one
// ordinary rephrasing, because "is this an action request?" was being decided
// from a human sentence — an open set nobody can enumerate. The set of TOOLS is
// closed, and the tool is what actually performs the action.

test("the web tools are research, whatever the request that led to them said", () => {
  assert.equal(capabilityOf("WebFetch", { url: "https://news.ycombinator.com" }), "research");
  assert.equal(capabilityOf("WebSearch", { query: "top story" }), "research");
});

test("the tools that change things are build", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(capabilityOf(tool), "build", `${tool} should be build`);
  }
});

test("reading and looking around is conversation", () => {
  for (const tool of ["Read", "Glob", "Grep", "TodoWrite"]) {
    assert.equal(capabilityOf(tool), "converse", `${tool} should be converse`);
  }
});

test("an unrecognised tool needs the strongest capability, never a free pass", () => {
  // Fail closed on the open end of the set. A tool we have never heard of could
  // do anything, so it is treated as build — the most privileged capability —
  // rather than waved through as conversation.
  assert.equal(capabilityOf("SomeFutureTool"), "build");
  assert.equal(capabilityOf("mcp__whatever__do_thing"), "build");
});

// ── Shell commands ─────────────────────────────────────────────────────────

test("the agent's own voice is conversation — it replies by RUNNING the buzz CLI", () => {
  // REGRESSION GUARD: Buzz discards an agent's plain text, so an agent speaks by
  // running `buzz messages send`. If the gate ever classifies that as an action,
  // a withheld turn produces an agent that wakes and never speaks — the exact
  // failure the launcher's ALWAYS_ALLOW exists to prevent.
  assert.equal(capabilityOf("Bash", { command: 'buzz messages send --channel x --content "hi"' }), "converse");
  assert.equal(capabilityOf("Bash", { command: "buzz.exe messages get --channel x" }), "converse");
});

test("shelling out to a web client is research, not a shell escape", () => {
  for (const command of ["curl https://example.com", "wget -qO- https://example.com", "iwr https://example.com"]) {
    assert.equal(capabilityOf("Bash", { command }), "research", command);
  }
});

test("shelling out to a build tool is build", () => {
  for (const command of ["git push origin main", "npm install", "node build.mjs", "docker run x"]) {
    assert.equal(capabilityOf("Bash", { command }), "build", command);
  }
});

test("an unrecognised shell command needs a grant — this is what closes the echo-to-a-file hole", () => {
  // Cycle 1 stated honestly that a denylist over a general shell cannot be
  // airtight, because `echo x > file` writes a file whatever the list says. On a
  // WITHHELD turn that is no longer true: an unknown command head is treated as
  // build and refused outright.
  assert.equal(capabilityOf("Bash", { command: "somethingnobodyhasheardof --do-it" }), "build");
  assert.equal(capabilityOf("Bash", { command: "echo x > /tmp/written" }), "build");
});

test("a compound command is classified by its most privileged segment", () => {
  assert.equal(capabilityOf("Bash", { command: "buzz messages get --channel x && curl https://x" }), "research");
  assert.equal(capabilityOf("Bash", { command: "curl https://x | git apply -" }), "build");
  assert.equal(capabilityOf("Bash", { command: "buzz messages get --channel x; buzz messages send --content hi" }), "converse");
});

test("classification ignores paths and env prefixes on the command head", () => {
  assert.equal(capabilityOf("Bash", { command: "/usr/bin/curl https://x" }), "research");
  assert.equal(capabilityOf("Bash", { command: "FOO=bar curl https://x" }), "research");
  assert.equal(capabilityOf("Bash", { command: '"C:\\Users\\volin\\AppData\\Local\\Buzz\\buzz.exe" messages send' }), "converse");
});

// ── The decision ───────────────────────────────────────────────────────────

test("conversation runs with no grant at all — AC-12 stays true", () => {
  const verdict = decideTool({ toolName: "Read", toolInput: { file_path: "x" }, grant: null, promptId: "p1", now });
  assert.equal(verdict.decision, "allow");
});

test("an action with no grant is denied — this is F-007's fetch", () => {
  const verdict = decideTool({
    toolName: "WebFetch",
    toolInput: { url: "https://news.ycombinator.com" },
    grant: null,
    promptId: "p1",
    now,
  });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.capability, "research");
});

test("an action with a matching grant runs", () => {
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now, expiresAt: now + 1000, boundPromptId: null };
  assert.equal(decideTool({ toolName: "WebFetch", toolInput: {}, grant, promptId: "p1", now }).decision, "allow");
});

test("a research grant does not unlock build", () => {
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now, expiresAt: now + 1000, boundPromptId: null };
  assert.equal(decideTool({ toolName: "Write", toolInput: {}, grant, promptId: "p1", now }).decision, "deny");
});

test("a fresh withheld record denies immediately, without waiting", () => {
  const grant = { kind: "withheld", capabilities: [], issuedAt: now, expiresAt: now + 60_000 };
  const verdict = decideTool({ toolName: "WebFetch", toolInput: {}, grant, promptId: "p1", now });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.waitable, false);
});

test("no record at all is waitable — the node's poll may simply not have landed yet", () => {
  // AC-16: the owner's message reaches the agent DIRECTLY, so the node may still
  // be inside its 2s poll when the turn starts. Waiting briefly for the node to
  // speak is what keeps the owner's "no separate approval step" promise without
  // opening a hole: a non-owner's turn always has a fresh withheld record, so it
  // never waits and never passes.
  const verdict = decideTool({ toolName: "WebFetch", toolInput: {}, grant: null, promptId: "p1", now });
  assert.equal(verdict.decision, "deny");
  assert.equal(verdict.waitable, true);
});

// ── End to end through the file system ─────────────────────────────────────

test("a denied action writes an audit entry and a blocked record", async () => {
  const dir = state();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "non-owner turn", now });
  const result = await runGate({
    stateDir: dir,
    agent: "spike",
    input: { tool_name: "WebFetch", tool_input: { url: "https://news.ycombinator.com/" }, prompt_id: "p1", session_id: "s1" },
    now,
    ...nowait,
  });

  assert.equal(result.decision, "deny");
  assert.match(result.output.hookSpecificOutput.permissionDecision, /deny/);

  const audit = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].via, "toolgate");
  assert.equal(audit[0].decision, "deny");
  assert.equal(audit[0].kind, "research");
  assert.match(audit[0].detail, /WebFetch/);

  const blocked = readdirSync(path.join(dir, "blocked"));
  assert.equal(blocked.length, 1);
  const record = JSON.parse(readFileSync(path.join(dir, "blocked", blocked[0]), "utf8"));
  assert.equal(record.agent, "spike");
  assert.equal(record.capability, "research");
});

test("an ALLOWED action is audited too — the log records what happened, not what was caught", () => {
  // DD-16. F-007 escaped the gate and the audit log in one stroke because the
  // only audit call sat inside the classifier's branch. Logging at the tool
  // boundary means detection and recording no longer share a failure.
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], reason: "owner request", now });
  return runGate({
    stateDir: dir,
    agent: "spike",
    input: { tool_name: "WebFetch", tool_input: { url: "https://example.com/x" }, prompt_id: "p1" },
    now,
    ...nowait,
  }).then(() => {
    const audit = readFileSync(path.join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(audit[0].decision, "allow");
    assert.equal(existsSync(path.join(dir, "blocked")), false);
  });
});

test("conversation is not audited — the log stays about actions", async () => {
  const dir = state();
  writeWithheld({ stateDir: dir, agent: "spike", now });
  const result = await runGate({
    stateDir: dir,
    agent: "spike",
    input: { tool_name: "Bash", tool_input: { command: "buzz messages send --content hi" }, prompt_id: "p1" },
    now,
    ...nowait,
  });
  assert.equal(result.decision, "allow");
  assert.equal(existsSync(path.join(dir, "audit.jsonl")), false);
});

test("the first allowed action binds the grant to its turn; a later turn is refused", async () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], now });

  const first = await runGate({
    stateDir: dir, agent: "spike", now, ...nowait,
    input: { tool_name: "WebFetch", tool_input: { url: "https://a" }, prompt_id: "turn-A" },
  });
  assert.equal(first.decision, "allow");
  assert.equal(readGrant({ stateDir: dir, agent: "spike" }).boundPromptId, "turn-A");

  const sameTurn = await runGate({
    stateDir: dir, agent: "spike", now, ...nowait,
    input: { tool_name: "WebFetch", tool_input: { url: "https://b" }, prompt_id: "turn-A" },
  });
  assert.equal(sameTurn.decision, "allow", "several fetches in one turn must work");

  const nextTurn = await runGate({
    stateDir: dir, agent: "spike", now, ...nowait,
    input: { tool_name: "WebFetch", tool_input: { url: "https://c" }, prompt_id: "turn-B" },
  });
  assert.equal(nextTurn.decision, "deny", "a grant is worth exactly one turn");
});

test("a secret in a tool input never reaches the audit log", async () => {
  const dir = state();
  writeWithheld({ stateDir: dir, agent: "spike", now });
  await runGate({
    stateDir: dir, agent: "spike", now, ...nowait,
    input: { tool_name: "Bash", tool_input: { command: `curl -H "key: sk-abcdefghijklmno"` }, prompt_id: "p1" },
  });
  const audit = readFileSync(path.join(dir, "audit.jsonl"), "utf8");
  assert.ok(!audit.includes("sk-abcdefghijklmno"), "the audit log is queryable from chat — it must not carry secrets");
  assert.match(audit, /redacted/);
});

test("the gate fails closed when its own state directory is unreadable", async () => {
  const result = await runGate({
    stateDir: path.join(state(), "does", "not", "exist"),
    agent: "spike",
    input: { tool_name: "WebFetch", tool_input: { url: "https://x" }, prompt_id: "p1" },
    now,
    ...nowait,
  });
  assert.equal(result.decision, "deny");
});

test("a malformed hook payload is denied rather than treated as conversation", async () => {
  const dir = state();
  const result = await runGate({ stateDir: dir, agent: "spike", input: null, now, ...nowait });
  assert.equal(result.decision, "deny");
});

// ── Defects found by RUNNING it (2026-08-15, cycle-2 live re-test) ─────────
//
// The first live attack contained F-007 correctly — no fetch happened — but it
// exposed three things no unit test had asked about, because no unit test had
// watched a real model try to do real work.

test("a research call hidden in a command substitution is not conversation", () => {
  // THE SERIOUS ONE. `echo "$(curl -s https://x)"` classified as converse,
  // because only the OUTER command head was ever looked at. That is a complete
  // bypass of the containment, reachable by an agent that simply wrote idiomatic
  // shell — which is exactly what F-007 was about the first time.
  assert.equal(capabilityOf("Bash", { command: 'echo "$(curl -s https://example.com)"' }), "research");
  assert.equal(capabilityOf("Bash", { command: "RESULT=`curl -s https://example.com`" }), "research");
  assert.equal(capabilityOf("Bash", { command: 'buzz messages send --content "$(curl -s https://x)"' }), "research");
});

test("a substitution is classified by what is INSIDE it, at any depth", () => {
  assert.equal(capabilityOf("Bash", { command: 'echo "$(echo "$(git push)")"' }), "build");
  assert.equal(capabilityOf("Bash", { command: 'echo "$(buzz messages get --channel x)"' }), "converse");
});

test("an assignment from a substitution is classified by the substitution", () => {
  // spike's real attempt began `TOP=$(curl -s https://hacker-news…)`. The
  // env-prefix stripper swallowed `$(curl` and left `-s` as the command head,
  // so an unmistakable research call was scored as an unknown one.
  assert.equal(capabilityOf("Bash", { command: "TOP=$(curl -s https://hacker-news.firebaseio.com/v0/topstories.json)" }), "research");
});

test("the agent can still compose a long reply through a scratch file", () => {
  // REGRESSION (live): an agent writing a multi-line reply does
  // `printf … > msg.txt && buzz messages send --content "$(cat msg.txt)"`.
  // Scoring that as build makes the agent MUTE on every contained turn, which
  // is the one failure mode the whole launcher is built to avoid — and it means
  // the room never even learns that something was refused.
  const cwd = "C:/state/work/spike";
  const classify = (command) => classifyTool({ toolName: "Bash", toolInput: { command }, cwd }).capability;
  assert.equal(classify(`printf '%s' "a long reply" > ${cwd}/msg.txt`), "converse");
  assert.equal(classify(`printf '%s' "hi" > msg.txt && buzz messages send --content "$(cat msg.txt)"`), "converse");
  assert.equal(classify(`printf '%s' "hi" > ${process.env.TEMP ?? "/tmp"}/msg.txt`), "converse");
});

test("a write OUTSIDE the agent's own scratch directory is still a build", () => {
  const cwd = "C:/state/work/spike";
  const classify = (command) => classifyTool({ toolName: "Bash", toolInput: { command }, cwd }).capability;
  assert.equal(classify('echo x > C:/Workspace-Kychee/somerepo/file.txt'), "build");
  assert.equal(classify('echo x > ../../../etc/hosts'), "build");
  assert.equal(classify('echo x > ~/.bashrc'), "build");
});

test("with no cwd known, every redirection is a build — unknown location, unknown blast radius", () => {
  assert.equal(capabilityOf("Bash", { command: "printf '%s' hi > msg.txt" }), "build");
});
