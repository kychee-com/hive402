import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_GRANT_TTL_MS,
  authorityPath,
  claimAuthority,
  coversCapability,
  grantPath,
  pruneAuthorities,
  readAuthority,
  readGrant,
  writeGrant,
  writeWithheld,
  bindGrant,
} from "../src/runtime/grants.mjs";

const state = () => mkdtempSync(path.join(tmpdir(), "hive402-grants-"));
const now = 1_700_000_000_000;

// ── The record itself ──────────────────────────────────────────────────────
//
// A grant is the node's statement that ONE turn may use ONE set of
// capabilities. Everything else about it — the TTL, the prompt binding — exists
// so that statement cannot be stretched to cover a second turn.

test("a written grant reads back with the capabilities it was issued for", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], reason: "owner request", now });
  const grant = readGrant({ stateDir: dir, agent: "spike" });
  assert.equal(grant.kind, "grant");
  assert.deepEqual(grant.capabilities, ["research"]);
  assert.equal(grant.issuedAt, now);
  assert.equal(grant.expiresAt, now + DEFAULT_GRANT_TTL_MS);
  assert.equal(grant.boundPromptId, null);
});

test("a withheld record is a record, not an absence", () => {
  // The distinction is load-bearing: "no record" means the node has not spoken
  // yet and the gate should wait; "withheld" means the node HAS spoken and the
  // answer is no. Conflating them either stalls every denial or races AC-16.
  const dir = state();
  writeWithheld({ stateDir: dir, agent: "spike", reason: "non-owner turn", requester: "b".repeat(64), now });
  const grant = readGrant({ stateDir: dir, agent: "spike" });
  assert.equal(grant.kind, "withheld");
  assert.deepEqual(grant.capabilities, []);
});

test("each agent gets its own record — one agent's grant never covers another", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], now });
  assert.equal(readGrant({ stateDir: dir, agent: "spike2" }), null);
  assert.notEqual(grantPath({ stateDir: dir, agent: "spike" }), grantPath({ stateDir: dir, agent: "spike2" }));
});

test("a missing record reads as null, not as an empty grant", () => {
  assert.equal(readGrant({ stateDir: state(), agent: "spike" }), null);
});

test("an unparseable record reads as null so the caller fails closed", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], now });
  writeFileSync(grantPath({ stateDir: dir, agent: "spike" }), "{ this is not json", "utf8");
  assert.equal(readGrant({ stateDir: dir, agent: "spike" }), null);
});

// ── Coverage ───────────────────────────────────────────────────────────────

test("a live grant covers the capability it names", () => {
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now, expiresAt: now + 1000, boundPromptId: null };
  assert.equal(coversCapability({ grant, capability: "research", promptId: "p1", now }).ok, true);
});

test("a grant does not cover a capability it does not name", () => {
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now, expiresAt: now + 1000, boundPromptId: null };
  const verdict = coversCapability({ grant, capability: "build", promptId: "p1", now });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /does not cover/);
});

test("an expired grant covers nothing", () => {
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now - 2000, expiresAt: now - 1, boundPromptId: null };
  const verdict = coversCapability({ grant, capability: "research", promptId: "p1", now });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /expired/);
});

test("a withheld record covers nothing, whatever capability is asked for", () => {
  const grant = { kind: "withheld", capabilities: [], issuedAt: now, expiresAt: now + 1000 };
  for (const capability of ["research", "build"]) {
    assert.equal(coversCapability({ grant, capability, promptId: "p1", now }).ok, false);
  }
});

test("a grant bound to one turn does not cover the next one", () => {
  // This is what makes a grant worth exactly one turn. Without it, an owner's
  // grant issued at 12:00:00 would still be sitting there when a non-owner's
  // message arrives 30 seconds later, and the containment would leak.
  const grant = { kind: "grant", capabilities: ["research"], issuedAt: now, expiresAt: now + 90_000, boundPromptId: "prompt-A" };
  assert.equal(coversCapability({ grant, capability: "research", promptId: "prompt-A", now }).ok, true);
  const other = coversCapability({ grant, capability: "research", promptId: "prompt-B", now });
  assert.equal(other.ok, false);
  assert.match(other.reason, /another turn/);
});

test("binding writes the prompt id back so later calls in the same turn still pass", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], now });
  bindGrant({ stateDir: dir, agent: "spike", promptId: "prompt-A" });
  const grant = readGrant({ stateDir: dir, agent: "spike" });
  assert.equal(grant.boundPromptId, "prompt-A");
  assert.equal(coversCapability({ grant, capability: "research", promptId: "prompt-A", now }).ok, true);
});

test("binding never re-binds a grant that is already bound", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["research"], now });
  bindGrant({ stateDir: dir, agent: "spike", promptId: "prompt-A" });
  bindGrant({ stateDir: dir, agent: "spike", promptId: "prompt-B" });
  assert.equal(readGrant({ stateDir: dir, agent: "spike" }).boundPromptId, "prompt-A");
});

// ── Authority keyed by the triggering event (DD-20, fix cycle 3) ───────────
//
// Cycle 3's F-009: two messages to one agent 40ms apart. The node wrote the
// owner's grant, then the non-owner's withhold — into the SAME file — and the
// second overwrote the first. The owner's own turn then found "withheld",
// was denied, parked, and never completed even after the owner approved it.
//
// One slot forces a choice between clobbering (breaks the owner) and keeping
// (leaks to the non-owner). Keyed by the event that triggered the turn, there
// is nothing to choose between: two messages are two authorities.

test("two authorities written 40ms apart do not overwrite each other", () => {
  const dir = state();
  const ownerEvent = "a".repeat(64);
  const otherEvent = "b".repeat(64);

  writeGrant({
    stateDir: dir, agent: "spike", eventId: ownerEvent,
    capabilities: ["research"], reason: "owner request", now,
  });
  writeWithheld({
    stateDir: dir, agent: "spike", eventId: otherEvent,
    reason: "not the owner", now: now + 40,
  });

  assert.equal(readAuthority({ stateDir: dir, agent: "spike", eventId: ownerEvent }).kind, "grant");
  assert.equal(readAuthority({ stateDir: dir, agent: "spike", eventId: otherEvent }).kind, "withheld");
});

test("a turn claims only the authority for its own triggering event", () => {
  const dir = state();
  const ownerEvent = "a".repeat(64);
  const otherEvent = "b".repeat(64);
  writeGrant({ stateDir: dir, agent: "spike", eventId: ownerEvent, capabilities: ["research"], now });
  writeWithheld({ stateDir: dir, agent: "spike", eventId: otherEvent, reason: "not the owner", now });

  const mine = claimAuthority({ stateDir: dir, agent: "spike", eventId: ownerEvent, promptId: "p-owner" });
  assert.equal(coversCapability({ grant: mine, capability: "research", promptId: "p-owner", now }).ok, true);

  const theirs = claimAuthority({ stateDir: dir, agent: "spike", eventId: otherEvent, promptId: "p-other" });
  assert.equal(coversCapability({ grant: theirs, capability: "research", promptId: "p-other", now }).ok, false);
});

test("an authority is claimed once — a second turn presenting the same event is refused", () => {
  const dir = state();
  const eventId = "c".repeat(64);
  writeGrant({ stateDir: dir, agent: "spike", eventId, capabilities: ["research"], now });

  claimAuthority({ stateDir: dir, agent: "spike", eventId, promptId: "p-first" });
  const second = claimAuthority({ stateDir: dir, agent: "spike", eventId, promptId: "p-second" });
  const verdict = coversCapability({ grant: second, capability: "research", promptId: "p-second", now });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /another turn/);
});

test("every tool call within one turn re-reads the same claim and passes", () => {
  const dir = state();
  const eventId = "d".repeat(64);
  writeGrant({ stateDir: dir, agent: "spike", eventId, capabilities: ["research"], now });
  for (let call = 0; call < 3; call += 1) {
    const authority = claimAuthority({ stateDir: dir, agent: "spike", eventId, promptId: "p-one" });
    assert.equal(coversCapability({ grant: authority, capability: "research", promptId: "p-one", now }).ok, true);
  }
});

test("an event with no authority record reads as null, so the caller waits or denies", () => {
  assert.equal(readAuthority({ stateDir: state(), agent: "spike", eventId: "e".repeat(64) }), null);
});

test("expired authorities are pruned, live ones are left alone", () => {
  const dir = state();
  const stale = "1".repeat(64);
  const fresh = "2".repeat(64);
  writeGrant({ stateDir: dir, agent: "spike", eventId: stale, capabilities: ["research"], now: now - 10 * 60_000 });
  writeGrant({ stateDir: dir, agent: "spike", eventId: fresh, capabilities: ["research"], now });

  pruneAuthorities({ stateDir: dir, agent: "spike", now });

  assert.equal(readAuthority({ stateDir: dir, agent: "spike", eventId: stale }), null);
  assert.ok(readAuthority({ stateDir: dir, agent: "spike", eventId: fresh }));
});

test("an event id is never allowed to escape its directory", () => {
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", eventId: "../../escape", capabilities: ["build"], now });
  const written = authorityPath({ stateDir: dir, agent: "spike", eventId: "../../escape" });
  assert.ok(written.startsWith(path.join(dir, "grants")), `escaped the grants dir: ${written}`);
});

test("a grant file is written atomically enough to be read while the node writes", () => {
  // The gate reads this file from a different process while the node may be
  // rewriting it. A partial read would fail closed (good) but would also stall
  // a legitimate owner turn, so the writer replaces rather than truncates.
  const dir = state();
  writeGrant({ stateDir: dir, agent: "spike", capabilities: ["build"], now });
  const raw = readFileSync(grantPath({ stateDir: dir, agent: "spike" }), "utf8");
  assert.doesNotThrow(() => JSON.parse(raw));
});
