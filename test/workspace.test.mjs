import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { trustWorkspace } from "../src/launcher/workspace.mjs";

function claudeJson(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), "hive402-trust-"));
  const file = path.join(dir, ".claude.json");
  if (contents !== undefined) writeFileSync(file, JSON.stringify(contents, null, 2));
  return file;
}

const read = (file) => JSON.parse(readFileSync(file, "utf8"));

// The agent's working directory is created fresh by the node, so the model
// runtime has never seen it and gates it behind a trust prompt. A headless
// agent cannot answer a prompt: the turn just dies. Observed live 2026-08-15 as
// `Internal error: [ede_diagnostic] result_type=user` on every turn, with the
// agent silent in the room.
test("a freshly created agent workspace is registered as trusted", () => {
  const file = claudeJson({ projects: {} });
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });
  assert.equal(read(file).projects["C:\\state\\work\\spike"].hasTrustDialogAccepted, true);
});

test("the owner's existing config is preserved, not rewritten", () => {
  // This file holds the owner's entire Claude Code configuration. Clobbering it
  // to add one boolean would be a spectacular own goal.
  const file = claudeJson({
    numStartups: 42,
    oauthAccount: { emailAddress: "owner@example.com" },
    projects: {
      "C:\\existing": { hasTrustDialogAccepted: true, allowedTools: ["Bash(ls:*)"] },
    },
  });
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });

  const after = read(file);
  assert.equal(after.numStartups, 42);
  assert.equal(after.oauthAccount.emailAddress, "owner@example.com");
  assert.deepEqual(after.projects["C:\\existing"].allowedTools, ["Bash(ls:*)"]);
  assert.equal(after.projects["C:\\state\\work\\spike"].hasTrustDialogAccepted, true);
});

test("an existing entry for the same workspace keeps its other fields", () => {
  const file = claudeJson({
    projects: {
      "C:\\state\\work\\spike": {
        hasTrustDialogAccepted: false,
        projectOnboardingSeenCount: 3,
      },
    },
  });
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });

  const entry = read(file).projects["C:\\state\\work\\spike"];
  assert.equal(entry.hasTrustDialogAccepted, true);
  assert.equal(entry.projectOnboardingSeenCount, 3);
});

test("a missing config file is created rather than crashing the launch", () => {
  const file = claudeJson(undefined);
  assert.ok(!existsSync(file));
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });
  assert.equal(read(file).projects["C:\\state\\work\\spike"].hasTrustDialogAccepted, true);
});

test("an unreadable config is left alone and reported, never overwritten", () => {
  // If we cannot parse it we certainly must not replace it — that would delete
  // the owner's configuration to fix our own convenience.
  const file = claudeJson();
  writeFileSync(file, "{ this is not json");
  assert.throws(() => trustWorkspace({ workDir: "C:\\x", claudeJsonPath: file }), /parse|json/i);
  assert.equal(readFileSync(file, "utf8"), "{ this is not json");
});

test("trusting is idempotent", () => {
  const file = claudeJson({ projects: {} });
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });
  trustWorkspace({ workDir: "C:\\state\\work\\spike", claudeJsonPath: file });
  assert.equal(Object.keys(read(file).projects).length, 1);
});
