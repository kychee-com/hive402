// FOUND BY RUNNING IT (2026-08-18): the deploy path had a caller and no
// trigger.
//
// FIX-43/44/45 made the whole route work — the gate refuses run402, the node
// reads the refusal, asks the owner, deploys and posts the URL. Then the first
// live run produced no deploy at all, because spike never reached for run402.
// Asked to "put a todo list live on the web", it wrote a page into a `.scratch`
// folder it invented and said it would "publish it with buzz upload file". It
// had no way to know this room publishes through run402, that the published
// tree is the `site` folder, or that attempting the command IS how publication
// is requested.
//
// That is issue #4's own bug class one level up: a path nothing causes. So the
// node states the workshop's protocol in the agent's workspace, through the
// runtime's own channel for workspace conventions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeWorkshopGuide, WORKSHOP_GUIDE_FILE } from "../src/workshop/guide.mjs";

const workDir = () => mkdtempSync(path.join(tmpdir(), "hive402-guide-"));
const agent = { name: "spike", build: true };
const workshop = { project: "prj_1", subdomain: "shared-todo" };

const guideAt = (dir) => readFileSync(path.join(dir, WORKSHOP_GUIDE_FILE), "utf8");

test("a room with a workshop tells the agent how publishing works here", () => {
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  const guide = guideAt(dir);

  assert.match(guide, /site/, "which folder is published");
  assert.match(guide, /run402 sites deploy-dir/, "how to request publication");
  assert.match(guide, /refused/i, "and that the attempt is the request, not a mistake");
});

test("it says the agent can never run run402 itself, and that no approval changes that", () => {
  // Without this the agent reads "run this command" and then treats the refusal
  // as a failure to work around, which is the one behaviour the gate asks it
  // not to have.
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  const guide = guideAt(dir);
  assert.match(guide, /cannot run run402|never run run402/i);
  assert.match(guide, /no approval|not something an approval/i);
});

test("it tells the agent not to invent a URL, because the node posts the real one", () => {
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  assert.match(guideAt(dir), /not .*(invent|make up|guess)/i);
});

test("a room with no workshop gets no guide at all", () => {
  // Nothing to say, and a file describing a workshop that does not exist would
  // send the agent at a command that can only ever be refused for good.
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop: null });
  assert.equal(existsSync(path.join(dir, WORKSHOP_GUIDE_FILE)), false);
});

test("rewriting it is idempotent, so a restart cannot stack duplicates", () => {
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  const once = guideAt(dir);
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  assert.equal(guideAt(dir), once);
});

test("the guide never contains a secret, a key reference or a state path", () => {
  const dir = workDir();
  writeWorkshopGuide({ workDir: dir, agent, workshop });
  const guide = guideAt(dir);
  assert.ok(!/privateKey|nsec|env:HIVE402|\.hive402/i.test(guide), guide);
});
