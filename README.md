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
- Inline Python expression template.
- Triple-backtick Python block for indentation-sensitive code.
- Return statement shortcut.
- Return-with-Python-block helper for native values.
- List type annotation stub.

## Configuration

On first activation in a trusted window, the extension prepares
`~/.kedi/editor-venv`, shared with the Kedi Zed extension. No existing Python
installation is required. A checksum-verified uv 0.11.21 downloads managed
Python 3.12 and installs `kedi==0.4.0`, `tree-sitter-kedi==0.4.0`, and their
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

Embedded Python hover, go-to-definition, and references are enabled by default for fenced Python blocks and inline backtick Python regions:

```json
{
  "kedi.embeddedPython.enable": true
}
```

For Pylance compatibility, the extension writes generated Python shadow files under VS Code's extension storage directory, outside the current workspace. They are cache-like files and can be deleted; the extension regenerates them when needed.

## Runtime Development and Release

`runtime/bootstrap.js` is the canonical shared installer. Run `npm run bundle`
and, from the parent Kedi checkout, `node scripts/sync_editor_runtime.mjs` to
update Zed's identical bundled copy. `npm test` checks installation recovery,
cross-process locking, and interpreter selection. `runtime/smoke.cjs` verifies
real installation, offline reuse, and an LSP handshake in an explicit test home.

**Release prerequisite:** verify both pinned 0.4.0 Python packages are available
from PyPI before publishing the extension. The installer intentionally fails
clearly instead of silently using an incompatible older release. Local smoke
tests can pass current wheels as arguments.
