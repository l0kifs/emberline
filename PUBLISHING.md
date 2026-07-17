# Publishing Emberline to the VS Code Marketplace

Maintainer notes for shipping `extension/` to the Marketplace. Not packaged into
the VSIX — `vsce` packages from `extension/`, and this file lives at the repo root.

Identifiers:

| | |
|---|---|
| Publisher ID | `l0kifs` |
| Extension name | `emberline` |
| Extension ID | `l0kifs.emberline` (`<publisher>.<name>`) |
| Marketplace URL | `https://marketplace.visualstudio.com/items?itemName=l0kifs.emberline` |

The publisher is the **account**, not the product, which is why it is a personal
handle and not `emberline`: a second extension published under `emberline` would
read as though a different project shipped it, and a publisher ID can never be
renamed. Branding costs nothing here — the publisher's **display name** is a
separate, editable field, so set it to whatever reads best ("Emberline" or your
own name) at registration. Users see `displayName` from package.json
("Emberline") in the sidebar regardless.

**Two VSIXes ship per release**, following rust-analyzer's model:

- **`darwin-arm64`** (~9.5 MB): `dist/extension.js` plus the `llama-server`
  engine and its dylibs, staged into `bin/llama/` by
  [extension/scripts/fetch-llama.mjs](extension/scripts/fetch-llama.mjs). This is
  the zero-setup build — the user installs nothing.
- **untargeted fallback** (~20 KB): no binary. VS Code serves it on every other
  platform, where the user provides `llama.cpp` themselves.

Neither bundles the Python server or the model. The server is published to **PyPI**
as `emberline-server` and installed on the user's machine by `uv` at first use
(the extension carries a private `uv` if none is on `PATH`); the model downloads
from Hugging Face on first run. So what reaches the Marketplace is the client plus,
on Apple Silicon, the inference engine — not the server and not the model.

Releases are cut by two tag-triggered GitHub Actions workflows, not by hand:
[.github/workflows/publish-server.yml](.github/workflows/publish-server.yml) (tag
`server-v*` → PyPI, via OIDC trusted publishing) and
[.github/workflows/publish-extension.yml](.github/workflows/publish-extension.yml)
(tag `ext-v*` → both VSIXes to the Marketplace). The manual steps below still apply
for a local dry run or a broken-PAT fallback. If the bundling model ever changes,
this document changes with it.

## One-time setup

You need a Microsoft account. `vsce` is deliberately not a dependency — run it
through `npx`.

1. **Azure DevOps organization.** Create one at [dev.azure.com](https://dev.azure.com)
   if you have none. Nothing is hosted there; it only issues the token.

2. **Personal Access Token.** In Azure DevOps → *User settings* → *Personal access
   tokens* → *New Token*:

   - **Organization: "All accessible organizations"** — not a specific org. This
     is the single most common cause of a `401` at publish time, and the error
     does not explain itself.
   - **Scopes: "Custom defined" → Marketplace → Manage.**
   - Copy the token immediately; it is shown once.

3. **Create the publisher** at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
   → *Create publisher*. The **ID** must equal `publisher` in
   [extension/package.json](extension/package.json) — `l0kifs` — and is
   **immutable**. The **display name** beside it is free text and editable later.

4. **Log in:**

   ```bash
   cd extension
   npx @vscode/vsce login l0kifs    # paste the PAT
   ```

## Pre-release checklist

Run from `extension/`.

```bash
node esbuild.js && npm run compile-tests && npm test
```

`node esbuild.js` is not optional. The test host loads the extension from
`dist/extension.js`, which `compile-tests` does not rebuild — skip it and you test
the previous bundle against the new tests. See the testing notes in
[CLAUDE.md](CLAUDE.md).

- [ ] **Start the server first** (`cd server && uv run emberline-server`). The two
      end-to-end tests skip themselves when nothing answers `/health`, so a green
      run without a server has not exercised completion at all.
- [ ] `uv run pytest` in `server/` passes.
- [ ] [extension/CHANGELOG.md](extension/CHANGELOG.md) has an entry for this version.
- [ ] [extension/README.md](extension/README.md) is accurate — it *is* the
      Marketplace landing page, and its relative links resolve against the
      `repository` field.
- [ ] Setup instructions still work from a clean clone.
- [ ] `npx @vscode/vsce package` reports **no warnings**. A missing `repository`
      or `LICENSE` warning means something regressed.

Inspect what you are about to ship. Stage the engine first for the targeted
build — without it you get a `darwin-arm64` VSIX with no binary, which fails only
on a user's machine:

```bash
node scripts/fetch-llama.mjs darwin-arm64          # stages bin/llama/ (~22 MB)
npx @vscode/vsce ls                                # files that will be included
npx @vscode/vsce package --target darwin-arm64     # writes the bundled VSIX
npx @vscode/vsce package                           # untargeted fallback, no binary
```

Install the VSIX locally before publishing — this is the only way to see what a
real user gets, including the first-run prompt:

```bash
code --install-extension emberline-0.1.0.vsix
# then: quit the server and start typing — the setup prompt should appear
code --uninstall-extension l0kifs.emberline
```

## Versioning

The Marketplace accepts **`major.minor.patch` only**. Semver pre-release tags
(`0.2.0-beta.1`) are rejected — pre-release is a publish *flag*, not a version
string.

The convention Microsoft recommends, which `0.1.0` already follows:

| | |
|---|---|
| `major.ODD.patch` | pre-release (`0.1.0`, `0.3.0`) |
| `major.EVEN.patch` | release (`0.2.0`, `1.0.0`) |

Bump and publish in one step with `vsce publish minor` / `patch` / `major`, which
rewrites `package.json` **and creates a git commit and tag**. Pass
`--no-git-tag-version` to skip that, or bump by hand.

## Publish

```bash
cd extension
npx @vscode/vsce publish --pre-release     # while on an odd minor
npx @vscode/vsce publish                   # stable
```

`vscode:prepublish` runs `npm run package` automatically, so `check-types`, `lint`
and a production esbuild all run before anything uploads. Lint cannot fail the
build — every rule is `warn` — so read its output rather than trusting the exit
code.

Verification goes live within a few minutes. Then:

- Check the listing renders: page, icon, categories, README.
- Install from the Marketplace in a clean VS Code and confirm the first-run
  prompt appears with no server running.

### Alternatives

Manual upload — package locally, then drag the `.vsix` into the publisher page.
Useful when the PAT is the thing that is broken.

CI — skip `login` entirely by exporting `VSCE_PAT`, which `publish` reads by
default; `-p <token>` overrides it.

```bash
VSCE_PAT="$MARKETPLACE_TOKEN" npx @vscode/vsce publish
```

> **PATs are retired on 1 December 2026.** For automated publishing, use
> Microsoft Entra ID with workload identity federation instead of building on a
> PAT that will expire by policy.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Unauthorized` | PAT not scoped to **all** organizations, or missing Marketplace → Manage. Re-create it; you cannot edit the org scope afterwards. |
| `ERROR Failed request: (401)` right after `login` | PAT expired. They are time-limited by default. |
| `Missing publisher name` | `publisher` absent from `package.json`, or it does not match the created publisher. |
| Extension published but does nothing | Expected without a server — that is the design. Check the endpoint and the *Emberline* output channel. |
| `A 'repository' field is missing` | Regression in `package.json`; it is set today. |
| README images broken on the listing | Relative paths resolve via `repository`. Use absolute URLs. |

## Unpublishing

```bash
npx @vscode/vsce unpublish l0kifs.emberline
```

Removes the extension for everyone and **frees nothing** — the ID cannot be
reused. Prefer deprecating a version from the publisher page.
