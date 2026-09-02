// The node's liveness record (AC-60, DD-53 as amended 2026-08-30).
//
// FOUND BY THE LIVE CHECK: relay presence (kind 20001) is CONNECTION-BOUND.
// `connection.rs` clears it for the authenticated pubkey the moment the
// socket closes — at the running local image and at buzz `origin/main`
// c856be0fb alike — so it works for buzz-acp agents, which hold their
// sockets, and can never work for a node that talks through one-shot CLI
// calls: every `set-presence` was accepted and then erased on the clean
// disconnect, milliseconds later. The hermetic suite could not see it; the
// local relay did, on the first run.
//
// So the node's liveness is a RECORD, not a connection: a kind-30315 status
// on the `hive402-liveness` coordinate (parameterised replaceable, world-
// readable — the same kind a profile status line uses, on its own d), with a
// 5-minute NIP-40 expiration, republished every 60 seconds through the
// NIP-98 `/events` door the node already uses for its 30177 records. A
// killed node stops republishing and reads offline within 5 minutes; a
// graceful stop publishes "offline" with a short expiry and reads offline at
// once. Readers apply the expiry themselves (`livenessOf`), so a relay that
// purges lazily changes nothing.
//
// A failed publish is logged and swallowed: liveness is a courtesy to OTHER
// rooms' nodes, and must never be the reason this node's own room goes down.

import { signEvent } from "../identity/nostrevent.mjs";

// One publish a minute against a 5-minute expiry: two beats may be lost to a
// blip before a live node reads offline, and AC-60's bound holds in the worst
// case — a death right after a beat reads offline at +5min.
export const HEARTBEAT_MS = 60_000;
export const LIVENESS_TTL_SEC = 300;
export const LIVENESS_D = "hive402-liveness";
export const KIND_USER_STATUS = 30315;

// How long an "offline" goodbye lingers: long enough for any in-flight cover
// pass to read it, short enough to purge fast.
const OFFLINE_TTL_SEC = 60;

// The signed record. `now` is milliseconds, like `signEvent` expects.
export function buildLiveness({ privateKeyHex, status, now = Date.now() }) {
  const ttl = status === "online" ? LIVENESS_TTL_SEC : OFFLINE_TTL_SEC;
  return signEvent({
    privateKeyHex,
    kind: KIND_USER_STATUS,
    tags: [
      ["d", LIVENESS_D],
      ["expiration", String(Math.floor(now / 1000) + ttl)],
    ],
    content: status,
    now,
  });
}

// Which of these authors are alive, read from their liveness records.
//
// Returns a Map of pubkey → "online" | "offline"; an author absent from the
// map published nothing usable, which readers treat as offline. The expiry is
// enforced HERE, not trusted to the relay: a lazily-purging relay may serve
// an expired record, and an expired claim of "online" is exactly the false
// positive the whole scheme exists to avoid.
export function livenessOf(rows, { nowSec }) {
  const newest = new Map(); // pubkey -> { at, status }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== KIND_USER_STATUS) continue;
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (!tags.some((t) => Array.isArray(t) && t[0] === "d" && t[1] === LIVENESS_D)) continue;
    const expiration = Number(tags.find((t) => Array.isArray(t) && t[0] === "expiration")?.[1]);
    if (!Number.isFinite(expiration) || expiration <= nowSec) continue;
    const at = Number.isFinite(row.created_at) ? row.created_at : 0;
    if (at > nowSec + LIVENESS_TTL_SEC) continue; // hostile future-dating buys nothing
    const status = row.content === "online" ? "online" : "offline";
    const author = String(row.pubkey ?? "").toLowerCase();
    if (!author) continue;
    const seen = newest.get(author);
    if (!seen || at > seen.at) newest.set(author, { at, status });
  }
  return new Map([...newest.entries()].map(([author, { status }]) => [author, status]));
}

export class Heartbeat {
  #publish;
  #intervalMs;
  #log;
  #schedule;
  #cancel;
  #timer = null;

  constructor({
    // async (status) => void — builds and submits the record. Supplied by the
    // supervisor so this class stays pure scheduling.
    publish,
    intervalMs = HEARTBEAT_MS,
    log = () => {},
    // Injected so tests drive beats by hand. The production default unrefs the
    // timer where the runtime allows: the heartbeat must never be what keeps a
    // stopping node's event loop alive.
    schedule = (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return timer;
    },
    cancel = (timer) => clearInterval(timer),
  }) {
    this.#publish = publish;
    this.#intervalMs = intervalMs;
    this.#log = log;
    this.#schedule = schedule;
    this.#cancel = cancel;
  }

  // Publish "online" now, then keep publishing it on the interval. Awaitable
  // so a caller (and a test) knows the first record has actually gone out.
  async start() {
    await this.beat();
    this.#timer = this.#schedule(() => this.beat(), this.#intervalMs);
  }

  async beat() {
    try {
      await this.#publish("online");
    } catch (err) {
      this.#log(`hive402: liveness publish failed: ${err.message} — retrying on the next beat`);
    }
  }

  // Cancel the schedule and say "offline" once, best effort: a graceful stop
  // reads offline immediately instead of five minutes later. Failure is
  // tolerated for the same reason a failed beat is — the relay being gone
  // must never make stopping fail.
  async stop() {
    if (!this.#timer) return;
    this.#cancel(this.#timer);
    this.#timer = null;
    try {
      await this.#publish("offline");
    } catch (err) {
      this.#log(`hive402: could not publish the offline liveness record: ${err.message}`);
    }
  }
}
