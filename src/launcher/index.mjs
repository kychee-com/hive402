import { buildAgentEnv } from "./env.mjs";

// launchAgent — hand-launch one buzz-acp agent with its explicit policy env.
//
// The concrete exec glue (locating the Desktop-bundled buzz-acp binary and
// wiring the claude-agent-acp adapter + Claude Code) is confirmed in spike S1
// and injected via `resolveCommand`. `spawn` is injected so the launch logic
// is testable without a live process; production passes node's child_process
// spawn.
//
// Isolation invariant (spec AC-3): the child receives ONLY the policy env this
// builder produced — the ambient process env is NOT inherited, so one agent's
// credentials can never leak into another's process.
export function launchAgent({
  agent,
  room,
  secrets,
  spawn,
  resolveCommand = defaultResolveCommand,
}) {
  const env = buildAgentEnv({ agent, room, secrets });
  const { command, args } = resolveCommand({ agent, room });
  return spawn(command, args, { env });
}

// Placeholder until spike S1 records the verified recipe. Kept isolated here so
// S1 changes exactly one function.
function defaultResolveCommand() {
  return { command: "buzz-acp", args: [] };
}
