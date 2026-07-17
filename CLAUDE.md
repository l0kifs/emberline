# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `README.md` first. It documents requirements, run instructions, configuration, and the
benchmark findings that justify most of the design. This file covers what the README does not:
commands, cross-cutting structure, and invariants that look like cruft but are load-bearing.

## Commands

Server (`cd server`, Python 3.12, uv):

```bash
uv sync                                          # installs the dev group too
uv run emberline-server                          # http://127.0.0.1:8011
uv run pytest
uv run pytest tests/test_engine.py::TestSupersede::test_forget_resets   # single test
uv run pytest -k "overlap"
uv run ruff check . && uv run ruff format .      # ruff is the only linter/formatter
```

There is no mypy and no type checking, despite the code being fully annotated.

Extension (`cd extension`, Node 22+):

```bash
npm install
npm run compile-tests   # REQUIRED before npm test — there is no pretest script
npm test                # vscode-test; runs out/test/**/*.test.js
npm run check-types     # tsc --noEmit
npm run lint            # all rules are 'warn'; lint cannot fail the build
npm run compile         # check-types + lint + esbuild -> dist/extension.js
```

`npm test` runs whatever is stale in `out/` if you skip `compile-tests`; `out/` is never cleaned
(it already contains an orphaned `probe.test.js.map`). The same applies to **`dist/`**, and it is
nastier: the test host loads the extension from `dist/extension.js` (`main`), which only
`node esbuild.js` / `compile` / `package` rebuilds — `compile-tests` does not. Change extension
source, run `npm test` alone, and you are testing the previous bundle against the new tests,
which reads as a bug in correct code. Before any run that exercises the extension itself:
`node esbuild.js && npm run compile-tests && npm test`. Filter single tests through the CLI, not
npm: `npx vscode-test --grep "newest call wins"`, `--fgrep`, `--run out/test/unit.test.js`,
`--grep "end-to-end" --invert`.

Normal development is F5 from the **repo root**, not from `extension/`. See the README.

## Architecture

Three processes: VS Code extension (TypeScript) → FastAPI server (Python) → llama-server
(llama.cpp subprocess). The split is a deliberate thesis, repeated verbatim in several
docstrings: **the extension is deliberately dumb.** It debounces, fires, and renders. Everything
else — prompt assembly, caching, ranking, file I/O, trimming — is server-side, because the
debounce is the only latency-sensitive thing that *cannot* live there (you cannot debounce a
request already sent).

When adding behavior, the default home is the server. "Why isn't this in the extension?" is
almost always answered by the above.

### Wire contract

The extension sends cursor context and open-file **paths only**; the server reads and chunks
those files itself. camelCase → snake_case remapping happens in `extension/src/client/http.ts`,
not on the server. `POST /v1/complete`, `POST /v1/accept`, `GET /health` (health is used only by
tests and the F5 task, never by the client).

### Server request path

Composition root is `lifespan()` in `server/src/emberline/main.py`, which builds one `AppContext`
dataclass onto `app.state.ctx`. **There is no FastAPI dependency injection** — every route does
`ctx = request.app.state.ctx`. Follow that convention.

`routes.py` → `context/assemble.py` (truncate + gather `input_extra` from examples then ring) →
cache lookup → supersede checks → `runtime/infill.py` (streams llama.cpp `/infill`) →
`postprocess.py::trim_completion`.

`InfillClient` streams even though Emberline's own API is non-streaming — that is what allows
abandoning a generation mid-flight when a newer keystroke supersedes it.

Retrieval (`context/ring.py`, `context/examples.py`) is wrapped in `try/except` + `log.exception`
and continues. Invariant: **retrieval is an enhancement; never fail a completion over it.**

### Concurrency model — the core of the design

Superseding is **per-session** (`session_id` = document URI); the model lock is **global**. The
asymmetry is deliberate and the two halves are coupled:

- Per-session supersede so two documents do not abort each other's requests.
- One global `asyncio.Lock` because llama-server runs with `-np 1`, so there is exactly one KV
  cache; concurrent generation thrashes it (~1.24s recompute vs ~67ms cache hit).

`-np 1` is passed in `main.py:77` and is mandatory — the `--fim-qwen-*` presets leave slot count
on auto, which round-robins requests across independent KV caches. **Do not remove `-np 1`, and
do not remove the lock. Dropping either alone breaks the other's rationale.**

`ctx.supersede.claim()` is called at `routes.py:47`, **before any `await`**. Claiming
synchronously is what makes an older in-flight request see itself go stale the moment a newer one
is parsed. Moving it below an await silently breaks superseding.

Uvicorn does not cancel plain `async def` handlers on client disconnect, so `/v1/complete` races
generation against a `request.is_disconnected()` poll itself. Without it, an abandoned keystroke
holds the global model lock for a full generation.

`superseded=True` is overloaded across stale-before-lock, stale-after-lock, and client
disconnect. A cache hit ignores staleness entirely and returns `cached=True` with content. So
`superseded` answers "should I render this?", not "does a newer request exist?".

### Extension runtime path

`extension.ts` (wiring only — `onStartupFinished` fires for every user, so nothing expensive at
module load or in `activate`) → `provider.ts` → `completion/debounce.ts` → `completion/context.ts`
→ `client/http.ts`.

The debouncer's latch is the request id, not the timer: every call sleeps the full delay, then
compares its monotonic id against `currentId`. Only the newest proceeds. There is no
`clearTimeout`.

Accept-tracking rides on `InlineCompletionItem.command`, which VS Code invokes only on actual
acceptance. Accepted completions feed `/v1/accept` → the example store → few-shot retrieval.

## Invariants worth preserving

Server:

- `response_model=None` on routes that still return pydantic models — this deliberately skips
  FastAPI's re-validation pass for latency. Do not "fix" it.
- `runtime/llama_server.py` sets **both** `HF_HOME` and `LLAMA_CACHE`, at different levels
  (`HF_HOME` is the parent, llama.cpp appends `/hub`). `LLAMA_CACHE` takes precedence in
  llama.cpp, so setting only `HF_HOME` is silently ignored. Both are required.
- `start()` short-circuits if a llama-server is already healthy, leaving `_proc = None`, so
  `stop()` never kills a server Emberline did not spawn. This is what makes the F5 task idempotent.
- Raising during `lifespan` startup is intentional: a server that cannot reach a model should
  refuse to serve rather than 500 per keystroke.
- llama-server stdout/stderr go to `DEVNULL` — there are no model logs to read through Emberline.

Extension:

- `external: ['vscode']` in `esbuild.js` — the host injects it; bundling it breaks the extension.
- Global `fetch`, no HTTP library. The extension host patches `globalThis.fetch` with proxy
  resolution and OS certificates; bundling axios/node-fetch loses that. The runtime bundle has
  zero third-party code.
- `completion/context.ts` and `client/http.ts` must stay free of `vscode` imports — that is what
  makes `unit.test.ts` meaningful.
- `AbortError` and `TimeoutError` are both normalized to `AbortedError`, which the provider
  swallows silently. This is what keeps the status bar from flashing red on every keystroke.
- A transport failure (`fetch` rejects with `TypeError`) becomes `ServerUnreachableError`, and
  the provider routes that to `onboarding.ts` instead of the generic error path — Emberline ships
  no server, so for a Marketplace install this is the expected first-run state, not a fault. The
  abort check must stay **above** the `TypeError` check: aborts also reject, and inverting the
  order would nag on every keystroke. `Onboarding` latches `shown` synchronously for the same
  reason. This does not use `/health` — the invariant that the client never calls it still holds.
- `sub.dispose()` in the provider's `finally` — `onCancellationRequested` returns a Disposable,
  and this runs per keystroke.
- **Stable VS Code API only.** `isInlineEdit`, `handleEndOfLifetime`, `yieldTo` and
  `debounceDelayMs` are proposed API: the Marketplace rejects them and they fail *silently* at
  runtime.
- `AbortSignal.any` / `AbortSignal.timeout` are why `engines.node >= 22` is not negotiable.
- The `server: start` task's echo string must contain `Application startup complete` — it is the
  background problem matcher's `endsPattern`, and the reuse path relies on it or F5 hangs.
- The esbuild problem-matcher regexes are duplicated in `esbuild.js` and **two** `tasks.json`
  files (root and `extension/`). Change one, change all three. `$esbuild-watch` is not built into
  VS Code; `$tsc-watch` is.

## Testing

Server tests are regression guards with the bug named in a comment (e.g. `test_sessions_are_independent`:
"a global counter means two editors abort each other"). Keep that style. `asyncio_mode = "auto"`
is set, so a future `async def test_` needs no decorator. Only pure/sync units are covered today;
the I/O half (FastAPI, `LlamaServer`, `Assembler`, `RingContext`, `ExampleStore`) is untested.

Extension tests use Mocha's **tdd** interface (`suite`/`test`) with Node's `assert` — the UI is
hard-coded by `@vscode/test-cli`, not configured here. `integration.test.ts` skips itself via
`this.skip()` in a `suiteSetup` (a `function`, not an arrow) when no server answers `/health`.

**Test code and `dist/extension.js` get different `vscode` API objects.** Stubbing
`vscode.window.showWarningMessage` from a test does *not* intercept what the running extension
calls — the stub silently never fires and the assertion fails with an empty record, which reads
like the feature is broken. Test such code by importing the class into the test's own module
graph (`first-run onboarding` constructs `Onboarding` directly); drive the real extension only
for assertions observable through the API, like "no ghost text appeared".
E2E drives the real UI — trigger, poll-commit, diff the buffer — because
`vscode.executeInlineCompletionProvider` does not exist. Model assertions are fuzzy on purpose.

## Known rough edges

Real, not stylistic — don't be surprised by them, and don't paper over them silently:

- `anyio` is imported in `main.py` but is not a declared dependency (present transitively). The
  thread-limiter tweak there is also inert: every blocking call uses `asyncio.to_thread`, which
  ignores anyio's limiter.
- `input_extra` has no size budget while prefix/suffix are carefully clamped; ring chunking does
  blocking disk I/O on the event loop.
- `ExampleStore.add()` re-stacks the whole table on every accept (O(n) per accept).
- `Supersede._generations` never shrinks; `forget()` is called only from tests.
- `provider.openPaths()` sends tab-layout order, though `schemas.py` documents `open_paths` as
  most-recent-first.
