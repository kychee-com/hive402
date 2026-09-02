// FIX-115 — `hive402 join <invite-link>` (AC-44, AC-45, AC-43).
//
// The join existed only as a session script: a person pasted commands, read the
// terms somewhere else, and the claim went out. AC-44 makes it the product, and
// AC-45 puts a condition on it that a script cannot own — the human must be
// SHOWN the policy and must accept it explicitly, and a missing acceptance is a
// stop rather than a default.
//
// Wire format read from buzz `origin/main` 29f2054c:
//
//   GET  /api/join-policy            -> {} | { policy: { terms_markdown,
//                                       privacy_markdown, version,
//                                       age_attestation_required } }
//   POST /api/invites/accept-policy  -> { receipt }   (NOT NIP-98 signed: the
//                                       handler takes no headers)
//   POST /api/invites/claim          -> { status, community_id, host, role }
//                                       (NIP-98 signed, payload tag required)
//
// The invite LINK is `https://<host>/invite/<code>` — `is_invite_landing_path`
// in crates/buzz-relay/src/router.rs accepts exactly one non-empty segment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { joinCommunity, parseInviteLink } from "../src/registry/join.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const CODE = "v2.YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE";
const LINK = `https://relay.example/invite/${CODE}`;
const now = 1_700_000_000_000;

const POLICY = {
  terms_markdown: "# Terms\n\nBe decent to each other.",
  privacy_markdown: "# Privacy\n\nWe keep what you post.",
  age_attestation_required: true,
  version: "2026-08-01",
};

// A fetch double that records every call and answers from a route table.
function relay({ policy = null, claim = { status: "joined", community_id: "kychee", host: "relay.example", role: "member" }, fail = null } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body ?? null });
    const reply = (status, payload) => ({
      ok: status < 400,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    if (fail && url.endsWith(fail.path)) return reply(fail.status, { error: fail.error });
    if (url.endsWith("/api/join-policy")) return reply(200, policy ? { policy } : {});
    if (url.endsWith("/api/invites/accept-policy")) return reply(200, { receipt: "receipt-abc" });
    if (url.endsWith("/api/invites/claim")) return reply(200, claim);
    return reply(404, { error: "not found" });
  };
  return { impl, calls, to: (suffix) => calls.filter((c) => c.url.endsWith(suffix)) };
}

const accepts = () => async () => ({ accepted: true, ageConfirmed: true });
const declines = () => async () => ({ accepted: false, ageConfirmed: false });
const never = (label) => () => {
  throw new Error(`${label} must not be reached on the join path`);
};

// ── The link ──────────────────────────────────────────────────────────────

test("an invite link is an origin and a code", () => {
  assert.deepEqual(parseInviteLink(LINK), { origin: "https://relay.example", code: CODE });
  assert.deepEqual(parseInviteLink("http://127.0.0.1:3000/invite/v2.abc"), {
    origin: "http://127.0.0.1:3000",
    code: "v2.abc",
  });
});

test("a link that is not an invite link is refused with the shape it should have", () => {
  for (const bad of [
    "",
    "relay.example/invite/v2.abc", // no scheme: cannot be signed against
    "https://relay.example/",
    "https://relay.example/invite/",
    "https://relay.example/invite/a/b",
    "https://relay.example/channels/abc",
    "ftp://relay.example/invite/v2.abc",
  ]) {
    assert.throws(() => parseInviteLink(bad), /invite link/i, JSON.stringify(bad));
  }
});

// ── AC-45: the consent gate ───────────────────────────────────────────────

test("a community with no join policy is claimed without inventing a consent step", async () => {
  const r = relay({ policy: null });
  const result = await joinCommunity({
    link: LINK,
    privateKeyHex: SK,
    consent: never("consent"),
    fetchImpl: r.impl,
    now,
    log: () => {},
  });
  assert.equal(result.status, "joined");
  assert.equal(result.policyVersion, null);
  assert.equal(r.to("/api/invites/accept-policy").length, 0);
  assert.equal(r.to("/api/invites/claim").length, 1);
});

test("the human is SHOWN the policy before being asked", async () => {
  const r = relay({ policy: POLICY });
  const shown = [];
  await joinCommunity({
    link: LINK,
    privateKeyHex: SK,
    consent: async (policy) => {
      shown.push(policy);
      return { accepted: true, ageConfirmed: true };
    },
    fetchImpl: r.impl,
    now,
    log: () => {},
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].version, POLICY.version);
  assert.equal(shown[0].ageAttestationRequired, true);
  assert.match(shown[0].terms, /Be decent/);
  assert.match(shown[0].privacy, /We keep what you post/);
  // …and the browser-readable copies, since the terms run to ~75k characters
  // and paging them into a terminal by default is not showing them (DD-47).
  assert.equal(shown[0].termsUrl, "https://relay.example/api/join-policy/terms");
  assert.equal(shown[0].privacyUrl, "https://relay.example/api/join-policy/privacy");
});

test("a refusal is a STOP — nothing is claimed and nothing is accepted", async () => {
  const r = relay({ policy: POLICY });
  await assert.rejects(
    joinCommunity({ link: LINK, privateKeyHex: SK, consent: declines(), fetchImpl: r.impl, now, log: () => {} }),
    /not accepted|stopped/i,
  );
  assert.equal(r.to("/api/invites/accept-policy").length, 0, "no acceptance may be sent");
  assert.equal(r.to("/api/invites/claim").length, 0, "and nothing may be claimed");
});

test("a missing age attestation is a stop, not a default", async () => {
  // AC-45: hive402 never makes an attestation on a person's behalf. The relay
  // would refuse it anyway (join_policy_not_accepted), but sending someone
  // else's age assertion and letting the relay decline it is not the same
  // thing as declining to make it.
  const r = relay({ policy: POLICY });
  await assert.rejects(
    joinCommunity({
      link: LINK,
      privateKeyHex: SK,
      consent: async () => ({ accepted: true, ageConfirmed: false }),
      fetchImpl: r.impl,
      now,
      log: () => {},
    }),
    /age/i,
  );
  assert.equal(r.to("/api/invites/accept-policy").length, 0);
  assert.equal(r.to("/api/invites/claim").length, 0);
});

test("a policy with no age requirement does not demand an attestation", async () => {
  const r = relay({ policy: { ...POLICY, age_attestation_required: false } });
  const result = await joinCommunity({
    link: LINK,
    privateKeyHex: SK,
    consent: async () => ({ accepted: true, ageConfirmed: false }),
    fetchImpl: r.impl,
    now,
    log: () => {},
  });
  assert.equal(result.status, "joined");
  assert.equal(JSON.parse(r.to("/api/invites/accept-policy")[0].body).age_confirmed, false);
});

// ── The wire ──────────────────────────────────────────────────────────────

test("acceptance is sent for the exact version shown, bound to this code", async () => {
  const r = relay({ policy: POLICY });
  await joinCommunity({ link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, log: () => {} });
  const accept = r.to("/api/invites/accept-policy")[0];
  assert.equal(accept.method, "POST");
  assert.deepEqual(JSON.parse(accept.body), { code: CODE, policy_version: POLICY.version, age_confirmed: true });
  // The relay's accept_policy handler takes no headers at all — signing it
  // would be inventing a requirement.
  assert.equal(accept.headers.authorization ?? accept.headers.Authorization, undefined);
});

test("the claim carries the receipt and a NIP-98 signature over its own body", async () => {
  const r = relay({ policy: POLICY });
  await joinCommunity({ link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, log: () => {} });
  const claim = r.to("/api/invites/claim")[0];
  assert.equal(claim.method, "POST");
  assert.deepEqual(JSON.parse(claim.body), { code: CODE, policy_receipt: "receipt-abc" });

  const header = claim.headers.Authorization ?? claim.headers.authorization;
  assert.match(header, /^Nostr /);
  const event = JSON.parse(Buffer.from(header.replace(/^Nostr /, ""), "base64").toString("utf8"));
  assert.equal(event.kind, 27235);
  const tag = (n) => event.tags.find((t) => t[0] === n)?.[1];
  assert.equal(tag("u"), "https://relay.example/api/invites/claim", "the u tag is the URL actually posted to");
  assert.equal(tag("method"), "POST");
  assert.ok(tag("payload"), "the invite routes require the payload tag");
});

test("already a member is a success, not a failure", async () => {
  // Claims are idempotent upstream. Re-running setup must not read as broken.
  const r = relay({ claim: { status: "already_member", community_id: "kychee", host: "relay.example", role: "member" } });
  const result = await joinCommunity({
    link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, log: () => {},
  });
  assert.equal(result.status, "already_member");
  assert.equal(result.alreadyMember, true);
});

test("a refused claim says which of the relay's reasons it was", async () => {
  for (const [error, expected] of [
    ["invite_expired", /expired/i],
    ["invite_exhausted", /used up|exhausted/i],
    ["invite_invalid", /not valid|invalid/i],
    ["join_policy_required", /policy/i],
  ]) {
    const r = relay({ fail: { path: "/api/invites/claim", status: 403, error } });
    await assert.rejects(
      joinCommunity({ link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, log: () => {} }),
      expected,
      error,
    );
  }
});

// ── AC-45: the version accepted is recorded ───────────────────────────────

test("the exact policy version accepted is written down", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-join-"));
  const r = relay({ policy: POLICY });
  const result = await joinCommunity({
    link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, stateDir, log: () => {},
  });
  assert.equal(result.policyVersion, POLICY.version);

  const record = JSON.parse(readFileSync(path.join(stateDir, "join.json"), "utf8"));
  assert.equal(record.policyVersion, POLICY.version);
  assert.equal(record.host, "relay.example");
  assert.equal(record.communityId, "kychee");
  assert.equal(record.origin, "https://relay.example");
  assert.equal(record.acceptedAt, now);
  assert.equal(record.ageConfirmed, true);
  assert.equal(
    record.pubkey,
    "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a",
    "the record names the identity that joined, so the next command knows who it is",
  );
  assert.ok(!JSON.stringify(record).includes(SK), "and never the secret");
});

test("nothing is recorded when the join did not happen", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-join-"));
  const r = relay({ policy: POLICY });
  await assert.rejects(
    joinCommunity({ link: LINK, privateKeyHex: SK, consent: declines(), fetchImpl: r.impl, now, stateDir, log: () => {} }),
  );
  assert.equal(existsSync(path.join(stateDir, "join.json")), false);
});

// ── AC-43: no human key, anywhere on this path ────────────────────────────

test("nothing on the join path can reach the secret prompt", async () => {
  // Structural, because this is a property of the PATH rather than of one run:
  // the thing AC-43 forbids is hive402 ever ASKING, and a behavioural test only
  // proves it did not ask this time. Walked from the COMMAND, not from the
  // protocol module, so the consent prompt and the credential store are inside
  // the graph being checked.
  const { readFileSync: read } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  const seen = new Set();
  const queue = [path.join(root, "src", "registry", "joincommand.mjs")];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = read(file, "utf8");
    } catch {
      continue;
    }
    for (const [, spec] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
      if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
    }
  }
  const reached = [...seen].map((f) => path.relative(root, f).replace(/\\/g, "/"));
  assert.ok(reached.includes("src/registry/join.mjs"), "sanity: the walk found the module it starts from");
  assert.ok(
    !reached.includes("src/credentials/prompt.mjs"),
    `the join path reaches the secret prompt: ${reached.join(", ")}`,
  );
});

test("the joining key is the node's own, and it is never sent", async () => {
  const r = relay({ policy: POLICY });
  await joinCommunity({ link: LINK, privateKeyHex: SK, consent: accepts(), fetchImpl: r.impl, now, log: () => {} });
  for (const call of r.calls) {
    assert.ok(!JSON.stringify(call).includes(SK), `the secret key reached the wire in ${call.url}`);
  }
});
