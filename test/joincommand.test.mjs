// FIX-115, the command layer: `hive402 join` end to end (AC-44, AC-45, AC-43).
//
// `join.test.mjs` covers the protocol. This covers the two decisions the
// command makes on top of it:
//
//   1. Where the node's key comes from. AC-44 says setup is ONE guided step
//      covering identity, join, name, agent and first channel — so a machine
//      with no node identity gets one minted here rather than being told to go
//      and run `keygen` first. That is the difference between a flow and a
//      checklist, and the checklist is what put a human key in the middle of
//      the old join.
//   2. That a person is genuinely asked. `terminalConsent` is the thing AC-45
//      is actually about, so it is exercised against real streams rather than
//      described.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";

import { runJoin } from "../src/registry/joincommand.mjs";
import { readJoinRecord } from "../src/registry/joinrecord.mjs";
import { terminalConsent } from "../src/registry/consent.mjs";
import { derivePubkey } from "../src/credentials/keys.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const CODE = "v2.YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
const LINK = `https://relay.example/invite/${CODE}`;
const now = 1_700_000_000_000;

const POLICY = {
  terms_markdown: Array.from({ length: 200 }, (_, i) => `term line ${i}`).join("\n"),
  privacy_markdown: "# Privacy\n\nshort",
  age_attestation_required: true,
  version: "2026-08-01",
};

function fakeStore({ nodeKey = null } = {}) {
  const calls = [];
  return {
    calls,
    // AC-72: every node call names its hive. The fake models one hive, but it
    // takes the real arguments — a fake that shifted them would read a pubkey
    // as a secret and pass for the wrong reason.
    async getNodePrivateKey(_pubkey) {
      calls.push("get");
      return nodeKey;
    },
    async createNodePrivateKey(_pubkey, secret) {
      calls.push("create");
      nodeKey = secret;
    },
    async setNodePrivateKey() {
      calls.push("set");
      throw new Error("join must never overwrite an existing node key");
    },
    current: () => nodeKey,
  };
}

const relay = ({ policy = null } = {}) => {
  const calls = [];
  return {
    calls,
    impl: async (url, options = {}) => {
      calls.push({ url, ...options });
      const reply = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => "" });
      if (url.endsWith("/api/join-policy")) return reply(policy ? { policy } : {});
      if (url.endsWith("/api/invites/accept-policy")) return reply({ receipt: "r" });
      return reply({ status: "joined", community_id: "kychee", host: "relay.example", role: "member" });
    },
  };
};

const accepts = async () => ({ accepted: true, ageConfirmed: true });

// ── The identity the node joins with ──────────────────────────────────────

test("a machine with no node identity gets one, and is told so", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-jc-"));
  const store = fakeStore({ nodeKey: null });
  const lines = [];
  const result = await runJoin({
    link: LINK,
    store,
    stateDir,
    consent: accepts,
    fetchImpl: relay().impl,
    now,
    log: (l) => lines.push(String(l)),
    generate: () => SK,
  });

  assert.deepEqual(
    store.calls,
    ["create"],
    "created, never set — a race must lose, not overwrite. Since AC-72 there is no " +
      "machine-wide slot to consult first: nothing named a hive, so this IS a new one.",
  );
  assert.equal(result.pubkey, derivePubkey(SK));
  const said = lines.join("\n");
  assert.match(said, /had no identity/i, "minting an identity is announced");
  assert.match(said, new RegExp(derivePubkey(SK)), "and the pubkey is shown");
  assert.ok(!said.includes(SK), "but never the secret");
  assert.match(said, /not asked for your\s+own key/i, "and it says whose key this is not");
});

test("an existing node identity is reused, never replaced", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-jc-"));
  const store = fakeStore({ nodeKey: SK });
  await runJoin({
    link: LINK, store, stateDir, consent: accepts, fetchImpl: relay().impl, now, log: () => {},
    // AC-72: WHICH hive already exists here. A machine may hold several, so
    // "an existing identity" is one the caller names — the config's own
    // node.pubkey — rather than whatever the machine happened to hold.
    nodePubkey: derivePubkey(SK),
    generate: () => { throw new Error("must not generate over an existing identity"); },
  });
  assert.deepEqual(store.calls, ["get"]);
});

test("a bad link does not mint an identity", async () => {
  // Ordering matters: parse before generate, or a typo leaves a stray identity
  // in the credential store that the operator did not ask for and cannot see.
  const store = fakeStore({ nodeKey: null });
  await assert.rejects(
    runJoin({ link: "nope", store, stateDir: mkdtempSync(path.join(tmpdir(), "hive402-jc-")), consent: accepts, fetchImpl: relay().impl, now, log: () => {} }),
    /invite link/i,
  );
  assert.deepEqual(store.calls, [], "nothing touched the credential store");
});

test("joining a different community than the record says is called out", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-jc-"));
  const store = fakeStore({ nodeKey: SK });
  await runJoin({ link: LINK, store, stateDir, consent: accepts, fetchImpl: relay().impl, now, log: () => {} });

  const lines = [];
  await runJoin({
    link: `https://other.example/invite/${CODE}`,
    store, stateDir, consent: accepts, fetchImpl: relay().impl, now,
    log: (l) => lines.push(String(l)),
  });
  assert.match(lines.join("\n"), /already has a join record for https:\/\/relay\.example/);
});

test("the join record is readable back by the commands that come after", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-jc-"));
  const store = fakeStore({ nodeKey: SK });
  await runJoin({ link: LINK, store, stateDir, consent: accepts, fetchImpl: relay({ policy: POLICY }).impl, now, log: () => {}, nodePubkey: derivePubkey(SK) });
  const record = readJoinRecord(stateDir);
  assert.equal(record.policyVersion, POLICY.version);
  assert.equal(record.pubkey, derivePubkey(SK));
  assert.equal(readJoinRecord(mkdtempSync(path.join(tmpdir(), "hive402-empty-"))), null);
});

// ── AC-45: a person is genuinely asked ────────────────────────────────────

function terminal(typed) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on("data", (c) => written.push(String(c)));
  for (const line of typed) input.write(`${line}\n`);
  input.end();
  return { input, output, said: () => written.join("") };
}

test("typing the word accepts, and the age question is asked separately", async () => {
  const t = terminal(["accept", "yes"]);
  const answer = await terminalConsent({ input: t.input, output: t.output })({
    version: POLICY.version,
    terms: POLICY.terms_markdown,
    privacy: POLICY.privacy_markdown,
    ageAttestationRequired: true,
    termsUrl: "https://relay.example/api/join-policy/terms",
    privacyUrl: "https://relay.example/api/join-policy/privacy",
  });
  assert.deepEqual(answer, { accepted: true, ageConfirmed: true });
  const said = t.said();
  assert.match(said, /Policy version: 2026-08-01/);
  assert.match(said, /term line 0/, "the terms are actually shown");
  assert.match(said, /shortened. Full text: https:\/\/relay\.example\/api\/join-policy\/terms/);
  assert.ok(!said.includes("term line 199"), "…but 200 lines are not paged into the terminal by default");
});

test("anything other than the word is a refusal", async () => {
  for (const typed of ["y", "yes", "", "ACCEPTABLE", "no"]) {
    const t = terminal([typed]);
    const answer = await terminalConsent({ input: t.input, output: t.output })({
      version: "v1", terms: "t", privacy: "p", ageAttestationRequired: false,
      termsUrl: "u", privacyUrl: "u",
    });
    assert.equal(answer.accepted, false, `"${typed}" must not accept`);
    assert.match(t.said(), /Not accepted/);
  }
});

test("accepting the terms is not accepting an age statement", async () => {
  // Two statements, two answers. Folding them together would make hive402 the
  // one asserting the second, which AC-45 forbids in as many words.
  const t = terminal(["accept", "no"]);
  const answer = await terminalConsent({ input: t.input, output: t.output })({
    version: "v1", terms: "t", privacy: "p", ageAttestationRequired: true,
    termsUrl: "u", privacyUrl: "u",
  });
  assert.deepEqual(answer, { accepted: false, ageConfirmed: false });
  assert.match(t.said(), /Age attestation not given/);
});

test("a closed stdin is a refusal, not an acceptance", async () => {
  // The unattended case: a script pipes nothing. It must never read as consent.
  const t = terminal([]);
  const answer = await terminalConsent({ input: t.input, output: t.output })({
    version: "v1", terms: "t", privacy: "p", ageAttestationRequired: false,
    termsUrl: "u", privacyUrl: "u",
  });
  assert.equal(answer.accepted, false);
});

test("--show-terms prints the whole document", async () => {
  const t = terminal(["accept"]);
  await terminalConsent({ input: t.input, output: t.output, showTerms: true })({
    version: "v1", terms: POLICY.terms_markdown, privacy: "p", ageAttestationRequired: false,
    termsUrl: "u", privacyUrl: "u",
  });
  assert.match(t.said(), /term line 199/);
});

test("the policy version written down is the one that was shown", async () => {
  // The receipt the relay mints is bound to a version; if what we recorded and
  // what we showed could differ, the record would be a claim about a document
  // nobody read.
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-jc-"));
  const shown = [];
  await runJoin({
    link: LINK,
    store: fakeStore({ nodeKey: SK }),
    stateDir,
    consent: async (policy) => {
      shown.push(policy.version);
      return { accepted: true, ageConfirmed: true };
    },
    fetchImpl: relay({ policy: POLICY }).impl,
    now,
    log: () => {},
  });
  const record = JSON.parse(readFileSync(path.join(stateDir, "join.json"), "utf8"));
  assert.deepEqual(shown, [record.policyVersion]);
});

// FOUND BY RUNNING IT AGAINST REAL TERMS (2026-08-26).
//
// The summariser counted LINES. The Buzz Terms of Service put each paragraph on
// one line of several hundred characters, so "the first 40 lines" was about
// twenty thousand characters of dense legalese — not a summary, the whole thing
// with the end cut off. DD-47 asked for a summary precisely so the consent
// moment is readable, and a wall that size is how people learn to type the
// magic word without looking.
test("a summary of REAL terms is short enough to read", async () => {
  // One paragraph per line, each ~600 characters: the shape that broke it.
  const para = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(8);
  const terms = Array.from({ length: 40 }, (_, i) => `${i}. ${para}`).join("\n");
  const t = terminal(["accept"]);
  await terminalConsent({ input: t.input, output: t.output })({
    version: "v1", terms, privacy: "", ageAttestationRequired: false,
    termsUrl: "https://relay.example/api/join-policy/terms", privacyUrl: "u",
  });
  const said = t.said();
  assert.ok(said.length < 4000, `the consent screen was ${said.length} characters — nobody reads that`);
  assert.match(said, /shortened. Full text: https:\/\/relay\.example/);
  assert.match(said, /^0\. Lorem/m, "it still shows the beginning of the document");
});

test("short terms are shown whole, with no truncation notice", async () => {
  const t = terminal(["accept"]);
  await terminalConsent({ input: t.input, output: t.output })({
    version: "v1", terms: "Be decent to each other.", privacy: "", ageAttestationRequired: false,
    termsUrl: "u", privacyUrl: "u",
  });
  assert.match(t.said(), /Be decent to each other\./);
  assert.doesNotMatch(t.said(), /shortened/);
});
