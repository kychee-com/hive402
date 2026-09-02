// NIP-98 HTTP auth (kind:27235) — the one signature hive402 makes itself.
//
// Everything else hive402 publishes goes out through the `buzz` CLI, which
// holds the key and signs. Joining a community cannot: `buzz` has no invite
// verb at all (there is no `invites` group in `Cmd`, checked at buzz
// `origin/main` 29f2054c), and the relay's join routes are plain HTTP outside
// the Nostr data plane. So the node signs its own HTTP request, with the key it
// minted for itself — which is what makes AC-43 possible. A human's secret is
// never involved, at any point on this path.
//
// Contract transcribed from crates/buzz-auth/src/nip98.rs and
// crates/buzz-relay/src/api/bridge.rs at that same commit:
//
//   Authorization: Nostr <base64(JSON event)>       standard base64, padded
//   kind        27235
//   created_at  within ±60s of RELAY time (so this is not a place to be clever
//               with clocks — the caller passes real `now` and the request goes
//               out immediately)
//   ["u", url]        compared after normalising scheme/host case and a
//                     trailing slash, and NOT aliasing loopback names:
//                     `localhost` and `127.0.0.1` are different hosts to it.
//   ["method", M]     case-insensitive
//   ["payload", hex]  SHA-256 of the exact request body. The invite routes are
//                     the strict ones — `require_payload = true` — so a POST
//                     without this tag is refused before the signature is
//                     checked at all.

import { randomBytes } from "node:crypto";

import { digestHex, pubkeyOf, signEvent } from "./nostrevent.mjs";

const HEX64 = /^[0-9a-f]{64}$/i;
const hex = (u8) => Buffer.from(u8).toString("hex");
const digest = digestHex;

export function signNip98({ privateKeyHex, url, method, body = null, now = Date.now() }) {
  if (!HEX64.test(privateKeyHex ?? "")) {
    throw new Error("nip98: the signing key must be 64-char hex");
  }
  // A relative URL signs a string the relay can never match, and the failure
  // arrives as an opaque 401 several layers away from the mistake.
  if (!/^https?:\/\//i.test(String(url ?? ""))) {
    throw new Error(`nip98: the signed URL must be absolute (got "${url}")`);
  }

  pubkeyOf(privateKeyHex); // refuses a key that is not one, before any work
  const tags = [
    ["u", String(url)],
    ["method", String(method).toUpperCase()],
    // FOUND BY RUNNING IT AGAINST A REAL RELAY (2026-08-25): without this, two
    // identical requests in the same SECOND are the same event.
    //
    // Everything else here is deterministic — key, url, method, body hash — and
    // `created_at` is in seconds, so a retry inside one second produced a
    // byte-identical event, an identical id, and `401 NIP-98: replay detected`
    // from the relay's replay guard (`check_nip98_replay`, keyed on event id).
    // That lands on the command most likely to be re-run: `setup` is designed
    // to be resumable, and the answer a person got for re-running it was a
    // sentence about replay attacks.
    //
    // A signature has to be unique per REQUEST, not per second. The relay reads
    // only `u`, `method` and `payload` (`verify_nip98_event`) and ignores tags
    // it does not know, so this changes the id and nothing else.
    ["nonce", hex(randomBytes(16))],
  ];
  // Only when there IS a body. A payload tag over an empty body is a hash of
  // nothing that the relay would then check against nothing.
  if (body !== null && body !== undefined && body !== "") {
    tags.push(["payload", digest(String(body))]);
  }

  // Serialising, hashing and signing is the same operation for every kind, and
  // it lives in one place (`nostrevent.mjs`) so a second copy cannot grow a
  // different id calculation — see the note there.
  return { event: signEvent({ privateKeyHex, kind: 27235, tags, content: "", now }) };
}

export function nip98Header(options) {
  const { event } = signNip98(options);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}
