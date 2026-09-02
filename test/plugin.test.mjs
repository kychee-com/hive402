import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadCore } from "../src/plugin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("loadCore returns null when no core module is present", async () => {
  const core = await loadCore({ modulePath: "@kychee/hive402-core" });
  assert.equal(core, null);
});

test("loadCore loads a present core module and exposes the plugin api", async () => {
  const fixture = path.join(here, "..", "fixtures", "fake-core.mjs");
  const core = await loadCore({ modulePath: fixture });
  assert.ok(core, "core should load");
  assert.equal(core.api, 1);
  assert.equal(typeof core.relevance, "function");
});
