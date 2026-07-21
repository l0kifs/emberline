# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `README.md` first. It documents requirements, run instructions, configuration, and the
benchmark findings that justify most of the design. This file covers what the README does not:
commands, cross-cutting structure, and invariants that look like cruft but are load-bearing.

## Commands

Everything is one npm package (`cd extension`, Node 22+). The inference server
lives in `src/engine/` and builds to a second bundle, `dist/server.js`.

```bash
npm install
npm run compile-tests   # REQUIRED before npm test — there is no pretest script
npm test                # vscode-test; runs out/test/**/*.test.js
npm run check-types     # tsc --noEmit
npm run lint            # all rules are 'warn'; lint cannot fail the build
npm run compile         # check-types + lint + esbuild -> dist/{extension,server}.js
npm run test:engine     # server engine only: plain node --test, no Electron (~2s)
node dist/server.js     # run the server in the foreground
```

`npm test` (vscode-test) and `npm run test:engine` (node --test) are **different
runners over different files**. `.vscode-test.mjs` globs `out/test/*.test.js` --
top level only, deliberately -- because `out/test/engine/` uses `node:test`, which
Mocha's tdd interface cannot load. Widening that glob back to `**` breaks the run.

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

Three processes: VS Code extension → Emberline server → llama-server (llama.cpp subprocess).
Both of the first two are TypeScript in one npm package, but they are still **two processes**,
and that is load-bearing (see "Why the server is not in the extension host" below).

The split is a deliberate thesis, repeated verbatim in several docstrings: **the extension is
deliberately dumb.** It debounces, fires, and renders. Everything else — prompt assembly,
caching, ranking, file I/O, trimming — is server-side, because the debounce is the only
latency-sensitive thing that *cannot* live there (you cannot debounce a request already sent).

When adding behavior, the default home is the server. "Why isn't this in the extension?" is
almost always answered by the above.

Source layout:

- `src/engine/**` — the server. **Must never import `vscode`**; there is no extension host in
  that process. Enforced at build time by a source scan in `esbuild.js` (`HOST_FREE`), which is
  fatal — lint cannot do this job because every rule here is `warn`.
- `src/wire.ts` — the request/response types, imported by *both* sides. A contract change that
  lands on only one side is now a compile error rather than a runtime surprise.
- everything else — the extension.

### Why the server is not in the extension host

The obvious simplification, now that both halves are TypeScript, is to delete the HTTP hop and
run the engine in-process. **Do not.** Each VS Code window gets its own extension host, so the
global model lock would become per-window and two windows would thrash the single `-np 1` KV
cache — the exact ~1.24s-vs-67ms failure the design exists to prevent. `ServerManager.dispose()`'s
no-op and the idle-timeout ownership story also both depend on a process no window owns.

### Wire contract

The extension sends cursor context and open-file **paths only**; the server reads and chunks
those files itself. camelCase → snake_case remapping happens in `extension/src/client/http.ts`,
not on the server; the snake_case shapes themselves live in `src/wire.ts` and are shared. `POST /v1/complete`, `POST /v1/accept`, `GET /health` (health is used only by
tests and the F5 task, never by the client).

### Server request path

Composition root is `main()` in `src/engine/main.ts`, which builds one `EngineContext` object and
hands it to `createServer()`. **There is no DI container** — the graph is a dozen objects built
once at startup. Follow that convention.

`engine/http.ts` → `engine/assemble.ts` (truncate + gather `input_extra` from examples then ring)
→ cache lookup → supersede checks → `engine/infill.ts` (streams llama.cpp `/infill`) →
`engine/postprocess.ts::trimCompletion`.

`InfillClient` streams even though Emberline's own API is non-streaming — that is what allows
abandoning a generation mid-flight when a newer keystroke supersedes it. It uses `node:http` on
a keep-alive agent rather than the global `fetch`: the "global fetch, no HTTP library" rule is an
*extension* invariant (it exists so the host's proxy and certificate handling apply), and neither
concerns a 127.0.0.1 hop between two processes we spawned.

`LineDecoder` in `engine/infill.ts` is not incidental. A transport chunk is not a message, and
splitting each chunk on `\n` independently tears JSON frames in half — intermittently, under
load, looking exactly like the model misbehaving. It is tested by slicing a real frame sequence
at every byte offset.

Retrieval (`engine/ring.ts`, `engine/examples.ts`) is wrapped in try/catch and continues.
Invariant: **retrieval is an enhancement; never fail a completion over it.**

### Concurrency model — the core of the design

Superseding is **per-session** (`session_id` = document URI); the model lock is **global**. The
asymmetry is deliberate and the two halves are coupled:

- Per-session supersede so two documents do not abort each other's requests.
- One global `asyncio.Lock` because llama-server runs with `-np 1`, so there is exactly one KV
  cache; concurrent generation thrashes it (~1.24s recompute vs ~67ms cache hit).

`-np 1` is passed in `engine/main.ts` and is mandatory — the `--fim-qwen-*` presets leave slot count
on auto, which round-robins requests across independent KV caches. **Do not remove `-np 1`, and
do not remove the lock. Dropping either alone breaks the other's rationale.**

`ctx.supersede.claim()` is called in `engine/http.ts::handleComplete`, **before any `await`**.
Claiming synchronously is what makes an older in-flight request see itself go stale the moment a
newer one is parsed. In `node:http` the body arrives as a stream, so the shape is: await the body
→ parse → *then* a synchronous block that claims. Moving the claim below another await silently
breaks superseding.

Client disconnect is `res.on('close')` before `res.writableEnded`, and it does **two** things:
sets a flag that stops the generation at its next frame, and aborts the `/infill` stream outright.
Both are needed. The handler holds the global model lock, so returning early while llama-server is
still generating would release the lock against a busy slot. (The Python server polled
`request.is_disconnected()` on a timer and raced it against the generation, because uvicorn does
not cancel plain `async def` handlers; that whole mechanism is gone.)

`superseded=True` is overloaded across stale-before-lock, stale-after-lock, and client
disconnect. A cache hit ignores staleness entirely and returns `cached=True` with content. So
`superseded` answers "should I render this?", not "does a newer request exist?".

The model lock is a hand-rolled FIFO mutex (`engine/supersede.ts`). Fairness is the point: a
mutex that reopens on release lets whoever races there first barge in, so a fast-typing document
can starve a slow one. A barging implementation passes the obvious serialization test unchanged.

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

- Request validation is hand-rolled in `src/wire.ts` rather than zod. The server bundle staying
  free of third-party runtime code is worth more than the ergonomics, and there are two bodies.
- `contextKey` hashes UTF-16LE, not UTF-8. The extension slices the document by offset, so a
  cursor can land inside a surrogate pair and hand the server a lone surrogate; UTF-8 maps every
  one of those to the same U+FFFD, which would let two different prefixes collide and serve each
  other's completions.
- `engine/ring.ts` decodes with `new TextDecoder('utf-8', { fatal: true })`, not
  `readFileSync(p, 'utf8')`. The latter never throws on a binary file — it substitutes U+FFFD, and
  the binary gets chunked into garbage and fed to the model as cross-file context. The `fatal`
  flag is what skips binaries.
- `engine/main.ts`'s shutdown calls `server.closeAllConnections()` after `server.close()`. Not
  defensive: the extension holds a keep-alive socket by design and `close()` waits for idle
  connections, so without it the process hangs instead of exiting, still holding ~1.6GB.
- `engine/llama.ts` records a spawn error and lets the health poll observe it, rather than racing
  the two. Racing leaves the losing poll running for the full startup timeout (300s by default),
  holding the event loop open long after `start()` rejected.
- `engine/llama.ts` sets **both** `HF_HOME` and `LLAMA_CACHE`, at different levels
  (`HF_HOME` is the parent, llama.cpp appends `/hub`). `LLAMA_CACHE` takes precedence in
  llama.cpp, so setting only `HF_HOME` is silently ignored. Both are required.
- `start()` short-circuits if a llama-server is already healthy, leaving `_proc = None`, so
  `stop()` never kills a server Emberline did not spawn. This is what makes the F5 task idempotent.
- Throwing during startup in `engine/main.ts` is intentional: a server that cannot reach a model
  should exit non-zero rather than 500 per keystroke. `ServerManager.awaitHealthy()` reads that
  exit code and reports it.
- llama-server stdout/stderr go to `'ignore'` — there are no model logs to read through Emberline.
  The Emberline server's *own* log is different: it writes `~/.emberline/server.log`, surfaced by
  the `Emberline: Show Server Log` command. That file is the only diagnostic for a startup crash,
  because the extension spawns the server detached with stdio ignored.
- `engine/idle.ts` self-SIGTERMs after `EMBERLINE__IDLE_TIMEOUT_S` (default 1800) with no
  completion traffic. This is what lets an editor start the server and *never kill it* (the
  process is shared across editor windows and kept warm for its KV cache, so no window may own its
  lifetime). `/health` deliberately does **not** `touch()` — only `/v1/complete` and `/v1/accept`
  do; counting liveness probes as activity would defeat the abandoned-editor case the timeout
  exists for. SIGTERM (not `process.exit`) so the normal shutdown handler still stops
  llama-server and flushes the example store.

### Server lifecycle & bundling (the zero-setup path)

- **The extension never kills the server** — `ServerManager.dispose()` is a deliberate no-op. The
  server is shared across windows and warm on purpose; killing it on one window's teardown would
  yank it from another and throw away the KV cache. Its lifetime is bounded only from inside, by
  the idle timeout above. This also resolves the multi-window coupling hazard: a window that
  reused another's server is unaffected when the spawner quits.
- `ServerManager` spawns the server **detached with `.unref()`** for the same reason — it must
  outlive the window that started it. Consent is asked **once ever** (globalState): the server no
  longer installs a toolchain, but downloading ~1.6GB and starting a long-lived background process
  is still squarely what the Marketplace publisher agreement §8(d) means by "beyond what may
  reasonably be expected".
- **The server is bundled, in every VSIX**, as `dist/server.js` — a second esbuild entry point
  beside `dist/extension.js`. It is spawned on VS Code's own Node via
  `spawn(process.execPath, [entry], { env: { ELECTRON_RUN_AS_NODE: '1' }, detached: true })`.
  That variable makes the Electron binary behave as plain Node; in a Remote/WSL/SSH host
  `process.execPath` is already a real node binary and the variable is inert. Nothing is installed
  at runtime — no Python, no uv, no PyPI, no downloaded runtime of any kind. First use downloads
  only the model.
- **`llama-server` *is* bundled, but only in the `darwin-arm64` VSIX.** `scripts/fetch-llama.mjs`
  stages a *flattened* `otool -L` closure into `bin/llama/`: a VSIX is a zip and cannot store
  symlinks (vsce materializes each alias as a full copy), so the script writes exactly the names
  the loader requests as real files — naive tree-copy tripled the size (23→50 MB). The binary is
  relocatable via a single `@loader_path` rpath and ad-hoc linker-signed; curl/fetch downloads
  carry no `com.apple.quarantine`, so it runs with no notarization. `bin/**` is git-ignored (a
  build artifact, pinned to `LLAMA_BUILD`, reproducible from `PROVENANCE.json`) but **not**
  `.vscodeignore`-ignored — excluding it ships a targeted VSIX with no engine, which fails only on
  a user's machine. The untargeted fallback VSIX has no `bin/` and expects llama.cpp on PATH; the
  server's `EMBERLINE__LLAMA_BINARY` (bundled) vs PATH fallback covers both.
- `scripts/verify-vsix.mjs` runs in CI after `vsce package` and asserts `dist/server.js` (and, for
  the targeted build, `bin/llama/llama-server`) is actually inside the zip. Both omissions fail
  only on a user's machine, which is why the check is a gate rather than a convention.
- **Two VSIXes per release** (rust-analyzer's model): `darwin-arm64` bundled + an untargeted
  fallback, both from `publish-extension.yml` (tag `ext-v*`). One publish channel, one version
  number — the extension and the server can no longer disagree about the wire contract, which is
  what the old `SERVER_VERSION` pin existed to fake.

Extension:

- `external: ['vscode']` in `esbuild.js` — the host injects it; bundling it breaks the extension.
- Global `fetch`, no HTTP library. The extension host patches `globalThis.fetch` with proxy
  resolution and OS certificates; bundling axios/node-fetch loses that. The runtime bundle has
  zero third-party code.
- `completion/context.ts` and `client/http.ts` must stay free of `vscode` imports — that is what
  makes `unit.test.ts` meaningful.
- `AbortError` and `TimeoutError` are both normalized to `AbortedError`, which the provider
  swallows silently. This is what keeps the status bar from flashing red on every keystroke.
- A transport failure (`fetch` rejects with `TypeError`) becomes `ServerUnreachableError`, which
  the provider treats as the expected first-run state, not a fault. Where it routes depends on
  `emberline.manageServer`: default (true) → `server/manage.ts` `ServerManager.ensure()`, which
  installs and spawns the server; false → `onboarding.ts`, the manual-setup pointer. The abort
  check must stay **above** the `TypeError` check: aborts also reject, and inverting the order
  would nag/provision on every keystroke. `Onboarding` latches `shown` synchronously for the same
  reason. `ServerManager.ensure()` is single-flight for the same reason — keystrokes outrun a
  server start. The client itself still never calls `/health`; only `ServerManager` does.
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

**Mandatory: before reporting any new or changed code as done, run it through
[`docs/ai-code-check-checklist.md`](docs/ai-code-check-checklist.md).** This is not optional and
not a general "review the code" pass — follow its procedure (§1): inventory the change, then run
the Input Matrix, Boundary Analysis, Unhappy Paths, decision tables, and state-transition checks
as *separate focused passes*, and gate the result against its Definition of Done (§10). Adding or
updating the automated tests below does not substitute for this checklist, and the checklist does
not substitute for them — both are required.

There are **two test tiers, two runners**:

- `src/test/engine/**` — the server. `node:test` (`describe`/`it`) + `node:assert/strict`, run by
  `npm run test:engine` outside Electron. This is possible only because nothing under
  `src/engine/` imports `vscode`; keep it that way. Covers the routes end to end against a fake
  llama-server (`http.test.ts`), including supersede, disconnect, and the accept→retrieve loop.
- `src/test/*.test.ts` — the extension. vscode-test, in a real extension host.

Tests are regression guards with the bug named in a comment (e.g. `keeps sessions independent`:
"a global counter means two editors abort each other"). Keep that style.

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

To run E2E without a real model, stand up `dist/server.js` on 8011 with
`EMBERLINE__LLAMA_MANAGED=false` pointed at a stub that answers `/health` and streams SSE frames
on `/infill`. The suite stops skipping and exercises the whole extension→server path.

## Known rough edges

Real, not stylistic — don't be surprised by them, and don't paper over them silently:

- `input_extra` has no size budget while prefix/suffix are carefully clamped; ring chunking does
  synchronous disk I/O on the event loop (`statSync`/`readFileSync` in `engine/ring.ts`).
- `Supersede.generations` never shrinks; `forget()` is called only from tests.
- `provider.openPaths()` sends tab-layout order, though `wire.ts` documents `open_paths` as
  most-recent-first.
- Accepted-example retrieval is **lexical, not semantic**. The embedding path (bge-small via
  fastembed, numpy matmul, SQLite) did not survive the move off Python: every JS embedding runtime
  worth using ships per-platform native binaries, which is the packaging problem the move existed
  to remove. `ExampleSource` is the seam an ONNX/WASM implementation would drop into.
  `examplesMinSimilarity` is on the Jaccard scale now (0.15), *not* the old cosine 0.65 — the two
  are unrelated. Measured on this repo's own source, 0.65 would still fire, but on 21% of queries
  instead of ~100%: a quiet degradation rather than a clean break, which is worse. The 0.15 choice
  is documented with its numbers in `engine/config.ts`.
- `engine/llama.ts`'s Windows termination path (`taskkill`) is untested, as it was in the Python
  server: the bundled llama-server ships only for darwin-arm64 and the PATH fallback has never
  been exercised on Windows.
