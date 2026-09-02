// The wake path — where every room message meets hive402's policy.
//
// Cycle 1's finding was that this layer did not exist: `decideWake`, the action
// gate, the turn cap, the loop guard and the audit log were all built and unit
// tested, and nothing called them. This is the thing that calls them, and it is
// the only route by which an agent is woken.
//
// `handle` is pure with respect to the world: it returns EFFECTS
// (`wake` / `say`) for the supervisor to carry out. Nothing here touches the
// relay, so the entire policy surface is testable without a room.
//
// ── Why the harness's inbound gate matters ────────────────────────────────
// Publishing agent profiles (the F-001 fix) means the relay now resolves
// "@spike" for ANY sender, and delivers a p-tagged event straight to the agent.
// That would make the authority gate unenforceable — the agent would already be
// awake before the node saw the message, which is precisely F-003.
//
// So an agent whose owner requires approval launches with `respond_to=allowlist`
// admitting only its owner and this node (AC-38: an explicit gate, never the
// harness's owner-only default). Then:
//   • the owner's mention reaches the agent directly     → AC-16, no round-trip
//   • anyone else's is DISCARDED by the harness          → the node gates it,
//     and republishes a wake under its own identity only once policy allows.
// A p-tag from a non-admitted author is therefore evidence the message was
// dropped, not evidence it was delivered.

import { resolveAddressed } from "./mentions.mjs";
import { inboundGateFor } from "../launcher/env.mjs";
import { replyAnchor } from "./threads.mjs";
import { stripAttribution } from "./attribution.mjs";
import { automaticCapabilities, ownerTurnCapabilities } from "../runtime/grants.mjs";
import { DEPLOY_DIR } from "../workshop/site.mjs";

const KIND_MESSAGE = 9;
const APPROVAL_RE = /\b(approve|deny)\s+(h4-[a-z0-9]+)/i;

// A chat-native command, recognised only when the message IS that command.
//
// This used to be an unanchored search for "/audit" anywhere in the text, which
// is F-013's defect class one pattern over: "@spike what do you think of the
// /audit endpoint we built?" was answered by the NODE out of the log, and the
// agent — who was asked a question — never saw it. Strip the mentions, and what
// is left has to be the command itself.
const COMMAND_RE = /^\/(audit|turns|help)[.!?]*$/i;
const MENTION_TOKEN_RE = /@[A-Za-z0-9_-]+/g;

const commandIn = (content) =>
  String(content ?? "")
    .replace(MENTION_TOKEN_RE, " ")
    .trim()
    .match(COMMAND_RE)?.[1]
    ?.toLowerCase() ?? null;

const short = (pubkey) => String(pubkey ?? "").slice(0, 8);

export class Dispatcher {
  #nodePubkey;
  #agents;
  #turnCap;
  #loopGuard;
  #audit;
  #respondTo;
  #allowlist;
  #workshop;
  #isAgentRunning;
  #pending = new Map(); // token -> { agent, requester, action, text, state }
  #seq = 0;
  // The last message that woke each agent, so a tool call the runtime gate
  // refuses can be tied back to the request that caused it and re-run once the
  // owner approves.
  #lastTrigger = new Map(); // agent name -> event
  #handledBlocks = new Set(); // blocked-record ids already escalated
  // The thread every notice from the message being handled belongs in (FIX-134).
  #anchor = null;

  constructor({
    nodePubkey,
    agents,
    turnCap,
    loopGuard,
    audit,
    respondTo = "allowlist",
    respondToAllowlist = null,
    // Is that agent's harness actually up? Supplied by the supervisor, which is
    // the only party that holds the process (FIX-78). Defaults to "yes", which
    // is the pre-DD-34 assumption and keeps every caller that has no processes
    // to speak of — the dispatcher's own tests — behaving exactly as before.
    isAgentRunning = () => true,
    // The room's run402 workshop (DD-27), or null. Null is not a degraded mode:
    // a room without one simply cannot deploy, and says so.
    workshop = null,
  }) {
    this.#isAgentRunning = isAgentRunning;
    this.#workshop = workshop;
    this.#nodePubkey = nodePubkey;
    this.#agents = agents;
    this.#turnCap = turnCap;
    this.#loopGuard = loopGuard;
    this.#audit = audit;
    this.#respondTo = respondTo;
    this.#allowlist = new Set(respondToAllowlist ?? [nodePubkey]);
  }

  // The roster can change while the node runs (AC-48, FIX-120): an agent added
  // to this channel in any Buzz client belongs here from that moment, and the
  // dispatcher is what decides who may be addressed in it. Replacing the whole
  // dispatcher instead would throw away its seen-set and its loop guard, which
  // is how a roster change becomes every recent message handled a second time.
  setAgents(agents) {
    this.#agents = agents;
  }

  // Would the harness have delivered this author's message to this agent
  // directly?
  //
  // FOUND BY BARRY, IN HIS OWN ROOM, TO HIS OWN AGENT (2026-08-27). He wrote
  // "@smith heya - you there?" with smith alive, the node running, the model
  // backend working and `doctor` green, and NOTHING happened. No reply, and no
  // wake either: the node never relayed it.
  //
  // This used to read `authorPubkey === agent.ownerPubkey || allowlist.has(…)`,
  // with the comment "the owner is always implicitly on the allowlist (harness
  // behaviour)". That IS true of buzz-acp, at buzz origin/main:
  //
  //     RespondTo::Allowlist => allowlist.contains(author)
  //                             || is_owner_or_sibling(author, …).await
  //
  // but the owner it resolves comes from BUZZ_AUTH_TAG, and since FIX-117 that
  // tag is signed by the NODE. smith's own log says so out loud:
  //
  //     owner resolved from BUZZ_AUTH_TAG: bead5b81…   (the node)
  //     agent owner: bead5b81…                          (not Barry, 800fab4d…)
  //
  // So "the owner" names two different identities in the two components. The
  // human in `ownerPubkey` is the APPROVER (AC-14/15/16); the node is what the
  // harness will actually accept a message from. Comparing against the human
  // made the node believe the harness held a message the harness was dropping,
  // and BOTH let go of it:
  //
  //     node    "he is the owner, the harness has it"   → no wake
  //     harness "he is neither owner nor allowlisted"   → dropped
  //
  // Only while the agent was RUNNING, because a dead agent fails the liveness
  // check and is relayed to regardless — which is why this looked intermittent
  // rather than broken, and why it had worked an hour earlier.
  //
  // So this asks the SAME FUNCTION that configures the harness, rather than
  // keeping its own idea of who gets through. `inboundGateFor` is the one place
  // that decides, the node launches buzz-acp from it, and now the node's guess
  // about what buzz-acp will do is computed from it too. The two cannot answer
  // differently, because there is only one answer.
  //
  // The dispatcher-level `respondTo` still wins when it is "anyone": that is how
  // a room-wide open policy is expressed, and how these paths are exercised in
  // tests.
  #reachesDirectly(agent, authorPubkey) {
    if (this.#respondTo === "anyone") return true;
    const gate = inboundGateFor({ agent, nodePubkey: this.#nodePubkey });
    if (gate.respondTo === "anyone") return true;
    return gate.respondToAllowlist.includes(authorPubkey) || this.#allowlist.has(authorPubkey);
  }

  #isAgent(pubkey) {
    return this.#agents.some((a) => a.pubkey === pubkey);
  }

  // Is there a PERSON behind this turn? (AC-52, DD-44.)
  //
  // Everything in the room is one of three things: a human, one of this room's
  // agents, or this node. Only the first can ask for something, so this is the
  // whole of the router — no new state, just one more question asked of the
  // requester the node already resolves for every blocked record.
  #isHumanRequester(pubkey) {
    if (!pubkey) return false; // an unattributable turn: nobody we can name asked
    if (pubkey === this.#nodePubkey) return false;
    return !this.#isAgent(pubkey);
  }

  #token() {
    this.#seq += 1;
    return `h4-${this.#seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // `forceRelay` is the ONE caller-supplied exception to the direct-delivery
  // shortcut, and it is not a new policy: it is the supervisor saying it has
  // evidence the harness did not answer this message (FIX-135). Everything
  // else about the turn — the authority record, the gate, the thread — is
  // computed exactly as it is for any other relayed message.
  handle(event, { forceRelay = false } = {}) {
    if (event?.kind !== KIND_MESSAGE) return [];

    // The node's own events — including the wakes it publishes, which quote the
    // text that triggered them and therefore contain the same "@name". Without
    // this guard the node answers itself.
    if (event.pubkey === this.#nodePubkey) return [];

    // FIX-134: every notice this call produces belongs in the thread the message
    // was written in. Set once, here, rather than passed through the thirteen
    // `#say` call sites — a new one cannot forget what it never has to remember.
    this.#anchor = replyAnchor(event);

    // An agent addressing another agent (AC-24). This is a NARROW path and it
    // is bounded by the loop guard, which until fix cycle 3 had no caller at
    // all: every agent-authored event was dropped here, which satisfied AC-25
    // trivially and made AC-24's own first clause — "an agent may address
    // another agent, and the addressed agent may post one reply" — impossible.
    // The addressed agent posted zero replies, never one.
    //
    // AC-25 still holds exactly as written: only an EXPLICIT mention wakes an
    // agent, so an agent's message never produces a relevance wake, and an
    // un-addressed agent is never woken by one.
    if (this.#isAgent(event.pubkey)) return this.#agentToAgent(event);

    // A human posted, so every agent pair gets its budget back (AC-24).
    this.#loopGuard.humanSpoke();

    const approval = this.#handleApproval(event);
    if (approval) return approval;

    const alreadyTagged = new Set(
      (event.tags ?? []).filter((t) => t[0] === "p").map((t) => t[1]),
    );

    const effects = [];
    // Both spellings of an address, deduplicated (AC-6, FIX-109): "@name" in
    // the body, and the `mention` tag Desktop emits when it is holding an agent
    // addressed across consecutive messages with no name in the text at all.
    for (const pubkey of resolveAddressed({ content: event.content, tags: event.tags, agents: this.#agents })) {
      const agent = this.#agents.find((a) => a.pubkey === pubkey);
      if (!agent) continue;

      // Was this message already delivered to the agent by the relay? Only the
      // WAKE is redundant in that case — every other policy still applies, and
      // skipping the message outright (as this once did) silently disabled the
      // gate, the capability refusal and the chat-native queries for exactly
      // the person most likely to use them: the agent's own owner.
      //
      // "The harness delivered it" is a claim about a harness that is RUNNING
      // (FIX-78). When the agent's process is gone, nothing was delivered to
      // anybody, so suppressing the wake leaves the message nowhere — which is
      // how the first cut of DD-34 revived spike (owner: owner) and left spike2
      // (owner: tal) silent for 180 seconds on the rig. Asking about liveness
      // here rather than adding a second respawn call site keeps ONE path: a
      // dead agent produces an ordinary wake, and the wake path relaunches it.
      const deliveredDirectly =
        !forceRelay &&
        alreadyTagged.has(pubkey) &&
        this.#reachesDirectly(agent, event.pubkey) &&
        this.#isAgentRunning(agent);

      effects.push(...this.#forAgent({ agent, event, deliveredDirectly }));
    }

    // FIX-133 — somebody addressed THE NODE, and no agent with it.
    //
    // Tal saw "Barry's Hive" in his @ picker and wrote to it. Nothing answered,
    // because the node resolves addresses against its AGENTS and is not one of
    // them, so the message matched nobody and produced no effects at all.
    //
    // The node cannot be hidden from that picker. It publishes a profile because
    // it must: it is a channel member in its own right, and that membership is
    // what lets it post the wakes every relayed message depends on. A member
    // with a name is a member people can address.
    //
    // So it answers, and says the one thing worth saying — it is not a person to
    // talk to, and here is who is. Silence would be the same failure as FIX-124,
    // FIX-129 and FIX-130: somebody spoke into a room and the room did not react.
    if (!effects.length && alreadyTagged.has(this.#nodePubkey)) {
      const named = this.#agents.map((a) => `@${a.name}`);
      effects.push(
        this.#say(
          named.length
            ? `I am this hive's node, not somebody to talk to. Ask an agent instead: ${named.join(", ")}.`
            : `I am this hive's node, not somebody to talk to, and no agent is set up in this channel yet.`,
          [event.pubkey],
        ),
      );
    }
    return effects;
  }

  // One agent addressing another, bounded to a single exchange per pair until a
  // human speaks again (AC-24). The addressed agent's turn carries NO
  // capability: an agent is nobody's owner, so it can never authorise an
  // action, however it phrases the request. Conversation stays free, which is
  // the whole of what AC-24 permits.
  #agentToAgent(event) {
    const effects = [];
    for (const pubkey of resolveAddressed({ content: event.content, tags: event.tags, agents: this.#agents })) {
      if (pubkey === event.pubkey) continue; // an agent cannot wake itself
      const agent = this.#agents.find((a) => a.pubkey === pubkey);
      if (!agent) continue;

      const { allowed, reason } = this.#loopGuard.allow({ from: event.pubkey, to: pubkey });
      if (!allowed) {
        this.#audit.action({
          agent: agent.name,
          actor: short(event.pubkey),
          kind: "loop-guard",
          detail: `blocked: ${reason}`,
        });
        continue; // silently bounded — announcing it would itself be chatter
      }

      effects.push(
        ...this.#withAuthority({
          agent,
          event,
          deliveredDirectly: false,
          reason: `addressed by ${short(event.pubkey)}… (agent)`,
          authority: this.#withhold({
            agent,
            reason: `turn triggered by ${short(event.pubkey)}…, an agent — agents hold no authority`,
            requester: event.pubkey,
          }),
        }),
      );
    }
    return effects;
  }

  // What may THIS turn do? (DD-15.)
  //
  // Capability used to be a property of the agent process — a settings file
  // written once at launch — while authority was a property of the message, read
  // out of prose by a verb lexicon. F-007 walked straight through the gap: the
  // lexicon said "conversation", so a fully research-capable agent answered a
  // non-owner with a live web fetch.
  //
  // Now the node states the turn's authority before every wake, and the runtime
  // gate (src/runtime/toolgate.mjs) enforces it at the moment a tool would run.
  // Nothing here reads the request text.
  //
  // ── The owner's turn IS "everything the owner switched on" again (DD-56) ──
  //
  // DD-35 subtracted `build` for everyone because AC-16 (0.3.1) said so, and
  // AC-16's stated reason was always deploy's: F-019's bill was a run402
  // project and a public subdomain committed with nothing to say yes to — and
  // what commits those is the DEPLOY, which still confirms once, as its own
  // proposal in `#delegateDeploy`. Spec 0.7.0 sends build back to the owner's
  // no-round-trip promise ("If I ask it auto does"), so the owner's turn
  // carries every enabled capability, and only a NON-owner's automatic turn
  // (auto-allow) still gets the subtracted set — a stranger's build is
  // escalated (AC-67), never granted by default.

  // An authority is the node's statement about ONE turn. It is keyed to the
  // event that will trigger that turn — which is the message itself when the
  // harness delivered it directly, and the node's own wake event when it did
  // not (DD-20). The caller attaches the key; this only describes the decision.
  #grant({ agent, capabilities, reason, requester, proposalId = null, signature = null }) {
    return { type: "authority", kind: "grant", agent, capabilities, reason, requester, proposalId, signature };
  }

  #withhold({ agent, reason, requester }) {
    return {
      type: "authority",
      kind: "withhold",
      agent,
      capabilities: [],
      reason,
      requester,
      proposalId: null,
      signature: null,
    };
  }

  // The record that precedes an ordinary wake. The owner's own turn carries
  // their agent's enabled capabilities (AC-16 — no approval round trip); an
  // agent whose owner chose `auto-allow` has opted out of gating entirely;
  // everyone else's turn carries nothing at all.
  #turnAuthority({ agent, event }) {
    if (event.pubkey === agent.ownerPubkey) {
      return this.#grant({
        agent,
        capabilities: ownerTurnCapabilities(agent),
        reason: "owner request",
        requester: event.pubkey,
      });
    }
    if ((agent.crossOwnerAsks ?? "owner-approves") === "auto-allow") {
      return this.#grant({
        agent,
        capabilities: automaticCapabilities(agent),
        reason: "cross-owner requests are auto-allowed",
        requester: event.pubkey,
      });
    }
    return this.#withhold({
      agent,
      reason: `turn triggered by ${short(event.pubkey)}…, who is not ${agent.name}'s owner`,
      requester: event.pubkey,
    });
  }

  // The wake path decides exactly two things: does this message reach the
  // agent, and what may the turn it triggers DO? It does not read the request
  // for meaning, and after F-013 it does not read it at all.
  //
  // ── Why the lexicon is gone, not demoted again (DD-26) ───────────────────
  //
  // `classifyIntent` used to run here, and a hit went to a decision that could
  // REFUSE. So "how do we build trust in a team?" — from the agent's own owner
  // — was answered with `@spike cannot do that: capability "build" is disabled
  // for spike.` and the agent never ran. Two of five ordinary sentences, in a
  // room whose whole subject is people BUILDING software together.
  //
  // Read the criteria: AC-17 governs "an ACTION the agent is not
  // capability-enabled for"; AC-12 governs an agent PERFORMING a
  // non-conversational action. A sentence that contains the word "build" is
  // neither of those things.
  //
  // DD-15 kept the lexicon as "an optimisation" and left it in the path, where
  // it went on deciding. Its two error directions are not symmetric, and that
  // is the whole argument: a false negative reaches the containment layer,
  // which cannot be talked around; a false positive is a refusal to TALK, which
  // is the one thing "conversation is always free" forbids. No threshold fixes
  // that, because the words are the same words.
  //
  // Refusals and approval requests now come from `handleBlockedAction`, fed by
  // the tool gate — which sees an action being attempted rather than a sentence
  // being written, and can therefore never be wrong about which it is.
  #forAgent({ agent, event, deliveredDirectly = false }) {
    const command = commandIn(event.content);
    if (command) return this.#answerCommand({ agent, event, command });
    return this.#withAuthority({ agent, event, deliveredDirectly, reason: "addressed" });
  }

  #handleApproval(event) {
    const match = event.content?.match(APPROVAL_RE);
    if (!match) return null;

    const [, verb, typed] = match;
    const parked = this.#pending.get(typed.toLowerCase()) ?? this.#pending.get(typed);
    // The token as ISSUED, not as typed: it keys an on-disk authority record,
    // and a case-shifted key would write one file and read another.
    const token = parked?.token ?? typed;
    // Nobody is holding that token: it is stale, already spent, or the words
    // simply lined up that way. So this is not an approval — it is a message
    // like any other, and it falls through to be answered. Returning `[]` here
    // still counted as "handled", which swallowed the message whole: no wake,
    // no reply, no notice. Same defect class as F-013 (DD-26).
    if (!parked || parked.state !== "pending") return null;

    // AC-14/AC-35: only the authorised approver counts, identified by the
    // pubkey that signed the event — never by display name. The relay verifies
    // the signature, so authorship here is already authenticated.
    if (event.pubkey !== parked.approver) {
      this.#audit.approval({
        agent: parked.agent.name,
        approver: short(event.pubkey),
        proposalId: token,
        granted: false,
      });
      return [
        this.#say(
          `Ignoring that: only ${parked.agent.name}'s owner can approve this request.`,
          [event.pubkey],
        ),
      ];
    }

    const granted = verb.toLowerCase() === "approve";
    // AC-68 (DD-58): text after the approve token is the owner amending the
    // request in the same breath — "approve h4-x, but only the top-level
    // folder" — and what runs is the amended request. Leading separators are
    // dropped; bare punctuation is not an amendment. Text BEFORE the token
    // ("sure — approve h4-x") is greeting, not instruction, and is ignored.
    const after = String(event.content ?? "").slice((match.index ?? 0) + match[0].length);
    const trailing = after.replace(/^[\s,.:;!—–-]+/, "").trim();
    const amendment = granted && /[a-z0-9]/i.test(trailing) ? trailing : "";
    parked.state = granted ? "approved" : "denied";
    this.#audit.approval({
      agent: parked.agent.name,
      approver: short(event.pubkey),
      proposalId: token,
      granted,
    });

    if (!granted) {
      return [this.#say(`Denied — ${parked.agent.name} will not ${parked.action}.`, [parked.requester])];
    }

    // A deploy proposal releases the NODE's work, not the agent's (DD-27).
    // Re-waking the agent here would send it straight back at a tool the gate
    // refuses unconditionally, spend an AC-26 turn on a call that cannot
    // succeed, and let a model re-type the URL and the receipt.
    if (parked.delegate === "run402") {
      return [
        {
          type: "deploy",
          agent: parked.agent,
          project: parked.project,
          subdomain: parked.subdomain ?? null,
          token,
          signature: parked.signature ?? null,
          requester: parked.requester,
          detail: parked.detail ?? null,
          authority: this.#grant({
            agent: parked.agent,
            capabilities: ["build"].filter((c) => parked.agent[c] === true),
            reason: `deploy approved by owner (${token})`,
            requester: parked.requester,
            proposalId: token,
            signature: parked.signature ?? null,
          }),
        },
      ];
    }

    // The approval is what turns the capability on, for this one released turn.
    // Before DD-15 the approval only released a wake, and the capability was
    // already sitting there whether anyone approved or not.
    //
    // The wake is written from the PROPOSAL, not from whichever message the
    // node happened to be holding. In F-009 those were different things, and
    // the agent resumed somebody else's request while the owner watched their
    // own go unanswered. Stating the approved action makes the resumed work the
    // work that was approved.
    //
    // ── DD-21 is not relaxed for the owner, and that was a deliberate retreat ─
    //
    // The first cut of DD-35 released an owner's own build confirmation as a
    // TURN-scoped grant with no signature, reasoning that the approver and the
    // requester are the same person so the binding buys nothing. Running it
    // showed what it would have cost. An approval posted while the agent is
    // mid-turn is folded into the running turn by the harness, which produces a
    // turn the runtime cannot attribute (FIX-87) — and an unattributed turn is
    // exactly where a second person's queued message can be sitting. A
    // signature-less grant reachable from there is F-009 with extra steps.
    //
    // So the binding stays. The cost is real and bounded: a released build that
    // writes two files asks twice, once per file. (Since DD-56 this path is a
    // NON-owner's granted request or the FIX-87 edge — an owner's ordinary turn
    // carries build and never parks at all. The old owner-confirm rider about
    // the publish is gone with the carry it described: a deploy the released
    // work leads to parks its own confirmation in `#delegateDeploy`.)
    //
    // ── AC-68 (DD-58): the grant runs the action as the OWNER'S OWN request ──
    //
    // The released wake is attributed to the OWNER — the person whose word
    // released it — and the grant's requester is the owner, "exactly as if the
    // owner had asked for it". The original asker stays on the record in the
    // proposal and the audit approval row; the RUN is the owner's.
    //
    // An AMENDED approval changes the concrete call, so an exact-signature
    // grant would refuse the very thing the owner just asked for. The amended
    // release is capability-scoped instead, bound tighter on every other axis:
    // keyed to this release wake's own event id, prompt-bound on first use,
    // TTL'd, one release per approval. A bare approve keeps DD-21 unchanged.
    const approvedWhat = parked.detail ?? `the approved ${parked.action}`;
    return this.#withAuthority({
      agent: parked.agent,
      event: parked.event,
      attributeTo: { pubkey: parked.agent.ownerPubkey },
      wakeContent:
        parked.detail || amendment
          ? `${stripAttribution(parked.event?.content)}\n\n[hive402] Your owner approved proposal ${token}: ` +
            `${approvedWhat}.` +
            (amendment
              ? ` Your owner AMENDED it: ${amendment}. Carry out the request AS AMENDED, ` +
                `and nothing else, then report back in the room.`
              : ` Carry out exactly that, and nothing else, then report back in the room.`)
          : null,
      reason: `${parked.action} approved by owner`,
      authority: this.#grant({
        agent: parked.agent,
        capabilities: [parked.action].filter((c) => parked.agent[c] === true),
        reason: `approved by owner (${token})${amendment ? ", as amended" : ""}`,
        requester: parked.agent.ownerPubkey,
        // Bound to this proposal — and, on a bare approve, to the one call it
        // named, single-use. A proposal parked from a request's WORDING
        // (rather than from a refused tool call) has no signature yet, so that
        // path stays capability-scoped as before.
        proposalId: token,
        signature: amendment ? null : (parked.signature ?? null),
      }),
    });
  }

  // ── Containment escalation (FIX-17) ──────────────────────────────────────
  //
  // The runtime gate refused a tool call, because the turn held no grant for
  // it. That refusal is the ONLY evidence that anything was attempted — the
  // request itself looked like conversation to everything upstream, which is
  // precisely F-007. So the node turns it into the approval request the
  // requester's phrasing never triggered, addressed to the person AC-14 says
  // must decide: the agent's owner.
  handleBlockedAction(record) {
    const agent = this.#agents.find((a) => a.name === record?.agent);
    if (!agent) return [];
    if (this.#handledBlocks.has(record.id)) return []; // the dir is re-scanned every tick
    this.#handledBlocks.add(record.id);

    // Who actually caused this? The runtime told us (DD-19): the blocked record
    // carries its own promptId, and the supervisor resolves that through the
    // turn record to the event — and the author — that really triggered it.
    //
    // The fallback is the old per-agent "last trigger" slot, which is a guess.
    // It is what F-009 got wrong: two messages 40ms apart, and the owner's own
    // refused fetch was reported as "while answering [tal]" and parked against
    // tal's message, so the owner's approval released tal's request.
    const trigger = record.triggerEvent ?? this.#lastTrigger.get(agent.name) ?? null;
    const requester = record.requester ?? trigger?.pubkey ?? null;

    // FIX-134: a refusal belongs in the thread of the request that caused it —
    // which for a blocked action is the TRIGGER, not whatever the room said
    // most recently. This is the same join F-009 taught us to make carefully:
    // get it wrong and a refusal is parked against somebody else's message.
    this.#anchor = trigger ? replyAnchor(trigger) : null;

    this.#audit.action({
      agent: agent.name,
      actor: "node",
      kind: record.capability,
      // Say WHY it was refused. A delegated call was not short of a grant and
      // never could be (DD-27), so logging "no grant for this turn" against one
      // would put a false explanation in the record a human queries.
      detail: record.delegate
        ? `contained: ${record.detail ?? record.capability} — refused at the tool boundary, ` +
          `${record.delegate} is the node's to run and never the agent's`
        : `contained: ${record.detail ?? record.capability} — refused at the tool boundary, no grant for this turn`,
    });

    // ── Did a human ask for this? (AC-52, DD-44.) ────────────────────────────
    //
    // The audit row above is written either way, and for a refusal nobody asked
    // for it is the WHOLE response. Announcing one in the channel reads as a
    // fault to every member who asked for nothing, and it publishes
    // `record.detail` — the actual argv the gate refused, which routinely
    // carries a URL or a header — into a shared room.
    //
    // AC-52 allows such a refusal to be "at most, raised with its owner". There
    // is no owner DM path in hive402: `#say` is the channel, and the channel is
    // exactly what AC-52 forbids here. So audit-only is what raising it with
    // the owner amounts to today, and `/audit` is how they read it.
    //
    // This sits above every branch on purpose. The loudest of them is the
    // deploy proposal, which names a run402 project and whose account pays —
    // the last thing that should appear because an agent reached for something
    // on its own.
    //
    // The trade-off is DD-44's own: a turn a human really did cause but that
    // the node could not attribute goes to the audit log instead of the room.
    // The alternative is announcing refusals nobody asked for.
    //
    // ── …and did a human ask for THIS ACTION? (FIX-169, DD-68.) ─────────────
    //
    // DD-44's question is turn-scoped; AC-52's is action-scoped, and the two
    // differ exactly when an agent does something of its own accord in the
    // middle of a turn a human started. `requester` falls back to
    // `#lastTrigger` — the last human who woke this agent — so a self-initiated
    // call inherits that human's authority and was published. T-059 is that
    // shape: a human asked spike2 a question, spike2 reached for its own memory
    // note mid-turn, and the room was told which capability its owner had
    // switched off, with `record.detail` — the refused call — attached.
    //
    // The GATE marks the record, because the gate is where the surface is
    // already resolved (DD-68). It marks surfaces nobody in this room can ask
    // for — an agent's own memory (AC-54) and the files that define it (AC-55)
    // — never intent, which is the verb lexicon DD-26 deleted for cause.
    //
    // The audit row above is written either way. That is what keeps this a
    // route rather than a mute, and it is what makes audit-only satisfy AC-52's
    // "AT MOST, raised with its owner".
    if (!this.#isHumanRequester(requester) || record.selfInitiated === true) return [];

    // AC-17: a capability the owner switched off is not something chat can
    // unlock, so no approval is offered for it. The tool is gone from the
    // runtime; a token would imply otherwise.
    if (agent[record.capability] !== true) {
      // Say which kind of "no" this is. Cycle 3 saw this exact line posted for a
      // turn that was only WITHHELD, and it reads as though nobody could fix it
      // — including the owner, who in that case could have. The two situations
      // now sound different: this one is a setting, the other is an approval.
      //
      // ── And say WHAT it refused (F-020, DD-37) ────────────────────────────
      //
      // This was the one refusal in the product that named no subject, and a
      // room cannot tell such a line apart from a refusal of whatever message
      // happens to sit above it. Cycle 7 filed exactly that: spike2 reached for
      // `node -e` while working out what an unrelated `/turns` meant, the gate
      // correctly refused it, and the notice landed one second after somebody
      // said the word "build" in a sentence about a treehouse. It read as a
      // keyword lexicon coming back — a reasonable reading of a line with no
      // subject, and one a real user would make. Its sibling below has always
      // named the call; so does this one now.
      return [
        this.#say(
          `@${agent.name} cannot do that: it tried to ${record.capability} ` +
            `(${record.detail ?? "an action"}) and its owner has "${record.capability}" switched ` +
            `off for ${agent.name}, so this cannot be unlocked by an approval — only by the owner ` +
            `changing that setting. Nothing anyone said was refused; the agent stopped itself here.`,
          requester ? [requester] : [],
        ),
      ];
    }

    // The owner set this agent to take no requests from other people at all.
    // That setting used to be enforced only in the pre-wake decision F-013's
    // fix deletes, and without moving it here the escalation path would ask the
    // owner to approve precisely what they configured away. The owner's own
    // request is not a cross-owner ask, so it is unaffected.
    if (
      requester &&
      requester !== agent.ownerPubkey &&
      (agent.crossOwnerAsks ?? "owner-approves") === "deny"
    ) {
      return [
        this.#say(
          `@${agent.name} cannot do that: it tried to ${record.capability} ` +
            `(${record.detail ?? "an action"}) and ${agent.name} does not take requests from ` +
            `others, so this cannot be unlocked by an approval — only by its owner changing that ` +
            `setting.`,
          [requester],
        ),
      ];
    }

    // DD-27: the gate did not refuse this because the turn lacked authority. It
    // refused it because run402 is not an agent's tool at all, and marked the
    // refusal with the party whose job it is. That mark is the ONLY trigger for
    // a deploy anywhere in hive402 — nothing reads the word "deploy" in a
    // sentence, and after DD-26 nothing reads the sentence.
    //
    // Deliberately AFTER the two refusals above, so gate order is unchanged: a
    // capability the owner switched off, and an agent that takes no cross-owner
    // asks, are both still answered before any deploy is contemplated.
    if (record.delegate === "run402") {
      return this.#delegateDeploy({ agent, record, requester, trigger });
    }

    // The SAME call, refused again, is not a second thing to approve.
    //
    // A turn that retries a refused call produces a second blocked record — and
    // a second prompt for the identical call would read as hive402 asking twice
    // about one thing.
    // Matching on the SIGNATURE, not the capability, is what makes this safe to
    // apply to everyone: a genuinely different call still gets its own prompt,
    // which it must, because an approval only ever releases the call it named.
    if (record.signature) {
      const already = [...this.#pending.values()].find(
        (p) =>
          p.state === "pending" &&
          p.agent?.name === agent.name &&
          p.requester === requester &&
          p.signature === record.signature,
      );
      if (already) return [];
    }

    const token = this.#token();
    this.#pending.set(token, {
      token,
      agent,
      requester,
      approver: agent.ownerPubkey,
      action: record.capability,
      event: trigger,
      // The identity of the exact call that was refused. This is what makes an
      // approval releasable only for the thing the owner was shown (DD-21) —
      // without it, "approve" meant "this agent may act now", and F-009 showed
      // what the next unrelated action does with that.
      signature: record.signature ?? null,
      detail: record.detail ?? null,
      state: "pending",
    });

    // ── AC-67 (DD-57): a non-owner's ask is put to the owner, not refused ────
    //
    // Two messages, two audiences. The requester learns the one fact that is
    // theirs — it needs the owner's permission, and the owner has been asked —
    // with no grant handle attached: nobody but the owner can grant it,
    // however the request is phrased (the approver check in #handleApproval is
    // the enforcement; this is the presentation). The owner gets the proposal,
    // addressed to them alone, naming the call and the asker.
    if (requester !== agent.ownerPubkey) {
      return [
        this.#say(
          `${agent.name} can do that only with its owner's permission — hive402 has put your ` +
            `request to them. Nothing runs unless they grant it.`,
          [requester],
        ),
        this.#say(
          `${agent.name} was asked to ${record.capability} (${record.detail ?? "an action"}) ` +
            `by ${short(requester)}…. Only you can grant this. ` +
            `Reply "approve ${token}" to run it, or "deny ${token}" to refuse.`,
          [agent.ownerPubkey],
        ),
      ];
    }

    // The OWNER's own refused call (DD-56, spec 0.7.0): their ordinary turn
    // CARRIES build, so reaching this point at all means something upstream
    // went wrong (the FIX-87 unattributed turn with nothing left to claim is
    // the known shape). The owner is both audiences at once, so the pair
    // collapses to one honest line: the turn holds no approval, and the parked
    // proposal is the recovery path.
    return [
      this.#say(
        `${agent.name} tried to ${record.capability} (${record.detail ?? "an action"}) ` +
          `for you, and hive402 stopped it — that turn holds no approval from you. ` +
          `Reply "approve ${token}" to allow it, or "deny ${token}" to refuse.`,
        [agent.ownerPubkey],
      ),
    ];
  }

  // The agent reached for run402 and the gate handed the work back to us
  // (DD-27). What happens next is an ordinary approval, with one difference:
  // approving releases a DEPLOY the node performs, not a wake that would send
  // the agent back to a tool it can never run.
  #delegateDeploy({ agent, record, requester, trigger }) {
    if (!this.#workshop) {
      // The safety valve. No workshop block means no project, which means there
      // is nothing an approval could authorise and no money to spend.
      return [
        this.#say(
          `@${agent.name} cannot deploy: no run402 workshop is configured for this room, so hive402 ` +
            `has no project to deploy to. Its owner sets one in the node config.`,
          requester ? [requester] : [],
        ),
      ];
    }

    const token = this.#token();

    // ── The deploy confirms on deploy's own merits — once, for everyone ──────
    //
    // DD-35 carried the owner's BUILD confirmation forward onto the deploy so
    // one yes covered the run (its `releasedBy` branch, retired by DD-56). That
    // carry existed to avoid a second round trip — but the confirmation it rode
    // was the build's, and spec 0.7.0 removed that confirmation entirely: an
    // owner's build now runs on the owner's word alone, so there is nothing for
    // a deploy to ride and no second round trip to avoid. The proposal parked
    // below is the ONE confirmation AC-16 still requires, sited exactly where
    // its stated reason lives — it is the deploy that commits a run402 project
    // and a public subdomain under the owner's account.
    //
    // A build approval must never silently cover a deploy it did not name: the
    // owner was shown a `Write`, and the thing they would silently also be
    // agreeing to is a public URL on their own account. True for the owner's
    // own edge-path confirmations exactly as for a stranger's (AC-69's "a
    // grant covers the one request it answered" is the same rule one layer up).
    //
    // Everyone lands here, auto-allow included. That setting says cross-owner
    // REQUESTS need no approval; it is not a standing authorisation to spend
    // the owner's run402 account. An unattributable requester lands here too,
    // which is the conservative direction.
    this.#pending.set(token, {
      token,
      agent,
      requester,
      approver: agent.ownerPubkey,
      action: "build",
      delegate: "run402",
      project: this.#workshop.project,
      subdomain: this.#workshop.subdomain ?? null,
      event: trigger,
      signature: record.signature ?? null,
      detail: record.detail ?? null,
      state: "pending",
    });

    const forWhom =
      requester === agent.ownerPubkey ? "you" : requester ? `${short(requester)}…` : "someone in this room";
    return [
      this.#say(
        `${agent.name} wants to deploy for ${forWhom}, ` +
          `and hive402 stopped it: an agent never runs run402 itself. If you approve, the hive402 node ` +
          `will deploy the "${DEPLOY_DIR}" folder from ${agent.name}'s working directory to run402 project ` +
          `${this.#workshop.project}, using YOUR run402 account, and post the live URL and receipt here. ` +
          `Reply "approve ${token}" to allow it, or "deny ${token}" to refuse.`,
        [agent.ownerPubkey],
      ),
    ];
  }

  // The runtime refused a turn because the agent is over its budget (AC-26).
  // Say so in the room, once per pause — the agent itself cannot, because the
  // turn that would have spoken is the turn that was refused.
  announcePause(record) {
    const agent = this.#agents.find((a) => a.name === record?.agent);
    if (!agent) return [];
    const { notice } = this.#turnCap.tryConsume(agent.name);
    if (!notice) return [];
    this.#audit.action({
      agent: agent.name,
      actor: "runtime",
      kind: "turn-cap",
      detail: `paused: ${record.limit} turns used in the last ${Math.ceil((record.windowMs ?? 3600000) / 60000)} minutes`,
    });
    return [this.#say(`@${agent.name}: ${notice}`, [])];
  }

  #answerCommand({ agent, event, command }) {
    if (command === "turns") {
      const remaining = this.#turnCap.remaining(agent.name);
      return [this.#say(`${agent.name}: ${remaining} model turns left in the current window.`, [event.pubkey])];
    }
    if (command === "help") {
      return [
        this.#say(
          `hive402 · @${agent.name} — "/audit" recent actions and approvals, ` +
            `"/turns" remaining turn budget. Anything else is a message for the agent.`,
          [event.pubkey],
        ),
      ];
    }

    // AC-27: answered by the NODE from the real record. Cycle 1 asked the agent
    // and got a narrative it labelled as its own reconstruction, because no
    // queryable log existed.
    const rows = this.#audit.query({ agent: agent.name, limit: 10 });
    if (rows.length === 0) {
      return [this.#say(`No audit entries recorded for ${agent.name} yet.`, [event.pubkey])];
    }
    const lines = rows.map((r) =>
      r.type === "approval"
        ? `· approval ${r.granted ? "granted" : "refused"} by ${r.approver} (${r.proposalId})`
        : r.type === "settings_change"
          ? `· setting ${r.setting}: ${r.from} → ${r.to} by ${r.actor}`
          : `· ${r.kind} — ${r.detail} (asked by ${r.actor})`,
    );
    return [
      this.#say(`Audit log for ${agent.name} (most recent first):\n${lines.join("\n")}`, [event.pubkey]),
    ];
  }

  #wake({ agent, event, reason, deliveredDirectly = false }) {
    return this.#wakeEffects({ agent, event, reason, deliveredDirectly }).effects;
  }

  // A wake, plus whether a model turn was actually dispatched. The caller needs
  // to know, because a turn that never happens must not be handed a capability
  // grant — an unused grant sitting on disk is exactly the leak the prompt
  // binding exists to prevent.
  #wakeEffects({ agent, event, reason, deliveredDirectly = false }) {
    // AC-26's fuse is no longer here. It moved to the runtime's prompt boundary
    // (DD-23), which is the only place that sees the turns buzz-acp hands an
    // agent's owner directly — the ones F-011 showed sailing past this counter.
    //
    // Keeping a second check here was actively harmful, and only running it
    // showed why: the runtime counts a turn, the node polls a moment later,
    // reads the ledger as full, and announces a pause for the turn about to be
    // answered — while ALSO suppressing the wake, so a non-owner's message the
    // runtime would have allowed is never delivered at all. One decision point.
    // The node's job is to tell the room what the runtime blocked
    // (`announcePause`), not to make the decision twice.
    this.#lastTrigger.set(agent.name, event);
    // Counted, but relaying would double-dispatch: the harness already woke it.
    //
    // FIX-135 (F-023): the branch no longer returns NOTHING. It returns a
    // receipt. "The harness has it" is a claim about delivery, and this path
    // had no way to find out it was wrong — `#isAgentRunning` is process
    // liveness, so a message folded into a turn already in flight and never
    // addressed by the model vanished with no wake, no turn record and no
    // audit row. The node keeps the handoff; the supervisor asks later whether
    // the agent ever replied, and relays it through this same wake path if not.
    if (deliveredDirectly) {
      return { dispatched: true, effects: [{ type: "handoff", agent, event }] };
    }
    // AC-50 / DD-42: the wake joins the conversation it is relaying. The
    // harness reads the WAKE's thread tags to tell the agent where to reply
    // (queue.mjs `resolve_reply_anchor`), so an unanchored wake is what makes
    // an agent answer in a thread hanging off the node's own relay message.
    return {
      dispatched: true,
      effects: [
        {
          type: "wake",
          agent,
          event,
          reason,
          replyTo: replyAnchor(event),
          // The human's words with any attribution-shaped line removed (DD-41).
          // Stripping happens HERE, on the human text alone, and never on the
          // composed wake: the node writes marker lines of its own further down
          // (an approval release explains itself in the same block), and a
          // strip after composition would delete those too.
          // `event` is null when a proposal was parked with no trigger to
          // point at, which the approval path can still release.
          content: stripAttribution(event?.content),
        },
      ],
    };
  }

  // Every wake this node authorises comes with the record that says what the
  // turn may do — attached to the event that will actually trigger it.
  //
  // Cycle 2 made this safe by ORDER (record first, wake second), which held
  // only while there was one turn at a time. F-009 was two turns at once, and
  // order cannot separate two writers of one slot. So the authority is now
  // KEYED instead:
  //   • delivered directly → the trigger is this message; key it by event.id
  //     and emit it as its own effect.
  //   • relayed by the node → the trigger will be the wake the supervisor is
  //     about to publish, whose id does not exist yet. The authority rides on
  //     the wake so the supervisor can key it once the id comes back.
  #withAuthority({ agent, event, deliveredDirectly, reason, authority = null, wakeContent = null, attributeTo = null }) {
    const { dispatched, effects } = this.#wakeEffects({ agent, event, reason, deliveredDirectly });
    if (!dispatched) return effects;

    const decided = authority ?? this.#turnAuthority({ agent, event });
    const wake = effects.find((e) => e.type === "wake");
    if (wake) {
      wake.authority = decided;
      if (wakeContent) wake.content = wakeContent;
      // AC-68: an approval-released run is attributed to the OWNER whose word
      // released it, not to the event that originally carried the request.
      if (attributeTo) wake.attributeTo = attributeTo;
      return effects;
    }
    // `event` travels with it so the supervisor can describe this turn later,
    // when the gate refuses something inside it (FIX-27).
    return [{ ...decided, eventId: event?.id ?? null, event }, ...effects];
  }

  // FIX-134 — every node notice lands in the THREAD it is about.
  //
  // Barry, watching Tal talk to smith: smith answered in the thread (the wake
  // carries `replyTo`, so the harness anchors the reply), while the node's
  // refusal shouted in the channel root — out of context, next to nothing it
  // referred to.
  //
  // No `say` had ever carried an anchor: not refusals, not turn-cap notices, not
  // approval prompts. The wake path threaded correctly and the notice path never
  // had the field at all, so the two halves of one exchange landed in two
  // different places.
  //
  // The anchor is set once per handled message rather than passed in at each of
  // the thirteen call sites, so a notice added later is threaded by default
  // instead of by remembering.
  #say(content, mentions = []) {
    return { type: "say", content, mentions, replyTo: this.#anchor ?? null };
  }
}
