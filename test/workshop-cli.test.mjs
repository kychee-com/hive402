// The node's run402 client (FIX-45).
//
// Every shape asserted here was READ OFF THE REAL CLI (run402 4.17.8) on
// 2026-08-18, not guessed. That matters: the first version of this client took
// `url` from the deploy envelope, because the SDK's own comment says v2 returns
// `urls = { project, release }`. A real deploy returned `"url": ""` — the
// project had no subdomain bound, so it had no public URL at all — and the
// client would have reported a deploy with no live URL as a success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { makeRun402Cli, resolveRun402Entry } from "../src/workshop/cli.mjs";

// A spawn that answers with canned stdout/stderr and an exit code, and records
// exactly what it was asked to run.
function fakeSpawn(responses) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const reply = responses[calls.length - 1] ?? { code: 0, stdout: "{}" };
    queueMicrotask(() => {
      if (reply.stdout) child.stdout.emit("data", reply.stdout);
      if (reply.stderr) child.stderr.emit("data", reply.stderr);
      child.emit("close", reply.code ?? 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

// The real envelope from `run402 sites deploy-dir`, verbatim.
const DEPLOYED = JSON.stringify({ deployment_id: "dpl_msz0n8t7_a1b086", url: "" }, null, 2);
// The real envelope from `run402 subdomains claim`, verbatim.
const CLAIMED = JSON.stringify(
  {
    name: "hive402-dresstest",
    deployment_id: "dpl_msz0n8t7_a1b086",
    url: "https://hive402-dresstest.run402.com",
    deployment_url: "https://dpl-msz0n8t7-a1b086.sites.run402.com",
    project_id: "prj_1",
  },
  null,
  2,
);

const cliFor = (responses, over = {}) => {
  const { spawnFn, calls } = fakeSpawn(responses);
  return {
    calls,
    cli: makeRun402Cli({ cliPath: "C:/fake/run402/cli.mjs", nodeBin: "C:/node/node.exe", spawnFn, ...over }),
  };
};

// `cliPath` is checked for existence, so point the resolver at this test file.
const HERE = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const cliAt = (responses, over = {}) => {
  const { spawnFn, calls } = fakeSpawn(responses);
  return { calls, cli: makeRun402Cli({ cliPath: HERE, nodeBin: "node", spawnFn, ...over }) };
};

// ── The command, exactly as the CLI documents it ──────────────────────────

test("the deploy runs node against run402's own cli.mjs, with args as an array", async () => {
  // Never the .cmd shim: node 22 refuses to spawn one without a shell, and
  // going through a shell would mean building a command STRING out of a project
  // id and a path.
  const { cli, calls } = cliAt([{ code: 0, stdout: DEPLOYED }]);
  await cli.deploy({ project: "prj_1", dir: "C:/work/spike/site" });

  assert.equal(calls[0].bin, "node");
  assert.deepEqual(calls[0].args, [
    HERE,
    "sites",
    "deploy-dir",
    "C:/work/spike/site",
    "--project",
    "prj_1",
    "--quiet",
    "--confirm-prune",
  ]);
});

// ── A deploy with no subdomain has no public URL, and says so ────────────

test("a deploy without a configured subdomain returns the receipt and NO invented url", async () => {
  // Measured: run402 returns `"url": ""` for a project with nothing bound. The
  // honest answer is "there is no public URL", never a guessed hostname.
  const { cli } = cliAt([{ code: 0, stdout: DEPLOYED }]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });

  assert.equal(r.ok, true);
  assert.equal(r.receipt, "dpl_msz0n8t7_a1b086");
  assert.equal(r.url, null);
});

test("a configured subdomain is claimed onto the new deployment, and its url is used", async () => {
  const { cli, calls } = cliAt([
    { code: 0, stdout: DEPLOYED },
    { code: 0, stdout: CLAIMED },
  ]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site", subdomain: "hive402-dresstest" });

  assert.deepEqual(calls[1].args, [
    HERE,
    "subdomains",
    "claim",
    "hive402-dresstest",
    "--project",
    "prj_1",
    "--deployment",
    "dpl_msz0n8t7_a1b086",
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://hive402-dresstest.run402.com", "read from run402's answer, never string-built");
  assert.equal(r.receipt, "dpl_msz0n8t7_a1b086");
});

test("a deploy that already carries a url does not need a claim", async () => {
  const { cli, calls } = cliAt([
    { code: 0, stdout: JSON.stringify({ deployment_id: "dpl_2", url: "https://already.run402.com" }) },
  ]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site", subdomain: "already" });
  assert.equal(calls.length, 1, "one CLI call, not two");
  assert.equal(r.url, "https://already.run402.com");
});

test("a deploy that succeeds but whose subdomain claim fails is not reported as fully live", async () => {
  const { cli } = cliAt([
    { code: 0, stdout: DEPLOYED },
    { code: 1, stderr: JSON.stringify({ status: "error", code: "SUBDOMAIN_TAKEN", message: "hive402-dresstest is already claimed" }) },
  ]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site", subdomain: "hive402-dresstest" });

  assert.equal(r.ok, true, "the deploy itself did happen, and pretending otherwise would be its own lie");
  assert.equal(r.url, null);
  assert.match(r.warning, /already claimed/);
});

// ── Failures are reported, never swallowed ───────────────────────────────

test("run402's own error envelope becomes the reason, not a raw dump", async () => {
  const { cli } = cliAt([
    {
      code: 1,
      stderr: JSON.stringify({
        status: "error",
        code: "PRUNE_CONFIRMATION_REQUIRED",
        message: "sites deploy-dir would replace the entire site with 1 file(s)",
      }),
    },
  ]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });
  assert.equal(r.ok, false);
  assert.match(r.error, /would replace the entire site/);
  assert.match(r.error, /PRUNE_CONFIRMATION_REQUIRED/);
});

test("a zero exit with no envelope is a failure, not a silent success", async () => {
  const { cli } = cliAt([{ code: 0, stdout: "deploying...\n" }]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no result envelope/);
});

test("a deploy with no receipt is a failure: AC-30 is a receipt in the channel", async () => {
  const { cli } = cliAt([{ code: 0, stdout: JSON.stringify({ url: "https://x.run402.com" }) }]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });
  assert.equal(r.ok, false);
  assert.match(r.error, /without a receipt/);
});

test("a run402 that never finishes is killed and reported, not awaited forever", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => {
      killed = true;
    };
    child.wasKilled = () => killed;
    return child;
  };
  const cli = makeRun402Cli({ cliPath: HERE, nodeBin: "node", spawnFn, timeoutMs: 20 });
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not finish/);
});

test("a missing run402 install is named, not blamed on the deploy", async () => {
  const { cli } = cliFor([{ code: 0, stdout: DEPLOYED }]);
  const r = await cli.deploy({ project: "prj_1", dir: "C:/site" });
  assert.equal(r.ok, false);
  assert.match(r.error, /run402 CLI is not installed/);
});

// ── Finding the CLI ──────────────────────────────────────────────────────

test("an explicit cliPath wins, and a wrong one is reported rather than guessed around", () => {
  assert.equal(resolveRun402Entry({ cliPath: HERE }), HERE);
  assert.equal(resolveRun402Entry({ cliPath: "C:/nope/cli.mjs" }), null);
});
