# Changelog

## [0.1.0] - 2026-07-17

First release.

- Inline completions from a local llama.cpp FIM model, via the Emberline server.
- Superseding: a newer keystroke abandons the in-flight generation for that
  document, so a burst of typing costs one completion rather than one per key.
- Cross-file context from open files, ranked by identifier overlap.
- Accepted completions are stored locally and retrieved as few-shot examples.
- Status bar showing state and last-completion latency; click to toggle.
- Zero-setup on Apple Silicon: the VSIX bundles both the inference server and the
  `llama-server` engine. The server runs on VS Code's own Node, so nothing is
  installed at runtime — first use downloads only the model, after a single
  consent prompt. Set `emberline.manageServer` to `false` to run the server
  yourself instead.
- The server exits after 30 minutes idle (`EMBERLINE__IDLE_TIMEOUT_S`), so an
  editor can start it and never have to stop it — it stays shared and warm across
  windows and frees its memory on its own.
- `Emberline: Show Server Log` opens the server's own log, where a failed startup
  explains itself — the server is spawned detached with no console to write to.
- Completions are offered in every language except the SCM commit box, including
  unsaved buffers, Markdown and plain text. A new unsaved file is `plaintext`
  until you pick a language, so excluding it also excluded unsaved files.
- Manual-setup prompt when `manageServer` is off and the server is unreachable.
- Toggling writes `emberline.enabled`, so it survives a reload, and honours the
  scope the setting is already defined in.
