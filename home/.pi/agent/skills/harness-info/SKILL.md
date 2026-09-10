---
name: harness-info
description: Locate and read your own (Pi) harness docs, examples, public API, source maps, CLI flags, installed extension and package sources, and the running session file. Use only when the task concerns the harness itself.
---

# Pi Harness Info

For tasks about Pi itself: how a tool or extension behaves, the extension API or SDK, sessions, CLI flags, or what this install contains. Skip it for ordinary repository work.

## Locate the installed package

Shell state does not carry between tool calls, so set `PI_PACKAGE` and use it in the same command:

```sh
PI_PACKAGE=$(d=$(dirname "$(readlink -f "$(command -v pi)")"); while [ ! -d "$d/@earendil-works/pi-coding-agent" ] && [ "$d" != / ]; do d=$(dirname "$d"); done; printf '%s' "$d/@earendil-works/pi-coding-agent"); ls "$PI_PACKAGE"
```

The walk-up is needed because `pi` is an installer shim or a symlink into `dist/`. `PI_PACKAGE_DIR` overrides resolution; embedded/SDK installs resolve the package from `node_modules`. Check `pi --version` against `$PI_PACKAGE/package.json` and read what is installed, not upstream `main`. Pi's own doc paths are not always in the system prompt (a replacement prompt drops them), so resolve them here.

## Docs, examples, sources

All under `$PI_PACKAGE`:

- `docs/` — task guides; entry point `docs/index.md`, navigation `docs/docs.json`
- `examples/` — runnable code: single-feature `extensions/*.ts`, numbered `sdk/` programs, `plugins/`
- `README.md`, `CHANGELOG.md` — overview and per-version behavior changes
- `dist/index.d.ts` — the entire public API surface; `dist/core/*` — implementation, internal and unstable

When asked about: extensions/tools/commands/events/renderers (`docs/extensions.md`, `examples/extensions/`), skills (`docs/skills.md`), embedding Pi (`docs/sdk.md`, `examples/sdk/`), sessions/resuming/forks/compaction (`docs/sessions.md`, `docs/session-format.md`, `docs/compaction.md`), settings and environment variables (`docs/settings.md`, `docs/environment-variables.md`), providers/models/custom providers (`docs/providers.md`, `docs/models.md`, `docs/custom-provider.md`), TUI/keybindings/themes (`docs/tui.md`, `docs/keybindings.md`, `docs/themes.md`), packages/prompt templates (`docs/packages.md`, `docs/prompt-templates.md`), modes and daily use (`docs/usage.md`, `docs/json.md`, `docs/rpc.md`).

Follow `.md` cross-references and read the examples they cite. No `src/` ships, but every `dist/**/*.js.map` embeds the original TypeScript in `sourcesContent`:

```sh
node -e 'const {readFileSync}=require("node:fs");const m=JSON.parse(readFileSync(process.argv[1],"utf8"));console.log(m.sources[0],"\n"+m.sourcesContent[0])' "$PI_PACKAGE/dist/core/system-prompt.js.map"
```

## Extensions and installed packages

- Custom extensions live in the agent directory: `~/.pi/agent/extensions/` (`PI_CODING_AGENT_DIR` overrides), where root `*.ts` and `*/index.ts` are entry points and `**/tests/` holds coverage.
- `pi list` prints every installed package's path — npm packages under `~/.pi/agent/npm/node_modules/`, git packages under `~/.pi/agent/git/<host>/<owner>/<repo>/`. Read those sources to see what a third-party extension actually does.
- Upstream source, tests, and history: `github.com/earendil-works/pi` (`packages/coding-agent`), per the `repository` field in the installed `package.json`.

## CLI

`pi --help` lists every flag. Sessions: `--continue`, `--resume`, `--session <path|id>`, `--fork`, `--session-dir`. Headless: `--print`, `--mode json|rpc`. Also `pi config` (toggle package resources), `pi list`, `pi update`, `pi --export <file>`.

## Reading your own session

`$PI_SESSION_FILE` is this session's JSONL (unset when ephemeral): append-only, last entry is the current leaf, entry types in `docs/session-format.md`. Tool results dominate its bytes and it keeps history that compaction dropped from context, so query slices instead of reading it whole.

```sh
jq -r .type "$PI_SESSION_FILE" | sort | uniq -c   # counts by entry type
tail -n 20 "$PI_SESSION_FILE" | jq -c '{type, id, role: .message.role, tool: .message.toolName}'   # newest entries

# user/assistant text in file order — tool traffic and thinking dropped
jq -r 'select(.type=="message" and (.message.role=="user" or .message.role=="assistant")) | .message as $m | (if ($m.content|type)=="string" then $m.content else [$m.content[]? | select(.type=="text") | .text] | join("\n") end) as $t | select(($t|length) > 0) | "\($m.role): \($t)"' "$PI_SESSION_FILE"

# newest compaction summary — the digest of history no longer in context
jq -r 'select(.type=="compaction") | .summary' "$PI_SESSION_FILE" | tail -n 1

# exact context the next turn sends: active branch, compaction applied (SDK: SessionManager.open(file).buildSessionContext())
PI_PACKAGE=$(d=$(dirname "$(readlink -f "$(command -v pi)")"); while [ ! -d "$d/@earendil-works/pi-coding-agent" ] && [ "$d" != / ]; do d=$(dirname "$d"); done; printf '%s' "$d/@earendil-works/pi-coding-agent"); node -e 'const {SessionManager}=require(process.argv[1]+"/dist/index.js");for(const m of SessionManager.open(process.argv[2]).buildSessionContext().messages){if(m.role!=="user"&&m.role!=="assistant")continue;const t=(typeof m.content==="string"?m.content:m.content.filter(p=>p.type==="text").map(p=>p.text).join("\n")).trim();if(t)console.log(m.role+": "+t)}' "$PI_PACKAGE" "$PI_SESSION_FILE"
```

Live session state: `$PI_SESSION_ID`, `$PI_PROVIDER`, `$PI_MODEL`, `$PI_REASONING_LEVEL`. A `/systemprompt` command, if this install has one, writes the exact system prompt the next turn will send.
