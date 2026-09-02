import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Platform-native credential storage. No third-party dependency: each OS ships
// a credential manager and hive402 shells out to it.
//
// Windows  — DPAPI per-user store via PowerShell
// macOS    — Keychain via `security`
// Linux    — Secret Service via `secret-tool` (libsecret)
//
// ---------------------------------------------------------------------------
// The rule this module exists to keep (DD-30, F-014): NOTHING A CHILD PROCESS
// SAYS IS EVER SURFACED.
//
// `execFile` rejects with `Command failed: <the whole command line>\n<stderr>`,
// and it attaches `stdout`, `stderr` and `cmd` to the error object. On these
// code paths every one of those can hold a secret:
//
//   the command line   held the secret on Windows before this fix, and still
//                      does on macOS, where `security` takes it as an argument
//   stdout             on the READ path IS the secret
//   stderr             quotes the failing line of the script
//
// So every child call goes through `child()`, which throws a FRESHLY BUILT
// error made of three whitelisted things: the operation, the exit code, and an
// exception TYPE name the script itself reports on a marker line whose charset
// cannot carry input. `test/f014-secret-leak.test.mjs` drives the real backend
// into a real failure and asserts all of it.
// ---------------------------------------------------------------------------

// The one thing read out of a child's stderr. The capture group's charset is a
// whitelist, so no path, no input and no script text can ride out through it.
const ERROR_MARKER = /^hive402-keychain-error: ([A-Za-z0-9_.+]{1,120})\s*$/m;

// A type name alone is precise but not actionable. These are the causes worth
// naming a remedy for; anything else still reports its type and exit code.
const HINTS = new Map([
  [
    "System.IO.PathTooLongException",
    "The credential file path is over the Windows 260-character limit. Use a shorter identity name.",
  ],
  ["System.IO.DirectoryNotFoundException", "The credential directory could not be created."],
  ["System.UnauthorizedAccessException", "Access to the credential file was denied."],
  [
    "System.Security.Cryptography.CryptographicException",
    "Windows DPAPI could not protect or unprotect this value for the current user.",
  ],
]);

// "There is no such entry" versus "I could not read the entry".
//
// FOUND BY BARRY LOOKING AT HIS MEMBER LIST (2026-08-26): an "Unnamed member"
// nobody had created. `hive402 join` had minted a SECOND node identity on a
// machine that already had one, joined the community with it, and left the real
// node orphaned — because every `get` below caught everything and returned
// null, so a failed read and an empty store were the same answer, and the
// caller mints on the second.
//
// That is F-008's class one layer down: "we could not check" rendering as
// "there is nothing there". The consequence is worse than F-008's, because what
// gets created is a durable identity in somebody's community, which no amount
// of local cleanup removes.
//
// Each platform reports "not found" as a specific exit code. Everything else is
// a real failure and has to travel.
export const ABSENT_EXIT = Object.freeze({ win32: 2, darwin: 44, linux: 1 });

export function absentOrRethrow(failure, absentExit) {
  if (failure?.exitCode === absentExit) return null;
  throw failure;
}

// ── WHERE THE WINDOWS STORE LIVES, and why it moved (FIX-127) ─────────────
//
// It was `%LOCALAPPDATA%\hive402\credentials`. That is the conventional place
// and it was wrong here, for a reason that took an afternoon to find.
//
// A packaged (MSIX) host REDIRECTS `%LOCALAPPDATA%` for every process it
// launches, into `AppData\Local\Packages\<package>\LocalCache\Local\`. The
// Claude desktop app is one. So keys written by a hive402 command run from
// inside it landed in that package's private cache, and were INVISIBLE to every
// ordinary terminal on the same machine, under the same user, at what looked
// like the same path. Barry's plain PowerShell reported "the store is empty"
// while a tool process reported both keys stored; listing both paths from one
// process showed identical names, sizes and timestamps, which is the redirect.
//
// `%USERPROFILE%` is NOT redirected, and that is not a guess: Barry's own
// `doctor`, in a plain shell, reads `~/.hive402/config.json`, a file written
// from a tool process. So the store moves next to the config, where every
// context can see it.
//
// The old location is still READ, so an install that already has keys there
// keeps working and can be migrated without a flag day. Nothing is written to it
// any more.
const WINDOWS_STORE = ["hive402", "credentials"];

function windowsStoreDirs() {
  const dirs = [];
  const home = process.env.USERPROFILE;
  if (home) dirs.push(pathJoin(home, ".hive402", "credentials"));
  // Legacy, read-only: keys written before this moved, including any written
  // from inside a packaged host, which is where they are for anyone who set
  // hive402 up through one.
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(pathJoin(local, ...WINDOWS_STORE));
  return dirs;
}

export function credentialLocation(platform = process.platform) {
  if (platform === "win32") {
    const [primary] = windowsStoreDirs();
    return primary ?? "%USERPROFILE% is NOT SET in this shell";
  }
  if (platform === "darwin") return "the login keychain";
  return "the Secret Service store (secret-tool)";
}

// WHAT IS ACTUALLY IN THE STORE, by entry name, for a `doctor` that has just
// reported no key (FIX-127).
//
// Barry's `doctor` said "NO KEY in the OS credential store" for both identities
// while the same command, same build, same store path, run from a different
// process on the same machine, said "stored" for both. Every explanation that
// could be checked from outside has been checked and eliminated: the config, the
// build, the shell, the store path, load, and the entry names, which match the
// files on disk exactly.
//
// So the remaining question is one only HIS process can answer: when it looks in
// that directory, what does it see? An empty list means the process cannot read
// the directory at all. A list containing the very entries it just called
// missing means the read is failing, not the key.
//
// Entry NAMES only. They are `<service>--<identity>`, and every identity in them
// is already named in the config the same command just printed, so this adds no
// disclosure. Nothing here opens a file, and DD-30 is untouched: the secret
// stays behind DPAPI and the child.
// CONFIRMED BY BARRY'S DOCTOR, 2026-08-27: `this process sees 0 entries there`,
// while another process on the same machine, at the same printed path, sees two.
// So the store is not missing keys — this process cannot reach the directory at
// all, and reporting that as "NO KEY" is the absent-versus-unreadable error one
// level further out again: at the DIRECTORY rather than at the entry.
//
// The distinction has to travel, so this returns a reason rather than an empty
// list. `unreadable` is the finding a caller must not turn into "create a key".
export function inspectStore(platform = process.platform) {
  if (platform !== "win32") return { entries: null, unreadable: false, reason: null };
  const dirs = windowsStoreDirs();
  if (!dirs.length) return { entries: [], unreadable: true, reason: "USERPROFILE is not set" };

  // Every location that holds anything, deduplicated: a half-migrated install
  // has keys in both, and reporting only the new one would call it empty.
  const seen = new Set();
  let anyReadable = false;
  let reason = null;
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".dpapi")) seen.add(f.replace(/\.dpapi$/, ""));
      }
      anyReadable = true;
    } catch (err) {
      // A location that simply does not exist is not a problem: the new store
      // is absent on every install made before this change, and the legacy one
      // is absent on every install made after.
      if (err?.code !== "ENOENT") reason ??= err?.code ?? "unreadable";
    }
  }
  if (seen.size || anyReadable) return { entries: [...seen], unreadable: false, reason: null };
  return { entries: [], unreadable: Boolean(reason), reason };
}


// Names only, for callers that just want to print what is there.
export function storeEntryNames(platform = process.platform) {
  return inspectStore(platform).entries;
}

// The one outcome a caller has to be able to tell apart from a failure: the
// entry was already there, so nothing was written and nothing was overwritten.
// A distinct TYPE rather than a string match, because `keygen` turns this into
// a specific refusal and a string match would rot the first time the wording
// changes (DD-32, F-017).
export class KeyExistsError extends Error {
  constructor() {
    super("credential store entry already exists");
    this.name = "KeyExistsError";
    this.exists = true;
  }
}

function sanitizedError(operation, cause) {
  const type = ERROR_MARKER.exec(String(cause?.stderr ?? ""))?.[1] ?? null;
  // `execFile` puts a numeric exit status in `code` when the child ran, and a
  // string like ENOENT when it could not be started at all.
  const exit = Number.isInteger(cause?.code) ? cause.code : null;
  const spawnFailure = typeof cause?.code === "string" ? cause.code : null;

  let message = `credential store ${operation} failed`;
  if (type) message += `: ${type}`;
  else if (spawnFailure) message += `: the platform credential tool could not be run (${spawnFailure})`;
  if (exit !== null) message += ` (helper exit ${exit})`;
  if (HINTS.has(type)) message += `. ${HINTS.get(type)}`;
  if (!type && !spawnFailure) message += ". The helper reported no recognised cause.";

  // A plain Error, built here: no `cause` chain, no copied fields. Anything
  // carried over from the child could be printed by a caller doing nothing more
  // careless than `console.error(err)`.
  const error = new Error(message);
  error.operation = operation;
  // A number, and the only thing a caller may branch on. The exclusive-create
  // path needs to tell "already there" from "it broke" (DD-32), and it must do
  // that without reading a single character the child produced.
  error.exitCode = exit;
  return error;
}

// READS retry once. Writes never do.
//
// FOUND TWICE ON ONE DAY (2026-08-26). Barry's `hive402 up` reported "2 of 2
// identities have no usable key" on a machine whose keys were both fine, and
// the test suite failed one credential round-trip in a run of 1098 and passed
// it on the next. Both are the same thing: shelling out to a platform
// credential tool is a process spawn, and under load one occasionally does not
// come back. Before this module distinguished absent from unreadable, that
// surfaced as "there is no key" and minted a second identity; now it surfaces
// as a hard failure, which is honest but still costs a start for no reason.
//
// One retry, reads only. A write is not idempotent here — `create` is
// exclusive and a retry could turn "I already made it" into a spurious
// KeyExistsError — and a read has nothing to undo. Two failures in a row is a
// real fault and travels.
async function child(operation, file, args, options = {}) {
  try {
    return await run(file, args, options);
  } catch (failure) {
    if (operation !== "read") throw sanitizedError(operation, failure);
    try {
      return await run(file, args, options);
    } catch (second) {
      throw sanitizedError(operation, second);
    }
  }
}

export function osKeychain(platform = process.platform) {
  switch (platform) {
    case "darwin":
      return macKeychain();
    case "win32":
      return windowsKeychain();
    default:
      return linuxKeychain();
  }
}

function macKeychain() {
  // KNOWN RESIDUAL (DD-30): `security` takes the password as an argument, so it
  // is in this child's argv for the life of the call, where `ps` can see it.
  // The DISCLOSURE half of F-014 is fixed here — `child()` means hive402 never
  // prints it — but the argv exposure is not. The fix is to feed the value on
  // stdin, and it is deliberately not being written blind: this project has no
  // Mac to run it on, and shipping untested credential-handling code to a
  // platform nobody can exercise is a worse trade than a recorded gap.
  return {
    async set(service, account, secret) {
      await child("write", "security", [
        "add-generic-password",
        "-s", service,
        "-a", account,
        "-w", secret,
        "-U",
      ]);
    },
    // `-U` is what makes `set` an upsert; WITHOUT it, `add-generic-password` is
    // already a create-only operation and fails with errSecDuplicateItem. So
    // the atomicity here is the Keychain's own (DD-32).
    //
    // The failure is classified by asking the store, not by reading the child's
    // words: `security`'s exit codes are not a contract this project has a Mac
    // to verify, and DD-30 forbids reading its output at all.
    async create(service, account, secret) {
      try {
        await child("write", "security", [
          "add-generic-password",
          "-s", service,
          "-a", account,
          "-w", secret,
        ]);
      } catch (failure) {
        if (await this.get(service, account)) throw new KeyExistsError();
        throw failure;
      }
    },
    async get(service, account) {
      try {
        const { stdout } = await child("read", "security", [
          "find-generic-password",
          "-s", service,
          "-a", account,
          "-w",
        ]);
        return stdout.trim();
      } catch (failure) {
        // `security` exits 44 (errSecItemNotFound) when the item is not there.
        // A locked keychain, a denied prompt or a missing binary are not that,
        // and must not read as "no key" — see `absentOrRethrow`.
        return absentOrRethrow(failure, ABSENT_EXIT.darwin);
      }
    },
    async remove(service, account) {
      try {
        await child("remove", "security", [
          "delete-generic-password",
          "-s", service,
          "-a", account,
        ]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function linuxKeychain() {
  return {
    // `secret-tool store` reads the value from stdin, which is what keeps it out
    // of argv. There used to be an `execFile(..., { input: secret })` call in
    // front of this with a `.catch()` fallback to it: `execFile` has no `input`
    // option, so that call never wrote anything and left `secret-tool` blocking
    // on a stdin nobody would ever end. The fallback was carrying the feature.
    async set(service, account, secret) {
      await storeViaStdin(service, account, secret);
    },
    // The one backend where the exclusion is hive402's rather than the OS's,
    // and DD-32 says so out loud: `secret-tool store` overwrites and has no
    // exclusive mode. So an O_EXCL lock file — the filesystem's own atomic
    // primitive — guards lookup-then-store, and is released in a `finally`.
    async create(service, account, secret) {
      const { open, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { createHash } = await import("node:crypto");
      const lock = pathJoin(
        tmpdir(),
        `hive402-create-${createHash("sha256").update(`${service}:${account}`).digest("hex").slice(0, 32)}.lock`,
      );

      let handle;
      try {
        handle = await open(lock, "wx");
      } catch {
        // Somebody else is creating this exact identity right now. That is the
        // same answer as "it already exists" for the caller: nothing of theirs
        // was stored, so they must not be told it was.
        throw new KeyExistsError();
      }
      try {
        if (await this.get(service, account)) throw new KeyExistsError();
        await storeViaStdin(service, account, secret);
      } finally {
        await handle.close();
        await rm(lock, { force: true });
      }
    },
    async get(service, account) {
      try {
        const { stdout } = await child("read", "secret-tool", [
          "lookup",
          "service", service,
          "account", account,
        ]);
        return stdout.trim() || null;
      } catch (failure) {
        // secret-tool exits 1 with no output when the item is not there.
        // Anything else is a real failure and must not read as "no key".
        return absentOrRethrow(failure, ABSENT_EXIT.linux);
      }
    },
    async remove(service, account) {
      try {
        await child("remove", "secret-tool", ["clear", "service", service, "account", account]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function storeViaStdin(service, account, secret) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const p = spawn("secret-tool", [
      "store",
      "--label", `${service}:${account}`,
      "service", service,
      "account", account,
    ]);
    // Neither branch may report the child's own words: `secret-tool`'s usage
    // output echoes the arguments it was given.
    p.on("error", (failure) => reject(sanitizedError("write", failure)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(sanitizedError("write", { code }))));
    p.stdin.end(secret);
  });
}

function windowsKeychain() {
  // `cmdkey` cannot read secrets back and a CredRead/CredWrite P/Invoke is
  // heavyweight, so this is the DPAPI-protected per-user store: values are
  // encrypted with the current user's credentials and written under
  // %LOCALAPPDATA%. Never plaintext, never off the device.

  // Filename-safe: Windows forbids : \ / * ? " < > | in file names. Identity
  // names are validated against exactly the surviving charset (names.mjs), so
  // for a name that reached here through the store this replace is a no-op and
  // the mapping is injective.
  const target = (service, account) =>
    `${service}--${account}`.replace(/[^A-Za-z0-9._-]/g, "_");

  // Every file this name could be in, most-preferred first: the new store under
  // %USERPROFILE%, then the legacy %LOCALAPPDATA% one (FIX-127). Resolved HERE
  // rather than inside the PowerShell script, because the whole bug was a path
  // the child computed from an environment variable that a packaged host
  // redirects underneath it. A literal path cannot be redirected out from under
  // the process that chose it.
  const vaultFiles = (name) => windowsStoreDirs().map((dir) => pathJoin(dir, `${name}.dpapi`));

  // Where a WRITE goes. Always the first location, never the legacy one: the
  // point of the move is that new keys land somewhere every shell can see.
  const writeTarget = (name) => vaultFiles(name)[0];

  // Which file actually holds this entry, or null. Used to pick the file the
  // child reads, and to contradict an absent verdict (see `get`). Touches
  // nothing but existence: the value stays behind DPAPI and the child.
  const vaultFileFound = (name) => vaultFiles(name).find((f) => existsSync(f)) ?? null;

  // A path is interpolated into the script, so it must not be able to close the
  // quote it sits in. Windows forbids `"` in paths and PowerShell single-quotes
  // escape by doubling, so this is exact rather than best-effort.
  const psLiteral = (p) => `'${String(p).replace(/'/g, "''")}'`;

  // The secret crosses into the child as an ENVIRONMENT VARIABLE, never as part
  // of the script and never as an argument (DD-30). That is what makes F-014
  // structurally impossible rather than merely redacted: there is no string
  // anywhere in this module that contains the secret, so no error, log line or
  // crash dump can carry one however the failure arrives. It is also off the
  // child's command line, which `Get-CimInstance Win32_Process` exposes to
  // every process on the box.
  const SECRET_ENV = "HIVE402_SECRET_B64";

  // Base64 in both directions (DD-29), for two measured reasons:
  //
  //   Going in — the value lands in a PowerShell string. Base64's alphabet is
  //   [A-Za-z0-9+/=], so it holds no metacharacter whatever quoting it meets.
  //
  //   Coming out — `UTF8.GetString($dec)` printed the secret as console text,
  //   so PowerShell appended a newline AND translated a lone \n to \r\n.
  //   `.trim()` hid the first and nothing hid the second, silently corrupting
  //   any multi-line secret. Base64 out has no such hazard, and trimming it is
  //   safe by construction.
  const encode = (value) => Buffer.from(String(value), "utf8").toString("base64");
  const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");

  // Every script is wrapped so PowerShell's own error record never reaches
  // stderr: the catch writes ONE marker line naming the innermost exception
  // type and nothing else. `GetBaseException()` unwraps the
  // MethodInvocationException PowerShell puts around a failing .NET call, which
  // would otherwise mask `PathTooLongException` behind a generic wrapper.
  const guarded = (body) => `
    $ErrorActionPreference='Stop'
    try {
${body}
    } catch {
      [Console]::Error.WriteLine('hive402-keychain-error: ' + $_.Exception.GetBaseException().GetType().FullName)
      exit 3
    }
  `;

  const ps = async (operation, script, childEnv = null) => {
    const { stdout } = await child(
      operation,
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", guarded(script)],
      {
        windowsHide: true,
        // A copied env, so the value is never placed in this process's own
        // environment where anything else could read it or inherit it.
        env: childEnv ? { ...process.env, ...childEnv } : process.env,
      },
    );
    return stdout;
  };

  // Everything up to the write is identical for `set` and `create`; only the
  // last two lines differ, and duplicating the DPAPI half is how the two would
  // drift apart. `WriteAllBytes` replaces; the `CreateNew` open refuses to.
  const protectAndWrite = (name, write) => `      Add-Type -AssemblyName System.Security
      $p = ${psLiteral(writeTarget(name))}
      New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
      $bytes = [Convert]::FromBase64String($env:${SECRET_ENV})
      $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
${write}`;

  // Exit 4 means "it was already there" (DD-32, F-017). It is a code, not a
  // message, because DD-30 forbids reading anything the child says.
  const EXISTS_EXIT = 4;

  return {
    async set(service, account, secret) {
      const name = target(service, account);
      await ps(
        "write",
        protectAndWrite(name, `      [IO.File]::WriteAllBytes($p, $enc)`),
        { [SECRET_ENV]: encode(secret) },
      );
    },
    // `FileMode::CreateNew` is CREATE_NEW at the Win32 layer, i.e. O_EXCL: the
    // filesystem does the mutual exclusion, so there is no lock to leak and no
    // stale state after a crash. Two concurrent `keygen` calls for one name can
    // no longer both "succeed" while only one key survives (F-017).
    //
    // The catch does not match on exception TYPE: PowerShell wraps a failing
    // .NET call, `DirectoryNotFoundException` derives from `IOException`, and
    // "did the file end up existing" is the question actually being asked.
    async create(service, account, secret) {
      const name = target(service, account);
      try {
        await ps(
          "write",
          protectAndWrite(
            name,
            `      try {
        $fs = [IO.File]::Open($p, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      } catch {
        if (Test-Path $p) { exit ${EXISTS_EXIT} }
        throw
      }
      try { $fs.Write($enc, 0, $enc.Length) } finally { $fs.Dispose() }`,
          ),
          { [SECRET_ENV]: encode(secret) },
        );
      } catch (failure) {
        if (failure?.exitCode === EXISTS_EXIT) throw new KeyExistsError();
        throw failure;
      }
    },
    async get(service, account) {
      const name = target(service, account);
      try {
        // What comes back on stdout IS the secret, which is the other half of
        // why no raw child error may ever be surfaced from this module.
        const out = await ps(
          "read",
          `      Add-Type -AssemblyName System.Security
      $p = ${psLiteral(vaultFileFound(name) ?? writeTarget(name))}
      if (!(Test-Path $p)) { exit 2 }
      $enc = [IO.File]::ReadAllBytes($p)
      $dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
      [Convert]::ToBase64String($dec)`,
        );
        const b64 = out.trim();
        return b64 ? decode(b64) : null;
      } catch (failure) {
        // FIX-127, second round. An "absent" verdict is CHECKED against the
        // filesystem before it is believed.
        //
        // Barry hit "no usable key" twice on a machine whose vault files were
        // sitting on disk and whose `hive402 keys list` said "key stored". The
        // only way to reach that message is this exit 2, which means the child's
        // `Test-Path` said no about a file that is demonstrably there.
        //
        // Whatever the reason (an environment the child resolves differently, a
        // scanner holding the path, a spawn that half-ran), THE VERDICT IS
        // WRONG, and this process can say so cheaply: it computes the same path
        // from the same variable it hands the child, and asks the filesystem
        // directly. A file that exists is not an absence, so this becomes a read
        // FAILURE — which travels, and which no caller turns into "mint a new
        // identity".
        //
        // Deliberately one-directional. It can only ever convert absent into
        // failure, never failure into absent, so it cannot weaken the
        // distinction that the whole of ABSENT_EXIT exists to keep.
        if (failure?.exitCode === ABSENT_EXIT.win32 && vaultFileFound(name)) {
          const wrong = new Error(
            `credential store read failed: the store reported no entry, but its file exists ` +
              `(${credentialLocation()}). Treating this as a failed READ, not a missing key.`,
          );
          wrong.operation = "read";
          // NOT the absent code. This must not be reclassified as absent by
          // anything downstream.
          wrong.exitCode = null;
          throw wrong;
        }
        // Exit 2 is the script's own "the vault file is not there". Anything
        // else — DPAPI refusing to unprotect, the file locked, PowerShell
        // failing to start — is a failure, and returning null for it is how a
        // second node identity got minted over a perfectly good one.
        return absentOrRethrow(failure, ABSENT_EXIT.win32);
      }
    },
    async remove(service, account) {
      const name = target(service, account);
      try {
        // BOTH locations. Leaving the legacy copy behind would make a "removed"
        // key reappear on the next read, which is the worst possible answer to
        // "forget this identity" — the same reasoning `removeNodePrivateKey`
        // already applies across the two account labels.
        const clears = vaultFiles(name)
          .map(
            (f) =>
              `      if (Test-Path ${psLiteral(f)}) { Remove-Item ${psLiteral(f)} -Force; $found = $true }`,
          )
          .join("\n");
        await ps("remove", `      $found = $false\n${clears}\n      if (-not $found) { exit 2 }`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
