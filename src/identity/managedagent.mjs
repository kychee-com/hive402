// The record a client's @ picker is actually built from (AC-51, FIX-123).
//
// ── How this was found ─────────────────────────────────────────────────────
//
// Barry opened his `@` menu and it listed Bzik, Honey, Pollen and Fizz — three
// of them marked "not in channel" — and did NOT list `smith`, a bot sitting in
// that very channel. Querying the live relay for kind 30177 returned ten
// records, one for each agent in the menu, and none for smith.
//
// So the picker is not built from channel membership, and it is not built from
// kind 0. It is built from kind 30177, `KIND_MANAGED_AGENT`, keyed
// `(author, 30177, d=<agent pubkey>)`. Desktop writes one for every agent it
// manages; hive402 wrote none, which is the whole of why its agents were
// invisible there. Nothing about it was ever agent-specific or hive402-specific.
//
// (The earlier FIX-121 spike reached the same conclusion by reading Desktop's
// source and recorded it as an open question. This is the measurement.)
//
// ── The rule that decides who may write one ───────────────────────────────
//
// Desktop only trusts a 30177 whose AUTHOR is the agent's verified NIP-OA
// owner: `latest_verified_managed_policies` drops any record where
// `verified_owners[agent] != event.pubkey`, and on a release build
// `retain_agents_allowed_by_build` then drops every remaining entry that has no
// verified owner at all.
//
// That is why this can only exist after FIX-117. An agent attested by a HUMAN
// needs that human's key to have its record written, and AC-43 forbids hive402
// ever holding one. An agent attested by the NODE can have its record written
// by the node. So the attestation is checked HERE, before anything is signed:
// publishing a record that will be silently dropped is worse than not
// publishing, because the symptom is identical and the cause is invisible.
//
// ── What may go in the content ────────────────────────────────────────────
//
// `ManagedAgentEventContent` in
// desktop/src-tauri/src/managed_agents/agent_events.rs is an opt-IN allowlist,
// and upstream says why in as many words: these events are world-readable, and
// the projection "physically cannot represent" a private key, an auth tag or
// env vars. hive402 builds the same shape and asserts the same absence.

import { signEvent } from "./nostrevent.mjs";
import { verifyAuthTag } from "./nipoa.mjs";

export const KIND_MANAGED_AGENT = 30177;

// `RespondTo` is a kebab-case enum upstream (managed_agents/types.rs):
// owner-only | allowlist | anyone. hive402's own `crossOwnerAsks` is a
// different question with different values, so it is mapped rather than passed
// through — a wire string the reader does not understand is dropped, and the
// agent silently fails to appear.
const RESPOND_TO = new Set(["owner-only", "allowlist", "anyone"]);

// Anything that must never reach a world-readable event, checked by NAME on the
// built content rather than trusted to the caller's discipline.
const NEVER_PUBLISH = ["privateKey", "private_key_nsec", "nsec", "sk", "authTag", "auth_tag", "env", "envVars"];

export function managedAgentContent({ agent, respondTo = "owner-only", parallelism = 1 }) {
  if (!RESPOND_TO.has(respondTo)) {
    throw new Error(
      `managed-agent record: respond_to must be one of ${[...RESPOND_TO].join(", ")} (got "${respondTo}")`,
    );
  }
  const content = {
    name: agent.name,
    parallelism,
    respond_to: respondTo,
  };
  // An allowlist of PUBLIC keys is legitimate content upstream; an empty one is
  // omitted, matching `skip_serializing_if = "Vec::is_empty"`.
  if (Array.isArray(agent.respondToAllowlist) && agent.respondToAllowlist.length > 0) {
    content.respond_to_allowlist = [...agent.respondToAllowlist];
  }

  const serialised = JSON.stringify(content);
  for (const banned of NEVER_PUBLISH) {
    if (Object.prototype.hasOwnProperty.call(content, banned)) {
      throw new Error(`managed-agent record: "${banned}" must never be published — these events are world-readable`);
    }
  }
  return { content, serialised };
}

// Build the signed record, refusing when the signer is not the agent's verified
// owner — because a record Desktop will drop is indistinguishable, from the
// outside, from not publishing at all.
export function buildManagedAgentEvent({ agent, authTag, ownerPrivateKeyHex, respondTo, parallelism, now }) {
  if (!agent?.pubkey) throw new Error("managed-agent record: the agent needs a pubkey to key the record on");

  const attested = verifyAuthTag({ tag: authTag, agentPubkey: agent.pubkey });
  if (!attested) {
    throw new Error(
      `managed-agent record: agent "${agent.name}" has no verifiable owner attestation, ` +
        `so no record written for it would be trusted by a client`,
    );
  }

  const { content, serialised } = managedAgentContent({ agent, respondTo, parallelism });
  const event = signEvent({
    privateKeyHex: ownerPrivateKeyHex,
    kind: KIND_MANAGED_AGENT,
    // The `d` tag is the AGENT's pubkey; the author is its owner. That pairing
    // is the whole coordinate, and swapping them produces a record about the
    // wrong identity that still verifies.
    tags: [["d", agent.pubkey]],
    content: serialised,
    now,
  });

  if (event.pubkey.toLowerCase() !== attested.toLowerCase()) {
    throw new Error(
      `managed-agent record: agent "${agent.name}" is attested by ${attested.slice(0, 12)}… but this ` +
        `record would be signed by ${event.pubkey.slice(0, 12)}…. A client keeps only the record whose ` +
        `author IS the verified owner, so this one would be dropped without trace. ` +
        `Re-register the agent so the node attests it.`,
    );
  }
  return { event, content };
}

// Retiring the record (AC-70, DD-60).
//
// A managed-agent record is a REPLACEABLE event keyed `d = <agent pubkey>`, and
// no relay deletion is assumed: it is retired by republishing the SAME
// coordinate with an empty name, which `managedAgentsFrom` drops (it keeps only
// rows whose `name` is a non-empty string — see listener/foreign.mjs, the
// reader every cover decision goes through).
//
// Authored by the NODE, exactly as the original was. A tombstone signed by
// anyone else is a contested claim, which `managedAgentsFrom` drops WHOLE — the
// same visible outcome by accident rather than by decision, and it would take
// the real record with it.
//
// Deliberately not routed through `buildManagedAgentEvent`: that builder
// requires a verifiable owner attestation and refuses to write a record a
// client would drop. Here, "a client drops this" IS the point.
export function buildManagedAgentTombstone({ agentPubkey, nodePrivateKeyHex, now = Date.now() }) {
  if (!agentPubkey) {
    throw new Error("managed-agent tombstone: which agent? the record is keyed on its pubkey");
  }
  if (!nodePrivateKeyHex) {
    throw new Error("managed-agent tombstone: only the node that published the record can retire it");
  }
  return signEvent({
    privateKeyHex: nodePrivateKeyHex,
    kind: KIND_MANAGED_AGENT,
    tags: [["d", agentPubkey]],
    content: JSON.stringify({ name: "" }),
    now,
  });
}

// `POST /events`, NIP-98 signed — the relay's HTTP door for a signed event
// (buzz-relay router.rs). `buzz` has no verb that submits an arbitrary event,
// which is why this does not go through the CLI like everything else.
export async function publishManagedAgent({
  agent,
  authTag,
  ownerPrivateKeyHex,
  origin,
  respondTo,
  parallelism,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  nip98,
}) {
  const { event, content } = buildManagedAgentEvent({
    agent, authTag, ownerPrivateKeyHex, respondTo, parallelism, now,
  });
  const url = `${String(origin).replace(/\/$/, "")}/events`;
  const body = JSON.stringify(event);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98({ privateKeyHex: ownerPrivateKeyHex, url, method: "POST", body, now }),
    },
    body,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload?.error ?? payload?.message ?? detail;
    } catch {
      /* the status is what we have */
    }
    throw new Error(`the relay refused the managed-agent record (${detail})`);
  }
  return { event, content, published: true };
}
