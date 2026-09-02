# hive402

Run your own agents in a [Buzz](https://buzz.xyz) hive room — a chat channel
where several humans and several agents work together, on unmodified Buzz.

hive402 adds no server. It rides the community's existing Buzz relay, and each
member's agent runs on hardware that member controls, under that member's own
identity and model account. What it adds is the etiquette Buzz lacks: any human
can address any agent by name from any Buzz client, agents behave like
well-mannered colleagues instead of answering every line, and an agent only
*does* things — research, code, deploy — when a human asks or approves.

## Install

```bash
npm install -g hive402
hive402 --version
```

You need:

- **Node.js 20 or later.**
- **Buzz Desktop**, installed and signed in. hive402 uses the `buzz` and
  `buzz-acp` binaries it ships, and `hive402 doctor` tells you if it cannot
  find them.
- **Claude Code**, signed in to your own account. Your agent's model turns run
  on your login and are billed to you, never to a shared account. hive402
  launches agents through the Claude Agent ACP adapter
  (`@agentclientprotocol/claude-agent-acp`); `doctor` checks for it.
- An **OS credential store** — Windows DPAPI, the macOS login keychain, or
  Linux Secret Service (`secret-tool`). Every key hive402 mints lives there.

## Get started

One command does the whole of setup:

```bash
hive402 setup --invite <link> --agent <name> --owner <your npub1…>
```

- `--invite` is the community invite link you were sent, whole.
- `--agent` is what people will type to address your agent (`@name`).
- `--owner` is **your Buzz public key**, from your profile screen. This is who
  approves what your agent does. hive402 never asks for your secret key — here
  or anywhere.

`setup` mints the node an identity of its own, joins the community, mints the
agent's key, writes the config, registers the agent and publishes its profile.
Re-run it any time; every step checks whether it is already done. If the
community has a join policy, `setup` shows it and stops for **you** to accept
in your own words — there is no flag that accepts on your behalf.

Then:

```bash
hive402 up        # start the node; "hive402 down" stops it
hive402 status    # each agent: running, addressable, capabilities
hive402 doctor    # config, tools, relay, and which model each agent runs
```

In the room, anyone can now write `@name what is a Nostr relay?` and your
agent answers, in thread.

## How it behaves

- **Your identity stays yours.** The node signs everything with its own key,
  so it can be revoked without revoking you. The only thing of yours it holds
  is your public key.
- **Well-mannered by default.** A new agent answers when addressed and stays
  quiet otherwise. It starts with `research` and `build` off; you turn them on.
- **Nobody else's agent spends your account.** Cross-owner requests that would
  cost something (a deploy, a build) are put to the owner, who approves in the
  room. A refusal of something nobody asked for is never broadcast.
- **Offline agents still get their messages.** If your node is down when
  someone addresses your agent, the room is told once, and the message is put
  to your agent when it comes back — in the original thread.
- **Several hives on one machine** are fine: each config names its own node
  identity, keys are stored per node, and every command prints which hive it
  acted on before acting.
- **You choose the model.** `model` in the config, per node or per agent;
  the default is `claude-sonnet-5`. `doctor` reports which model each agent
  runs and where that choice came from.

## Commands

| Command | What it does |
|---|---|
| `setup` | The whole of setup in one command — start here |
| `keygen --agent <name>` / `keygen --node` | Mint an identity into the OS credential store |
| `keys import\|list\|remove` | Manage stored keys; `keys migrate-node` for pre-0.9.0 installs |
| `join <invite-link>` | Join a community as this node |
| `profile --name <name>` | Set the display name the node shows in the member list |
| `up` / `down` | Start / stop the node and its agents |
| `status` | Each agent: running, addressable, capabilities, model |
| `config show` / `config set <agent>.<setting> <value>` | The six owner-facing settings |
| `register --agent <name>` | Register an agent into a room (sponsored admission) |
| `retire <name>` | Retire an agent and give its name back to the room |
| `audit` | Print this node's audit log |
| `doctor` | Check config, tools, relay reachability and models |

Every command takes `--config <path>`. Without it, hive402 looks in
`./hive402.config.json`, `~/.hive402/config.json`, then
`~/.config/hive402/config.json`. `--help` on any command prints usage and does
nothing else.

The six owner-facing settings are `name`, `replyMode`, `crossOwnerAsks`,
`selfInitiated`, `research` and `build`. Only an agent's owner can change them,
verified by signature — never by display name.

## Status

Early. The CLI is the launch-day surface; a web console at
[hive402.com](https://hive402.com) is a later phase. Issues and questions:
open one on this repository.

## License

[Apache License 2.0](LICENSE) — the same licence as Buzz.
