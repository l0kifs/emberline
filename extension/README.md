# Emberline

Local inline code completion for VS Code. Ghost text from a code model running on
your own machine — no account, no telemetry, no code leaving your laptop.

> ### Emberline needs a local server
>
> This extension is a thin client. It does **not** bundle a model or an inference
> server — you run those yourself, on your own hardware. Installing the extension
> alone will not produce completions. Setup is a few commands and takes about five
> minutes; see [Setup](#setup) below.

## Why

Every hosted completion product sends your buffer to someone else's machine and
lands at 690 ms or worse at p75. If you're going to wait anyway, you may as well
wait locally and keep the code. Emberline runs [llama.cpp](https://github.com/ggml-org/llama.cpp)
with a Qwen2.5-Coder FIM model and gets a completion back in **~950 ms warm** on a
base M1 — the slowest Apple Silicon chip llama.cpp lists — and **~3 ms** on a cache
hit.

## Requirements

- **macOS on Apple Silicon** (Metal). Linux/CUDA should work but is untested.
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — `brew install llama.cpp`
- [uv](https://docs.astral.sh/uv/) and Python 3.12
- VS Code 1.104+
- ~2 GB of disk for the model, downloaded on first run

## Setup

```bash
git clone https://github.com/l0kifs/emberline.git
cd emberline/server
uv sync
uv run emberline-server
```

That starts the server on `http://127.0.0.1:8011` and manages the `llama-server`
subprocess for you. The first run downloads the model (~1.6 GB), so it will sit at
"starting" for a minute; later starts take a few seconds.

Verify it's up:

```bash
curl -s http://127.0.0.1:8011/health   # {"status":"ok",...}
```

Now open a code file in VS Code and start typing. Ghost text appears after about a
second; <kbd>Tab</kbd> accepts it. The status bar shows Emberline's state and the
latency of the last completion — click it to toggle completions off and on.

If the status bar shows a warning, run **Emberline: Show Logs** from the Command
Palette.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `emberline.enabled` | `true` | Enable completions. Overridable per language. |
| `emberline.endpoint` | `http://127.0.0.1:8011` | Server base URL. |
| `emberline.debounceMs` | `150` | Delay before requesting. VS Code adds ~50 ms of its own first. |
| `emberline.timeoutMs` | `5000` | Hard timeout for a request. |
| `emberline.disabledLanguages` | `plaintext`, `markdown`, `scminput` | Languages never to complete in. |
| `emberline.maxPrefixChars` | `8192` | Characters before the cursor to send. |
| `emberline.maxSuffixChars` | `2048` | Characters after the cursor to send. |
| `emberline.maxLineSuffixChars` | `8` | Skip completion when more code than this follows the cursor on the line. |
| `emberline.sendOpenFiles` | `true` | Send paths of open files for cross-file context. Paths only. |

The server is configured separately, through `EMBERLINE__*` environment variables.
See the [server configuration docs](https://github.com/l0kifs/emberline#configuration).

## Privacy

Your code goes to `emberline.endpoint` and nowhere else. By default that is
`127.0.0.1`, a server you started, running a model on your own GPU. The extension
sends no telemetry and stores nothing.

Two details worth knowing. The extension sends the **paths** of your other open
files (not their contents) so the server can build cross-file context; turn that
off with `emberline.sendOpenFiles`. And completions you **accept** are stored
locally in `~/.emberline/examples.db` and reused as few-shot examples — delete the
file or set `EMBERLINE__EXAMPLES_ENABLED=false` to opt out.

Because `emberline.endpoint` decides where your buffer is sent, it's marked as
restricted in untrusted workspaces — a malicious repo can't silently repoint it.

## Commands

| Command | |
|---|---|
| `Emberline: Toggle Inline Completions` | Turn ghost text off and on. Writes `emberline.enabled`, so it sticks across reloads. |
| `Emberline: Show Logs` | Open the log output channel. |

## Known limitations

- Apple Silicon is the only tested platform.
- Cross-file context is read from disk by the server, so it doesn't work in
  virtual or remote workspaces.

## Links

- [Source, architecture notes, and benchmarks](https://github.com/l0kifs/emberline)
- [Issues](https://github.com/l0kifs/emberline/issues)

MIT licensed.
