# pi-acp-adapter

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent) — formerly `pi-acp` / `pi-agent`.

`pi-acp-adapter` (binary aliases: `pi-acp`, `pi-agent`) speaks **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two. One ACP session ↔ one `pi` subprocess.

## Status

MVP intended to be useful today and easy to iterate on. Some ACP features are not implemented (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) — other clients may have varying compatibility. Expect minor breaking changes.

## Features

- **Streaming** — assistant `text_delta` → `agent_message_chunk`, reasoning `thinking_delta` → `agent_thought_chunk` (with `PI_ACP_THINK_HOLD_MS` coalescing so quick thoughts don't interleave with streamed text).
- **Tool calls** — pi `tool_execution_*` + streamed `toolcall_*` → ACP `tool_call` / `tool_call_update` (monotonic `pending` → `in_progress` → `completed/failed`, never downgrades):
  - Locations resolved against session `cwd` (absolute paths) so clients like Zed can follow-along / open the file. For `edit`, a pre-edit file snapshot is used to infer a 1-based `line` when `oldText` is unique.
  - `edit`/`write` → structured `diff` content (`oldText`/`newText` with `path`) when possible, instead of plain text.
  - `bash` → ACP terminal content (`terminal` + `terminal-output`/`terminal-exit` meta) with live output delta.
  - `todo` (rpiv) → ACP `plan` entries.
- **Session persistence & history** — pi owns sessions at `~/.pi/agent/sessions/...` (or `$PI_CODING_AGENT_DIR` / `$PI_SESSIONS_DIR` overrides). The adapter keeps a small mapping at `~/.pi/pi-acp/session-map.json` (or `$PI_ACP_DATA_DIR`) so `session/load` can reattach. Also supports:
  - `session/list` with `cwd` filtering (defaults to last session `cwd` when client sends no filter, matching pi's `/resume` picker) and cursor pagination (`nextCursor`, page 50).
  - `session/load` — replays full conversation (`user`/`assistant`/`toolResult` + bash terminal + diff) and re-advertises commands/models.
  - `session/delete` — idempotent per ACP spec.
  - `_session/steering` ext method for follow-up steering.
- **Slash commands** — see [Slash commands](#slash-commands).
- **MCP servers** — per-session, via bundled bridge extension (`-e`, env `PI_ACP_MCP_SERVERS`; one pi process per session makes env hand-off safe). Supports `stdio` (command), `http` (Streamable HTTP) and `sse`; advertises `mcpCapabilities: {http:true, sse:true}`. Tools are exposed as `<server>_<tool>`; a failing server only notifies without breaking others. `type:"acp"` (unstable channel) is not supported. Global MCP servers configured via pi itself (e.g. `pi-mcp-adapter`) still work independently.
- **Extensions & skills** — pi extensions/skills are loaded by pi directly. Skill commands appear as `/skill:skill-name` when `enableSkillCommands` is enabled in pi settings.
- **Startup info** — emits a prelude block (pi version, context, skills, prompts, extensions, workspace roots) similar to `pi` in a terminal. Disable with `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`); the "New version available" notice still shows. The update check is cached with `PI_ACP_CHECK_FOR_UPDATES=false` to disable.
- **Workspace roots** — `additionalDirectories` (ACP `additional-workspace-roots`) validated (absolute paths, de-duplicated, `cwd` is primary). Injected into the pi prompt as `<workspace_roots>` so the model treats those roots as part of the workspace. Relative paths still resolve against `cwd`.
- **Context usage** — `usage_update` via `get_session_stats` after each turn.
- **Model & thinking selectors** — advertises `model` and `thought_level` as `configOptions` (+ legacy `modes` for Zed), auto-enriched from pi's `get_available_models` / `get_available_thinking_levels` / `get_state`. Auth-required errors are surfaced as `authRequired`.

## Prerequisites

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js `>=20` (22+ recommended)
- `pi` `v0.84.4+` on `PATH` (the adapter spawns the `pi` executable)
- Configure `pi` separately for your model providers / API keys

## Install

### ACP Registry (Zed or other registry-aware clients)

`zed: acp registry` → select `pi ACP`. This keeps `settings.json` up to date:

```json
{
  "agent_servers": {
    "pi-acp": { "type": "registry" }
  }
}
```

### npx (no install, always latest)

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp-adapter"],
      "env": {}
    }
  }
}
```

### Global install

```bash
npm install -g pi-acp-adapter
```

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp-adapter",
      "args": [],
      "env": {}
    }
  }
}
```

Aliases `pi-acp` and `pi-agent` also work as commands.

### From source

```bash
npm install
npm run build
```

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp-adapter/dist/index.js"],
      "env": {}
    }
  }
}
```

## Configuration

### Environment variables

| Variable                               | Default        | Effect                                                                                                                                                        |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_ACP_PI_COMMAND`                    | `pi`           | Override the pi executable / absolute path.                                                                                                                   |
| `PI_ACP_PI_ARGS` / `PI_ACP_EXTRA_ARGS` | —              | Extra args appended when spawning pi.                                                                                                                         |
| `PI_ACP_DATA_DIR`                      | `~/.pi/pi-acp` | Adapter data dir (`session-map.json` lives here).                                                                                                             |
| `PI_CODING_AGENT_DIR`                  | `~/.pi/agent`  | Pi agent dir (`settings.json`, `sessions/`, `prompts/`, `extensions/`). Also respects `PI_SESSIONS_DIR` / `PI_AGENT_SESSIONS_DIR` for sessions.               |
| `PI_ACP_ENABLE_EMBEDDED_CONTEXT`       | `false`        | When `true`, advertises `promptCapabilities.embeddedContext`. When false, clients should avoid `resource` blocks — if sent anyway they degrade to plain text. |
| `PI_ACP_CHECK_FOR_UPDATES`             | `true`         | Set `false` to disable the 800ms npm update check in startup info.                                                                                            |
| `PI_ACP_THINK_HOLD_MS`                 | `200`          | Hold window (ms) for coalescing text after a `thinking_delta`. `0` disables holding.                                                                          |

Set them via the ACP client's `env` map, e.g. Zed `settings.json`:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp-adapter",
      "args": [],
      "env": {
        "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
        "PI_ACP_DATA_DIR": "~/.pi/pi-acp"
      }
    }
  }
}
```

### Pi settings (`~/.pi/agent/settings.json` or `<cwd>/.pi/settings.json`, merged, project wins)

- `quietStartup: boolean` — suppress startup prelude (still shows update notice).
- `enableSkillCommands: boolean` (also `skills.enableSkillCommands`) — expose skill commands as `/skill:*`.
- `enabledModels: string[]` — filter for advertised models.

## Slash commands

Pi has slash expansion disabled in RPC mode, so the adapter expands **file-based commands** locally before forwarding.

#### 1) File-based (prompt templates)

- User: `~/.pi/agent/prompts/**/*.md`
- Project: `<cwd>/.pi/prompts/**/*.md`
- Subdirectories become namespaced (`subdir:command`). Frontmatter `description` is used when present, otherwise first line.

#### 2) Built-ins (handled without a model turn)

| Command        | Args                                     | Effect                                                                                                                              |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/compact`     | `[instructions...]`                      | Run pi compaction, optional custom instructions.                                                                                    |
| `/autocompact` | `on\|off\|toggle`                        | Toggle automatic compaction.                                                                                                        |
| `/export`      | —                                        | Export session to HTML in session `cwd` (`pi-session-<id>.html`, `file://` resource link). No-ops with a hint when no messages yet. |
| `/session`     | —                                        | Show stats (messages, tokens in/out/cache, cost, session file/name, streaming/compacting).                                          |
| `/name`        | `<name>`                                 | Set session display name (`set_session_name`).                                                                                      |
| `/steering`    | `all\|one-at-a-time` (or no arg to show) | Get/set pi steering mode.                                                                                                           |
| `/follow-up`   | `all\|one-at-a-time` (or no arg)         | Get/set pi follow-up mode.                                                                                                          |
| `/changelog`   | —                                        | Print installed pi `CHANGELOG.md` (best-effort locate via `pi` on PATH / `PI_ACP_PI_COMMAND` / `npm root -g`).                      |
| `/bash`        | `<command>`                              | Run shell directly via pi `bash`.                                                                                                   |
| `/fork`        | `<entryId>` (or no arg to list)          | Fork from a previous entry; no arg lists forkable messages.                                                                         |
| `/clone`       | —                                        | Clone current branch.                                                                                                               |
| `/reload`      | —                                        | Re-advertise `available_commands` (extensions + skills).                                                                            |

Unsupported / delegated:

- `/model` — use the model selector UI.
- `/thinking` — use the mode selector (maps to `thought_level`).
- `/clear` — use the client's "new session".

`/queue` is not a slash command — queue/depth is managed via `steering`/`followUp` + ACP `session_info_update` (`_meta.piAcp.queueDepth`).

#### 3) Skill commands

When enabled, appear as `/skill:skill-name`.

> Slash commands from pi extensions are not yet supported.

## MCP servers

`mcpServers` from the ACP client on `session/new` and `session/load` are handed to the spawned pi via a bundled bridge extension (`-e`, servers JSON in `PI_ACP_MCP_SERVERS`). One pi process per session ⇒ per-session env is safe.

- Transports: `stdio` (with `command`/`args`/`env`), `http`, `sse`. Headers for http/sse are forwarded.
- Each server opens one MCP `Client`; tools are registered on pi as `${server}_${tool}` (sanitized to `[a-zA-Z0-9_-]`).
- Failure of one server only notifies in the transcript; others still connect.

`type: "acp"` (unstable channel transport) is not supported. Use a regular `stdio`/`http`/`sse` entry or a pi-wide adapter.

## Workspace roots

Clients can send `additionalDirectories: string[]` (ACP `additional-workspace-roots`). All entries must be absolute paths; `cwd` remains primary and an entry equal to `cwd` is dropped (order preserved, duplicates removed). The adapter forwards them to pi via RPC and injects `<workspace_roots>...</workspace_roots>` so the model knows those roots are in-scope; clients should still send absolute file paths for files outside `cwd`.

## Authentication (ACP Registry — Terminal Auth)

The adapter advertises Terminal Auth so registry clients (Zed) show an **Authenticate** banner that re-launches the binary with `--terminal-login`:

```bash
pi-acp-adapter --terminal-login  # aliases: pi-acp, pi-agent
```

`getAuthMethods()` emits both the registry-required `type:"terminal"` shape and Zed's `_meta["terminal-auth"]` compat field. If the client calls `authenticate` directly, it's a no-op (the out-of-band terminal launch does the work). Missing models / auth errors on `newSession` surface as `authRequired`.

## Development

```bash
npm install
npm run dev        # tsx src/index.ts
npm run build      # tsup (src/index.ts + mcp-bridge/extension.ts)
npm run lint
npm run test       # node --import tsx --test test/**/*.test.ts
npm run smoke      # smoke-acp.mjs
```

Project layout:

- `src/acp/*` — ACP `Agent` (`agent.ts`, `session.ts`, `session-store.ts`), pi settings/sessions, slash commands, auth, `workspace-roots.ts`, `rpiv-todo.ts`, `translate/*`
- `src/pi-rpc/*` — pi subprocess wrapper (`process.ts`, `command.ts`, NDJSON RPC, event dispatch)
- `src/mcp-bridge/*` — bridge extension (`extension.ts` inlined via tsup, `servers.ts`, `wire.ts`, `extension-path.ts`)
- `src/index.ts` — stdio `ndJsonStream` + `AgentSideConnection` + `--terminal-login` entrypoint

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`) — pi reads/writes and executes locally.
- Assistant streaming is `agent_message_chunk` + `agent_thought_chunk` (thought holding is best-effort) and `usage_update`; no separate plan stream except the `todo` → `plan` translation.
- Queue is implemented locally plus pi's `steering`/`followUp` modes; queued prompts and `_session/steering` are best-effort and behavior may change.
- Extension UI is bridged via `requestPermission` / `unstable_createElicitation` (`select`/`confirm` → permission options, `input`/`editor` → elicitation, `notify` → message); not all clients implement these.
- `type:"acp"` MCP transport is not supported.

## License

MIT (see [LICENSE](LICENSE)).
