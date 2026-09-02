// Who already answers to this name in this room? (AC-37, DD-17, fix cycle 2.)
//
// Cycle 2's F-008: two separate hive402 nodes — separate config files, separate
// state directories, which is exactly how two different owners are set up —
// each registered an agent called "probe1" into the same channel under
// different pubkeys, and both succeeded. The relay ended up with two bots
// claiming one name.
//
// The cause was that the uniqueness check was handed `room.agents` from the
// LOCAL CONFIG FILE. A config file lists the agents of the owner who wrote it
// and nobody else's, so the check was structurally incapable of seeing another
// owner's node. It could only ever catch a duplicate inside one config — which
// is what cycle 1 measured and, wrongly, reported as AC-37.
//
// Uniqueness is a property of the room, so this asks the room. Two questions,
// because a name can be claimed two ways:
//
//   1. a member of this channel already publishes that display name — the
//      literal reading of AC-37;
//   2. the name already resolves ANYWHERE on the relay, because `@name`
//      resolution is a global kind-0 lookup. Registering into a name someone
//      else holds produces an agent that is admitted and unaddressable, which
//      is a worse outcome than a refusal.
//
// Fail closed. If the relay cannot be read, this throws rather than returning
// an empty list — "we could not check" must never render as "there is nothing
// there", which is exactly the answer the local-config check used to give.

export async function claimedNamesInRoom({ cli, channel, exceptPubkey, name = null }) {
  const mine = String(exceptPubkey ?? "").toLowerCase();
  const claims = [];
  const seen = new Set();

  let members;
  try {
    members = await cli.channelMembers({ channel });
  } catch (err) {
    throw new Error(
      `could not read the room's membership to check name uniqueness (${err.message}) — ` +
        `refusing rather than registering a name that might already be taken`,
    );
  }

  for (const member of members ?? []) {
    const pubkey = String(member?.pubkey ?? "").toLowerCase();
    if (!pubkey || pubkey === mine || seen.has(pubkey)) continue;
    seen.add(pubkey);
    let profile;
    try {
      profile = await cli.getUser({ pubkey });
    } catch (err) {
      throw new Error(
        `could not read ${pubkey.slice(0, 8)}…'s profile to check name uniqueness (${err.message}) — ` +
          `refusing rather than guessing`,
      );
    }
    const published = profile?.display_name ?? profile?.name ?? null;
    // A member with no published profile holds no name. That is not a failure:
    // humans and un-started agents simply have nothing to collide with yet.
    if (published) claims.push({ name: published, pubkey, scope: "room" });
  }

  if (name) {
    let byName;
    try {
      byName = await cli.getUser({ name });
    } catch (err) {
      throw new Error(`could not resolve "${name}" at the relay (${err.message}) — refusing`);
    }
    const holder = String(byName?.pubkey ?? "").toLowerCase();
    if (holder && holder !== mine && !seen.has(holder)) {
      claims.push({ name: byName.display_name ?? byName.name ?? name, pubkey: holder, scope: "relay" });
    }
  }

  return claims;
}
