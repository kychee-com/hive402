import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLog } from "../src/audit/log.mjs";

function memorySink() {
  const lines = [];
  return { lines, append: (line) => lines.push(line) };
}

test("records an action with actor, agent and detail", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink, now: () => 1000 });
  log.action({ agent: "blitz", actor: "d".repeat(64), kind: "deploy", detail: "run402 shared-todo" });
  const e = JSON.parse(sink.lines[0]);
  assert.equal(e.type, "action");
  assert.equal(e.agent, "blitz");
  assert.equal(e.kind, "deploy");
  assert.equal(e.at, 1000);
});

test("records an approval with who approved what", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink });
  log.approval({ agent: "blitz", approver: "d".repeat(64), proposalId: "evt123", granted: true });
  const e = JSON.parse(sink.lines[0]);
  assert.equal(e.type, "approval");
  assert.equal(e.granted, true);
  assert.equal(e.proposalId, "evt123");
});

// AC-27 explicitly includes settings changes — enabling `build` is the
// security-relevant event, not just the deploy that follows it.
test("records a settings change with before and after", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink });
  log.settingsChange({ agent: "blitz", actor: "0".repeat(64), setting: "build", from: false, to: true });
  const e = JSON.parse(sink.lines[0]);
  assert.equal(e.type, "settings_change");
  assert.equal(e.setting, "build");
  assert.equal(e.from, false);
  assert.equal(e.to, true);
});

test("entries are one JSON object per line (append-only, greppable)", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink });
  log.action({ agent: "a", actor: "x", kind: "research", detail: "web" });
  log.action({ agent: "a", actor: "x", kind: "deploy", detail: "run402" });
  assert.equal(sink.lines.length, 2);
  for (const l of sink.lines) {
    assert.doesNotMatch(l, /\n/, "no embedded newlines");
    JSON.parse(l);
  }
});

test("query filters by agent and returns newest first", () => {
  const sink = memorySink();
  let t = 0;
  const log = new AuditLog({ sink, now: () => ++t });
  log.action({ agent: "blitz", actor: "x", kind: "research", detail: "1" });
  log.action({ agent: "bzik", actor: "x", kind: "research", detail: "2" });
  log.action({ agent: "blitz", actor: "x", kind: "deploy", detail: "3" });
  const rows = log.query({ agent: "blitz" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].detail, "3", "newest first");
});

test("query can limit results for a chat reply", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink });
  for (let i = 0; i < 10; i++) log.action({ agent: "a", actor: "x", kind: "k", detail: String(i) });
  assert.equal(log.query({ limit: 3 }).length, 3);
});

test("a secret-looking value is never written verbatim", () => {
  const sink = memorySink();
  const log = new AuditLog({ sink });
  log.action({ agent: "a", actor: "x", kind: "deploy", detail: "token sk-ant-oat01-SECRETVALUE here" });
  assert.doesNotMatch(sink.lines[0], /SECRETVALUE/);
  assert.match(sink.lines[0], /redacted/i);
});
