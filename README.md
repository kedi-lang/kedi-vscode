# The Kedi Programming Language Support

Kedi is a lightweight DSL for orchestrating LLM workflows. This extension ships syntax awareness and authoring helpers for the language.

## Syntax Highlighting
- Procedures with typed parameters, optional return annotations, and colon terminators.
- Custom type declarations with nested field highlighting.
- Assignments, return lines, template text, and indentation-delimited blocks.
- Substitutions, nested calls, output placeholders, and `>>` template blocks with continuation rows.
- Inline Python expressions inside templates and arguments, plus escaped delimiter tokens.
- Multiline Python fences with dedicated scopes for embedded return/assignment blocks.
- String literals, unquoted template segments, and inline/block comments.
- Test definitions `@test: procedure` where `procedure` is highlighted like a function name, with case blocks `> case: name` where `>` is highlighted like `@`, `case` as a keyword, and `name` as a variable.
- Evaluation definitions `@eval: procedure` where `procedure` is highlighted like a function name, with metric blocks `> metric: name` where `>` is highlighted like `@`, `metric` as a keyword, and `name` as a variable.

## Authoring Semantics
- Distinguishes plain template lines from control lines so prompts, returns, and assignments render correctly.
- Recognizes typed outputs and variables so downstream code receives proper types (e.g., `list[str]`, `int`).
- Captures call argument grammar, including single-backtick native arguments and escaped commas.
- Supports nested procedure definitions, indentation-aware scopes, and block comment exclusion.

## Snippets
- Procedure scaffold with parameters, body placeholder, and return slot.
- Return statement shortcut.
- List type annotation stub.

Directive completions include a short description and preserve `>`. A colon
does not trigger suggestions. Backticks are entered explicitly, without an
automatically inserted partner or delimiter snippet.

## Configuration

On first activation in a trusted window, the extension prepares
`~/.kedi/editor-venv`, shared with the Kedi Zed extension. No existing Python
installation is required. A checksum-verified uv 0.11.21 downloads managed
Python 3.12 and installs `kedi==0.4.0`, `tree-sitter-kedi==0.4.1`,
`kedi-debugger==0.1.0`, and their
dependencies, including the language server. An absolute `KEDI_HOME` overrides
`~/.kedi`. Python downloads and package caches stay inside that directory.

Both editors use the same installation lock. A healthy environment is reused
without downloading packages; failed installations are retried on the next
activation or **Kedi: Restart Language Server**. Missing environments are
recreated. Unowned directories and symlinks are not overwritten. The managed
environment is for editor services, not your project's dependencies or CLI PATH.

Use **Kedi: Select Python Interpreter** to return to the managed environment,
follow **Python: Select Interpreter**, or enter a host executable. The default
does not automatically execute a workspace-local server. To use a host Python:

```json
{
  "kedi.lsp.usePythonExtension": false,
  "kedi.lsp.pythonPath": "/path/to/python"
}
```

Kedi must already be installed in a selected host environment; the extension
never installs into or modifies it. Following the Microsoft Python extension
is opt-in with `kedi.lsp.usePythonExtension: true`. Its environment-change
callback restarts Kedi automatically, resolving environment folders to their
actual Python executable. An explicit `pythonPath` takes priority.

For an advanced server override, with no `pythonPath` and
`usePythonExtension: false`, configure:

```json
{
  "kedi.lsp.serverCommand": "kedi-lsp"
}
```

Embedded Python completion, hover, go-to-definition, and references are enabled by default for fenced Python blocks and inline backtick Python regions:

```json
{
  "kedi.embeddedPython.enable": true
}
```

For Pylance compatibility, the extension writes generated Python shadow files under VS Code's extension storage directory, outside the current workspace. They are cache-like files and can be deleted; the extension regenerates them when needed.

Completions preserve snippets and additional edits. Auto-imports are inserted in
the module's Python prelude, creating one when necessary. Suggestions whose edits
cannot be safely projected to Kedi are omitted. At most 128 resolved suggestions
are offered at once; continue typing to narrow the list. Python/Pylance must be
enabled, and the selected Kedi server must support `kedi/pythonCompletions`.

## Debugging

The native Run and Debug UI registers DAP type `kedi`. Trust the workspace,
open a saved `.kedi` file, and press F5, or add this `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "kedi",
      "request": "launch",
      "name": "Kedi: Current File",
      "program": "${file}",
      "cwd": "${workspaceFolder}",
      "args": [],
      "env": {},
      "stopOnEntry": true
    }
  ]
}
```

Debugging uses the same **Kedi: Select Python Interpreter** selection as the
language server, including the shared `~/.kedi/editor-venv` default. That Python
runs `-m kedi_debugger --stdio` and owns the debuggee's project dependencies.
There is no second debug environment and no fallback interpreter. An opaque
`kedi.lsp.serverCommand` needs an explicit Python selection for debugging.

Managed mode installs `kedi-debugger` automatically alongside Kedi. Existing
managed environments are upgraded under the shared installation lock; subsequent
starts verify and reuse the complete installation without reinstalling it.

For an explicitly selected host Python, install the debugger yourself. Until
the matching releases are published, use the local source packages:

```sh
uv pip install --python /absolute/path/to/selected/python -e /path/to/kedi -e /path/to/kedi/debugger
```

For managed mode, use `~/.kedi/editor-venv/bin/python` (Windows:
`~/.kedi/editor-venv/Scripts/python.exe`), adjusted for `KEDI_HOME`. Install a
compatible local Kedi checkout and any project/provider dependencies there too,
or select your existing project environment. Preflight imports `kedi_debugger`
and the required `DebugEvent` / `observe_execution` symbols from `kedi.debugging`;
an importable module without those hooks is not sufficient. The extension never installs
packages into a host interpreter. A missing/incompatible package error names the selected interpreter
and gives the local editable-install command.
Host-Python language support remains usable without the debugger package.

`program` must resolve to an absolute saved `.kedi` file. An unsaved edit to that
file is saved before launch; a failed save, an edit that remains dirty, or a new
edit during debugger preparation cancels launch. `cwd` defaults to the launch
workspace folder, or the program directory when no folder is open.
`args` is a string array and `env` maps names to strings or `null` for the
debuggee. A `null` value removes an inherited environment variable; an empty
string sets it to empty. Optional `adapter` and `model` select Kedi runtime defaults. Entry stop
defaults to true; set `stopOnEntry: false` to run to a breakpoint.
Environment names must be nonempty and contain neither `=` nor NUL; paths,
arguments and environment values cannot contain NUL. Interpreter overrides
(`python`, `pythonPath`, `interpreter`, `pythonExecutable`) in launch arguments
are rejected. Configure Python through Kedi settings instead; malformed Python
settings report an error without falling back to or installing another runtime.

Use native line breakpoints, call stack, scopes/variables, step into/over/out,
continue, pause, and stop. Inspection and supported controls are supplied by the
backend's DAP capabilities; there is no custom inspector or expression engine.
Native exception-breakpoint filters include raised Kedi exceptions, model input
ready, and model result ready (`exceptions`, `model_input`, `model_result`).
Attach, variable mutation, arbitrary evaluation, conditional/function
breakpoints, reverse stepping, and Python-internal stepping are not supported.
Pause is cooperative: in-flight model/tool work and external deadlines can
continue. Save source changes and restart to debug the new version.

Keep credentials out of committed launch files. The extension does not record
DAP payloads or interpreter-probe output; prompt/results shown by the backend
can still contain sensitive application data. Native UI may clear variables
when a session terminates; this extension does not persist a post-run inspector.

The registration uses the official [VS Code debugger extension API](https://code.visualstudio.com/api/extension-guides/debugger-extension).
In a parent Kedi source checkout, `debugger/README.md` describes backend controls
and inspection boundaries; `debugger/src/kedi_debugger/server.py` is the
authoritative launch validation and environment-merge contract.

## Runtime Development and Release

`runtime/bootstrap.js` is the canonical shared installer. Run `npm run bundle`
and, from the parent Kedi checkout, `node scripts/sync_editor_runtime.mjs` to
update Zed's identical bundled copy. `npm test` checks installation recovery,
cross-process locking, and interpreter selection. `runtime/smoke.cjs` verifies
real installation, offline reuse, an LSP handshake, and a complete no-model
debugger session in an explicit test home. Supply the local Kedi, parser, and
debugger wheels as its optional package arguments when validating before release.

Debugger checks: `npm run compile`, `npm test`, and `npm run bundle`. The tests
cover launch validation, trust, save failures, interpreter changes, missing
packages, and the stdio descriptor without executing a model. For an editor
smoke test, launch `examples/debug.kedi` in an Extension Development Host, set a
breakpoint on `> show:`, inspect `message` and the procedure stack, step, continue,
and stop. This deterministic fixture needs no provider credentials.

**Release prerequisite:** verify `kedi==0.4.0`, `tree-sitter-kedi==0.4.1`, and
`kedi-debugger==0.1.0` are available from PyPI and that the Kedi wheel contains
the required debugger hooks before publishing the extension. Version metadata
alone is not sufficient. If that Kedi version was published without the hooks,
publish a new version and update the runtime pin first. The installer intentionally fails
clearly instead of silently using an incompatible older release. Local smoke
tests can pass current wheels as arguments.
