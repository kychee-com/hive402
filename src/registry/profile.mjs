// The node's own profile — a name in the member list (AC-46, F-10).
//
// A node that has joined a community appears in it as 64 characters of hex.
// That is not what F-10 describes: the node is "visible in the member list as
// that person's hive", which is what lets a community see who is hosting the
// agents it is talking to, and what makes a node revocable as itself rather
// than as an anonymous key.
//
// ── Two halves, and only one is decidable in a test ────────────────────────
//
// The NAME is required and is ordinary work. The AVATAR is exploratory and the
// spec says so: whether a real client renders a picture hive402 publishes is
// unverified (Open Questions). So this module makes the field reachable and
// correct on the wire, and the question of whether a dropdown draws it stays
// open until a client can actually be watched.
//
// ── What the CLI actually takes ────────────────────────────────────────────
//
// From crates/buzz-cli/src/commands/users.rs at buzz `origin/main` 29f2054c:
// the flag is `--avatar`, and `cmd_set_profile` merges it onto the kind-0
// `picture` field. There is no `--picture` flag; passing one is a usage error,
// not a no-op that quietly does nothing.
//
// `set-profile` is read-merge-write upstream — it fetches the current kind-0,
// overlays the fields given, and republishes. So `--name` alone cannot erase an
// avatar, and this module passes only the fields it was asked to change.

import { BuzzCli } from "../relay/buzzcli.mjs";
import { derivePubkey } from "../credentials/keys.mjs";
import { NOT_PRINTED, looksLikeKeyMaterial, looksLikePublicKeyMaterial } from "../credentials/refusal.mjs";

// Longer than an identity name is allowed to be, because this one is not a file
// name — but still bounded: a member list is a column, and Nostr clients
// truncate hard. 64 is what `IDENTITY_NAME_MAX` uses and there is no reason for
// a second number.
export const DISPLAY_NAME_MAX = 64;

// A DISPLAY name, which is a different thing from an identity name.
//
// `assertIdentityName` restricts to [A-Za-z0-9._-] because the value becomes a
// file name in the OS credential store. This one becomes a line in a member
// list, so "Barry's hive" — the spec's own example — has to be legal, along
// with every apostrophe, space and script a person's name is written in.
//
// The two refusals it keeps are the two that are about the operator, not about
// the charset: a display name is printed straight back by this command and by
// `doctor`, and an npub in the name field is the wrong-field slip that produced
// an agent addressed by its own public key (the F-022 sweep).
export function assertDisplayName(value, what = "display name") {
  const name = String(value ?? "").trim();

  if (name === "") throw new Error(`a ${what} is required — it is what the community sees instead of a hex key`);

  if (looksLikeKeyMaterial(name)) {
    throw new Error(
      `that ${what} is a private KEY, not a name. A display name is published to the ` +
        `community and printed back by this command, so hive402 will not accept one. ${NOT_PRINTED}`,
    );
  }
  if (looksLikePublicKeyMaterial(name)) {
    throw new Error(
      `that ${what} is a PUBLIC key (npub1…), not a name. The whole point of the name is ` +
        `that the member list shows something other than a key.`,
    );
  }
  if (name.length > DISPLAY_NAME_MAX) {
    // By length, never by value — this is the branch a pasted near-key lands in.
    throw new Error(
      `${what} is too long: ${name.length} characters, and the limit is ${DISPLAY_NAME_MAX}. ${NOT_PRINTED}`,
    );
  }
  return name;
}

// An avatar is a URL other people's clients will fetch. A relative path or a
// local file name publishes a broken `picture` to everyone in the community and
// nothing here would ever see it fail.
function assertAvatarUrl(value) {
  const raw = String(value ?? "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`avatar must be a full URL that other people's clients can fetch (got "${raw}")`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`avatar must be an http(s) URL (got "${url.protocol}")`);
  }
  return url.toString();
}

export async function publishNodeProfile({
  name = null,
  avatar = null,
  about = null,
  privateKeyHex,
  relayUrl,
  binPath,
  makeCli = (opts) => new BuzzCli(opts),
  log = console.log,
}) {
  const fields = {};
  if (name !== null && name !== undefined) fields.name = assertDisplayName(name);
  if (avatar !== null && avatar !== undefined) fields.avatar = assertAvatarUrl(avatar);
  if (about !== null && about !== undefined) fields.about = String(about);

  if (Object.keys(fields).length === 0) {
    throw new Error(
      "nothing to publish — pass --name, --avatar or --about. " +
        "(An empty profile update would be refused by the relay anyway.)",
    );
  }

  const pubkey = derivePubkey(privateKeyHex);
  const cli = makeCli({ binPath, relayUrl, privateKey: privateKeyHex });
  await cli.setProfile(fields);

  log(`hive402: published this node's profile`);
  for (const [key, value] of Object.entries(fields)) log(`  ${key.padEnd(7)} ${value}`);
  log(`  pubkey  ${pubkey}`);
  if (fields.avatar) {
    // Honest about the half that is not settled. The spec lists this in Open
    // Questions, and a command that reports success for something unverified is
    // how an open question quietly becomes a false claim.
    log("");
    log(`  ! The avatar is published, but whether a Buzz client DRAWS it is not`);
    log(`    something hive402 can confirm. Look at the member list and see.`);
  }
  return { ...fields, pubkey, published: true };
}
