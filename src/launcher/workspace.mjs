// Workspace trust for the agent's working directory.
//
// hive402 launches each agent in its own working directory so the agent's
// capability settings are project-scoped (see capabilities.mjs). That directory
// is created by the node, which means the model runtime has never seen it and
// gates it behind a "do you trust the files in this folder?" prompt.
//
// A headless agent cannot answer a prompt. Observed live on 2026-08-15: every
// turn died with `Internal error: [ede_diagnostic] result_type=user` and the
// agent sat silent in the room while the harness retried with backoff. So the
// node registers the directory it just created — a directory whose only
// contents are the settings file the node itself wrote, on the owner's own
// machine.
//
// The file being edited is the owner's ENTIRE Claude Code configuration, so
// this merges one key and never rewrites the document. Same lesson as DD-5:
// with a shared record you own your field and nothing else.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function defaultClaudeJsonPath() {
  return path.join(homedir(), ".claude.json");
}

export function trustWorkspace({ workDir, claudeJsonPath = defaultClaudeJsonPath() }) {
  let config = {};
  if (existsSync(claudeJsonPath)) {
    const text = readFileSync(claudeJsonPath, "utf8");
    try {
      config = JSON.parse(text);
    } catch (err) {
      // Do NOT replace a file we cannot read. Losing the owner's configuration
      // to save a launch would be a far worse outcome than a failed launch.
      throw new Error(
        `${claudeJsonPath}: could not parse the runtime config (${err.message}). ` +
          `Leaving it untouched — fix or move the file and start the node again.`,
      );
    }
  } else {
    mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
  }

  config.projects ??= {};
  config.projects[workDir] = {
    ...(config.projects[workDir] ?? {}),
    hasTrustDialogAccepted: true,
  };

  writeFileSync(claudeJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { workDir, claudeJsonPath };
}
