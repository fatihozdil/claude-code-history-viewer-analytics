# Contributing

VS Code extension that browses, searches, inspects, and resumes Claude Code conversations.
This file is for people building, testing, or contributing to the extension. The
user-facing description lives in [`README.md`](README.md) — that's the file `vsce`
packages by default (and what the Marketplace listing is built from).

For end-user docs, see `docs/`: `INSTALLATION.md`, `USAGE.md`, `PRIVACY.md`.
Product requirements live in [`SPEC.md`](SPEC.md).

## License

The project is MIT licensed — see [`LICENSE`](LICENSE). By contributing you agree
your contributions are licensed under the same terms. There is no CLA.

## Stack

- TypeScript, esbuild for bundling
- Webview UI built with Preact, rendered via `media/browser.js` (bundled from `src/webview/ui`)
- `sql.js` (SQLite/WASM) for the local search index
- `markdown-it` + `highlight.js` for conversation rendering
- Node's built-in test runner (`node --test`) against compiled output in `out-test/`

## Project layout

```
src/
  extension.ts        activation, command registration
  discovery/           finds and scans ~/.claude/projects/ for sessions
  storage/              sqlite schema + queries for the search index
  data/                 session/message parsing and normalization
  search/               full-text search indexing and querying
  watch/                file watcher for live session updates
  services/             quota/cost calculation, analytics aggregation
  views/                tree views (e.g. file changes)
  webview/              browser sidebar, conversation panel, analytics panel + UI
  types/                shared types
test/                   mirrors src/, compiled by tsconfig.test.json before running
docs/                   end-user documentation bundled into the package
```

## Development

```bash
npm install
npm run watch       # esbuild in watch mode
```

Press `F5` in VS Code (or use the Run Extension launch config) to open an Extension
Development Host with the extension loaded.

## Testing

```bash
npm test            # compiles test/ then runs node --test against out-test/
npm run typecheck   # tsc --noEmit
```

## Packaging

```bash
npm run package
```

This runs `vsce package --allow-missing-repository`, which uses the root `README.md`
(the user-facing copy) by default — `vsce` does not rename whatever you pass via
`--readme-path`, it only relies on the literal filename `README.md`, and that's also
the only file VS Code's local "Install from VSIX" Details tab will read. So don't
reintroduce a `--readme-path` flag; just edit `README.md` directly.

## Testing a real build locally

`npm run watch` + `F5` gives you an Extension Development Host, which is the fast
loop for day-to-day work. But the dev host is not the same as an installed
extension — it runs unbundled from `src/`, so it will not catch packaging
mistakes (a file excluded by `.vscodeignore`, a missing runtime dependency, an
asset path that only resolves in the repo). To test the artifact users actually
install:

```bash
./scripts/install-extension.sh
```

It runs `npm install`, packages a `.vsix` with `vsce`, picks the newest `.vsix`
in the repo root, and installs it into your real VS Code with
`code --install-extension --force`. Reload the window afterwards to pick it up.

Notes:

- It needs the `code` CLI on your `PATH` (VS Code: *Shell Command: Install 'code'
  command in PATH*).
- `--force` overwrites whatever version you have installed, including a copy
  installed from the Marketplace. To get back to the released build, uninstall
  and reinstall from the Marketplace, or run
  `code --uninstall-extension Fatih-Ozdil.claude-code-history-search-analytics`.
- It does not bump the version or touch git, so the installed build may report
  the same version as the published one. Check the behaviour, not the version
  number.
- The generated `.vsix` files are gitignored; delete the stale ones occasionally
  since the script always installs the most recent by mtime.

Run this before opening a pull request — a packaging bug is invisible in the dev
host and only shows up once it is in someone's editor.

## Submitting a pull request

1. Fork the repo and branch off `main`.
2. Make your change, with tests where the behaviour is testable.
3. Make sure `npm run typecheck` and `npm test` pass, and ideally that
   `./scripts/install-extension.sh` gives you a working build.
4. Open a pull request describing what changed and why.

CI runs typecheck, the test suite, and a packaging build on every pull request.

Releases are cut by the maintainer, so please do not bump the version in
`package.json` or add entries under a new version heading in `CHANGELOG.md` —
put user-visible changes under `## [Unreleased]` and they will be folded into
the next release.

