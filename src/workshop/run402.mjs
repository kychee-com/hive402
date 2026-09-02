// The run402 workshop path (DD-27, fix cycle 6).
//
// hive402 is a CONSUMER of run402: approved builds are deployed there and the
// live URL + receipt come back into the channel. Nothing in run402 changes —
// this module only calls its CLI.
//
// ── Who runs this, and why it is not the agent ────────────────────────────
//
// The NODE runs it. The tool gate refuses `run402` in an agent process
// unconditionally (FIX-43), so the only route to a deploy is: the agent reaches
// for the command, the gate refuses and marks the refusal delegated, and the
// node — reading that mark — asks the owner and then does the work itself.
// Three reasons, in full in DD-27: the owner's wallet never enters an agent
// process; the project and subdomain are a resource commitment the agent may
// not choose; and the URL and receipt posted in the room are read from run402's
// own result envelope rather than re-typed by a model.
//
// ── Why there is no `approved` boolean any more ───────────────────────────
//
// There was one, and this module had six passing tests around it while nothing
// in `src/` or `bin/` imported the file at all (issue #4). A boolean parameter
// is an invitation to hand-roll permission at whichever call site eventually
// appears. So the deploy is authorised by the SAME on-disk record type as every
// tool call, read here rather than passed in, and verified by the SAME function
// the tool gate uses. No record, a withheld record, an expired record, a spent
// record or a record naming a different call all deploy nothing.

import { consumeAuthority, coversCapability, readAuthority } from "../runtime/grants.mjs";

export async function buildAndDeploy({
  stateDir,
  agent,
  project,
  dir,
  // The public name the owner configured for this room's workshop, if any. A
  // run402 project has no live URL until a subdomain is bound to a deployment
  // (measured 2026-08-18), so this is what turns a receipt into AC-29's URL.
  subdomain = null,
  token,
  signature,
  run402,
  now = Date.now(),
}) {
  // Capability first, exactly as the gate orders it (AC-17 before AC-14): a
  // build-disabled agent never reaches run402 even holding an approval, and its
  // approval is not even spent — there was nothing to spend it on.
  if (agent?.build !== true) {
    return { ok: false, reason: `capability "build" is disabled for ${agent?.name}` };
  }

  // The authority the node wrote when the owner approved, keyed by the proposal
  // token. Read from disk, not from an argument.
  const authority = readAuthority({ stateDir, agent: agent.name, eventId: token });
  const verdict = coversCapability({ grant: authority, capability: "build", signature, now });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason };
  }

  // Spend it BEFORE calling run402. A deploy that dies half way through has
  // still spent the owner's approval, and a retry must ask again rather than
  // silently producing a second deployment.
  consumeAuthority({ stateDir, agent: agent.name, eventId: token, now });

  let result;
  try {
    result = await run402.deploy({ project, dir, subdomain });
  } catch (err) {
    return { ok: false, reason: err?.message ?? "deploy failed" };
  }
  if (!result?.ok) {
    return { ok: false, reason: result?.error ?? "deploy failed" };
  }
  return { ok: true, url: result.url ?? null, receipt: result.receipt, warning: result.warning ?? null };
}

// What the room is told after a successful deploy (AC-29, AC-30, AC-31).
//
// Three things, and the second is the one a reader would otherwise have to
// guess: the live URL, the receipt, and WHOSE run402 account paid for it. The
// interim identity is the agent's owner's account (issue #2 gives an agent its
// own principal); a room that cannot see whose money moved cannot judge the
// deploy, so it is disclosed in the room rather than in a design document.
//
// AC-31 is covered as a POINTER: the message names the project and the exact
// `run402 transfer init` command a room human runs to become a co-owner
// through run402's existing adoption flow. Actually transferring ownership
// needs a second wallet and is a real resource commitment, so hive402 states
// the route rather than walking it.
export function formatDeployMessage({ project, url, receipt, identity, warning = null }) {
  // No URL is a real outcome, not an error to paper over: the bytes are
  // deployed and the receipt proves it, but nothing public points at them until
  // a subdomain is bound. Say that, and say what would fix it. Guessing a
  // hostname would put a 404 in the room under the word "Live".
  const live = url
    ? [`Live: ${url}`]
    : [
        `Live: not yet. The deploy is real (see the receipt), but this run402 project has no`,
        `subdomain bound, so nothing public points at it. To publish it:`,
        `  run402 subdomains claim <name> --project ${project} --deployment ${receipt}`,
      ];

  return [
    `Deployed to run402.`,
    ``,
    ...live,
    ...(warning ? [`Note: ${warning}`] : []),
    `Receipt: ${receipt}`,
    `Project: ${project}`,
    ``,
    `Whose identity ran this: ${identity}. hive402's node ran run402 itself, so the ` +
      `agent never held the account and never chose the project.`,
    ``,
    `To co-own it, any human here can adopt the project through run402:`,
    `  run402 transfer init --project ${project} --to <your run402 account>`,
  ].join("\n");
}
