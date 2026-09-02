// NIP-98 HTTP auth (kind:27235) — the signature the relay's invite API wants.
//
// hive402 had no HTTP signer at all: everything it publishes goes through the
// `buzz` CLI, and `buzz` has no invite verb (there is no `invites` group in
// `Cmd` — checked at origin/main 29f2054c). So joining a community is the one
// thing the node has to sign for itself.
//
// The contract is transcribed from crates/buzz-auth/src/nip98.rs and
// crates/buzz-relay/src/api/bridge.rs at buzz `origin/main` 29f2054c:
//
//   Authorization: Nostr <base64(JSON event)>      (standard base64, padded)
//   kind        27235
//   created_at  within ±60s of relay time
//   ["u", url]        matched after normalising scheme/host case and trailing /
//   ["method", M]     case-insensitive
//   ["payload", h]    hex SHA-256 of the exact request body. The invite routes
//                     pass require_payload = true, so a POST without this tag
//                     is rejected before the signature is even checked.
//
// The URL the relay expects is built from the tenant's own Host header, not
// from its configured relay_url — so the `u` tag must carry exactly the origin
// the request is sent to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { nip98Header, signNip98 } from "../src/identity/nip98.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const PK = Buffer.from(schnorr.getPublicKey(Uint8Array.from(Buffer.from(SK, "hex")))).toString("hex");
const now = 1_700_000_000_000;

const decode = (header) => JSON.parse(Buffer.from(header.replace(/^Nostr /, ""), "base64").toString("utf8"));
const tagOf = (event, name) => event.tags.find((t) => t[0] === name)?.[1] ?? null;

test("the header is the scheme the relay reads", () => {
  const header = nip98Header({
    privateKeyHex: SK,
    url: "https://relay.example/api/invites/claim",
    method: "POST",
    body: '{"code":"v2.aaa"}',
    now,
  });
  assert.match(header, /^Nostr [A-Za-z0-9+/]+=*$/, "Authorization: Nostr <standard base64>");
  const event = decode(header);
  assert.equal(event.kind, 27235);
  assert.equal(event.pubkey, PK);
  assert.equal(event.content, "");
});

test("the u tag is the exact URL the request is sent to", () => {
  // The relay rebuilds this from the tenant Host header, so anything but the
  // literal request URL is a mismatch — and it does not alias loopback names.
  const { event } = signNip98({
    privateKeyHex: SK,
    url: "http://127.0.0.1:3000/api/invites/claim",
    method: "POST",
    body: "{}",
    now,
  });
  assert.equal(tagOf(event, "u"), "http://127.0.0.1:3000/api/invites/claim");
  assert.equal(tagOf(event, "method"), "POST");
});

test("a POST carries the payload tag, because the invite routes require one", () => {
  const body = '{"code":"v2.aaa","policy_receipt":"r"}';
  const { event } = signNip98({ privateKeyHex: SK, url: "https://r/api/invites/claim", method: "POST", body, now });
  const expected = Buffer.from(sha256(new TextEncoder().encode(body))).toString("hex");
  assert.equal(tagOf(event, "payload"), expected);
});

test("a body-less request carries no payload tag", () => {
  const { event } = signNip98({ privateKeyHex: SK, url: "https://r/api/join-policy", method: "GET", now });
  assert.equal(tagOf(event, "payload"), null);
});

test("the id is the NIP-01 serialisation, and the signature verifies over it", () => {
  // If the id is computed any other way the relay's verify_event fails and the
  // whole join is a 401 with a message about the signature, which is the least
  // debuggable failure this command could have.
  const { event } = signNip98({ privateKeyHex: SK, url: "https://r/api/invites/claim", method: "POST", body: "{}", now });
  const serialised = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const id = Buffer.from(sha256(new TextEncoder().encode(serialised))).toString("hex");
  assert.equal(event.id, id, "id must be sha256 of the NIP-01 array form");
  assert.ok(
    schnorr.verify(
      Uint8Array.from(Buffer.from(event.sig, "hex")),
      Uint8Array.from(Buffer.from(event.id, "hex")),
      Uint8Array.from(Buffer.from(event.pubkey, "hex")),
    ),
    "signature must verify over the id, by the node's key",
  );
});

test("created_at is seconds, not milliseconds", () => {
  // A ±60 SECOND window against a millisecond timestamp is a rejection every
  // time, and the error the relay returns names a delta of fifty thousand years.
  const { event } = signNip98({ privateKeyHex: SK, url: "https://r/api/x", method: "GET", now });
  assert.equal(event.created_at, Math.floor(now / 1000));
});

test("a key that is not a key is refused before anything is signed", () => {
  for (const bad of [undefined, "", "nope", "aa", SK.slice(0, 63)]) {
    assert.throws(
      () => signNip98({ privateKeyHex: bad, url: "https://r/api/x", method: "GET", now }),
      /64-char hex/i,
      String(bad),
    );
  }
});

test("the URL must be absolute, because a relative one signs nothing the relay can match", () => {
  assert.throws(
    () => signNip98({ privateKeyHex: SK, url: "/api/invites/claim", method: "POST", body: "{}", now }),
    /absolute/i,
  );
});

// FOUND BY RUNNING IT AGAINST A REAL RELAY (2026-08-25).
//
// Two `hive402 join` calls in the same second produced a byte-identical event —
// same key, same url, same method, same body, and `created_at` is in SECONDS —
// so the id was identical and the relay answered the second one with
// `401 NIP-98: replay detected` (`check_nip98_replay`, keyed on event id).
//
// That lands on the command most likely to be re-run: `setup` is designed to be
// resumable, and the error a person would see for re-running it is a sentence
// about replay attacks. The signature has to be unique per REQUEST, not per
// second, so every event carries a random nonce.
//
// The relay ignores tags it does not know — `verify_nip98_event` reads `u`,
// `method` and `payload` and nothing else — so this changes the id and nothing
// about verification.
test("two signings of the SAME request are different events", () => {
  const same = { privateKeyHex: SK, url: "https://r/api/invites/claim", method: "POST", body: "{}", now };
  const a = signNip98(same).event;
  const b = signNip98(same).event;
  assert.notEqual(a.id, b.id, "an identical retry must not be a replay of the first attempt");
  assert.equal(a.created_at, b.created_at, "and it is not the clock that makes them differ");
});

test("the nonce is a tag the relay ignores, not a change to what is signed", () => {
  const { event } = signNip98({ privateKeyHex: SK, url: "https://r/api/x", method: "POST", body: "{}", now });
  const nonce = event.tags.find((t) => t[0] === "nonce");
  assert.ok(nonce, "there is a nonce tag");
  assert.match(nonce[1], /^[0-9a-f]{32}$/, "and it is random hex");
  // The three tags the relay actually reads are untouched.
  assert.equal(tagOf(event, "u"), "https://r/api/x");
  assert.equal(tagOf(event, "method"), "POST");
  assert.ok(tagOf(event, "payload"));
});
