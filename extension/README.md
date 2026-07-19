# Emberline

Local inline code completion for VS Code. Ghost text from a code model running on
your own machine — no account, no telemetry, no code leaving your laptop.

> ### On Apple Silicon, it sets itself up
>
> On an Apple Silicon Mac the extension bundles the `llama-server` engine and, the
> first time you type in a code file, offers to finish setup for you: it installs a
> small local inference server and downloads the model (~1.6 GB, once). You approve
> one prompt and wait for the download — no terminal, no Python, no Homebrew.
> Everything runs on your machine and nothing is sent anywhere.
>
> On other platforms the extension still brings its own server, but you provide
> `llama.cpp` yourself. See [Setup](#setup) for both paths, and for running the
> server yourself if you'd rather.

## Why

Every hosted completion product sends your buffer to someone else's machine and
lands at 690 ms or worse at p75. If you're going to wait anyway, you may as well
wait locally and keep the code. Emberline runs [llama.cpp](https://github.com/ggml-org/llama.cpp)
with a Qwen2.5-Coder FIM model and gets a completion back in **~950 ms warm** on a
base M1 — the slowest Apple Silicon chip llama.cpp lists — and **~3 ms** on a cache
hit.

## Requirements

- **macOS 15+ (Sequoia) on Apple Silicon** (Metal), or **Linux with a Vulkan-capable
  GPU** (NVIDIA, AMD or Intel). Both are tested.
- VS Code 1.104+
- ~2 GB of disk for the model, downloaded on first run
- An internet connection for that first-run download

Nothing else on Apple Silicon (macOS 15+): the inference engine is bundled and the
server ships inside the extension. On other platforms, and on macOS 14 or older
(which cannot load the bundled engine), you also need
[llama.cpp](https://github.com/ggml-org/llama.cpp) — see below.

## Setup

**Apple Silicon — nothing to do.** Install the extension, open a code file, and
start typing. The first keystroke offers to finish setup; approve it and wait for
the model to download (~1.6 GB, once — the status bar sits at "starting" for a
minute). After that, ghost text appears after about a second; <kbd>Tab</kbd>
accepts it. The status bar shows Emberline's state and the latency of the last
completion — click it to toggle completions off and on.

If the status bar shows a warning, run **Emberline: Show Logs** from the Command
Palette. If setup itself failed, **Emberline: Show Server Log** has the server's
own account of why.

### Linux and Windows — install llama.cpp first

Only the Apple Silicon build bundles an inference engine. Elsewhere, put
`llama-server` on your `PATH` (or point `EMBERLINE__LLAMA_BINARY` at it) before
running setup — otherwise setup stops and tells you exactly this.

Grab a build from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).
On Linux the **Vulkan** build is usually the right pick: it drives NVIDIA, AMD and
Intel GPUs with no CUDA or ROCm toolchain to install.

If your machine has more than one GPU — any laptop with integrated graphics beside
a discrete card — check `llama-server --list-devices` and pin the fast one:

```bash
mkdir -p ~/.config/environment.d
echo 'EMBERLINE__LLAMA_EXTRA_ARGS=--device Vulkan1' > ~/.config/environment.d/emberline.conf
# log out and back in
```

llama.cpp otherwise splits the model across every device it finds, including the
slow one. Measured on an RTX 4060 laptop: 49 tok/s split, 80 tok/s pinned.

### Running the server yourself

If you'd rather manage the server (another machine, a shared box, a tuned
configuration), set `emberline.manageServer` to `false` and start it yourself:

```bash
# The server ships inside the extension; run it yourself with any Node 22+.
node ~/.vscode/extensions/l0kifs.emberline-*/dist/server.js
curl -s http://127.0.0.1:8011/health   # {"status":"ok",...}
```

Point `emberline.endpoint` at it if it isn't on the default
`http://127.0.0.1:8011`. With `manageServer` off, the extension only ever
connects to a server you started — it never installs or spawns one.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `emberline.enabled` | `true` | Enable completions. Overridable per language. |
| `emberline.endpoint` | `http://127.0.0.1:8011` | Server base URL. |
| `emberline.manageServer` | `true` | Let Emberline start its bundled server when nothing answers. Turn off to run it yourself. |
| `emberline.debounceMs` | `150` | Delay before requesting. VS Code adds ~50 ms of its own first. |
| `emberline.timeoutMs` | `5000` | Hard timeout for a request. |
| `emberline.disabledLanguages` | `scminput` | Languages never to complete in. |
| `emberline.maxPrefixChars` | `8192` | Characters before the cursor to send. |
| `emberline.maxSuffixChars` | `2048` | Characters after the cursor to send. |
| `emberline.maxLineSuffixChars` | `8` | Skip completion when more code than this follows the cursor on the line. |
| `emberline.sendOpenFiles` | `true` | Send paths of open files for cross-file context. Paths only. |

The server is configured separately, through `EMBERLINE__*` environment variables.
See the [server configuration docs](https://github.com/l0kifs/emberline#configuration).

## Privacy

Your code goes to `emberline.endpoint` and nowhere else. By default that is
`127.0.0.1`, a local server running a model on your own GPU. The extension sends
no telemetry.

When Emberline sets the server up for you, the only thing it downloads is the
model, from Hugging Face. The server itself ships inside the extension and runs
on VS Code's own Node, so there is no toolchain to install. Everything downloaded
lands under `~/.emberline`; `rm -rf ~/.emberline` removes it. None of this sends
your code anywhere.

Two more details worth knowing. The extension sends the **paths** of your other
open files (not their contents) so the server can build cross-file context; turn
that off with `emberline.sendOpenFiles`. And completions you **accept** are stored
locally in `~/.emberline/examples.jsonl` and reused as few-shot examples — delete
the file or set `EMBERLINE__EXAMPLES_ENABLED=false` to opt out.

Because `emberline.endpoint` decides where your buffer is sent, it's marked as
restricted in untrusted workspaces — a malicious repo can't silently repoint it.

## Commands

| Command | |
|---|---|
| `Emberline: Toggle Inline Completions` | Turn ghost text off and on. Writes `emberline.enabled`, so it sticks across reloads. |
| `Emberline: Show Logs` | Open the extension's log output channel. |
| `Emberline: Show Server Log` | Open the inference server's own log. This is where a failed startup explains itself. |

## Known limitations

- The model is a **code** model. It completes code well in any language, including
  fenced code blocks in Markdown — but prose in Markdown or plain text is
  noticeably weaker and sometimes runs on repetitively. Those languages are
  enabled by default anyway, because a new unsaved file is `plaintext` until you
  pick a language; add them to `emberline.disabledLanguages` if the prose
  suggestions get in your way.
- Apple Silicon and Linux/Vulkan are the tested platforms. Windows should work
  with `llama-server` on `PATH`, but is untested.
- Only the Apple Silicon build bundles an inference engine; elsewhere you install
  llama.cpp yourself.
- Cross-file context is read from disk by the server, so it doesn't work in
  virtual or remote workspaces.

## Links

- [Source, architecture notes, and benchmarks](https://github.com/l0kifs/emberline)
- [Issues](https://github.com/l0kifs/emberline/issues)

MIT licensed.
