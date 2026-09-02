// `hive402 setup` — the whole of AC-44 in one command.
//
// "Setup is a single guided step delivered in exactly two shapes, and no
//  installer: a script in the public repository that a person runs in a
//  terminal, or a line of text pasted to the coding agent they already use.
//  Both do the same work — identity, join, name, agent, first channel — and a
//  person may complete setup knowing only which of the two they prefer."
//
// This is the work. The two shapes are two ways of reaching it: the terminal
// shape runs this command, and the coding-agent shape has skill.md drive the
// same command. Neither shape has its own recipe, because two recipes drift and
// the one that drifts is always the one nobody ran this week.
//
// ── Every step is skippable, because setup is resumed more often than run ──
//
// Something fails, a person closes the terminal, a name is already taken, the
// relay is down for a minute. Re-running has to pick up where it stopped rather
// than refuse ("you already have an identity") or repeat ("here is a second
// key"). So each step asks whether it is already done and says so.
//
// ── The one step this command cannot do for anybody ───────────────────────
//
// The join, when the community has a policy. AC-45 requires the human to be
// shown the terms and to accept them explicitly, and there is deliberately no
// flag that accepts on their behalf. In the terminal shape that is fine — the
// person is right there. In the coding-agent shape the agent is running this
// process and the human is not looking at its stdin, so skill.md has the human
// run `hive402 join` themselves first; this command then finds the node already
// joined and moves on. That is the sequencing answer, and it is why `--invite`
// is optional rather than required.

import { assertDisplayName, publishNodeProfile } from "../registry/profile.mjs";
import { readJoinRecord, rememberDisplayName } from "../registry/joinrecord.mjs";
import { buzzBinPath } from "../registry/profilecommand.mjs";
import { cliRelayUrl } from "../relay/buzzcli.mjs";
import { checkAgentName, describeNameFindings } from "../registry/namecheck.mjs";
import { derivePubkey, generateSecretKey } from "../credentials/keys.mjs";

// A step's outcome. `done` means it happened now, `already` means it was
// already true, `skipped` means it could not run and setup continued anyway,
// `blocked` means setup cannot go further until a person does something.
const step = (name, state, detail = null) => ({ name, state, detail });

export async function runSetup({
  invite = null,
  nodeName = null,
  agentName = null,
  // The human's PUBLIC key, and the one thing here that cannot be derived.
  //
  // Since DD-51 the node attests the agents it hosts, but the APPROVER is the
  // human: `ownerPubkey` is what the dispatcher checks when it decides whose
  // reply releases a gated action (AC-14/15/16). Nothing on this machine knows
  // which Buzz account that is — the node has its own identity by design, and
  // "whichever member is you" is not a question a relay can answer.
  //
  // So it is asked for. It is a PUBLIC key, one paste from the profile screen,
  // and AC-43 forbids asking for the secret, never the public half. Getting it
  // wrong is not dangerous, it is inert: approvals from the wrong identity
  // simply do not count, which is visible immediately.
  ownerPubkey = null,
  channel = null,
  store,
  stateDir,
  config = null,
  configFile,
  join = null, // ({ link }) => joinResult — injected so setup is testable
  makeCli = null,
  // DD-69 rung 2's door, the same seam `makeNameCheck` and `registerAgent`
  // have. Real callers pass nothing and get `src/relay/query.mjs`.
  queryEvents = undefined,
  writeConfig,
  log = console.log,
  generate = generateSecretKey,
}) {
  const steps = [];
  const say = (line) => log(line);

  // ── 1. Identity ─────────────────────────────────────────────────────────
  //
  // WHICH hive's identity (AC-72, DD-61)? The join record in THIS state
  // directory names it — a resumed setup is resuming one specific hive, and a
  // machine may now hold several. With no record there is no hive here yet,
  // so there is nothing to find and one is minted below.
  const alreadyHere = readJoinRecord(stateDir);
  let nodeKey = alreadyHere?.pubkey ? await store.getNodePrivateKey(alreadyHere.pubkey) : null;
  if (nodeKey) {
    steps.push(step("identity", "already", derivePubkey(nodeKey)));
  } else if (invite) {
    // The join mints it. Doing it here as well would leave a stray identity
    // when the join then fails.
    steps.push(step("identity", "pending", "the join creates it"));
  } else {
    nodeKey = generate();
    await store.createNodePrivateKey(derivePubkey(nodeKey), nodeKey);
    steps.push(step("identity", "done", derivePubkey(nodeKey)));
  }

  // ── 2. Join ─────────────────────────────────────────────────────────────
  let joined = readJoinRecord(stateDir);
  if (joined) {
    steps.push(step("join", "already", joined.host));
  } else if (!invite) {
    steps.push(
      step(
        "join",
        "blocked",
        "no invite link. Run: hive402 join <invite-link>   (or pass --invite <link>). " +
          "If the community has a join policy you have to accept it yourself — " +
          "hive402 never accepts an agreement on anyone's behalf.",
      ),
    );
    return report({ steps, say });
  } else {
    if (!join) {
      steps.push(step("join", "skipped", "no join implementation supplied"));
      return report({ steps, say });
    }
    joined = await join({ link: invite });
    nodeKey = joined?.pubkey ? await store.getNodePrivateKey(joined.pubkey) : null;
    steps.push(step("join", "done", joined.host));
    // The identity step said "pending — the join creates it". It has, so say
    // so: a step left pending is one the final "Next:" line can pick up and
    // offer as the thing still to do, which is how a completed setup came to
    // end with "Next: the join creates it".
    const identity = steps.find((s) => s.name === "identity");
    if (identity?.state === "pending") {
      identity.state = "done";
      // The join is what created it, so read it back rather than assuming.
      identity.detail = nodeKey ? derivePubkey(nodeKey) : (joined.pubkey ?? "created by the join");
    }
  }

  const relayUrl = config?.relayUrl ?? joined.origin;
  const binPath = buzzBinPath(config?.tools?.buzzDir ?? null);
  const cliFor = (privateKey) =>
    (makeCli ?? (() => null))({ binPath, relayUrl, privateKey });

  // ── 3. Name ─────────────────────────────────────────────────────────────
  if (joined.displayName) {
    steps.push(step("name", "already", joined.displayName));
  } else if (!nodeName) {
    steps.push(step("name", "skipped", 'set one with: hive402 profile --name "<your name>\'s hive"'));
  } else {
    const name = assertDisplayName(nodeName);
    await publishNodeProfile({ name, privateKeyHex: nodeKey, relayUrl, binPath, makeCli, log: () => {} });
    rememberDisplayName({ stateDir, name });
    steps.push(step("name", "done", name));
  }

  // ── 4. The first agent ──────────────────────────────────────────────────
  if (!agentName) {
    steps.push(step("agent", "blocked", "no agent name. Re-run with --agent <name>."));
    return report({ steps, say });
  }
  if (!ownerPubkey) {
    steps.push(
      step(
        "agent",
        "blocked",
        "no owner. Re-run with --owner <npub1…>: your own Buzz PUBLIC key, which is who " +
          "approves this agent's actions. It is the public half, one paste from your profile " +
          "screen — hive402 never wants the secret.",
      ),
    );
    return report({ steps, say });
  }

  let agentKey = await store.getAgentPrivateKey(agentName);
  if (agentKey) {
    steps.push(step("agent", "already", derivePubkey(agentKey)));
  } else {
    // AC-56, before the identity exists. The relay is reachable by now — this
    // is after the join — so this is the one place the check can be complete.
    //
    // ── The THIRD door, and it was left behind (FIX-181, F-037) ───────────
    //
    // `keygen`, `register` and this all check a name before an identity
    // exists. FIX-175 wired DD-69's ladder into the first two and this call
    // passed no `config`, no `origin` and no key — so the ladder could not run
    // here at all, and a same-owner collision got the ownership-blind wording
    // F-036 was filed for, at the door every new operator is sent through.
    // Fixing two of three doors is the shape that produces repeat findings.
    //
    // No `selfPubkey` (DD-70). This mints below; there is no self yet.
    const nodeCli = cliFor(nodeKey);
    if (nodeCli) {
      const findings = await checkAgentName({
        cli: nodeCli,
        name: agentName,
        channel,
        ownerPubkey,
        config,
        origin: cliRelayUrl(relayUrl),
        privateKeyHex: nodeKey,
        ...(queryEvents ? { queryEvents } : {}),
      });
      // `continuing` is a claim about what happens next, and on this arm
      // nothing does: it returns without generating (FIX-179's rule, at the
      // door where the key would otherwise be written two lines below).
      const refusing = (findings.refusals ?? []).length > 0;
      const said = describeNameFindings({ name: agentName, findings, continuing: !refusing });
      for (const warning of said.warnings) say(`  ! ${warning}`);
      if (said.error) {
        steps.push(step("agent", "blocked", said.error));
        return report({ steps, say });
      }
    }
    agentKey = generate();
    await store.createAgentPrivateKey(agentName, agentKey);
    steps.push(step("agent", "done", derivePubkey(agentKey)));
  }

  // ── 5. The first channel ────────────────────────────────────────────────
  //
  // Since FIX-120 the node follows channel MEMBERSHIP, so this is genuinely a
  // first channel and not a list to maintain: one place to put the agent so it
  // has somewhere to be, after which adding it to another channel in any Buzz
  // client is enough.
  let firstChannel = channel;
  if (!firstChannel) {
    // VISIBLE channels, not the node's own memberships.
    //
    // FOUND BY RUNNING THE WHOLE FLOW (2026-08-25): a node that has just
    // claimed an invite is a member of the COMMUNITY and of no channel at all,
    // so asking `myChannels()` here answered "you are not in any channel yet"
    // to someone who had done everything right — and sent them off to another
    // app in the middle of a one-command setup. `register` puts the node in
    // the channel it is about to sponsor into, so being in one is not a
    // precondition; the question is only which room the agent belongs in.
    const nodeCli = cliFor(nodeKey);
    const seen = nodeCli ? await safeVisibleChannels(nodeCli) : [];
    if (seen.length === 1) {
      firstChannel = seen[0].id;
      steps.push(step("channel", "done", `${seen[0].name ?? firstChannel} (the only one here)`));
    } else if (seen.length === 0) {
      steps.push(
        step("channel", "blocked", "no channels are visible to this node yet. Create one in Buzz, then re-run with --channel <id>."),
      );
      return report({ steps, say });
    } else {
      // Names first. A person recognises "hive-spike"; nobody recognises a
      // UUID, and a bare list of fifteen of them is not a question anyone can
      // answer. Printed as lines rather than run together for the same reason.
      say("");
      say(`  Which channel should ${agentName} start in?`);
      for (const c of seen) say(`    ${(c.name ?? "(unnamed)").padEnd(24)} --channel ${c.id}`);
      steps.push(
        step("channel", "blocked", `there are ${seen.length} channels — re-run with --channel <id> from the list above`),
      );
      return report({ steps, say });
    }
  } else {
    steps.push(step("channel", "done", firstChannel));
  }

  // ── 6. The config ───────────────────────────────────────────────────────
  const written = writeConfig({
    file: configFile,
    relayUrl,
    nodePubkey: derivePubkey(nodeKey),
    channel: firstChannel,
    // The NODE attests this agent (DD-51); the HUMAN named here approves it.
    agent: { name: agentName, pubkey: derivePubkey(agentKey), ownerPubkey },
  });
  steps.push(step("config", "done", written));

  steps.push(
    step(
      "register",
      "pending",
      `hive402 register --agent ${agentName} --config ${written}   (the node vouches for it — nothing to paste)`,
    ),
  );
  return report({ steps, say });
}

// Never throws: a setup that cannot list channels should say "tell me which
// one" rather than fall over, and the caller's message does exactly that.
async function safeVisibleChannels(cli) {
  const idOf = (row) => row?.channel_id ?? row?.channel ?? row?.channelId ?? row?.id ?? null;
  try {
    const rows = (await cli.visibleChannels()) ?? [];
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const id = String(idOf(row) ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: row?.name ?? null });
    }
    return out;
  } catch {
    return [];
  }
}

// One report at the end rather than a running commentary, because a person
// resuming setup needs to see the WHOLE state — what is done, what is not, and
// the single next thing — not a scroll of lines they have read before.
function report({ steps, say }) {
  const mark = { done: "+", already: "=", skipped: "~", blocked: "!", pending: ">" };
  say("");
  say("hive402 setup");
  for (const s of steps) {
    say(`  ${mark[s.state] ?? " "} ${s.name.padEnd(9)} ${s.detail ?? ""}`.trimEnd());
  }
  // The LAST pending step, not the first. Steps run in order, so anything
  // pending behind a step that has since completed is history; the one a person
  // has to act on is always the furthest along.
  const blocked = steps.find((s) => s.state === "blocked");
  const next = blocked ?? [...steps].reverse().find((s) => s.state === "pending");
  say("");
  if (blocked) say(`Stopped: ${blocked.detail}`);
  else if (next) say(`Next: ${next.detail}`);
  else say("Setup is complete. Run: hive402 up");
  return { steps, complete: !blocked, blocked: blocked ?? null };
}

// The starter config. Deliberately minimal: the six agent settings are left at
// their defaults (research and build OFF), and the channel is written into the
// deprecated `rooms[]` slot because the schema still requires one — the node
// follows membership from the relay regardless (AC-48).
export function starterConfig({ relayUrl, nodePubkey, channel, agent }) {
  return {
    relayUrl: String(relayUrl).replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://"),
    node: { pubkey: nodePubkey },
    rooms: [
      {
        channel,
        agents: [{ name: agent.name, pubkey: agent.pubkey, ownerPubkey: agent.ownerPubkey }],
      },
    ],
  };
}
