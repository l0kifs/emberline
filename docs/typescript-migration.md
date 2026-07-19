# Migrating the server to TypeScript

Goal: one language, one distribution channel (VS Code Marketplace), no PyPI, no uv, no Python
toolchain on the user's machine.

Non-goal: changing the architecture. The three-process split, the concurrency model, and the
"deliberately dumb extension" thesis all survive verbatim. Only the sidecar's implementation
language changes.

---

## 1. Decisions to lock before writing code

### 1.1 The sidecar stays a separate process

The tempting version of "all TypeScript" is to run the engine inside the extension host and delete
the HTTP hop. **Do not.** Each VS Code window gets its own extension host, so:

- the global model lock becomes per-window, and two windows thrash the single `-np 1` KV cache —
  the exact ~1.24s-vs-67ms failure the design exists to prevent;
- `ServerManager.dispose()`'s no-op and the idle-timeout ownership story both depend on a process
  no window owns.

Same three processes: extension → sidecar → llama-server.

### 1.2 Runtime: VS Code's own Node

```ts
spawn(process.execPath, [serverJs], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  detached: true,
  stdio: 'ignore',
}).unref();
```

Zero runtime download. Works in both host flavors: in the desktop host `process.execPath` is
Electron and the env var makes it behave as Node; in a Remote/WSL/SSH host (`extensionKind:
["workspace"]` puts us there) it is already a real `node` binary and the variable is inert.

### 1.3 The wire contract is frozen

`POST /v1/complete`, `POST /v1/accept`, `GET /health` keep byte-identical snake_case JSON. This is
the linchpin of the whole migration: at every phase you can run either server behind the same
extension, which turns "did the port break something?" into a bisect instead of a debate. See
§6 for the A/B harness.

### 1.4 Embeddings are dropped in phase 1

`fastembed` is the only dependency with no clean JS equivalent. Options were weighed in the
analysis; the decision is:

- **Now:** lexical retrieval — the same identifier-token Jaccard `ring.ts` already uses, extracted
  into a shared module. Zero dependencies. Consistent with the argument already in `ring.py`'s
  docstring that token overlap is enough for code.
- **Door left open:** onnxruntime-web (WASM) + a pure-JS tokenizer, model fetched into `data_dir`
  on first use. Keep `ExampleStore`'s interface identical so this drops in behind it.
- **Rejected:** onnxruntime-node — prebuilt native `.node` per platform reintroduces exactly the
  multi-platform packaging pain this migration exists to escape.

This also removes `sqlite3` and `numpy`, and fixes the known `ExampleStore.add()` O(n) re-stack:
append-only JSONL replaces the table.

### 1.5 Layout: fold the sidecar into the extension package

```
extension/src/
  wire.ts             <- shared request/response types + validators (imported by BOTH sides)
  engine/             <- the sidecar; NOTHING here may import 'vscode'
    main.ts             composition root + listen
    config.ts  http.ts  cache.ts  supersede.ts  assemble.ts
    ring.ts    examples.ts  infill.ts  llama.ts  idle.ts  postprocess.ts  tokens.ts
  server/manage.ts    <- unchanged role: spawns the sidecar
```

One `package.json`, one `tsconfig`, one linter, one test runner. The real prize is `wire.ts`: the
contract becomes compile-time checked on both ends instead of documented in two places.

`dist/extension.js` must **not** bundle `engine/` — two esbuild entry points, two outputs (§5).
Extend the existing no-`vscode`-imports rule (today: `completion/context.ts`, `client/http.ts`) to
cover all of `engine/`; that rule is what keeps the engine testable outside Electron.

---

## 2. Port order

Pure leaves first, then I/O, then the composition root, then the launcher, then delete Python.
Each phase ends at a state you can run.

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Scaffolding: `wire.ts`, second esbuild entry, `test:engine` script | `dist/server.js` builds and exits cleanly |
| 1 | `postprocess`, `cache`, `supersede`, `tokens`, `ring`, `assemble` | ported Python tests pass under `node --test` |
| 2 | `infill`, `llama`, `idle` | sidecar can spawn llama-server and stream one completion from a script |
| 3 | `config`, `http`, `main` | **unmodified current extension** completes against the TS sidecar |
| 4 | `examples` (lexical) | `/v1/accept` persists, retrieval feeds `input_extra` |
| 5 | `manage.ts` launcher swap; delete `uv.ts` | fresh-profile install completes with no network beyond the model |
| 6 | Packaging, CI, docs; delete `server/` | both VSIXes verified; `publish-server.yml` gone |

Rough effort: ~5 focused days plus half a day of docs.

---

## 3. Module-by-module notes

Only the parts where a naive port is wrong. Everything not mentioned is a direct transcription —
keep the docstrings, they carry the rationale.

### postprocess.ts

Pure string ops. `text.rstrip("\n")` → `text.replace(/\n+$/, '')`. Python indexes by code point and
JS by UTF-16 code unit, so `_strip_suffix_overlap` can differ if an astral character sits exactly on
the overlap boundary — negligible, but do not "fix" it by reaching for `Array.from`, which would
make the scan O(n) allocations per keystroke.

### cache.ts

`OrderedDict` LRU → `Map` (insertion-ordered; `delete`+`set` to bump, `map.keys().next().value` to
evict). Direct.

**`context_key` needs care.** Python uses `encode("utf-8", "surrogatepass")`. `Buffer.from(s,
'utf8')` instead replaces lone surrogates with U+FFFD — and the extension *can* produce lone
surrogates, because it slices the document by offsets and a cursor can land inside a surrogate
pair. Two distinct prefixes would then collide and serve each other's completions. Hash
`Buffer.from(s, 'utf16le')`: deterministic and injective over JS strings.

### supersede.ts

`asyncio.Lock` → a FIFO promise mutex (~12 LOC; a plain queue of resolvers). Do not use a
"first waiter wins the race" implementation — fairness is what stops one document from starving
another.

**`claim()` must stay synchronous and run before any `await`.** In `node:http` the body arrives as
a stream, so the shape is: await the full body → parse → **then** enter a synchronous block that
claims and proceeds. Same guarantee FastAPI gives, but you have to arrange it yourself.

### ring.ts

Two real semantic traps:

1. `p.read_text(errors="strict")` raises on invalid UTF-8, which is how binary files get skipped.
   `readFileSync(p, 'utf8')` **does not throw** — it silently substitutes U+FFFD, and binaries get
   chunked into garbage that poisons `input_extra`. Read a `Buffer` and decode with
   `new TextDecoder('utf-8', { fatal: true })`, catching the error.
2. `st_mtime_ns` → `fs.statSync(p, { bigint: true }).mtimeNs`. `mtimeMs` is a float with worse
   resolution than the cache invalidation assumes.

`splitlines()` also splits on `\v`, `\f`, `` and friends; `split(/\r\n|\r|\n/)` is close
enough for chunking — note the difference, do not chase it.

### infill.ts

**Use `node:http` with an `http.Agent({ keepAlive: true })`, not `fetch`.**

The "global `fetch`, no HTTP library" invariant is about the *extension* — it exists so the host's
proxy resolution and OS certificate store apply. Neither concerns a 127.0.0.1 hop inside the
sidecar, and `node:http` buys explicit control over `keepAlive` (undici's 4s default would drop the
warm connection between keystrokes, against `httpx`'s `keepalive_expiry=120`). Write this reason
into the module docstring so nobody "fixes" it later.

**The highest-risk line in the whole port is SSE framing.** `httpx.aiter_lines()` reassembles
partial lines across chunk boundaries; a naive `chunk.toString().split('\n')` will split a JSON
frame in half and drop tokens intermittently under exactly the conditions that are hardest to
reproduce. Keep a residual buffer, and add a test that feeds a known frame sequence sliced at every
possible offset (§4).

Keep the `shouldStop()` callback checked per frame rather than switching to `AbortController` —
same behavior, smaller diff. The AbortController version is a later optimization.

No read timeout, same as today: length is bounded by `n_predict` / `t_max_predict_ms`, not the clock.

### llama.ts

`Popen(start_new_session=True)` → `spawn(..., { detached: true, stdio: 'ignore' })`.
`os.killpg(os.getpgid(pid), SIGTERM)` → `process.kill(-child.pid, 'SIGTERM')` — the negative pid
addresses the process group, which works only because `detached` made the child a group leader.

Windows has no process groups; the fallback is `taskkill /pid <pid> /T /F`. This is a pre-existing
gap (bundled llama is darwin-arm64 only, and the PATH fallback on Windows was never exercised) —
port it as a documented `TODO`, do not silently paper over it.

`_env()` sets **both** `HF_HOME` and `LLAMA_CACHE`, at different levels. Copy the comment verbatim;
it is the single most deletable-looking load-bearing line in the codebase.

Preserve the reuse short-circuit in `start()`: if a llama-server is already healthy, do not spawn,
leave the handle null, and never kill it in `stop()`. That is what makes the F5 task idempotent.

### idle.ts

`os.kill(os.getpid(), SIGTERM)` → `process.kill(process.pid, 'SIGTERM')`, unchanged in spirit.

But Node has no lifespan context manager, so you must build the other half yourself:

```ts
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

where `shutdown()` closes the HTTP server, stops llama-server, and flushes the example store.

**`server.close()` alone will hang.** It waits for idle connections, and the extension is holding a
keep-alive socket by design. Call `server.closeAllConnections()` (Node ≥18.2) after `close()`.
This is the difference between a clean idle shutdown and a zombie holding 1.6GB.

### examples.ts

Replaces sqlite + fastembed + numpy:

- **Storage:** `data_dir/examples.jsonl`, appended on accept, read once at startup. Bounded (suggest
  2000 rows, oldest dropped) since it is scanned linearly in memory.
- **Retrieval:** shared `tokens()`/`similarity()` from `tokens.ts`, against the same 512-char cursor
  tail.
- **`examples_min_similarity` must be re-tuned.** 0.65 was a cosine threshold on bge-small
  embeddings; Jaccard over identifier tokens lives on a completely different scale and will be much
  lower. Start around 0.15 and measure — shipping 0.65 unchanged silently disables retrieval
  entirely, which is the failure mode most likely to go unnoticed.
- Keep the `Example` shape and the `search()` / `add()` / `count()` signatures identical so §1.4's
  ONNX path can drop in behind them.

Preserve the `try/except` + log-and-continue wrapper in `assemble.ts`: **retrieval is an
enhancement; never fail a completion over it.**

### config.ts

Env-only, `EMBERLINE__` prefix, same names and defaults. Two pydantic-settings behaviors to
replicate: list-typed vars (`EMBERLINE__LLAMA_EXTRA_ARGS`) are parsed as JSON — do `JSON.parse`
with a whitespace-split fallback; and a `.env` in cwd is loaded, which Node 22 gives you free via
`process.loadEnvFile()`.

### http.ts

`node:http`, three routes, JSON in and out, 404 otherwise. Cap request body size.

**The `_watch_disconnect` polling loop disappears entirely** — `res.on('close')` before
`res.writableEnded` *is* the disconnect signal. Delete the 0.1s poll and the `asyncio.wait` race
with it; this is one of two places where the port is simpler than the original.

Mirror uvicorn's `timeout_keep_alive=120` with `server.keepAliveTimeout = 125_000`, and set
`server.headersTimeout` above it or Node will close sockets out from under the client.

Request validation was pydantic's job. Hand-roll ~30 LOC of guards in `wire.ts` (`asString`,
`asStringArray`, defaults) rather than adding zod — the sidecar staying dependency-free is worth
more than the ergonomics, and it keeps the shared types honest.

`response_model=None` has no analog; drop it. The latency it was buying back is not spent in the
first place.

### main.ts

Direct port of `lifespan()` + `AppContext`: build everything, assign to one object, wire SIGTERM,
listen. Two things to keep:

- **Throwing during startup is intentional.** A sidecar that cannot reach a model must exit
  non-zero, not serve 500s per keystroke. `ServerManager.awaitHealthy()` already reads the child's
  exit code and reports it.
- The `anyio` thread-limiter tweak is inert today (a known rough edge) — do not port a Node
  equivalent. There is nothing to limit.

**Add a log file.** Today `stdio: 'ignore'` is acceptable because a failing server can be run in the
foreground with `uv run emberline-server` and its traceback read. After the swap the sidecar is
launched only by the extension, so a startup crash is invisible. Write to `data_dir/server.log` and
add an `Emberline: Show Server Log` command next to the existing `Emberline: Show Logs`.

---

## 4. Tests

Port `test_engine.py`, `test_postprocess.py`, `test_idle.py` to `extension/src/test/engine/`, keeping
the house style: each test is a regression guard naming the bug it prevents
(`test_sessions_are_independent`: "a global counter means two editors abort each other").

**Run them under `node --test`, not vscode-test.** The engine has no `vscode` import, so it does not
need Electron — this gives a fast unit tier that today's setup cannot offer. Add
`"test:engine": "node --test out/test/engine/"` and leave `npm test` (vscode-test) for the
extension and integration suites.

New tests the port specifically needs:

- **SSE reassembly** — feed a known frame sequence sliced at every byte offset; assert identical
  parsed output. Guards the #1 port bug.
- **Binary rejection in ring** — a file with invalid UTF-8 yields zero chunks, not U+FFFD soup.
- **Cache key injectivity** — two prefixes differing only by a lone surrogate produce different keys.
- **Idle shutdown with a live keep-alive connection** — asserts the process actually exits.

`integration.test.ts` keeps its `this.skip()`-when-no-server guard unchanged.

---

## 5. Packaging and CI

### esbuild

Two entry points, one `outdir`:

```js
entryPoints: { extension: 'src/extension.ts', server: 'src/engine/main.ts' },
outdir: 'dist',
```

`main` stays `./dist/extension.js`; `dist/server.js` appears beside it. `external: ['vscode']`
applies to both and is harmless for the server, which never imports it (enforced by the lint rule
from §1.5).

Remember the existing hazard: `dist/` is only rebuilt by `node esbuild.js` / `compile` / `package`,
never by `compile-tests`. That now applies to the sidecar too — `node esbuild.js && npm run
compile-tests && npm test` before any run that exercises it.

### Ship-verification

`dist/server.js` missing from a VSIX fails **only on a user's machine** — the same failure class as
the `bin/**` / `.vscodeignore` trap already documented in CLAUDE.md. Add
`scripts/verify-vsix.mjs`: unzip the built VSIX, assert `extension/dist/server.js` exists, and for
the `darwin-arm64` target also assert `extension/bin/llama/llama-server`. Run it in CI after
`vsce package`, before publish.

### Workflows

- Delete `.github/workflows/publish-server.yml` and the `server-v*` tag convention.
- `publish-extension.yml` is otherwise unchanged — still two VSIXes (`darwin-arm64` bundled +
  untargeted fallback), still tagged `ext-v*`. It simply no longer has to be sequenced after a PyPI
  release.

### manage.ts

Delete: `resolveUv`, `uvToolEnv`, `server/uv.ts` (125 LOC), the `uv tool install` step,
`SERVER_VERSION`, `SERVER_PACKAGE`, the `execFile`/`promisify` imports.

Keep unchanged: the single-flight `ensure()` latch, the `declined` latch, `awaitHealthy()`, the
`bundledLlama()` + defensive `chmod`, and the deliberately-empty `dispose()`.

`provision()` collapses from three progress steps to one. Update the consent copy — it no longer
installs a toolchain, only downloads the model — but **keep the prompt**: a ~1.6GB download is still
squarely what publisher agreement §8(d) means by "beyond what may reasonably be expected".

Update `emberline.manageServer`'s description in `package.json`, which currently points at
`uv run emberline-server`. The escape hatch survives: `node <extension-dir>/dist/server.js`.

---

## 6. De-risking the cutover

**A/B harness (available from phase 3 onward).** Run `uv run emberline-server` on 8011 and
`node dist/server.js` on 8013, then flip `emberline.endpoint` between them. Any behavioral
difference is bisectable to a module.

**Golden-context parity test.** The highest-confidence check, and cheap: capture ~50 real
`/v1/complete` bodies from a live session, stand up a 40-line fake llama-server that echoes its
`/infill` payload back instead of generating, and replay the corpus against both servers. Diff the
resulting `input_prefix` / `input_suffix` / `input_extra`. This catches truncation off-by-ones, ring
ranking drift, and digest changes — the failures that otherwise surface as "completions feel
slightly worse" weeks later.

**Do not delete `server/` until a release has shipped** on the TS sidecar. It is the reference
implementation and the other half of the A/B harness.

---

## 7. Invariants that must survive verbatim

Listed so the port does not "improve" them:

- `-np 1` on llama-server, and the global `model_lock` paired with per-session supersede. Neither
  works without the other.
- `claim()` before any await.
- The extension never kills the sidecar; the sidecar bounds its own lifetime via idle timeout.
- `/health` does not `touch()`; only `/v1/complete` and `/v1/accept` do.
- Retrieval failures log and continue; they never fail a completion.
- The extension stays dumb — no prompt assembly, caching, ranking, or trimming moves into it.
- llama.cpp's `/infill` stays a subprocess, not an embedded library. The FIM token spellings live in
  the GGUF metadata and hand-rolling them is the classic silent-breakage bug.
- `superseded=True` remains overloaded across stale-before-lock, stale-after-lock, and disconnect. It
  answers "should I render this?", not "does a newer request exist?".

---

## 8. Docs to update in phase 6

- **README:** Requirements (no Python, no uv), Run it, Configuration, Where things are stored, Tests,
  Publishing.
- **CLAUDE.md:** delete the server `uv`/`pytest`/`ruff` command block; rewrite "Server lifecycle &
  bundling" (the PyPI-not-`git+` reasoning and `UV_TOOL_DIR` sandboxing become history); drop the
  `SERVER_VERSION` lockstep bullet; update Testing for the `node --test` tier; move `anyio`,
  `ExampleStore.add()` O(n), and sqlite off the "known rough edges" list as they cease to exist.

## 9. What this migration costs

Stated plainly so it is a decision, not a surprise:

- **Semantic example retrieval, until the WASM path lands.** Lexical is a real quality regression on
  that one feature, mitigated by re-tuning the threshold and measured by §6's parity test.
- **Independently upgradable server.** `uv tool install emberline-server` let a user move server
  versions without touching the extension. In exchange, extension and server can no longer disagree
  about the wire contract — which is what `SERVER_VERSION` existed to fake.
- **The other-editor story**, which the README never claimed, so this costs nothing today. If it ever
  becomes a goal, `dist/server.js` + a bundled Node is a perfectly ordinary thing to ship.
