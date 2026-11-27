# Contributing

Read `docs/KEDI_DSL.md` before changing language support. It is a mirror of
the Kedi repository's DSL reference and must stay identical to it.

## Checks

```sh
npm ci
npm run compile
npm test
npm run bundle
```

`npm test` covers the TextMate grammar (through VS Code's grammar engine), the
language-server client, launch validation, trust, save failures, interpreter
changes, missing packages, installation recovery, cross-process locking and
interpreter selection. None of it calls a model.

## Editor Integration Test

To exercise a real extension host, point `kedi.lsp.pythonPath` in a trusted,
isolated test workspace at a Python environment with the current Kedi sources
installed. Then run from this directory:

```sh
npm run bundle
code --new-window --user-data-dir /tmp/kedi-editor-test \
  --extensions-dir /tmp/kedi-editor-test-extensions \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/tests/editor/index.cjs" /path/to/test-workspace
```

The test checks semantic tokens, profile output, captures, hover, outline,
completion, language-server restart, debugger stepping, variables, clean exit,
relaunch with changed source and `.env` values, the `@test:` code lens, a test
run's exit status and Debug Kedi File, without making model calls. Set
`debug.saveBeforeStart` to `none` in the test profile to avoid save prompts for
the untitled language-server fixtures. To verify a packaged VSIX, use its
installed directory as `extensionDevelopmentPath`.

For a manual debugger check, launch `examples/debug.kedi` in an Extension
Development Host, set a breakpoint on `> show:`, inspect `message` and the
procedure stack, step, continue and stop. It needs no provider credentials.

## Managed Runtime

`runtime/bootstrap.js` is the installer shared with the Kedi Zed extension.
After changing it, run `npm run bundle` and, from the parent Kedi checkout,
`node scripts/sync_editor_runtime.mjs` to update Zed's identical bundled copy.

`runtime/smoke.cjs` checks a real installation, offline reuse, a language
server handshake and a complete debugger session without a model, in an
explicit test home:

```sh
node runtime/smoke.cjs /absolute/test-home [kedi.whl tree-sitter-kedi.whl kedi-debugger.whl]
```

The wheel arguments validate unreleased packages before they are published. The
smoke test does not publish anything or touch the default editor environment.

## Releasing

1. The runtime pins (`kedi`, `tree-sitter-kedi`, `kedi-debugger` in
   `runtime/bootstrap.js`) must be published on PyPI, and the Kedi wheel must
   contain the debugger hooks (`kedi.debugging.DebugEvent`,
   `observe_execution`). Version metadata alone is not enough. The installer
   fails clearly instead of falling back to an older release.
2. Update `CHANGELOG.md` and the version in `package.json`.
3. `npx vsce package`, then install the VSIX and run the editor integration
   test against its installed directory.
4. Publish the same VSIX to the Visual Studio Marketplace (`npx vsce publish
   --packagePath <vsix>`) and Open VSX (`npx ovsx publish <vsix>`).
