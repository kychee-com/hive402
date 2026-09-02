// AC-16 as amended in spec 0.7.0 (DD-56): the owner's word is the whole gate.
//
// Barry, watching Tal's file count get refused while his own builds confirmed:
// "If I ask it auto does." The build half of AC-16's old exception was carrying
// deploy's reason — a local build commits nothing — so build leaves the confirm
// list and the owner's own turn now carries every capability the owner enabled.
// Deploy keeps its confirm-once, on deploy's own merits, as its own proposal.
//
// What survives of DD-35 is pinned here too: a non-owner turn NEVER carries
// build automatically, auto-allow included — where DD-35 made that a flat
// loss, DD-57 makes it an escalation, but it is never a silent grant.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Dispatcher } from "../src/listener/dispatch.mjs";
import { TurnCap } from "../src/safety/turncap.mjs";
import { LoopGuard } from "../src/safety/loopguard.mjs";
import { AuditLog } from "../src/audit/log.mjs";

const OWNER = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";
const TAL = "dab7655a909a1935a6167c3c6f4f95659971d47121f4378657354a9c563f23e7";
const SPIKE = "43e1b96665f8907b095619c60aafa0bbc9ff43fe4f133611abf454aa803a2d3c";
const NODE = "924280894112c28ff0c0f4d67a3a55305c57d7334bc40845f59fe7651c2b0957";

const spike = (over = {}) => ({
  name: "spike",
  pubkey: SPIKE,
  ownerPubkey: OWNER,
  research: true,
  build: true,
  crossOwnerAsks: "owner-approves",
  replyMode: "addressed-only",
  ...over,
});

function make(over = {}) {
  const audit = new AuditLog();
  const agents = [spike(over)];
  return {
    agents,
    audit,
    dispatcher: new Dispatcher({
      nodePubkey: NODE,
      agents,
      turnCap: new TurnCap({ limit: 20 }),
      loopGuard: new LoopGuard(),
      audit,
      workshop: { project: "prj_x", subdomain: null },
    }),
  };
}

const msg = (over) => ({ id: "e1", kind: 9, pubkey: TAL, content: "@spike do the thing", tags: [], ...over });
const authorityOf = (fx) =>
  fx.find((e) => e.type === "authority") ?? fx.find((e) => e.type === "wake")?.authority ?? null;
const says = (fx) => fx.filter((e) => e.type === "say");
const deploys = (fx) => fx.filter((e) => e.type === "deploy");
const tokenIn = (text) => text.match(/approve (h4-[a-z0-9]+)/)?.[1] ?? null;

// ── The owner's own turn carries build (AC-16, 0.7.0) ──────────────────────

test("AC-16: the owner's own turn carries build — no round trip, no proposal", () => {
  const { dispatcher } = make();
  const effects = dispatcher.handle(msg({ pubkey: OWNER, tags: [["p", SPIKE]] }));
  const authority = authorityOf(effects);
  assert.equal(authority.kind, "grant");
  assert.ok(authority.capabilities.includes("build"), "the owner asked; build must be on the turn");
  assert.ok(authority.capabilities.includes("research"), "everything enabled rides the owner's turn");
  assert.equal(authority.reason, "owner request");
  assert.equal(says(effects).length, 0, "and nothing asks anybody anything");
});

test("AC-17: a capability the owner switched off is not on the owner's own turn either", () => {
  const { dispatcher } = make({ build: false });
  const authority = authorityOf(dispatcher.handle(msg({ pubkey: OWNER, tags: [["p", SPIKE]] })));
  assert.equal(authority.kind, "grant");
  assert.deepEqual(authority.capabilities, ["research"], "build: false means never, even for the owner");
});

// ── What survives of DD-35: build never rides a NON-owner's automatic turn ─

test("auto-allow still hands no build to a non-owner's turn", () => {
  const { dispatcher } = make({ crossOwnerAsks: "auto-allow" });
  const authority = authorityOf(dispatcher.handle(msg({ pubkey: TAL })));
  assert.equal(authority.kind, "grant", "auto-allow still grants the free capabilities");
  assert.ok(authority.capabilities.includes("research"));
  assert.ok(!authority.capabilities.includes("build"), "a stranger's turn never holds build automatically");
});

test("a non-owner's turn on an owner-approves agent is a withhold, unchanged", () => {
  const { dispatcher } = make();
  const authority = authorityOf(dispatcher.handle(msg({ pubkey: TAL })));
  assert.equal(authority.kind, "withhold");
  assert.deepEqual(authority.capabilities, []);
});

// ── Deploy confirms on deploy's own merits — exactly once (AC-16, 0.7.0) ───

test("the owner's write-and-publish run confirms exactly once: the deploy's own proposal", () => {
  const { dispatcher } = make();

  // The write ran free on the owner's turn (asserted above), so the first
  // thing the node hears about is the agent reaching for run402.
  const blocked = dispatcher.handleBlockedAction({
    id: "b-run402",
    agent: "spike",
    capability: "build",
    delegate: "run402",
    detail: "run402 sites deploy-dir ./site",
    requester: OWNER,
    triggerEvent: msg({ id: "e-owner", pubkey: OWNER, tags: [["p", SPIKE]] }),
    at: Date.now(),
  });

  assert.equal(deploys(blocked).length, 0, "nothing deploys before the owner's yes");
  const asks = says(blocked).filter((s) => tokenIn(s.content));
  assert.equal(asks.length, 1, "exactly one confirmation for the whole run");
  assert.match(asks[0].content, /prj_x/, "naming the project whose account pays");
  assert.deepEqual(asks[0].mentions, [OWNER], "addressed to the owner");

  const approved = dispatcher.handle(
    msg({ id: "e-yes", pubkey: OWNER, content: `approve ${tokenIn(asks[0].content)}` }),
  );
  assert.equal(deploys(approved).length, 1, "the owner's one yes releases the deploy");
});

test("an approved build no longer carries its deploy — the deploy confirms itself (DD-56 retires the DD-35 carry)", () => {
  const { dispatcher } = make();

  // The FIX-87 edge is the one place an OWNER's build still parks a proposal:
  // an unattributed turn with nothing to claim. Park one and approve it.
  const parked = dispatcher.handleBlockedAction({
    id: "b-write",
    agent: "spike",
    capability: "build",
    detail: "Write site/index.html",
    signature: "Write|site/index.html",
    requester: OWNER,
    triggerEvent: msg({ id: "e-ask", pubkey: OWNER, tags: [["p", SPIKE]] }),
    at: Date.now(),
  });
  const buildToken = tokenIn(says(parked).map((s) => s.content).join("\n"));
  assert.ok(buildToken, "the edge still asks, so the owner can still recover it");
  dispatcher.handle(msg({ id: "e-yes", pubkey: OWNER, content: `approve ${buildToken}` }));

  // The released turn now reaches for run402, carrying the approved proposal id
  // — exactly the shape the DD-35 carry used to deploy on with no further ask.
  const blocked = dispatcher.handleBlockedAction({
    id: "b-run402",
    agent: "spike",
    capability: "build",
    delegate: "run402",
    detail: "run402 sites deploy-dir ./site",
    requester: OWNER,
    proposalId: buildToken,
    triggerEvent: msg({ id: "e-ask", pubkey: OWNER, tags: [["p", SPIKE]] }),
    at: Date.now(),
  });

  assert.equal(
    deploys(blocked).length,
    0,
    "a build approval must not silently cover a deploy it never named (AC-16 0.7.0)",
  );
  const asks = says(blocked).filter((s) => tokenIn(s.content));
  assert.equal(asks.length, 1, "the deploy asks for itself, once");
  assert.match(asks[0].content, /prj_x/);
});
