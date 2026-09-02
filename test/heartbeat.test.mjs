// The node's own liveness (AC-60, DD-53 as amended).
//
// FOUND BY THE LIVE CHECK (2026-08-30): relay presence (kind 20001) is
// CONNECTION-BOUND — `connection.rs` clears it for the authenticated pubkey
// the moment the socket closes, at the running image AND at origin/main
// c856be0fb. buzz-acp agents hold their sockets, so agent presence works; a
// node that talks through one-shot CLI calls can never leave presence behind
// (each set is erased milliseconds later on clean disconnect). The relay
// ACCEPTED every publish while Redis held nothing — 1284 hermetic tests could
// not have seen it.
//
// So node liveness is a RECORD, not a connection: a kind-30315 status on the
// `hive402-liveness` coordinate with a 5-minute expiration, republished every
// 60 seconds through the NIP-98 `/events` door and read back through
// `/query`. A killed node stops republishing and reads offline within 5
// minutes; a graceful stop publishes "offline" and reads offline at once.
// Proven on the local relay before this rework was written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HEARTBEAT_MS,
  LIVENESS_D,
  LIVENESS_TTL_SEC,
  Heartbeat,
  buildLiveness,
  livenessOf,
} from "../src/node/heartbeat.mjs";
import { Supervisor } from "../src/node/supervisor.mjs";

const SK = "aa".repeat(32);
const A = (n) => n.repeat(64);

// ── The record ─────────────────────────────────────────────────────────────

test("buildLiveness signs a 30315 status on the liveness coordinate with a 5-minute expiry", () => {
  const now = 1_700_000_000_000;
  const event = buildLiveness({ privateKeyHex: SK, status: "online", now });
  assert.equal(event.kind, 30315);
  assert.equal(event.content, "online");
  assert.deepEqual(
    event.tags.find((t) => t[0] === "d"),
    ["d", LIVENESS_D],
  );
  assert.deepEqual(
    event.tags.find((t) => t[0] === "expiration"),
    ["expiration", String(Math.floor(now / 1000) + LIVENESS_TTL_SEC)],
  );
  assert.ok(event.sig, "signed");
});

test("an offline record carries a short expiry — it only needs to outlive the next read", () => {
  const now = 1_700_000_000_000;
  const event = buildLiveness({ privateKeyHex: SK, status: "offline", now });
  assert.equal(event.content, "offline");
  assert.deepEqual(
    event.tags.find((t) => t[0] === "expiration"),
    ["expiration", String(Math.floor(now / 1000) + 60)],
  );
});

test("the interval gives three republishes inside the record's expiry", () => {
  assert.equal(HEARTBEAT_MS, 60_000);
  assert.equal(LIVENESS_TTL_SEC, 300);
});

// ── Reading liveness back ──────────────────────────────────────────────────

const record = ({ author, status = "online", at, ttl = LIVENESS_TTL_SEC }) => ({
  kind: 30315,
  pubkey: author,
  created_at: at,
  content: status,
  tags: [["d", LIVENESS_D], ["expiration", String(at + ttl)]],
});

test("livenessOf reads fresh online records and treats everything else as offline", () => {
  const now = 10_000;
  const map = livenessOf(
    [
      record({ author: A("1"), at: now - 30 }), // fresh
      record({ author: A("2"), at: now - 30, status: "offline" }), // said goodbye
      record({ author: A("3"), at: now - 400 }), // expired, relay served it lazily
      { kind: 30315, pubkey: A("4"), created_at: now - 30, content: "online", tags: [["d", "general"]] }, // wrong coordinate
      { kind: 9, pubkey: A("5"), created_at: now - 30, content: "online", tags: [["d", LIVENESS_D]] }, // wrong kind
    ],
    { nowSec: now },
  );
  assert.equal(map.get(A("1")), "online");
  assert.equal(map.get(A("2")), "offline");
  assert.equal(map.get(A("3")), undefined, "an expired record is no record");
  assert.equal(map.get(A("4")), undefined);
  assert.equal(map.get(A("5")), undefined);
});

test("livenessOf keeps the newest record per author", () => {
  const now = 10_000;
  const map = livenessOf(
    [
      record({ author: A("1"), at: now - 200, status: "online" }),
      record({ author: A("1"), at: now - 10, status: "offline" }),
    ],
    { nowSec: now },
  );
  assert.equal(map.get(A("1")), "offline");
});

// ── The beat ───────────────────────────────────────────────────────────────

test("start publishes online immediately and schedules the repeat at the interval", async () => {
  const published = [];
  const scheduled = [];
  const hb = new Heartbeat({
    publish: async (status) => published.push(status),
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return "timer-1";
    },
    cancel: () => {},
  });
  await hb.start();
  assert.deepEqual(published, ["online"]);
  assert.equal(scheduled[0].ms, HEARTBEAT_MS);
  await scheduled[0].fn();
  assert.deepEqual(published, ["online", "online"]);
});

test("a failed publish is logged and never throws", async () => {
  const logged = [];
  const hb = new Heartbeat({
    publish: async () => {
      throw new Error("relay unreachable");
    },
    log: (line) => logged.push(line),
    schedule: () => "t",
    cancel: () => {},
  });
  await hb.start();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /liveness/i);
  assert.match(logged[0], /relay unreachable/);
});

test("stop cancels the schedule and publishes offline, once, tolerating failure", async () => {
  const published = [];
  const cancelled = [];
  const hb = new Heartbeat({
    publish: async (status) => published.push(status),
    schedule: () => "timer-9",
    cancel: (t) => cancelled.push(t),
  });
  await hb.start();
  await hb.stop();
  assert.deepEqual(cancelled, ["timer-9"]);
  assert.deepEqual(published, ["online", "offline"]);

  await hb.stop();
  assert.deepEqual(cancelled, ["timer-9"], "a second stop is a no-op");
  assert.deepEqual(published, ["online", "offline"]);

  const dying = new Heartbeat({
    publish: async () => {
      throw new Error("gone");
    },
    log: () => {},
    schedule: () => "t",
    cancel: () => {},
  });
  await dying.start();
  await dying.stop(); // must not reject
});

// ── Supervisor wiring ──────────────────────────────────────────────────────

const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

test("the supervisor publishes a signed liveness record as the node, and offline on stop", async () => {
  const submitted = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "hive402-hb-"));
  const sup = new Supervisor({
    config: {
      relayUrl: "ws://localhost:3000",
      node: { pubkey: NODE, privateKeyRef: "env:TEST_NODE_KEY" },
      turnCap: { limit: 20, windowMs: 3600000 },
      tools: { buzzDir: "C:\\Buzz", nodeDir: "C:\\node", adapter: "C:\\adapter.js", extraDirs: [] },
      rooms: [],
    },
    stateDir,
    spawn: () => ({ pid: 4242, kill() {} }),
    makeCli: () => ({}),
    readAttestation: () => null,
    resolveKey: () => SK,
    trustWorkspace: () => {},
    queryEvents: async () => [],
    submitEvent: async ({ event }) => {
      submitted.push(event);
      return { published: true };
    },
    log: () => {},
  });
  await sup.start();
  assert.equal(submitted.length, 1, "one liveness record at start");
  assert.equal(submitted[0].kind, 30315);
  assert.equal(submitted[0].content, "online");
  assert.deepEqual(submitted[0].tags.find((t) => t[0] === "d"), ["d", LIVENESS_D]);
  assert.ok(submitted[0].sig, "signed by the node's own key");

  await sup.stop();
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].content, "offline");
});
