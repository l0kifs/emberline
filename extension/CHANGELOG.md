# Changelog

## [0.1.0] - 2026-07-17

First release.

- Inline completions from a local llama.cpp FIM model, via the Emberline server.
- Superseding: a newer keystroke abandons the in-flight generation for that
  document, so a burst of typing costs one completion rather than one per key.
- Cross-file context from open files, ranked by identifier overlap.
- Accepted completions are stored locally and retrieved as few-shot examples.
- Status bar showing state and last-completion latency; click to toggle.
- Setup prompt when the server is unreachable.
- Toggling writes `emberline.enabled`, so it survives a reload, and honours the
  scope the setting is already defined in.
