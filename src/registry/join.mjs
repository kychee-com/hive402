// `hive402 join <invite-link>` — the node becomes a community member (F-10).
//
// ── What this replaces ─────────────────────────────────────────────────────
//
// A session script. The node DID join the Kychee community with its own key,
// and it worked, but the sequence lived in a transcript: paste the code, sign
// this, POST that. AC-44 makes it the product, and AC-45 adds the thing a
// script cannot own — the human is shown the community's policy and accepts it
// explicitly, and a missing acceptance is a stop rather than a default.
//
// ── AC-43 is the load-bearing property here ────────────────────────────────
//
// The whole flow signs with the key the NODE minted for itself. There is no
// branch on which a human's secret is read, prompted for, or accepted, and a
// test walks this module's import graph to prove the secret prompt is not
// reachable from it at all. That is what makes a node revocable on its own: a
// node that borrowed its owner's key could not be turned off without turning
// off the person.
//
// ── The wire, from buzz origin/main 29f2054c ───────────────────────────────
//
//   GET  /api/join-policy            {} when the community configures none,
//                                    else { policy: { terms_markdown,
//                                    privacy_markdown, version,
//                                    age_attestation_required } }
//   POST /api/invites/accept-policy  { code, policy_version, age_confirmed }
//                                    -> { receipt }.  NOT NIP-98 signed: the
//                                    handler takes no headers, so signing it
//                                    would be inventing a requirement.
//   POST /api/invites/claim          { code, policy_receipt? }
//                                    -> { status, community_id, host, role }
//                                    NIP-98 signed, and the invite routes pass
//                                    require_payload = true, so the signature
//                                    must cover the exact body bytes.
//
// The claim route is deliberately exempt from the relay's membership gate —
// the point is that the caller is not a member yet. NIP-98 proves the joining
// key is ours; the invite code proves an admin authorised the join.

import { nip98Header, signNip98 } from "../identity/nip98.mjs";
import { writeJoinRecord } from "./joinrecord.mjs";

// `is_invite_landing_path` in crates/buzz-relay/src/router.rs: exactly one
// non-empty segment under /invite/. Everything else is a link to something
// that is not an invite, and saying which shape we wanted saves the reader a
// trip to the relay's source.
export function parseInviteLink(link) {
  const raw = String(link ?? "").trim();
  const shape = 'an invite link looks like "https://<relay-host>/invite/<code>"';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not an invite link: "${raw}" — ${shape}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`not an invite link: "${raw}" is not http(s) — ${shape}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "invite") {
    throw new Error(`not an invite link: "${raw}" — ${shape}`);
  }
  return { origin: url.origin, code: decodeURIComponent(segments[1]) };
}

// The relay's own error codes, in words. A join is the very first thing a
// person does with hive402, so "403" is the worst possible answer: each of
// these has a different next step and only the relay knows which one happened.
const CLAIM_ERRORS = new Map([
  ["invite_expired", "that invite has expired — ask whoever sent it for a fresh link"],
  ["invite_exhausted", "that invite has been used up (it had a limited number of uses) — ask for a fresh link"],
  ["invite_invalid", "the relay says that invite code is not valid — check the link was copied whole"],
  ["join_policy_required", "the relay wants the join policy accepted, and the acceptance it was sent did not satisfy it"],
  ["join_policy_not_accepted", "the relay rejected the acceptance — the policy version may have changed while you were reading it"],
]);

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function explain(payload, status, fallback) {
  const code = payload?.error ?? payload?.message ?? null;
  return CLAIM_ERRORS.get(code) ?? `${fallback} (HTTP ${status}${code ? `: ${code}` : ""})`;
}

export async function joinCommunity({
  link,
  privateKeyHex,
  consent,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  stateDir = null,
  log = console.log,
}) {
  const { origin, code } = parseInviteLink(link);

  // Signing before anything is sent: a bad key should stop the command, not
  // leave a half-done acceptance on the relay.
  const { event } = signNip98({ privateKeyHex, url: `${origin}/api/join-policy`, method: "GET", now });
  const pubkey = event.pubkey;

  // 1. What does this community ask of a joiner?
  const policyResponse = await fetchImpl(`${origin}/api/join-policy`, { method: "GET", headers: {} });
  if (!policyResponse.ok) {
    throw new Error(
      explain(await readBody(policyResponse), policyResponse.status, `could not read the join policy at ${origin}`),
    );
  }
  const policy = (await readBody(policyResponse))?.policy ?? null;

  let receipt = null;
  let policyVersion = null;
  let ageConfirmed = false;

  if (policy) {
    // 2. Show it, then ask. In that order: an acceptance collected before the
    //    terms were displayed is not the thing AC-45 describes.
    const shown = {
      version: policy.version,
      terms: policy.terms_markdown ?? "",
      privacy: policy.privacy_markdown ?? "",
      ageAttestationRequired: policy.age_attestation_required === true,
      // The terms run to ~75k characters. Paging that into a terminal by
      // default is not showing it to anyone (DD-47), so the relay's own
      // browser-readable copies travel with the summary.
      termsUrl: `${origin}/api/join-policy/terms`,
      privacyUrl: `${origin}/api/join-policy/privacy`,
    };
    const answer = (await consent(shown)) ?? {};

    if (answer.accepted !== true) {
      throw new Error(`the join policy was not accepted — stopped, and nothing was sent to ${origin}`);
    }
    // hive402 never makes an attestation on a person's behalf. The relay would
    // refuse an unconfirmed one anyway, but sending someone else's age
    // assertion and letting the relay decline it is a different act from
    // declining to make it.
    if (shown.ageAttestationRequired && answer.ageConfirmed !== true) {
      throw new Error(
        "this community requires a minimum-age attestation and it was not given — " +
          "stopped. hive402 does not make that statement on anyone's behalf.",
      );
    }
    ageConfirmed = answer.ageConfirmed === true;
    policyVersion = policy.version;

    // 3. Exchange the acceptance for a receipt bound to THIS code and version.
    const body = JSON.stringify({ code, policy_version: policy.version, age_confirmed: ageConfirmed });
    const response = await fetchImpl(`${origin}/api/invites/accept-policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(explain(await readBody(response), response.status, "the relay refused the policy acceptance"));
    }
    receipt = (await readBody(response))?.receipt ?? null;
    if (!receipt) throw new Error("the relay accepted the policy but returned no receipt — cannot claim the invite");
  }

  // 4. Claim, as ourselves.
  const claimBody = JSON.stringify(receipt === null ? { code } : { code, policy_receipt: receipt });
  const claimUrl = `${origin}/api/invites/claim`;
  const response = await fetchImpl(claimUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: nip98Header({ privateKeyHex, url: claimUrl, method: "POST", body: claimBody, now }),
    },
    body: claimBody,
  });
  const payload = await readBody(response);
  if (!response.ok) {
    throw new Error(explain(payload, response.status, "the relay refused the invite claim"));
  }

  const result = {
    status: payload?.status ?? "joined",
    alreadyMember: payload?.status === "already_member",
    host: payload?.host ?? new URL(origin).host,
    communityId: payload?.community_id ?? null,
    role: payload?.role ?? "member",
    origin,
    pubkey,
    policyVersion,
    ageConfirmed,
  };

  // 5. Write down WHICH version was accepted (AC-45). Only now — a record
  //    written before the claim succeeded would claim an acceptance for a
  //    membership that does not exist.
  if (stateDir) writeJoinRecord({ stateDir, record: { ...result, acceptedAt: now } });

  log(
    result.alreadyMember
      ? `hive402: already a member of ${result.host} — nothing to do`
      : `hive402: joined ${result.host} as ${result.role}`,
  );
  return result;
}
