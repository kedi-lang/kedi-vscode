# The Kedi Programming Language Support

Kedi is a lightweight DSL for orchestrating LLM workflows. This extension ships syntax awareness and authoring helpers for the language.

## Syntax Highlighting
- Procedures with typed parameters, optional return annotations, and colon terminators.
- Custom type declarations with nested field highlighting.
- Assignments, return lines, template text, and indentation-delimited blocks.
- Substitutions, nested calls, output placeholders, and template continuations with trailing backslashes.
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

The extension starts `kedi-lsp` with the Python interpreter selected by the Microsoft Python extension when possible. Override the server path only when the active interpreter cannot import `kedi`:

```json
{
  "kedi.lsp.usePythonExtension": false,
  "kedi.lsp.pythonPath": "/path/to/python"
}
```

For final fallback without an interpreter path, configure the command used on `PATH`:

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
