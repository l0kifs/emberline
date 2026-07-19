# emberline

Local inline code completion for VS Code. Ghost text from a llama.cpp FIM model
running on your own machine.

```
VS Code extension (TypeScript)     debounce, fire, render — and nothing else
        │  HTTP
        ▼
Emberline server (TypeScript)      supersede · cache · prompt & context assembly
        │  HTTP  POST /infill
        ▼
llama-server (llama.cpp)           Qwen2.5-Coder-1.5B-Q8_0 · Metal · KV cache
```

The extension is deliberately dumb. Everything latency-sensitive except the
debounce lives in the server, where it is easier to reason about: prompt
assembly, result caching, and cancelling work that a newer keystroke made
obsolete. The debounce has to be client-side, because you cannot debounce a
request that has already been sent.

The server is a **separate process, not part of the extension host**. That is
load-bearing: each VS Code window gets its own extension host, so an in-process
engine would give each window its own model lock, and two windows would thrash
the single KV cache. The server is shared, warm, and bounds its own lifetime
with an idle timeout.

It ships inside the VSIX as `dist/server.js` and runs on VS Code's own Node
(`ELECTRON_RUN_AS_NODE`), so there is no runtime to install.

**Just want to use it?** Install *Emberline* from the VS Code Marketplace. On
Apple Silicon it bundles the engine too — see
[extension/README.md](extension/README.md). The rest of this file is for
building, running from source, and the design rationale.

## Requirements

- **macOS on Apple Silicon** (Metal), or **Linux with a Vulkan-capable GPU**. Both
  are tested; see the numbers below. CUDA and ROCm builds exist upstream and
  should work, but are not exercised here.
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `llama-server` on `PATH`,
  or point `EMBERLINE__LLAMA_BINARY` at one.
- **Node 22+** (`@vscode/test-cli` requires it), VS Code 1.104+

No Python toolchain: the server is TypeScript and ships with the extension.

### Installing llama.cpp

macOS: `brew install llama.cpp`.

Linux: upstream ships no CUDA build for Ubuntu, but the **Vulkan** build drives
NVIDIA, AMD and Intel GPUs without a vendor toolchain — no CUDA/ROCm install, and
it is what the Linux numbers below were measured on.

```bash
# pick the current tag from https://github.com/ggml-org/llama.cpp/releases
curl -sL -o llama.tar.gz \
  https://github.com/ggml-org/llama.cpp/releases/download/b10068/llama-b10068-bin-ubuntu-vulkan-x64.tar.gz
mkdir -p ~/.local/lib && tar xzf llama.tar.gz && mv llama-b10068 ~/.local/lib/llama.cpp
ln -sf ~/.local/lib/llama.cpp/llama-server ~/.local/bin/llama-server
llama-server --list-devices
```

The binaries carry an `$ORIGIN` runpath, so the symlink resolves its libraries
correctly and nothing needs to go in a system directory.

### Multi-GPU machines: pin the device

**This one costs real performance and is silent.** llama.cpp's Vulkan backend
splits layers across *every* device it finds. On a laptop with an integrated GPU
beside a discrete one, that means part of the model runs on the iGPU:

```
$ llama-server --list-devices
  Vulkan0: Intel(R) Graphics (RPL-S)
  Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU
```

Measured on that machine: **49 tok/s split, 80 tok/s pinned to the discrete GPU
alone.** Pin it with `EMBERLINE__LLAMA_EXTRA_ARGS`, which Emberline passes through
to llama-server:

```bash
mkdir -p ~/.config/environment.d
echo 'EMBERLINE__LLAMA_EXTRA_ARGS=--device Vulkan1' > ~/.config/environment.d/emberline.conf
# log out and back in, so GUI-launched VS Code inherits it
```

Re-check the index with `--list-devices` after a driver update; the ordering is
not guaranteed stable.

`extension/.nvmrc` pins Node 22. With [fnm](https://github.com/Schniz/fnm) or nvm
installed, `fnm use` / `nvm use` inside `extension/` picks it up. Older Node
mostly works but npm will warn `EBADENGINE` and the test runner is then outside
its supported range.

## Run it

One-time setup:

```bash
cd extension && npm install
```

Then open the **repo root** in VS Code and press <kbd>F5</kbd>.

That runs the `Run Extension + Server` launch config, which starts the
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
cd extension && node esbuild.js && node dist/server.js
curl -s http://127.0.0.1:8011/health   # {"status":"ok",...}
```

Opening `extension/` directly in VS Code also works — it has its own launch
config, but it will not start the server for you.

## Measured performance

Two machines, same model (Qwen2.5-Coder-1.5B-Q8_0):

| | base M1, 16GB (Metal) | RTX 4060 Laptop, 8GB (Vulkan) |
|---|---|---|
| Completion, warm | ~950 ms | **~435 ms** |
| Decode | ~33 tok/s | **~80 tok/s** |
| Result cache hit | ~3 ms | ~3 ms |

The M1 figures are the detailed benchmark below and the ones the design was tuned
against — it is the slowest chip in llama.cpp's Apple Silicon table, so it is the
honest floor. The 4060 numbers are a spot measurement of the same request shapes,
included because they show the architecture is not the bottleneck on faster
hardware: superseding, the KV cache and the result cache all matter more, not
less, when generation gets cheap.

Full benchmark, on the base **M1, 16GB** (68 GB/s memory bandwidth), ~790 token
prefix:

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
| `EMBERLINE__IDLE_TIMEOUT_S` | `1800` | Exit after this long with no completion traffic; `0` disables. Lets an editor start the server and never have to stop it. |
| `EMBERLINE__DATA_DIR` | `~/.emberline` | Everything on disk lives under here |

Extension, under `emberline.*`: `endpoint`, `manageServer` (default true — install
and start the server automatically; set false to run it yourself), `debounceMs`
(default 150 — VS Code adds ~50 ms of its own before the provider is even called),
`timeoutMs`, `disabledLanguages`, `maxLineSuffixChars`, `sendOpenFiles`.

## Where things are stored

Everything lives under `EMBERLINE__DATA_DIR` (default `~/.emberline`). The
extension itself stores nothing — it is stateless.

```
~/.emberline/
├── examples.jsonl              # accepted completions, append-only
├── server.log                  # the server's own log (Emberline: Show Server Log)
└── cache/
    └── huggingface/hub/        # GGUF models (~1.5GB for 1.5B-Q8_0)
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

**Cross-file ring buffer** (`engine/ring.ts`) — chunks other open files and ranks
them against the cursor context by Jaccard overlap on identifier tokens. Ranking
runs on every keystroke, so it has to be nearly free; this is why it does not use
embeddings. Modelled on llama.vim. The extension sends *paths only*; the server
reads and chunks the files itself.

**Accepted-example retrieval** (`engine/examples.ts`) — completions you accept are
stored in an append-only JSONL file and retrieved as few-shot context when a later
cursor position looks similar, ranked by the same identifier-token overlap with a
similarity floor.

This used to be semantic (`bge-small-en-v1.5` embeddings via fastembed, scored as
a numpy matmul over a resident matrix, in SQLite). It went lexical when the server
moved from Python to TypeScript: every JS embedding runtime worth using drags in
per-platform native binaries, which is exactly the packaging problem that move was
meant to remove. The interface is unchanged, so an ONNX/WASM implementation can
drop back in behind it.

The loss is smaller than "lexical vs semantic" implies, because code carries its
meaning in identifiers. Asked to match each TypeScript module here to the Python
module it was ported from — restructured, resyntaxed, renamed — token overlap picked
the right counterpart 75% of the time against 11% chance. (That measures the scorer;
retrieval itself filters by language first, so a cross-language match never actually
gets returned. It carries over to same-language, different-file retrieval, which is
the case that does fire.)

## Tests

```bash
cd extension && npm run test:engine   # server engine, plain Node, no Electron
cd extension && npm test              # extension + onboarding + end-to-end
```

`test:engine` runs outside an extension host: nothing under `src/engine/` may
import `vscode` (enforced at build time by `esbuild.js`), so those tests need no
Electron and finish in ~2s.

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
