// FIX-116, the command layer: `hive402 profile`, and the name asked at join.
//
// Two things this proves that `profile.test.mjs` cannot:
//
//   1. The command works BEFORE there is a config. A profile can be published
//      the moment the node has joined, and `hive402.config.json` is written
//      later in setup — so the community's address has to come from the join
//      record, which is the only source that could be right at that moment.
//   2. A failed profile publish does not report a failed JOIN. The membership
//      is real either way, and telling someone the join failed sends them to
//      re-run the one part that already worked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";

import { buzzBinPath, resolveRelay, runProfile } from "../src/registry/profilecommand.mjs";
import { readJoinRecord, writeJoinRecord } from "../src/registry/joinrecord.mjs";
import { runJoin } from "../src/registry/joincommand.mjs";
import { terminalConsent, lineReader } from "../src/registry/consent.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const CODE = "v2.YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
const LINK = `https://relay.example/invite/${CODE}`;
const now = 1_700_000_000_000;

const joined = () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  writeJoinRecord({
    stateDir,
    record: {
      status: "joined", host: "relay.example", communityId: "kychee",
      origin: "https://relay.example", pubkey: derivePubkey(SK), role: "member",
      policyVersion: null, ageConfirmed: false, acceptedAt: now,
    },
  });
  return stateDir;
};

const store = (key = SK) => ({ async getNodePrivateKey() { return key; } });

function cli() {
  const runs = [];
  return { runs, make: (opts) => ({ opts, async setProfile(f) { runs.push({ ...f, ...opts }); return {}; } }) };
}

// ── Working before there is a config ──────────────────────────────────────

test("with no config, the relay comes from the join record", () => {
  const stateDir = joined();
  const r = resolveRelay({ config: null, stateDir });
  assert.equal(r.relayUrl, "https://relay.example");
  assert.equal(r.joined.pubkey, derivePubkey(SK));
});

test("a config, when there is one, wins — that is the node's real address", () => {
  const stateDir = joined();
  const r = resolveRelay({ config: { relayUrl: "wss://configured.example", tools: { buzzDir: "C:/buzz" } }, stateDir });
  assert.equal(r.relayUrl, "wss://configured.example");
  assert.equal(r.binPath, path.join("C:/buzz", process.platform === "win32" ? "buzz.exe" : "buzz"));
});

test("with neither, it says to join rather than failing obscurely", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  assert.throws(() => resolveRelay({ config: null, stateDir: empty }), /hive402 join <invite-link>/);
});

// FOUND BY BARRY RUNNING `hive402 join` (2026-08-26). This used to return a
// bare `buzz.exe` and trust PATH. Buzz does not put itself on PATH — on Windows
// it installs to `%LOCALAPPDATA%\Buzz` — so the join claimed the invite,
// recorded the policy acceptance, asked for a name, and then failed to publish
// it with `exit ENOENT` on a machine where Buzz was installed and working.
// `join` is the FIRST command anyone runs and the one with no config to read
// `tools.buzzDir` from, so the bare-name assumption failed exactly there.
test("an explicitly configured directory is used as given", () => {
  const bin = process.platform === "win32" ? "buzz.exe" : "buzz";
  assert.equal(buzzBinPath("C:/somewhere"), path.join("C:/somewhere", bin));
});

test("with no directory it looks where Buzz actually installs itself", () => {
  const found = buzzBinPath(null, {
    platform: "win32",
    env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" },
    exists: (p) => p === path.join("C:/Users/x/AppData/Local", "Buzz", "buzz.exe"),
  });
  assert.equal(found, path.join("C:/Users/x/AppData/Local", "Buzz", "buzz.exe"));
});

test("and falls back to the bare name so PATH still wins", () => {
  // Someone who HAS arranged PATH should keep working; this is a fallback, not
  // a replacement for it.
  assert.equal(buzzBinPath(null, { platform: "win32", env: {}, exists: () => false }), "buzz.exe");
  assert.equal(buzzBinPath(null, { platform: "linux", env: {}, exists: () => false }), "buzz");
});

test("each platform is looked for where that platform puts it", () => {
  // Compared through `path.join`, because these tests run on Windows too and
  // `path.join` there produces backslashes — a literal POSIX string would never
  // match and the assertion would be testing the separator, not the lookup.
  const macApp = path.join("/Applications/Buzz.app/Contents/MacOS", "buzz");
  const mac = buzzBinPath(null, {
    platform: "darwin",
    env: { HOME: "/Users/x" },
    exists: (p) => p === macApp,
  });
  assert.equal(mac, macApp);

  const linuxBin = path.join("/home/x", ".local", "bin", "buzz");
  const linux = buzzBinPath(null, {
    platform: "linux",
    env: { HOME: "/home/x" },
    exists: (p) => p === linuxBin,
  });
  assert.equal(linux, linuxBin);
});

// ── Setting and showing ───────────────────────────────────────────────────

test("a name is published and remembered next to the join record", async () => {
  const stateDir = joined();
  const c = cli();
  await runProfile({ name: "Barry's hive", stateDir, store: store(), makeCli: c.make, log: () => {} });
  assert.equal(c.runs[0].name, "Barry's hive");
  assert.equal(c.runs[0].privateKey, SK, "published by the node's own key");
  assert.equal(readJoinRecord(stateDir).displayName, "Barry's hive");
});

test("showing does not change anything", async () => {
  const stateDir = joined();
  const c = cli();
  const lines = [];
  const result = await runProfile({ stateDir, store: store(), makeCli: c.make, log: (l) => lines.push(String(l)) });
  assert.equal(result.shown, true);
  assert.deepEqual(c.runs, [], "no publish for a question");
  assert.match(lines.join("\n"), /hive402 profile --name/);
});

test("a node with no identity is told to join, not handed a crash", async () => {
  // No join record and no config: nothing here names a hive, so there is no
  // identity at all and "go and join" is the right remedy.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  await assert.rejects(
    runProfile({ name: "x", stateDir, store: store(null), makeCli: cli().make, log: () => {} }),
    /hive402 join <invite-link>/,
  );
});

test("AC-72: a hive that joined but whose KEY is gone says that, not 'go and join'", async () => {
  // The other half, and it only became a separate situation with AC-72: the
  // join record names this hive, so it is a member — what is missing is the key
  // for that specific identity, which telling someone to re-join would not fix
  // (and re-joining would mint a different pubkey).
  const stateDir = joined();
  await assert.rejects(
    runProfile({ name: "x", stateDir, store: store(null), makeCli: cli().make, log: () => {} }),
    (err) => {
      assert.match(err.message, /no key for this hive/i);
      assert.match(err.message, new RegExp(derivePubkey(SK).slice(0, 12)), "naming WHICH hive");
      assert.doesNotMatch(err.message, /hive402 join <invite-link>/, "re-joining is not the remedy");
      return true;
    },
  );
});

test("the remembered name does not invent a membership", async () => {
  // `rememberDisplayName` on a state dir with no join record must write nothing:
  // a display name with no community behind it would have `profile` reporting a
  // node that belongs somewhere it does not.
  const empty = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  const { rememberDisplayName } = await import("../src/registry/joinrecord.mjs");
  assert.equal(rememberDisplayName({ stateDir: empty, name: "ghost" }), null);
  assert.equal(readJoinRecord(empty), null);
});

// ── The name asked at join ────────────────────────────────────────────────

const relay = () => async (url) => ({
  ok: true, status: 200, text: async () => "",
  json: async () =>
    url.endsWith("/api/join-policy")
      ? {}
      : { status: "joined", community_id: "kychee", host: "relay.example", role: "member" },
});

const joinStore = () => ({
  // AC-72: node calls name their hive. This fake holds one, but it accepts the
  // real shape — a fake with the old arity would take a pubkey for a secret.
  async getNodePrivateKey(_pubkey) { return SK; },
  async createNodePrivateKey(_pubkey, _secret) {},
});

test("the join asks for a name, publishes it, and records it", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  const published = [];
  const result = await runJoin({
    link: LINK, store: joinStore(), stateDir, consent: async () => ({ accepted: true }),
    fetchImpl: relay(), now, log: () => {}, nodePubkey: derivePubkey(SK),
    askName: async () => "Barry's hive",
    publishProfile: async (f) => published.push(f),
  });
  assert.equal(result.displayName, "Barry's hive");
  assert.equal(published[0].name, "Barry's hive");
  assert.equal(published[0].privateKeyHex, SK, "the node's own key, not a human's");
  assert.equal(readJoinRecord(stateDir).displayName, "Barry's hive");
});

test("skipping the name leaves a joined node and the command to fix it", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  const lines = [];
  const result = await runJoin({
    link: LINK, store: joinStore(), stateDir, consent: async () => ({ accepted: true }),
    fetchImpl: relay(), now, log: (l) => lines.push(String(l)),
    askName: async () => "",
    publishProfile: async () => assert.fail("nothing to publish"),
  });
  assert.equal(result.displayName, null);
  assert.equal(result.status, "joined", "the join still happened");
  assert.match(lines.join("\n"), /hive402 profile --name/);
});

test("a failed publish does NOT report a failed join", async () => {
  // The membership is real. Reporting this as a join failure sends someone to
  // re-run the one part that worked, against an invite that may be single-use.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-pc-"));
  const lines = [];
  const result = await runJoin({
    link: LINK, store: joinStore(), stateDir, consent: async () => ({ accepted: true }),
    fetchImpl: relay(), now, log: (l) => lines.push(String(l)),
    askName: async () => "Barry's hive",
    publishProfile: async () => {
      throw new Error("buzz.exe ENOENT");
    },
  });
  assert.equal(result.status, "joined");
  assert.equal(result.displayName, null);
  const said = lines.join("\n");
  assert.match(said, /joined, but the name could not be published/);
  assert.match(said, /buzz\.exe ENOENT/, "and says why");
  assert.match(said, /hive402 profile --name "Barry's hive"/, "and how to finish it");
});

// ── One stdin, two questions ──────────────────────────────────────────────

test("consent and the name question share one reader, so neither eats the other's line", async () => {
  // The join asks for consent and then for a display name. Two readers on one
  // stdin is the same defect as one reader per question: whichever consumes the
  // chunk keeps the line the other was waiting for, and the command hangs.
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  // One chunk, three answers — the shape a paste or a piped heredoc produces.
  input.write("accept\nyes\nBarry's hive\n");
  input.end();

  const reader = lineReader({ input, output });
  const consent = terminalConsent({ input, output, reader });

  const answer = await consent({
    version: "v1", terms: "t", privacy: "p", ageAttestationRequired: true,
    termsUrl: "u", privacyUrl: "u",
  });
  assert.deepEqual(answer, { accepted: true, ageConfirmed: true });

  const name = await reader.ask("name? ");
  assert.equal(name, "Barry's hive", "the third line survived the first two questions");
});
