// Buzz-governance guard (spec AC-28).
//
// hive402 adds behavior only where Buzz provides none. Concretely: the node
// publishes its own event kinds and must never write the events Buzz uses to
// govern a channel (metadata, roster, discovery). Those belong to Buzz, and
// overwriting them would make hive402 a fork of the platform rather than a
// layer on it.
//
// Kind numbers verified against buzz @ df9e773a.

// What hive402 legitimately publishes.
//
// Kind 0 is here because an agent's own profile is how a name becomes
// mentionable, and the node publishes it under the agent's own identity.
export const HIVE402_WRITABLE_KINDS = Object.freeze([
  0, // kind-0 profile — what makes "@name" resolve (publisher.mjs)
  9, // channel message — wakes and agent replies
  7, // reaction — approval gestures
]);

// Buzz's channel governance/discovery events — read-only for us.
const BUZZ_GOVERNED_KINDS = new Set([
  39000, // channel metadata
  39001, // channel roles
  39002, // channel roster / discovery
  9000, // channel membership management
  9030, // relay membership admin
  13534, // relay-signed membership snapshot
  // 10100 moved here from WRITABLE in FIX-121, and the reason is worth keeping.
  //
  // DD-5 assumed 10100 was "our own record, merged". The FIX-121 spike measured
  // it at buzz `origin/main` 29f2054c and it is not ours in any sense:
  //
  //   • it is REPLACEABLE per pubkey, and the only writer in the Buzz CLI is
  //     `buzz channels set-add-policy`, which publishes
  //     `{"channel_add_policy": …}` with no merge and no tags;
  //   • the relay's own side-effect handler parses it for `channel_add_policy`
  //     alone and errors "kind:10100 missing channel_add_policy field" without
  //     one — so a hive402 write both destroys the policy and is rejected as a
  //     policy update;
  //   • and it would not even buy what DD-5 wanted: Desktop drops legacy 10100
  //     directory entries that lack a verified NIP-OA owner on any RELEASE
  //     build (`retain_agents_allowed_by_build` /
  //     `BUZZ_DESKTOP_BUILD_AGENT_ACCESS_OWNER_ONLY`).
  //
  // Writing it is exactly what AC-28 forbids: overwriting an event Buzz uses to
  // govern a channel. The record that DOES drive a release build's picker is
  // kind 30177, authored by the agent's verified NIP-OA owner — a different
  // question, recorded in the spec's Open Questions rather than bolted on here.
  10100, // agent profile / channel-add policy — Buzz's, not ours
]);

export function assertOwnEventKind(kind) {
  if (HIVE402_WRITABLE_KINDS.includes(kind)) return;
  if (BUZZ_GOVERNED_KINDS.has(kind)) {
    throw new Error(
      `kind ${kind} is buzz-governed — hive402 never writes channel governance events`,
    );
  }
  throw new Error(`kind ${kind} is unknown to hive402 and not ours to write`);
}
