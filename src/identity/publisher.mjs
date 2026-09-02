// Identity publisher — the fix for "nobody can say @spike".
//
// Cycle 1's F-001: a human typing "@spike" had their message REFUSED
// ("does not match a current channel member") because nothing had ever
// published the agent. F-006 was the same hole seen from the other side: no
// owner attestation existed on a profile that did not exist.
//
// Measured 2026-08-15 against a live relay: publish the agent's kind-0 profile
// and the identical send from a NON-OWNER comes back with
// `mention_pubkeys:["43e1b966…"]` — the relay resolves the name itself, in any
// client, with no per-message setup. That is AC-5's actual mechanism, so the
// node publishes at start, on settings change, and on a keepalive (AC-39).
//
// DEVIATION from DD-5 (evidence, buzz @ df9e773a, RE-MEASURED at origin/main
// 29f2054c in FIX-121): the plan assumed the advertisement clients consult is
// the kind:10100 record. It is not.
//
// FIX-121's spike went looking for the other half — would publishing a MERGED
// 10100 put an agent in a real client's @ picker? — and the answer is no, on
// the builds anyone runs. Desktop does query 10100 and does read a name out of
// it, but `retain_agents_allowed_by_build` drops every legacy entry lacking a
// verified NIP-OA owner, and that gate is on for any RELEASE build
// (`BUZZ_DESKTOP_BUILD_AGENT_ACCESS_OWNER_ONLY`). The record that survives is
// kind 30177, authored by the agent's verified NIP-OA owner with `d` = the
// agent's pubkey — which, since DD-51, is this node. That is a real option and
// a separate question; it is in the spec's Open Questions, not bolted on here.
//
// `crates/buzz-core/src/kind.rs` names 10100 KIND_AGENT_PROFILE, and the only
// writer, `buzz channels set-add-policy`, publishes content
// `{"channel_add_policy": …}` with NO merge. 10100 is the agent's channel-add
// policy, owned by Buzz's own CLI; the record that makes a name mentionable is
// the kind-0 profile. Since 10100 is replaceable per pubkey, a hive402 write of
// our own fields would DESTROY the channel_add_policy Buzz put there — which is
// exactly what AC-28 forbids. So the node publishes kind-0 and never writes
// 10100. This removes the footgun DD-5 was trying to survive rather than
// implementing a merge against it.

import { verifyAuthTag } from "./nipoa.mjs";

const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — well inside any cache window

export class IdentityPublisher {
  #cli;
  #now;
  #refreshMs;
  #lastPublished = new Map(); // agent name -> timestamp

  constructor({ cli, now = () => Date.now(), refreshMs = DEFAULT_REFRESH_MS } = {}) {
    this.#cli = cli;
    this.#now = now;
    this.#refreshMs = refreshMs;
  }

  // Publish (or republish) the agent's profile. Refuses to publish an identity
  // whose attestation does not verify: an unverifiable agent is worse than an
  // absent one, because the room would treat a claim as proof (AC-35).
  //
  // `attestedBy` is who the tag MUST name. Until FIX-117 that was
  // `agent.ownerPubkey`, which was right while the node ran as the owner's own
  // key and wrong the moment the node had an identity of its own (AC-47). The
  // node is the attester now; the human named by `ownerPubkey` is still the
  // approver, and is not something a signature on THIS profile could prove. A
  // caller that passes nothing keeps the old meaning, so no path that has not
  // moved to the node identity changes behaviour underneath it.
  async publish({ agent, authTag, attestedBy = null }) {
    const attester = verifyAuthTag({ tag: authTag, agentPubkey: agent.pubkey });
    if (!attester) {
      throw new Error(
        `agent "${agent.name}": refusing to publish without a verifiable owner attestation`,
      );
    }
    // FOUND BY RUNNING `up` AFTER RE-REGISTERING (2026-08-26). This compared the
    // attester against ONE identity, and `#bringUpAgent` passed none — so it
    // fell back to `agent.ownerPubkey`, the human. The moment an agent was
    // re-registered under FIX-117 the node became its attester and its own node
    // refused to publish it:
    //
    //     agent "smith": attestation names bead5b81…, expected 800fab4d…
    //
    // Both are legitimate attesters and which one applies is a matter of WHEN
    // the agent was registered: before FIX-117 the human attested, after it the
    // node does. What must still be refused is a FOREIGN attestation — someone
    // else's key vouching for an agent this config claims — so the check
    // becomes membership of a small known set rather than equality with a
    // guess.
    const accepted = [attestedBy, agent.ownerPubkey]
      .filter(Boolean)
      .map((k) => String(k).toLowerCase());
    if (!accepted.includes(attester)) {
      throw new Error(
        `agent "${agent.name}": attestation names ${attester}, which is neither this node ` +
          `nor the owner this config declares (${accepted.join(" or ") || "nothing"}). ` +
          `Re-register it, or correct ownerPubkey.`,
      );
    }

    await this.#cli.setProfile({
      name: agent.name,
      // What this line says has to be something the room can CHECK. The
      // attestation proves which node hosts this agent; it does not prove which
      // human owns it, and AC-35 is explicit that identification is by the
      // verifiable attestation and never by a display string.
      about: `hive402 agent · hosted by ${attester.slice(0, 12)}…`,
      // FOUND BY LOOKING AT THE ROOM (Barry, 2026-08-25): a hive402 agent sat
      // in the member list with no picture, next to a human who had one.
      //
      // AC-46 had the avatar filed as exploratory — "whether a client renders a
      // picture hive402 publishes is unverified". Rendering was never the
      // question. hive402 published `{name, about}` and nothing else, so there
      // was no picture to render; the human's showing correctly, in the same
      // list, is the proof the client side works.
      //
      // `setProfile` is read-merge-write upstream and this sends only what it
      // was given, so an agent with no configured avatar keeps whatever its
      // profile already has rather than having it cleared on every publish.
      avatar: agent.avatar ?? undefined,
    });
    this.#lastPublished.set(agent.name, this.#now());

    const report = await this.check({ agent });
    // `owner` is kept as an alias for what callers already read; `attestedBy`
    // is the honest name for it now that the attester and the owner are two
    // different identities (DD-51).
    return { ...report, published: true, attested: true, attestedBy: attester, owner: attester };
  }

  // Republish only when the advertisement is old enough to be worth refreshing.
  async keepalive({ agent, authTag }) {
    const last = this.#lastPublished.get(agent.name);
    if (last != null && this.#now() - last < this.#refreshMs) {
      return { refreshed: false };
    }
    await this.publish({ agent, authTag });
    return { refreshed: true };
  }

  // AC-39: the node reports an absent or stale advertisement ITSELF. The
  // failure mode this exists to prevent is silent: the agent looks "down" to
  // everyone else, and the only symptom is a raw relay error in the sender's
  // client that says nothing about hive402.
  async check({ agent }) {
    const problems = [];

    const byName = await this.#cli.getUser({ name: agent.name });
    const byPubkey = await this.#cli.getUser({ pubkey: agent.pubkey });

    if (!byPubkey) {
      problems.push(
        `agent "${agent.name}" has no published profile — it is NOT addressable by name in any client`,
      );
    } else {
      const published = byPubkey.display_name ?? byPubkey.name ?? null;
      if (published?.toLowerCase() !== agent.name.toLowerCase()) {
        problems.push(
          `agent "${agent.name}" is published as "${published}" — the room's name will not resolve`,
        );
      }
    }

    if (byName && byName.pubkey !== agent.pubkey) {
      problems.push(
        `name "${agent.name}" resolves to another identity (${byName.pubkey.slice(0, 12)}…) — collision`,
      );
    }

    return {
      name: agent.name,
      pubkey: agent.pubkey,
      addressable: problems.length === 0,
      problems,
      publishedAt: this.#lastPublished.get(agent.name) ?? null,
    };
  }
}
