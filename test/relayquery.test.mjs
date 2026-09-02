// The relay's HTTP query door (F-11, spike S30-3).
//
// `POST /query` takes a JSON ARRAY of Nostr filters, NIP-98-signed over the
// exact URL and body, and answers with an array of events. It is how the cover
// path reads the managed-agent registry, finds promised messages, and fetches
// one old message by id — the same door `publishManagedAgent` already writes
// through, so the auth pattern is deliberately identical.

import { test } from "node:test";
import assert from "node:assert/strict";

import { queryEvents } from "../src/relay/query.mjs";

const KEY = "aa".repeat(32);

function fakeFetch({ status = 200, body = "[]" } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return JSON.parse(body);
      },
    };
  };
  return { calls, impl };
}

test("posts the filters array to /query with a NIP-98 header over that exact body", async () => {
  const { calls, impl } = fakeFetch({ body: "[]" });
  const signed = [];
  const filters = [{ kinds: [30177] }, { ids: ["ab".repeat(32)] }];
  await queryEvents({
    origin: "http://relay.example",
    filters,
    privateKeyHex: KEY,
    now: 1234,
    fetchImpl: impl,
    nip98: (args) => {
      signed.push(args);
      return "Nostr signed-header";
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://relay.example/query");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, JSON.stringify(filters));
  assert.equal(calls[0].options.headers.Authorization, "Nostr signed-header");

  // The signature is over the URL and body actually sent — a header signed for
  // different bytes is a 401 at the relay, not a working request.
  assert.equal(signed[0].url, "http://relay.example/query");
  assert.equal(signed[0].method, "POST");
  assert.equal(signed[0].body, JSON.stringify(filters));
  assert.equal(signed[0].privateKeyHex, KEY);
  assert.equal(signed[0].now, 1234);
});

test("a trailing slash on the origin does not double up", async () => {
  const { calls, impl } = fakeFetch();
  await queryEvents({
    origin: "http://relay.example/",
    filters: [],
    privateKeyHex: KEY,
    fetchImpl: impl,
    nip98: () => "Nostr h",
  });
  assert.equal(calls[0].url, "http://relay.example/query");
});

test("returns the relay's rows, and [] for a non-array answer", async () => {
  const rows = [{ id: "x", kind: 30177 }];
  const { impl } = fakeFetch({ body: JSON.stringify(rows) });
  assert.deepEqual(
    await queryEvents({ origin: "http://r", filters: [], privateKeyHex: KEY, fetchImpl: impl, nip98: () => "n" }),
    rows,
  );

  const { impl: objectImpl } = fakeFetch({ body: '{"unexpected":true}' });
  assert.deepEqual(
    await queryEvents({ origin: "http://r", filters: [], privateKeyHex: KEY, fetchImpl: objectImpl, nip98: () => "n" }),
    [],
  );
});

test("a refused query surfaces the relay's own message", async () => {
  const { impl } = fakeFetch({ status: 403, body: '{"error":"not a relay member"}' });
  await assert.rejects(
    () => queryEvents({ origin: "http://r", filters: [], privateKeyHex: KEY, fetchImpl: impl, nip98: () => "n" }),
    /not a relay member/,
  );
});
