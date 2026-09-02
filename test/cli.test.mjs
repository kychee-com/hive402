import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bin", "cli.mjs");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("hive402 --version prints the package version and exits 0", () => {
  const r = spawnSync(process.execPath, [bin, "--version"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `exit code (stderr: ${r.stderr})`);
  assert.equal(r.stdout.trim(), pkg.version);
});
