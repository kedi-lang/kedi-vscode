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

### Bracket Colorization

By default, VS Code's bracket pair colorizer is **disabled for Kedi files** to ensure escape sequences like `\[` and `\]` highlight correctly as escape characters rather than as brackets. The extension provides a setting to enable bracket colorization for Kedi files if desired:

1. Open VS Code Settings (Ctrl/Cmd + ,)
2. Search for "Kedi"
3. Check "Kedi: Bracket Colorization" to enable it

Alternatively, add this to your VS Code settings.json:
```json
{
  "kedi.bracketColorization": true
}
```

**How it works**: When this setting is disabled (default), the extension automatically disables VS Code's global bracket colorizer when you're viewing Kedi files, ensuring escape sequences highlight correctly. When you switch to other file types, the original bracket colorizer setting is restored.
