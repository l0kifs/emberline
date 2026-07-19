# Changelog

## [0.1.1] - 2026-07-20

Input-validation and edge-case hardening, driven by a systematic test pass
(engine suite 95 → 299 tests). No new features; behavior changes are confined to
rejecting previously-accepted malformed input.

Fixed:

- Server configuration is validated at startup. Numeric settings accept only
  decimal values within a sensible per-field range, so a typo now fails loudly
  and names the variable instead of surfacing later as an opaque bind error. In
  particular, `EMBERLINE__RING_CHUNK_LINES=0` used to wedge the server in an
  infinite loop; it is now rejected. Empty values for path/host settings are
  rejected rather than silently clobbering a working default.
- Oversized completion requests return a proper error response instead of
  dropping the connection.
- A prefix, suffix, or example-store limit of `0` now clamps to nothing;
  previously a limit of `0` disabled the clamp entirely and sent everything.
- Long duplicated tails are fully trimmed from completions — the de-duplication
  scan no longer stops at 200 characters, which had let longer overlaps render
  as visibly doubled code.
- Completion routes tolerate a trailing slash or query string.
- Cross-file context skips a file opened in more than one editor group instead
  of spending two context slots on identical text.
- Requests with an empty document id are rejected, keeping per-document
  superseding from collapsing every document into one scope.

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
