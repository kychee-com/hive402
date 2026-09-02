// The node's relay transport.
//
// hive402 runs on UNMODIFIED Buzz (spec constraint), so the node speaks to the
// relay through Buzz's own CLI rather than reimplementing Nostr signing, auth
// and framing (DD-13). Every read and write path here was proven live in the
// 2026-08-15 spike.
//
// `run` is injected so the whole surface is testable without a relay or a
// binary; production passes the execFile wrapper at the bottom.
//
// ── Every upstream contract quoted below, and whether it was EXERCISED ────
//
// FIX-175's defect class: a guard built on a platform contract read from the
// documentation and never once run against the platform's real answer. The
// help text for `--owner` said one thing, the command did another, and the
// difference sat in a refusal for fifteen cycles. So each upstream claim
// asserted as a comment in this file is listed with how it is known, and
// anything load-bearing for a REFUSAL or an OWNERSHIP CLAIM has been probed
// live rather than read. Probes below were run against the rig relay on
// 2026-09-01 with the node's own key.
//
//   claim                          | load-bearing for   | evidence
//   -------------------------------|--------------------|------------------
//   `--owner` scopes to an owner   | ownership claim    | PROBED — false.
//                                  |                    | See getUser.
//   `users get --name` resolves    | the RELAY refusal  | PROBED — returns
//   a name relay-wide              |                    | the holder's row
//   `users get --pubkey` reads a   | the ROOM refusal   | PROBED — returns
//   member's profile               |                    | the row
//   both forms DROP event tags     | ownership claim    | PROBED — content
//                                  |                    | + pubkey only
//   `channels members` lists the   | the ROOM refusal,  | PROBED — 90 rows
//   room's roster                  | AC-36 sponsorship  | with roles
//   `channels list --member` is    | AC-48 surface      | PROBED — [] for a
//   membership-scoped              |                    | non-member key
//   `channels list` sees all       | channel choice     | PROBED — 19 rows
//   `channels join` adds the       | AC-36 sponsorship  | exercised by every
//   caller                         |                    | `register` run
//   `set-profile` is read-merge-   | nothing — display  | exercised by every
//   write; the flag is `--avatar`  | fields only        | `profile` run
//   presence (20001) is            | AC-60 liveness     | verified live when
//   connection-bound                |                    | AC-60 was built
//
// The rule this leaves behind: a sentence from `--help` is a hypothesis. If a
// refusal or an ownership claim rests on it, probe it and paste the output
// here, or say in the comment that it has never had one.

import { execFile } from "node:child_process";

// buzz-acp (the agent harness) requires ws://. buzz.exe (this CLI) requires
// http:// — it speaks to the relay's HTTP bridge. One relay, two spellings, and
// the wrong one fails at connect time rather than at startup, which reads as a
// crash rather than a config mistake. The node stores the ws:// form (the
// launcher validates it) and converts here.
export function cliRelayUrl(relayUrl) {
  return String(relayUrl ?? "")
    .replace(/^ws:\/\//i, "http://")
    .replace(/^wss:\/\//i, "https://");
}

export class BuzzCli {
  #binPath;
  #relayUrl;
  #privateKey;
  #authTag;
  #run;

  constructor({ binPath, relayUrl, privateKey, authTag = null, run = execFileRunner }) {
    this.#binPath = binPath;
    this.#relayUrl = cliRelayUrl(relayUrl);
    this.#privateKey = privateKey;
    this.#authTag = authTag;
    this.#run = run;
  }

  #env() {
    const env = {
      BUZZ_RELAY_URL: this.#relayUrl,
      BUZZ_PRIVATE_KEY: this.#privateKey,
    };
    // Only set BUZZ_AUTH_TAG when we actually have one: buzz.exe hard-fails on
    // a malformed value, so an empty string would break every call a plain
    // human identity makes.
    if (this.#authTag) env.BUZZ_AUTH_TAG = JSON.stringify(this.#authTag);
    return env;
  }

  async #json(args) {
    const { stdout, stderr, code } = await this.#run({
      bin: this.#binPath,
      args,
      env: this.#env(),
    });
    if (code !== 0) {
      // buzz prints JSON errors on stderr: surface the relay's own message so
      // an operator sees "not a channel member", not "exit 1".
      let detail = stderr?.trim() || stdout?.trim() || `exit ${code}`;
      try {
        const parsed = JSON.parse(detail);
        if (parsed?.message) detail = parsed.message;
      } catch {
        /* not JSON — use the raw text */
      }
      throw new Error(`buzz ${args[0]} ${args[1] ?? ""}: ${detail}`.trim());
    }
    const text = stdout?.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getMessages({ channel, limit }) {
    const args = ["messages", "get", "--channel", channel];
    if (limit != null) args.push("--limit", String(limit));
    return (await this.#json(args)) ?? [];
  }

  async send({ channel, content, mentions = [], replyTo = null }) {
    const args = ["messages", "send", "--channel", channel, "--content", content];
    for (const pubkey of mentions) args.push("--mention", pubkey);
    if (replyTo) args.push("--reply-to", replyTo);
    return this.#json(args);
  }

  // `users set-profile` is read-merge-write upstream (buzz-cli
  // commands/users.rs at origin/main 29f2054c): it fetches the current kind-0,
  // overlays the fields it was given and republishes. Passing ONLY what the
  // caller asked to change is therefore what preserves everything else.
  //
  // The picture field's flag is `--avatar`. There is no `--picture`; passing
  // one is a usage error, not a no-op that quietly does nothing.
  async setProfile({ name, avatar, about, nip05 }) {
    const args = ["users", "set-profile"];
    for (const [flag, value] of [["--name", name], ["--avatar", avatar], ["--about", about], ["--nip05", nip05]]) {
      if (value !== undefined && value !== null && value !== "") args.push(flag, String(value));
    }
    if (args.length === 2) throw new Error("setProfile needs at least one of name, avatar, about, nip05");
    return this.#json(args);
  }

  // ── What `--owner` actually queries, MEASURED (FIX-175, TR-022) ─────────
  //
  // This comment used to quote the flag's help text — "Scope an exact-name
  // agent lookup to its owner (`me`, hex, or npub)" — and treat that sentence
  // as the contract. It is not what the command does, and FIX-118 built AC-56's
  // whole ownership answer on it.
  //
  // `--owner` queries `{kinds:[30177], authors:[owner]}` — the MANAGED-AGENT
  // ROSTER records, which only Buzz Desktop publishes — matches on
  // `content.name` and returns their `d` tags
  // (`crates/buzz-cli/src/commands/users.rs:128-139`, buzz `eed74bde2`). It
  // never reads the NIP-OA attestation at all. `publisher.mjs` deliberately
  // writes no 30177 record, so a hive402-hosted agent has no row in that table
  // and the command returns `[]` at an early return.
  //
  // Probed on the rig 2026-09-01, against an agent whose owner really IS
  // `71a12235…`:
  //
  //   users get --name spike                    -> [{…"pubkey":"43e1b966…"}]
  //   users get --name spike --owner 71a12235…  -> []      (the TRUE owner)
  //   users get --name spike --owner dab7655a…  -> []      (a STRANGER)
  //
  // The last two are byte-identical, which is why a same-owner collision read
  // exactly like a cross-owner one: both arms were reading the same empty
  // array. So this call is now the LAST rung of `checkAgentName`'s ladder
  // rather than its only source — kept, because it is still the one thing that
  // can find a Desktop-made agent, and unchanged in behaviour.
  //
  // Note also what BOTH forms drop: the printed row is the kind-0 CONTENT with
  // a `pubkey` spliced in, and the event's TAGS are gone (`users.rs:56-64`).
  // The attestation is unreachable through this command at all, which is why
  // `namecheck.mjs` rung 2 goes to `POST /query` for the raw event instead.
  //
  // Upstream requires `--name` alongside `--owner`.
  async getUser({ pubkey, name, owner }) {
    const args = ["users", "get"];
    if (pubkey) args.push("--pubkey", pubkey);
    else args.push("--name", name);
    if (owner && !pubkey) args.push("--owner", owner);
    const rows = await this.#json(args);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async channelMembers({ channel }) {
    return (await this.#json(["channels", "members", "--channel", channel])) ?? [];
  }

  // The channels the CALLING identity belongs to — `--member` is "Only show
  // channels where the current identity is a member" (ChannelsCmd at buzz
  // origin/main 29f2054c). Run as an agent, this is the agent's own membership,
  // which AC-48 makes the per-channel permission surface.
  async myChannels() {
    return (await this.#json(["channels", "list", "--member"])) ?? [];
  }

  // Every channel this identity can SEE, member or not. A node that has just
  // joined a community is a member of no channel yet, so "which channel shall I
  // put this agent in?" cannot be answered from `myChannels()`.
  async visibleChannels() {
    return (await this.#json(["channels", "list"])) ?? [];
  }

  // Join a channel as the calling identity.
  //
  // The node needs this before it can sponsor anything: `validateRegistration`
  // requires the sponsor to be a member of the TARGET CHANNEL, and claiming an
  // invite only makes a node a member of the COMMUNITY. Those are two different
  // memberships, and conflating them is what left a freshly joined node unable
  // to register the very agent it exists to host.
  async joinChannel({ channel }) {
    return this.#json(["channels", "join", "--channel", channel]);
  }

  async addChannelMember({ channel, pubkey, role }) {
    return this.#json([
      "channels", "add-member",
      "--channel", channel,
      "--pubkey", pubkey,
      "--role", role,
    ]);
  }

  async setAddPolicy({ policy }) {
    return this.#json(["channels", "set-add-policy", "--policy", policy]);
  }

  // There are deliberately NO presence verbs here. Relay presence (kind
  // 20001) is CONNECTION-BOUND — the relay clears it for the authenticated
  // pubkey when the socket closes (`connection.rs`, verified at the local
  // image and origin/main c856be0fb) — so a one-shot CLI call can never
  // leave presence behind: it is accepted and then erased on the clean
  // disconnect. The first cut of AC-60 shipped exactly that footgun; the
  // live check caught it. Node liveness is a kind-30315 record instead
  // (`node/heartbeat.mjs`), published through the `/events` door.
}

// Production runner. The child gets ONLY the env we hand it plus the minimum
// Windows/POSIX process scaffolding — the same isolation rule the agent
// launcher follows, so a stray ambient BUZZ_PRIVATE_KEY can never silently
// re-identify a call.
const PASSTHROUGH = ["SystemRoot", "windir", "TEMP", "TMP", "PATH", "HOME", "USERPROFILE"];

function execFileRunner({ bin, args, env }) {
  const childEnv = { ...env };
  for (const key of PASSTHROUGH) {
    if (process.env[key] != null) childEnv[key] ??= process.env[key];
  }
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env: childEnv, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? (err.code ?? 1) : 0 });
      },
    );
  });
}
