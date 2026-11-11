# CLAUDE.md — cc-hud project instructions

## Project overview

cc-hud — a minimal single-line status bar plugin for Claude Code. It shows the model name, thinking depth (effort), context usage, active subagents, rate limits (5h / 7d / spend cap), weekly usage of the top-tier model, and the workspace (directory · branch). It also provides a one-time preset for the Codex CLI native footer (see "Codex CLI native footer preset" below).

The English reference for AI agents is in `AGENTS.md` (runtime contract, files / processes / network endpoints read and written, environment variables, verification and debugging steps, invariants to keep when changing code). When you change behavior or interfaces, update README / AGENTS.md / this file together.

## Tech stack

| Layer | Technology |
|------|------|
| Language | TypeScript (strict) |
| Runtime | Node.js ≥ 18 |
| Build | tsc (ESM, ES2022) |
| Dependencies | Zero external dependencies, Node.js built-in modules only |
| Tests | node:test (built-in; `npm test` explicitly enumerates ts/cjs via scripts/test.cjs) |
| Colors | Catppuccin Mocha (ANSI 256 colors) |

## Project structure

```
.claude-plugin/plugin.json  — Claude Code plugin manifest
commands/setup.md           — install/configure command (v0.5.0+ writes the launcher to <cfg>/bin/; cfg = $CLAUDE_CONFIG_DIR or ~/.claude)
src/
  index.ts                  — entry point: stdin → parse → render → stdout (writes stdout exactly once; both the exception path and the 2s timeout path output a line containing only stdin data)
  stdin.ts                  — parses stdin JSON (anything that is not a plain object is treated as {})
  transcript.ts             — thinking depth (effort) comes from the last 64KB of the transcript; active agents come from <session>/subagents/agent-*.meta.json (written when Claude Code launches an agent asynchronously, marked finished when it ends; no heartbeat for 15 minutes counts as dead); legacy synchronous agents still go through the transcript
  render.ts                 — single-line compact rendering (1/8-precision progress bar + ANSI colors; free text has control characters stripped first)
  model.ts                  — model name prettifying (claude-opus-4-7[1m] → Opus 4.7 (1M))
  git.ts                    — workspace segment: directory name + branch + dirty marker (800ms budget, --no-optional-locks; status failure = unknown, not treated as clean)
  claude.ts                 — weekly usage of the top-tier model (OAuth usage API): the tick only reads the cache, all network access lives in refresh.ts
  refresh.ts                — entry point of the detached refresh child process (node refresh.js <kind>, 8s budget, writes the cache after fetching)
  cache.ts                  — cache conventions: ~/.cache/cc-hud/<name>.json, atomic writes; two disciplines: detached (serveCache: tick only reads + spawns a refresh child process, with TTL / cooldown / stale decisions) and inline (cachedInline: the collector fetches within the tick, falls back to the old value on failure and records failTs, no retry within 30s; if no fresh value for 30 minutes it is marked stale → rendering adds ~)
  http.ts                   — JSON GET: fetchJson (used by the refresh child process) goes through curl only when a proxy is configured (Node fetch ignores proxies, so trying it first would connect directly with the token), with no fallback if curl fails; without a proxy, native fetch is preferred, falling back to curl on transport failure or WAF 403. fetchJsonNative (used by collectors) is native fetch only, INLINE_TIMEOUT_MS = 1.2s, never spawns curl
  env.ts                    — boolean environment variable switches ("" / "0" / "false" count as off)
  balance.ts / glm.ts / mmx.ts  — DeepSeek / GLM / MiniMax balance or quota collectors: only the backend detection and response parsing remain; caching and fetching go through cache.cachedInline + http.fetchJsonNative (fetched within the tick on a cache miss, 1.2s budget, falls back to the old value on failure)
  types.ts                  — type definitions
  cli.ts                    — npm bin entry: with no arguments it runs index.ts (prints help on a TTY); `<action> codex` dispatches to the Codex commands; --help / --version
  codex-rpc.ts              — temporary `codex app-server --stdio`: version gate, JSON-RPC, readUserLayer / writeUserLayer, 10s timeout, killed on exit
  codex.ts                  — Codex footer setup / check / restore (only touches tui.status_line, single-field backup cc-hud-native.json)
  codex-theme.ts            — optional theme: tui.theme + status_line_use_colors; the theme file is tracked and refreshed by sha256, with its own backup / restore
scripts/launcher.cjs        — stable-path launcher (setup copies it to <cfg>/bin/cc-hud-launcher.cjs; prints a one-line hint instead of a blank line when the plugin cannot be found)
scripts/test.cjs            — npm test runner: explicitly enumerates tests/*.test.{ts,cjs} and enables type stripping
plugin.json                 — Codex plugin manifest (repo root; version number is bumped together with the other three places)
skills/codex-setup/SKILL.md — Codex onboarding skill (runs dist/cli.js … codex)
assets/cc-hud.tmTheme       — optional Codex theme file
dist/                       — build output (committed to the repo; CI verifies it is in sync with src)
tests/*.test.ts(.cjs)       — node:test unit + end-to-end tests (render / model / transcript / git / http / cache / env / claude / balance / glm / mmx / launcher / index / codex; codex-live requires CC_HUD_CODEX_LIVE_TEST=1; fixtures/fake-codex.cjs simulates the app-server)
.claude-plugin/marketplace.json — marketplace entry (read by `/plugin marketplace add WaterTian/cc-hud`; bumped together with plugin.json on release)
.github/workflows/ci.yml    — CI: ubuntu / windows / macos × node 22 / 24 test matrix + dist sync check + node 18 / 20 runtime smoke test
AGENTS.md                   — English reference for AI agents (runtime contract / files and network / environment variables / verification and debugging / invariants), maintained in sync with this file
scripts/ds-balance-cache.sh — example script that writes the DeepSeek balance to a one-line file for CC_HUD_EXTRA_FILE
scripts/mmx-debug.mjs       — MiniMax quota endpoint debugging script (not part of src)
preview.html / cc-hud-preview.{svg,png} — source file and outputs of the preview image at the top of the README (if the image changes, update the ?v= cache parameter in the README)
```

## Data flow

```
Claude Code → stdin JSON → cc-hud → stdout → status bar
           ↘ transcript JSONL (last 64KB → thinking depth effort) + <session>/subagents/*.meta.json (active agents)
           ↘ git symbolic-ref / status (directory · branch*, 800ms budget)
           ↘ ~/.cache/cc-hud/claude-plan.json (read only; when expired, spawns a detached refresh.js to fetch in the background and write back)

Codex (explicit commands only, unrelated to the tick): cc-hud <action> codex → temporary codex app-server --stdio → config/read → config/batchWrite → $CODEX_HOME/config.toml (only touches tui.status_line / tui.theme / tui.status_line_use_colors)
```

## Performance and stability

- **Stateless** — every invocation is an independent process, so there is no risk of memory leaks
- **Tail reads** — only reads the last 64KB of the transcript, never parses it in full
- **String pre-filtering** — only runs JSON.parse on lines containing `"Agent"` / `"tool_result"` / `"effort"` (almost all assistant lines carry effort, so what it skips are mainly user / progress lines)
- **2s hard timeout** — setTimeout + unref(); on timeout it first outputs a line containing only stdin data and then exits, without blocking Claude Code or leaving a blank; the inline fetch budget of third-party collectors is 1.2s, a timeout drops only that segment rather than the whole line, and after a failure there is a 30s cooldown instead of retrying every tick
- **Write stdout only once** — an extra line would pollute the status bar; emit uses a synchronous writeSync (pipes are asynchronous on macOS / Windows, and the timeout path exits immediately after), the exception path outputs whatever can be computed from stdin, worst case `[Claude]`
- **All IO wrapped in try-catch** — failures degrade silently, no crashes
- **Zero network inside the tick (official backend)** — claude.ts only reads the cache, all network requests are done by the detached refresh child process; the WAF on the OAuth usage endpoint returns 403 for the Node TLS fingerprint, so a curl fallback is needed (measured 2026-07)

## Codex CLI native footer preset

- Purpose: configure Codex's **own** footer once so that it approximates the Claude HUD information set (model/depth → context used → 5h/weekly quota remaining → project → branch), after which Codex natively handles the data, refreshing, and colors. There is no resident process, hook, MCP, transcript scanning, or extra quota requests; it does not wrap normal startup with `-c` (that would bypass Codex's shared daemon).
- Entry point: the npm bin points to `dist/cli.js`. No arguments + piped stdin = the original Claude renderer; no arguments + TTY prints help. `cc-hud setup|check|restore|theme|restore-theme codex`, `--help`, `--version`. The Claude launcher runs `dist/index.js` directly without going through cli, so it is entirely unaffected.
- Configuration channel (`codex-rpc.ts`): temporarily starts `codex app-server --stdio`, `config/read` → `config/batchWrite` (`expectedVersion` guards against concurrent writes) → read back to verify; 10s total timeout, SIGKILL 500ms after SIGTERM; server notifications and server-initiated requests are ignored; error bodies are not echoed (they may contain private configuration). Requires Codex ≥ 0.166.0, with separate errors for not found / version too low; `CC_HUD_CODEX` specifies the executable or the npm `bin/codex.js`.
- Footer (`codex.ts`): only changes `tui.status_line`; single-field backup `$CODEX_HOME/cc-hud-native.json` (`{schema, previous, applied}`, 0600). Idempotent; if the user changed it afterwards → setup / restore only report and never overwrite; "ours" = the current preset or the previously applied preset, so restore can still revert after a release changes the preset (setup refreshes `applied` to the new preset). setup / check on an already configured setup will note that the quota color is determined by the theme and unrelated to the remaining percentage, and will mention the optional theme.
- Theme (`codex-theme.ts`, optional): installs `assets/cc-hud.tmTheme` to `$CODEX_HOME/themes/cc-hud.tmTheme`, sets `tui.theme` + `tui.status_line_use_colors`, with backup `cc-hud-theme.json` (including the sha256 `asset` of the installed file: a new version only overwrites files it installed itself, and refuses user-modified ones with a prompt to delete the path). Even when the config already matches, it records the original values and file hash so that later theme upgrades work; after an upgrade, run `theme codex` again to refresh the installed file. The old name `cc-hud-mocha` is treated as our own. The quota field is a fixed neutral teal and does not indicate remaining health; the theme also changes code highlighting, so it is independent of setup.
- Failure handling: an error does not mean an automatic rollback; the backup, the installed theme file, or the saved user-layer fields may remain (for example when overridden by another config layer). Retry or run the corresponding restore according to the error.
- Distribution: the root `plugin.json` (Codex plugin manifest) + `skills/codex-setup/SKILL.md` (onboarding skill; Claude Code also loads it as a skill, and its description notes that Claude should use /cc-hud:setup); reuses the existing marketplace repo. `codex plugin marketplace add WaterTian/cc-hud` → `codex plugin add cc-hud@cc-hud`; `marketplace upgrade` syncs the installed plugin, taking effect in new sessions.
- Visual boundaries: Codex quota shows **remaining**, Claude shows **used**; Codex maps 5h / weekly to the syntax theme's `constant.language` (falling back to `storage.type`), with a fixed color per field that does not change by percentage, so the original theme may show `93% left` in red. The cc-hud theme separates the green of `constant.numeric` from the quota scope and makes the quota a neutral teal; `1% left` and `93% left` still share the same color. Separators / colors are controlled by Codex, there is no progress bar; 0% may briefly show during `/compact`.
- Tests: `tests/codex.test.ts` uses `tests/fixtures/fake-codex.cjs` to simulate the app-server (hang / concurrency / write failure / version switch); `CC_HUD_CODEX_LIVE_TEST=1 npm test` additionally tests against real Codex (isolated CODEX_HOME, offline provider) and requires a local Codex ≥ 0.166.0. `npm test` explicitly enumerates ts/cjs tests via `scripts/test.cjs` and enables type stripping.

## Release process

No script; four manual steps (dist is committed, and `npm test` includes the build):

1. Bump the version in four places: `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` / root `plugin.json`
2. `npm test` fully passes, and `git diff -- dist/` has changed together with the source
3. Single commit (title includes `(vX.Y.Z)`) → `git tag vX.Y.Z` → `git push origin main && git push origin vX.Y.Z` → `gh release create vX.Y.Z --notes-file <notes>`
4. `npm publish` (npm package name **`cc-hud`**, sole maintainer watertian). `@watertian/cc-hud` is stuck at 0.9.4 and deprecated; never publish to that name again

Plugin users go through the Claude Code marketplace (`/plugin marketplace add WaterTian/cc-hud`), which is independent of npm publishing; the README's npm badge / Via npm section points to `cc-hud`.

## Environment

- Windows 11, use Node.js as the runtime, do not use Bun (memory crash issue)
- Claude Code must be installed via npm (`npm i -g @anthropic-ai/claude-code`), do not use the native installer
  - The native installer's `claude.exe` embeds the Bun runtime, which triggers the `pas panic: deallocation did fail` crash
  - The npm version uses the system Node.js and is stable without this problem
