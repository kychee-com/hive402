// TR-008 / DD-36: the deploy folder is not scratch paper.
//
// Cycle 7 asked a question it could not answer from outside the code: is a
// `kind:"build"` decision for a plain `Write` requester-aware at all, or is
// model judgment the only thing keeping a non-owner from writing the page that
// gets published? The agent itself told the room it was the latter — "the file
// write to site/index.html is not gated at the tool level; I write files
// freely… my judgment is the control point".
//
// It was wrong about its own containment for the TOOL form, and right about the
// SHELL form. Both halves are asserted here, and both are asserted through the
// product rather than over a helper: the node really handles a non-owner's
// message, the record it really wrote to disk is the one the gate really reads,
// and the entry point is `runGate` — the actual `PreToolUse` hook.
//
//   • `Write site/index.html`  → build, and denied on a withheld turn. Always
//     was: `classifyTool` has no in-workspace carve-out for the tool form.
//   • `cat > site/index.html`  → was CONVERSE, because DD-33 makes anything
//     inside the working directory composition, and `site/` is inside it. So a
//     turn holding no authority whatsoever could choose the exact bytes the
//     next approved deploy publishes, unaudited. That is what DD-36 closes.
//
// The half that must NOT change is the speech path: an agent composing a reply
// into a scratch file and sending it is the pattern F-010 nearly cost the
// product, and it is exercised here in the same file for that reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Supervisor } from "../src/node/supervisor.mjs";
import { computeAuthTag } from "../src/identity/nipoa.mjs";
import { readAuthority } from "../src/runtime/grants.mjs";
import { writeTurnRecord } from "../src/runtime/turngate.mjs";
import { classifyTool, runGate } from "../src/runtime/toolgate.mjs";
import { DEPLOY_DIR, deployDirIn } from "../src/workshop/site.mjs";

const OWNER_SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const AGENT = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const CHANNEL = "b86d8eda-5f05-496c-af45-ef4442ad5876";

const authTag = computeAuthTag({ ownerPrivateKey: OWNER_SK, agentPubkey: AGENT });

const config = () => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
  turnCap: { limit: 20, windowMs: 3600000 },
  tools: { buzzDir: "C:/Buzz", nodeDir: "C:/node", adapter: "C:/adapter.js", extraDirs: [] },
  rooms: [
    {
      channel: CHANNEL,
      workshop: { project: "prj_dresstest_0001", subdomain: null },
      agents: [
        {
          name: "spike",
          pubkey: AGENT,
          ownerPubkey: OWNER,
          privateKeyRef: "env:TEST_AGENT_KEY",
          research: true,
          build: true, // build is ON: the only thing containing a stranger is the turn record
          crossOwnerAsks: "owner-approves",
          selfInitiated: "asks-owner",
          replyMode: "addressed-only",
        },
      ],
    },
  ],
});

function harness() {
  const events = [];
  const sent = [];
  const cli = {
    deliver: (e) => events.push(e),
    async getMessages() {
      return events;
    },
    async send(args) {
      const event_id = `sent-${sent.length + 1}`.padEnd(64, "0");
      sent.push({ ...args, event_id });
      return { accepted: true, event_id };
    },
    async setProfile() {
      return { accepted: true };
    },
    async getUser({ pubkey }) {
      return pubkey === AGENT ? { pubkey: AGENT, display_name: "spike" } : null;
    },
  };
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-deployfolder-"));
  const sup = new Supervisor({
    config: config(),
    stateDir,
    spawn: () => ({ pid: 4242, killed: false, kill() {} }),
    makeCli: () => cli,
    readAttestation: () => authTag,
    resolveKey: () => "aa".repeat(32),
    trustWorkspace: () => {},
    log: () => {},
    run402: { async deploy() { return { ok: true, url: "https://x.run402.com", receipt: "dpl_1" }; } },
  });
  return { sup, cli, sent, stateDir, workDir: path.join(stateDir, "work", "spike") };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "", tags: [], ...over });
const nowait = { waitMs: 0, sleep: async () => {} };

// Drive a real non-owner message through the node, and hand back the turn the
// gate will actually see. This is the part cycle 7 could not do from outside.
async function contained(promptId = "p-tal") {
  const h = harness();
  await h.sup.start();
  h.cli.deliver(msg({ id: "e-tal", pubkey: TAL, content: "@spike put a page up for me" }));
  await h.sup.tick();

  const wake = h.sent.find((s) => s.content.includes("put a page up"));
  assert.ok(wake, "the node relays a non-owner's message as a wake");
  const authority = readAuthority({ stateDir: h.stateDir, agent: "spike", eventId: wake.event_id });
  assert.equal(authority.kind, "withheld", "a stranger's turn carries an explicit withhold");
  writeTurnRecord({ stateDir: h.stateDir, agent: "spike", promptId, eventId: wake.event_id, now: Date.now() });
  return h;
}

const blockedCount = (stateDir) =>
  readdirSync(path.join(stateDir, "blocked")).filter((n) => n.endsWith(".json")).length;

// ── The half cycle 7 doubted: the Write tool ──────────────────────────────

test("TR-008: a non-owner's `Write` into the deploy folder is denied by the GATE, not by the model", async () => {
  const h = await contained();
  const result = await runGate({
    stateDir: h.stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Write",
      tool_input: { file_path: path.join(deployDirIn(h.workDir), "index.html"), content: "<h1>tal was here</h1>" },
      prompt_id: "p-tal",
      cwd: h.workDir,
    },
    ...nowait,
  });
  assert.equal(result.decision, "deny", "model judgment is not what stops this");
  assert.equal(result.verdict.capability, "build");
  assert.match(result.verdict.reason, /withheld/i, "and the reason is the node's record for THIS turn");
  assert.equal(blockedCount(h.stateDir), 1, "and the node is told, so the owner can be asked");
});

test("TR-008: `Write` is build wherever it points — there is no in-workspace carve-out for the tool form", () => {
  for (const target of ["site/index.html", "notes.md", "C:/Users/volin/note.md", "./draft.txt"]) {
    assert.equal(
      classifyTool({ toolName: "Write", toolInput: { file_path: target }, cwd: "C:/work/spike" }).capability,
      "build",
      `Write ${target}`,
    );
  }
});

// ── The half that was really open: the shell form ─────────────────────────

test("TR-008/DD-36: a non-owner's SHELL write into the deploy folder is denied too", async () => {
  // Before DD-36 every one of these scored `converse` and ran on a turn holding
  // an explicit withhold — no grant, no audit row, and the bytes they wrote are
  // exactly what the next approved deploy publishes.
  const writes = [
    `echo "<h1>tal was here</h1>" > site/index.html`,
    `cat > ./site/index.html <<'EOF'\n<h1>tal</h1>\nEOF`,
    `printf 'x' >> site/index.html`,
    `cp notes.md site/index.html`,
    `mv draft.html site/index.html`,
    `rm site/index.html`,
    `mkdir site/assets`,
    `echo x > ${"C:/work/spike/site/index.html"}`,
  ];
  for (const [i, command] of writes.entries()) {
    const h = await contained(`p-${i}`);
    const result = await runGate({
      stateDir: h.stateDir,
      agent: "spike",
      enabled: ["research", "build"],
      input: { tool_name: "Bash", tool_input: { command }, prompt_id: `p-${i}`, cwd: "C:/work/spike" },
      ...nowait,
    });
    assert.equal(result.decision, "deny", `must be refused: ${command}`);
    assert.equal(result.verdict.capability, "build", `must be a build: ${command}`);
  }
});

test("DD-36 after DD-56: the deploy folder is still a BUILD — and the owner's turn now carries build, so their write runs", async () => {
  // DD-36's claim was always about CLASSIFICATION: touching what gets
  // published is an action, not composition — and the non-owner tests above
  // prove the deny on a turn without build. What changed in spec 0.7.0 is the
  // owner's side: their turn carries build (AC-16), so the write into the
  // deploy folder runs on their word, and the PUBLISH still confirms once
  // through the deploy's own proposal (`#delegateDeploy`).
  const h = harness();
  await h.sup.start();
  h.cli.deliver(msg({ id: "e-owner", pubkey: OWNER, content: "@spike put a page up", tags: [["p", AGENT]] }));
  await h.sup.tick();
  const authority = readAuthority({ stateDir: h.stateDir, agent: "spike", eventId: "e-owner" });
  assert.deepEqual(
    authority.capabilities,
    ["research", "build"],
    "DD-56: the owner's own turn carries everything the owner enabled",
  );

  writeTurnRecord({ stateDir: h.stateDir, agent: "spike", promptId: "p-own", eventId: "e-owner", now: Date.now() });
  const result = await runGate({
    stateDir: h.stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Bash",
      tool_input: { command: `echo hi > site/index.html` },
      prompt_id: "p-own",
      cwd: "C:/work/spike",
    },
    ...nowait,
  });
  assert.equal(result.decision, "allow", "the owner asked; the write half of the run is theirs to have");
});

// ── DD-33 is untouched everywhere else, and the voice must not go mute ────

test("DD-33 still holds: the rest of the workspace is scratch paper", async () => {
  const h = await contained("p-scratch");
  for (const command of [
    `printf 'a reply' > msg.txt`,
    `cat > notes.md <<'EOF'\ndraft\nEOF`,
    `mkdir drafts`,
    `rm notes.md`,
    `echo x > ./sub/dir/file.txt`,
  ]) {
    const result = await runGate({
      stateDir: h.stateDir,
      agent: "spike",
      enabled: ["research", "build"],
      input: { tool_name: "Bash", tool_input: { command }, prompt_id: "p-scratch", cwd: "C:/work/spike" },
      ...nowait,
    });
    assert.equal(result.decision, "allow", `in-workspace scratch must stay free: ${command}`);
  }
});

test("the speech path is untouched: compose into a scratch file, then send", async () => {
  // F-010's failure mode. A contained agent that cannot say why it stopped is
  // worse than one that is refused, because the room cannot tell it from broken.
  const h = await contained("p-speak");
  const result = await runGate({
    stateDir: h.stateDir,
    agent: "spike",
    enabled: ["research", "build"],
    input: {
      tool_name: "Bash",
      tool_input: {
        command: `printf 'I was asked to publish and stopped' > msg.txt && buzz messages send --channel ${CHANNEL} --content "$(cat msg.txt)"`,
      },
      prompt_id: "p-speak",
      cwd: "C:/work/spike",
    },
    ...nowait,
  });
  assert.equal(result.decision, "allow", "an agent must always be able to speak");
});

test("a name that merely STARTS with the folder name is not the deploy folder", async () => {
  const h = await contained("p-prefix");
  for (const command of [`echo x > sitemap.xml`, `echo x > site-notes.md`]) {
    const result = await runGate({
      stateDir: h.stateDir,
      agent: "spike",
      enabled: ["research", "build"],
      input: { tool_name: "Bash", tool_input: { command }, prompt_id: "p-prefix", cwd: "C:/work/spike" },
      ...nowait,
    });
    assert.equal(result.decision, "allow", `prefix match must not over-refuse: ${command}`);
  }
});

// ── One name, two readers ─────────────────────────────────────────────────

test("the gate and the node agree on which folder is published, by construction", () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs") && full !== path.join(src, "workshop", "site.mjs")) {
        const text = readFileSync(full, "utf8")
          .replace(/\/\/.*$/gm, "") // prose about the folder is not a second source of truth
          .replace(/["'][^"'\n]*\bsite\.mjs["']/g, ""); // the import of the one source
        // A second literal "site" — as a path segment, a quoted name, or a
        // sentence telling the agent where to put its files — is a second
        // source of truth. A gate guarding a folder the node does not publish
        // guards nothing, and a guide naming a folder the gate does not know
        // sends the agent somewhere it will be refused. Nothing in the suite
        // would notice either.
        if (/["'`\s]site[["'`\s/]|\/site\b/.test(text)) offenders.push(path.relative(src, full));
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], `the deploy folder name is duplicated in: ${offenders.join(", ")}`);
  assert.equal(DEPLOY_DIR, "site");
});
