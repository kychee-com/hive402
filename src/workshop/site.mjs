// The one directory hive402 publishes (DD-27, DD-36).
//
// Fixed on purpose, and named in exactly one place. The agent decides the
// CONTENT of a deploy and never its location: the node deploys `<workDir>/site`
// and nothing else, so a project id and a public subdomain stay the owner's
// resource commitment rather than something an agent picks.
//
// Two very different readers need this name, which is why it lives on its own:
//
//   • the supervisor, to know what to hand run402;
//   • the tool gate, to know that this one subdirectory of the agent's own
//     working directory is NOT scratch paper.
//
// The second is TR-008's answer. DD-33 makes an in-workspace write composition —
// a draft, a note, a half-finished file nobody else reads — and that argument
// stops dead at the folder whose bytes become a public URL. Before this, a turn
// holding no authority at all could `cat > site/index.html <<'EOF' … EOF`,
// because the target sat inside the working directory, and the owner would then
// approve a deploy without being told who wrote what they were publishing.
//
// If these two ever disagreed about the name, the gate would guard a directory
// the node does not publish. `test/workshop-gate.test.mjs` asserts they cannot.
import path from "node:path";

export const DEPLOY_DIR = "site";

// Where a given agent's publishable files live.
export function deployDirIn(workDir) {
  return path.join(workDir, DEPLOY_DIR);
}
