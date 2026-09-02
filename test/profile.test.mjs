// FIX-116 — the node has a name in the member list (AC-46).
//
// A node that has joined shows up in the community as 64 characters of hex.
// AC-46 says it publishes a human-chosen display name so it reads as "Barry's
// hive" instead — the node is a member in its own right (F-10), and a member
// nobody can identify is indistinguishable from a stranger's key.
//
// Two halves, and only one of them is decidable here:
//
//   NAME     required. Published to the node's own kind-0.
//   AVATAR   exploratory. Whether a real client RENDERS a picture hive402
//            publishes is unverified — the spec says so in as many words — so
//            this proves the field is SENT and the live rendering check stays
//            open until a client can be watched.
//
// Wire, from crates/buzz-cli/src/commands/users.rs at buzz origin/main
// 29f2054c: the flag is `--avatar`, and `cmd_set_profile` maps it onto the
// kind-0 `picture` field. The task text said "picture"; the CLI has no such
// flag, and passing one is a usage error rather than a no-op.
//
// `set-profile` is read-merge-write upstream: fields we do not pass are carried
// forward from the existing profile, so setting a name later cannot silently
// erase an about or an avatar.

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertDisplayName, publishNodeProfile } from "../src/registry/profile.mjs";

const SK = "745e32758514a561fda889d7e25782b6734c441c6daf23ce5974cb66afb6991c";
const PK = "71a12235e894d6875ad23d6674b48ccaad2b9a369983beea4536fc1cdb1a657a";

// A BuzzCli double that records the argv the real one would have run.
function cli() {
  const runs = [];
  return {
    runs,
    make: (opts) => ({
      opts,
      async setProfile(fields) {
        runs.push(fields);
        return { event_id: "abc" };
      },
    }),
  };
}

const publish = (over = {}) => {
  const c = over.cliDouble ?? cli();
  return {
    c,
    run: (fields) =>
      publishNodeProfile({
        privateKeyHex: SK,
        relayUrl: "https://relay.example",
        binPath: "buzz.exe",
        makeCli: c.make,
        log: () => {},
        ...fields,
      }),
  };
};

// ── The name ──────────────────────────────────────────────────────────────

test("a display name is not an identity name — spaces and apostrophes are the point", () => {
  // `assertIdentityName` restricts to [A-Za-z0-9._-] because the name becomes a
  // file name in the credential store. A display name becomes a line in a
  // member list, and "Barry's hive" is the actual example from the spec.
  for (const name of ["Barry's hive", "Barry's Hive", "hive402 · barry", "Tal’s hive", "バリーの巣"]) {
    assert.equal(assertDisplayName(name), name, name);
  }
});

test("a display name is required, and blank is not a name", () => {
  for (const bad of [undefined, null, "", "   ", "\t\n"]) {
    assert.throws(() => assertDisplayName(bad), /required/i, JSON.stringify(bad));
  }
});

test("a display name is trimmed, because a trailing space is invisible in a member list", () => {
  assert.equal(assertDisplayName("  Barry's hive  "), "Barry's hive");
});

test("a key pasted into the name field is refused, in both directions", () => {
  // The same two mistakes `assertIdentityName` catches, and for the same
  // reasons: a display name is printed straight back, and an npub in the name
  // field is the wrong-field slip that produced an agent addressed by its own
  // public key (F-022 sweep).
  assert.throws(() => assertDisplayName(SK), /private KEY|not a name/i);
  assert.throws(() => assertDisplayName(`npub1${"q".repeat(58)}`), /PUBLIC key|not a name/i);
});

test("an absurd display name is refused by length, not echoed back", () => {
  const long = "a".repeat(300);
  let message = "";
  try {
    assertDisplayName(long);
    assert.fail("a 300-character display name must be refused");
  } catch (err) {
    message = err.message;
  }
  assert.match(message, /too long/i);
  assert.ok(!message.includes(long), "the error must not repeat 300 characters back");
});

// ── The publish ───────────────────────────────────────────────────────────

test("the name reaches buzz as the node's own profile", async () => {
  const p = publish();
  const result = await p.run({ name: "Barry's hive" });
  assert.deepEqual(p.c.runs, [{ name: "Barry's hive" }]);
  assert.equal(result.name, "Barry's hive");
  assert.equal(result.published, true);
});

test("the key handed to the client is the node's, and the relay URL is the community's", async () => {
  // AC-43's other half. The node is a member in its own right, so its member
  // list entry is signed by the identity that joined — never a human's.
  const seen = [];
  const c = {
    make: (opts) => {
      seen.push(opts);
      return { async setProfile() { return {}; } };
    },
  };
  await publish({ cliDouble: c }).run({ name: "Barry's hive" });
  assert.equal(seen[0].privateKey, SK);
  assert.equal(seen[0].relayUrl, "https://relay.example");
  assert.equal(seen[0].binPath, "buzz.exe");
});

test("an avatar is sent as --avatar, which is the flag that exists", async () => {
  const p = publish();
  await p.run({ name: "Barry's hive", avatar: "https://example.com/hive.png" });
  assert.deepEqual(p.c.runs, [{ name: "Barry's hive", avatar: "https://example.com/hive.png" }]);
});

test("an avatar that is not a URL is refused before it is published", async () => {
  // A relative path or a local file name would publish a broken picture field
  // to every client in the community, and the failure is invisible from here.
  for (const bad of ["hive.png", "./hive.png", "C:/pics/hive.png", "javascript:alert(1)"]) {
    await assert.rejects(publish().run({ name: "x", avatar: bad }), /avatar/i, bad);
  }
});

test("an avatar alone updates the avatar, because set-profile merges upstream", async () => {
  const p = publish();
  await p.run({ avatar: "https://example.com/hive.png" });
  assert.deepEqual(p.c.runs, [{ avatar: "https://example.com/hive.png" }]);
});

test("publishing nothing at all is refused rather than sent", async () => {
  // buzz answers "at least one field required"; saying so here costs a process
  // launch and a confusing error attributed to the wrong layer.
  await assert.rejects(publish().run({}), /nothing to publish|at least one/i);
});

test("a relay failure is reported as a failure, not swallowed", async () => {
  const c = {
    make: () => ({
      async setProfile() {
        throw new Error("buzz users set-profile: not a relay member");
      },
    }),
  };
  await assert.rejects(publish({ cliDouble: c }).run({ name: "x" }), /not a relay member/);
});

test("the node's own pubkey is reported back, so the operator can check the member list", async () => {
  const result = await publish().run({ name: "Barry's hive" });
  assert.equal(result.pubkey, PK);
});
