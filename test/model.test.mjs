import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfig, resolveModel, DEFAULT_MODEL } from "../src/config/schema.mjs";

// AC-74/AC-75: a hive names the model its agents run.
//
// Before 0.10.0 there was no model field at all. The launcher passes
// USERPROFILE/APPDATA so an agent can find its owner's login, the ACP adapter
// starts Claude Code, and Claude Code reads the OWNER'S OWN settings.json — so
// one line in a personal config decided what every hosted agent on the machine
// ran, and two hives on one machine could not differ. DD-62.

const PK = (c) => c.repeat(64);

const good = (over = {}) => ({
  relayUrl: "ws://localhost:3000",
  node: { pubkey: PK("9"), ...(over.node ?? {}) },
  rooms: [
    {
      channel: "b86d8eda-5f05-496c-af45-ef4442ad5876",
      agents: [{ name: "spike", pubkey: PK("4"), ownerPubkey: PK("7"), ...(over.agent ?? {}) }],
    },
  ],
});

const agentOf = (cfg) => cfg.rooms[0].agents[0];

test("a node names the model its agents run, and the value reaches the parsed node", () => {
  const cfg = parseConfig(good({ node: { model: "claude-opus-5" } }));
  assert.equal(cfg.node.model, "claude-opus-5");
});

test("a config naming no model resolves to the shipped default, not null", () => {
  // The third rung is what keeps AC-74 honest: "names none" must fall back to
  // something hive402 owns, NEVER to the owner's machine-wide setting.
  const cfg = parseConfig(good());
  const resolved = resolveModel(agentOf(cfg), cfg.node);
  assert.equal(resolved.model, "claude-sonnet-5");
  assert.equal(resolved.model, DEFAULT_MODEL);
  assert.equal(resolved.source, "default");
});

test("an agent naming its own model overrides its node's", () => {
  const cfg = parseConfig(good({ node: { model: "claude-sonnet-5" }, agent: { model: "claude-opus-5" } }));
  const resolved = resolveModel(agentOf(cfg), cfg.node);
  assert.equal(resolved.model, "claude-opus-5");
  assert.equal(resolved.source, "agent");
});

test("an agent naming no model runs on its node's", () => {
  const cfg = parseConfig(good({ node: { model: "claude-opus-5" } }));
  const resolved = resolveModel(agentOf(cfg), cfg.node);
  assert.equal(resolved.model, "claude-opus-5");
  assert.equal(resolved.source, "node");
});

test("two configs on one machine naming different models resolve independently", () => {
  // The AC-72 property, restated for this field: neither reads the other's, and
  // neither reads any machine-wide setting.
  const a = parseConfig(good({ node: { pubkey: PK("a"), model: "claude-opus-5" } }));
  const b = parseConfig(good({ node: { pubkey: PK("b"), model: "claude-haiku-4-5-20251001" } }));

  assert.equal(resolveModel(agentOf(a), a.node).model, "claude-opus-5");
  assert.equal(resolveModel(agentOf(b), b.node).model, "claude-haiku-4-5-20251001");
});

test("the schema still refuses an unknown agent key — adding model does not relax it", () => {
  assert.throws(
    () => parseConfig(good({ agent: { modle: "claude-opus-5" } })),
    /unknown setting "modle"/,
  );
});

test("a model that is not a non-empty string is refused, on the node and on an agent", () => {
  // A blank model is not a choice. Storing one makes the resolver's "named
  // nothing" case ambiguous, and the agent dies at its first turn instead of
  // at config load, next to the typo.
  for (const bad of ["", "   ", 5, true, null, {}]) {
    assert.throws(
      () => parseConfig(good({ node: { model: bad } })),
      /model/,
      `node.model=${JSON.stringify(bad)} should be refused`,
    );
    assert.throws(
      () => parseConfig(good({ agent: { model: bad } })),
      /model/,
      `agent.model=${JSON.stringify(bad)} should be refused`,
    );
  }
});

test("a named model is trimmed, so trailing whitespace is not a different model", () => {
  const cfg = parseConfig(good({ node: { model: "  claude-opus-5  " } }));
  assert.equal(cfg.node.model, "claude-opus-5");
});
