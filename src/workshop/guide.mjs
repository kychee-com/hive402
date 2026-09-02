// What the agent is told about this room's workshop, before it needs to know.
//
// ── Why this file exists (found by running it, 2026-08-18) ────────────────
//
// FIX-43/44/45 built the whole deploy route and it worked: the gate refuses
// run402, the node reads the refusal, asks the owner, deploys, posts the URL
// and the receipt. Then the first live run produced no deploy at all. spike,
// asked to "put a todo list live on the web", wrote a page into a `.scratch`
// folder it invented and announced it would "publish it with buzz upload file".
// It never reached for run402, so the delegate refusal never happened, so
// nothing triggered the path.
//
// That is issue #4's own bug class one level up. A caller with no trigger is as
// unreachable as a module with no caller, and no unit test can see either.
//
// So the node states the protocol where the runtime will actually read it: a
// CLAUDE.md in the agent's own working directory, which the model runtime loads
// as project context. It is written per launch from the room's config, so it
// cannot drift from what the node will actually do.
//
// Note the shape of the instruction: the agent is told to run a command that
// will be REFUSED, and that the refusal is the request. That is not a
// workaround, it is DD-27's design — the attempted call is what carries the
// intent and the signature the owner's approval binds to. Saying so plainly is
// what stops the agent reading the refusal as a failure to route around.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { DEPLOY_DIR } from "./site.mjs";

export const WORKSHOP_GUIDE_FILE = "CLAUDE.md";

export function writeWorkshopGuide({ workDir, agent, workshop }) {
  // No workshop, nothing to say. A guide describing a workshop this room does
  // not have would send the agent at a command that can only ever be refused.
  if (!workshop) return null;

  const file = path.join(workDir, WORKSHOP_GUIDE_FILE);
  writeFileSync(file, body({ agent, workshop }), "utf8");
  return file;
}

function body({ agent, workshop }) {
  return `# This workspace

You are ${agent.name}, running in a hive402 room. This file is written by the
hive402 node and describes how publishing works here.

## Publishing to the web

This room has a run402 workshop, so pages can be put on the public web.

**The \`${DEPLOY_DIR}\` folder in this directory is the published site.** Put
everything you want published there, and nothing else: files outside it are
never published, and a file you remove from it is removed from the live site.

**Writing into \`${DEPLOY_DIR}\` is a build, and a build always confirms with
your owner first — even when your owner is the one who asked you.** The rest of
this directory is your scratch paper and needs no permission at all; this one
folder is different because whatever is in it becomes a public web page on your
owner's account.

**Go ahead and make the write anyway. The refusal IS how your owner gets asked.**
Write the file you intend to publish, exactly as you would normally. hive402
will refuse it once, show your owner the exact call, and wake you again with
their answer — and their approval covers the publish too. What you must not do
is decide for yourself that it will be refused and ask in words instead: nothing
asks your owner except the attempt itself. One attempt, then stop and say what
you were doing. Do not retry it and do not route around it.

**You cannot run run402 yourself.** It spends your owner's run402 account and
commits a public address, so it is not something an approval can hand to you.
hive402's node runs it instead, against the project your owner configured.

To request publication, build the page into \`${DEPLOY_DIR}\` and then run:

    run402 sites deploy-dir ./${DEPLOY_DIR}

**That command will be refused, and the refusal is the request.** hive402 reads
it and deploys the \`${DEPLOY_DIR}\` folder itself, then posts the live URL and
the run402 receipt into the room. If your owner already confirmed this build,
that same confirmation covers the publish and they are not asked twice;
otherwise hive402 asks them now.

**Nothing publishes unless you run that command.** There is no other trigger:
the node is not watching the folder and does not act on its own, so "hive402
will deploy it" is only true after you have asked. Being told the publish is
already covered is not a reason to skip the request — it is the reason the
request will go straight through. Run it once, then stop: do not retry it and
do not look for another way to publish.

Do not invent, guess or predict the URL. You will not know it, the node posts
the real one, and a made-up address in the room is worse than none.
`;
}
