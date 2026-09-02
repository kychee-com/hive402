// The node's run402 client (FIX-45, DD-27).
//
// One method, `deploy`, and one job: run the real run402 CLI and read its
// result envelope. Everything about WHETHER a deploy may happen was decided
// before this file is reached — the tool gate refused the agent's own attempt,
// the owner approved, and `buildAndDeploy` re-checked the authority record.
// This is the hop that actually spends money, so it is deliberately dumb.
//
// ── Why `node <entry>` and not the shim ───────────────────────────────────
//
// npm installs `run402` as a `.cmd` shim on Windows, and node 22 refuses to
// spawn `.cmd` without a shell (EINVAL, since the CVE-2024-27980 fix). Going
// through a shell to work around that would mean building a command STRING out
// of a project id and a path, which is a quoting bug waiting to become a
// command injection. So we spawn `process.execPath` — the same node already
// running the supervisor — against the package's own `cli.mjs` entry, with the
// arguments passed as an array. No shell is involved at any point.
//
// ── The commands, and why there are two ──────────────────────────────────
//
// `run402 sites deploy-dir <dir> --project <id>` (verified against run402
// 4.17.8) prints `{ deployment_id, url, … }` on stdout and reports failures as
// a JSON envelope on stderr with a non-zero exit.
//
// FOUND BY RUNNING IT (2026-08-18): on a real deploy that envelope came back
// with `"url": ""`. A run402 project has no public URL until a SUBDOMAIN is
// bound to a deployment — `projects get` showed `site_url: null` and the
// operation showed `subdomain_bindings: []` — and the deployed bytes were
// genuinely unreachable. The SDK's own comment says v2 returns
// `urls = { project, release }`; the gateway did not.
//
// So a deploy alone satisfies AC-30 (a receipt) but not AC-29 (a live URL).
// When the room's workshop config names a subdomain, the node claims it onto
// the deployment it just made and takes the URL from THAT answer —
// `run402 subdomains claim <name> --project <id> --deployment <dpl>` returns
// `{ url, deployment_url, … }`. When it does not, there is no live URL, and
// the room is told exactly that. A hostname is never constructed here: an
// invented URL that happens to 404 is worse than an honest absence.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Where npm puts a globally installed package's files, relative to the
// directory its launcher shim lives in. Windows keeps both together; POSIX puts
// the shim in `bin/` and the package under `lib/node_modules/`.
function candidateEntries(dir) {
  return [
    path.join(dir, "node_modules", "run402", "cli.mjs"),
    path.join(dir, "..", "lib", "node_modules", "run402", "cli.mjs"),
    path.join(dir, "..", "node_modules", "run402", "cli.mjs"),
  ];
}

// Find run402's real JavaScript entry point by walking the PATH for its shim
// and then locating the package beside it. An explicit `tools.run402Cli` in the
// node config always wins, because an unusual install should be stated rather
// than guessed at.
export function resolveRun402Entry({ cliPath = null, env = process.env } = {}) {
  if (cliPath) return existsSync(cliPath) ? cliPath : null;
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of String(env.PATH ?? env.Path ?? "").split(sep)) {
    if (!dir) continue;
    const shim = ["run402", "run402.cmd", "run402.exe"].some((n) => existsSync(path.join(dir, n)));
    if (!shim) continue;
    for (const entry of candidateEntries(dir)) {
      if (existsSync(entry)) return path.normalize(entry);
    }
  }
  return null;
}

export function makeRun402Cli({
  cliPath = null,
  nodeBin = process.execPath,
  spawnFn = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  return {
    async deploy({ project, dir, subdomain = null }) {
      const entry = resolveRun402Entry({ cliPath, env });
      if (!entry) {
        return {
          ok: false,
          error:
            `the run402 CLI is not installed where hive402 can find it. Install it ` +
            `(npm i -g run402) or set tools.run402Cli in the node config to its cli.mjs.`,
        };
      }
      const call = (args) => run({ nodeBin, args: [entry, ...args], spawnFn, timeoutMs });

      const deployed = await call([
        "sites",
        "deploy-dir",
        dir,
        "--project",
        project,
        // Progress events go to stderr and we do not read them; the room gets
        // the result, not a build log.
        "--quiet",
        // A workshop deploy IS the whole site: the node publishes the agent's
        // site folder and nothing else, so replacing what is there is the
        // intent rather than an accident. run402 guards a site of fewer than
        // five files behind this flag precisely because it cannot know that.
        "--confirm-prune",
      ]);
      if (!deployed.ok) return deployed;

      const receipt = deployed.envelope.deployment_id || deployed.envelope.release_id || "";
      if (!receipt) {
        // AC-30 is a receipt in the channel. A deploy we cannot name is not one
        // we can report.
        return { ok: false, error: `run402 reported a deploy without a receipt: ${trim(deployed.raw)}` };
      }
      const url = deployed.envelope.url || deployed.envelope.site_url || null;
      if (url) return { ok: true, url, receipt };

      // No public URL yet, and none can be invented. Bind the subdomain the
      // owner configured, if they configured one.
      if (!subdomain) return { ok: true, url: null, receipt };

      const claimed = await call([
        "subdomains",
        "claim",
        subdomain,
        "--project",
        project,
        "--deployment",
        receipt,
      ]);
      if (!claimed.ok) {
        // The deploy DID happen. Saying otherwise would be its own lie, and
        // would invite a retry that deploys a second time.
        return { ok: true, url: null, receipt, warning: claimed.error };
      }
      return { ok: true, url: claimed.envelope.url || null, receipt };
    },
  };
}

function run({ nodeBin, args, spawnFn, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(nodeBin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (err) {
      resolve({ ok: false, error: `could not start run402: ${err.message}` });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: `run402 did not finish within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on("data", (c) => {
      out += c;
    });
    child.stderr?.on("data", (c) => {
      err += c;
    });
    child.on("error", (e) => finish({ ok: false, error: `could not start run402: ${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return finish({ ok: false, error: describeFailure({ code, err, out }) });
      const envelope = lastJsonObject(out);
      if (!envelope) {
        return finish({ ok: false, error: `run402 returned no result envelope (exit 0): ${trim(out || err)}` });
      }
      finish({ ok: true, envelope, raw: out });
    });
  });
}

// run402 reports failures as a JSON envelope on stderr. Prefer its own message
// over a raw dump, and fall back to the dump when it is something else.
function describeFailure({ code, err, out }) {
  const envelope = lastJsonObject(err) ?? lastJsonObject(out);
  if (envelope?.message) {
    return envelope.code ? `${envelope.message} (${envelope.code})` : envelope.message;
  }
  return `run402 exited ${code}: ${trim(err || out)}`;
}

// The CLI prints progress lines as well as its result, so take the last thing
// on the stream that parses as a JSON object.
function lastJsonObject(text) {
  const source = String(text ?? "").trim();
  if (!source) return null;
  // The result is pretty-printed across lines, so try the whole stream first
  // and then fall back to scanning individual lines (NDJSON progress output).
  try {
    const whole = JSON.parse(source);
    if (whole && typeof whole === "object") return whole;
  } catch {
    /* not one object — fall through */
  }
  const start = source.lastIndexOf("\n{");
  if (start >= 0) {
    try {
      const tail = JSON.parse(source.slice(start + 1));
      if (tail && typeof tail === "object") return tail;
    } catch {
      /* not it either */
    }
  }
  for (const line of source.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const trim = (text) => String(text ?? "").trim().slice(0, 400);
