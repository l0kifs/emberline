# emberline

Local inline code completion for VS Code. Ghost text from a llama.cpp FIM model
running on your own machine.

```
VS Code extension (TypeScript)     debounce, fire, render — and nothing else
        │  HTTP
        ▼
FastAPI server (Python)            supersede · cache · prompt & context assembly
        │  HTTP  POST /infill
        ▼
llama-server (llama.cpp)           Qwen2.5-Coder-1.5B-Q8_0 · Metal · KV cache
```

The extension is deliberately dumb. Everything latency-sensitive except the
debounce lives in the Python server, where it is easier to reason about: prompt
assembly, result caching, and cancelling work that a newer keystroke made
obsolete. The debounce has to be client-side, because you cannot debounce a
request that has already been sent.

## Requirements

- macOS on Apple Silicon (Metal). Linux/CUDA should work but is untested.
- [llama.cpp](https://github.com/ggml-org/llama.cpp): `brew install llama.cpp`
- [uv](https://docs.astral.sh/uv/), Python 3.12
- **Node 22+** (`@vscode/test-cli` requires it), VS Code 1.104+

`extension/.nvmrc` pins Node 22. With [fnm](https://github.com/Schniz/fnm) or nvm
installed, `fnm use` / `nvm use` inside `extension/` picks it up. Older Node
mostly works but npm will warn `EBADENGINE` and the test runner is then outside
its supported range.

## Run it

One-time setup:

```bash
cd server && uv sync          # server deps
cd ../extension && npm install # extension deps
```

Then open the **repo root** in VS Code and press <kbd>F5</kbd>.

That runs the `Run Extension + Server` launch config, which starts the Python
server (reusing one if it is already running), builds the extension, and opens a
second VS Code window titled **[Extension Development Host]** with Emberline
loaded. Open a code file in that window and start typing — ghost text appears
after ~1s. Edits to the source rebuild automatically; <kbd>Cmd</kbd>+<kbd>R</kbd>
in the dev host reloads the extension.

The first run downloads the model (~1.6GB), so it will sit at "starting" for a
minute. Subsequent starts take a few seconds.

Other launch configs (<kbd>F5</kbd> uses the first; pick others from the Run and
Debug panel):

| Config | What it does |
|---|---|
| **Run Extension + Server** | Default. Starts the server, builds, opens the dev host. |
| **Run Extension only** | For when you already run the server in a terminal. |
| **Run Extension (isolated)** | Adds `--disable-extensions`. |
| **Extension Tests** | Runs the suite in a host window. |

Use **isolated** when judging suggestion quality. It disables every other
extension while still loading Emberline, so nothing else competes for the ghost
text slot — VS Code queries all inline completion providers in parallel and merges
the results, and `yieldTo` (the API for deferring to another provider) is proposed,
so a shipped extension cannot use it. The cost is that your other extensions are
gone in that window too.

Prefer separate terminals?

```bash
cd server && uv run emberline-server
curl -s http://127.0.0.1:8011/health   # {"status":"ok",...}
```

Opening `extension/` directly in VS Code also works — it has its own launch
config, but it will not start the server for you.

## Measured performance

Benchmarked on a base **M1, 16GB** (68 GB/s memory bandwidth — the slowest chip
in llama.cpp's Apple Silicon table), Qwen2.5-Coder-1.5B-Q8_0, ~790 token prefix:

| | |
|---|---|
| Completion, warm KV cache | **~950 ms** |
| Completion, result cache hit | **~3 ms** |
| Prefill, cached prefix | ~67–137 ms (18–62 tokens) |
| Decode | ~33 tok/s → ~750 ms for a typical 26-token completion |
| Burst of 5 keystrokes | 1283 ms vs ~4750 ms naive (**3.7× saved** by superseding) |

**~950 ms is the honest number on this hardware**, and it matches llama.cpp's own
stated FIM design target of "~1 second or less". Sub-100 ms ghost text is an
architecture decision, not a tuning outcome — the systems that achieve it use
much smaller models (Google's is 0.5B in-house at ~40 ms; JetBrains ships 100M
INT4 at 150 ms with >90% cache hits). Every remote system lands at 690 ms+ p75.

Completion is **decode-bound**, not prefill-bound: ~750 ms of the ~950 ms is
generating 26 tokens at 33 tok/s. So the levers are decoding fewer tokens, and
not asking at all.

### Things the benchmark caught that the docs do not tell you

**`-np 1` is mandatory.** The `--fim-qwen-*` presets leave slot count on auto.
With multiple slots, consecutive requests round-robin across *independent KV
caches*, so roughly every other keystroke fully recomputes the prompt: measured
**793 tokens / ~1240 ms** instead of a ~67 ms cache hit. The server passes
`-np 1` for this reason; do not remove it.

**`t_max_predict_ms` does not cap generation.** It only takes effect after the
first token *and* after a newline has been generated. A 128-token completion ran
3934 ms with `t_max_predict_ms: 1000` set. Bound latency with `n_predict`
instead.

**A smaller model is not automatically faster.** Qwen2.5-Coder-0.5B decodes 2.2×
faster (74 vs 33 tok/s), but it does not know when to stop — it rambles past the
completion and burns the whole `n_predict` budget. At `n_predict: 128` the 0.5B
took 902 ms against the 1.5B's 947 ms. The 1.5B stops at EOS after 26 tokens.
Speed came from knowing when to shut up, not from parameter count. 0.5B is
available via `EMBERLINE__LLAMA_PRESET`, but it is not the default.

## Configuration

Server, env vars prefixed `EMBERLINE__`:

| Variable | Default | Notes |
|---|---|---|
| `EMBERLINE__PORT` | `8011` | |
| `EMBERLINE__LLAMA_PRESET` | `--fim-qwen-1.5b-default` | `--fim-qwen-3b-default` if you have the headroom |
| `EMBERLINE__LLAMA_MANAGED` | `true` | `false` to point at an llama-server you run yourself |
| `EMBERLINE__N_PREDICT` | `128` | The real latency cap |
| `EMBERLINE__RING_ENABLED` | `true` | Cross-file context |
| `EMBERLINE__EXAMPLES_ENABLED` | `true` | Accepted-completion retrieval |
| `EMBERLINE__DATA_DIR` | `~/.emberline` | Everything on disk lives under here |

Extension, under `emberline.*`: `endpoint`, `debounceMs` (default 150 — VS Code
adds ~50 ms of its own before the provider is even called), `timeoutMs`,
`disabledLanguages`, `maxLineSuffixChars`, `sendOpenFiles`.

## Where things are stored

Everything lives under `EMBERLINE__DATA_DIR` (default `~/.emberline`). The
extension itself stores nothing — it is stateless.

```
~/.emberline/
├── examples.db                 # accepted completions + embeddings (SQLite)
└── cache/
    ├── huggingface/hub/        # GGUF models (~1.5GB for 1.5B-Q8_0)
    └── fastembed/              # embedding model (~64MB)
```

Uninstalling is `rm -rf ~/.emberline`; everything regenerates.

The model cache is pinned there by setting **both** `HF_HOME` and `LLAMA_CACHE`
on the llama-server subprocess. Both are needed: `LLAMA_CACHE` takes precedence
in llama.cpp, so setting only `HF_HOME` is silently ignored for anyone who
exports `LLAMA_CACHE`. They also name *different levels* — `HF_HOME` is the
parent and llama.cpp appends `/hub`, while `LLAMA_CACHE` is the hub directory
itself. Without this, models land in the shared `~/.cache/huggingface` mixed in
with unrelated ones.

Completion results are cached in memory only, and die with the process.

## Context

Two mechanisms, both delivered through `/infill`'s `input_extra`:

**Cross-file ring buffer** (`context/ring.py`) — chunks other open files and ranks
them against the cursor context by Jaccard overlap on identifier tokens. Ranking
runs on every keystroke, so it has to be nearly free; this is why it does not use
embeddings. Modelled on llama.vim. The extension sends *paths only*; the server
reads and chunks the files itself.

**Accepted-example retrieval** (`context/examples.py`) — completions you accept are
embedded (`bge-small-en-v1.5`, via fastembed) and stored in SQLite. Similar past
completions are retrieved as few-shot context. Scoring is one numpy matmul against
a resident normalised matrix, with a similarity floor.

## Tests

```bash
cd server && uv run pytest
cd extension && npm test    # 12 unit + 4 onboarding + 2 end-to-end
```

The end-to-end tests drive the real UI — trigger ghost text, commit it, assert on
the buffer — and skip themselves when no server is reachable. There is no
`vscode.executeInlineCompletionProvider` command (it does not exist in the
registry, despite appearing in some guides), so trigger/commit is the honest way
to test this.

## Notable design decisions

- **`llama-server` over `llama-cpp-python`.** `/infill` reads FIM token spellings
  from the GGUF metadata. There are at least four incompatible spellings in the
  wild (Qwen `<|fim_prefix|>`, StarCoder2 `<fim_prefix>`, DeepSeek's fullwidth
  `<｜fim▁begin｜>`, Seed-Coder's bracket-dash) crossed with PSM/SPM ordering.
  Hand-rolling that is the classic silent-breakage bug. We also get
  `--cache-reuse`, the 3:1 prefix:suffix batch clamp, and crash isolation.
- **Superseding is per-session, model access is global.** Two documents must not
  abort each other's requests, but with one slot there is one KV cache, so letting
  them generate concurrently would thrash it.
- **Only the stable VS Code API.** Next-edit suggestions (`isInlineEdit`),
  `handleEndOfLifetime`, `yieldTo` and `debounceDelayMs` are all proposed API,
  which the Marketplace rejects and which fails *silently* at runtime. Accept
  tracking uses the stable `InlineCompletionItem.command`.
- **Global `fetch`, no HTTP library.** The extension host patches
  `globalThis.fetch` with proxy resolution and OS certificates. Bundling axios or
  node-fetch would lose that rather than add anything.

## Publishing

The extension ships to the VS Code Marketplace as a thin client; the server and
model are not bundled and are installed from this repo. Publisher setup, the
release checklist, versioning rules and troubleshooting are in
[PUBLISHING.md](PUBLISHING.md).

## License

MIT
