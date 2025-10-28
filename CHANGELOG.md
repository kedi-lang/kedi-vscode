# Change Log

All notable changes to the "kedi-language" extension will be documented in this file.

## [1.0.0] - 2025-01-XX

### Added
- Initial release
- Syntax highlighting for all Kedi DSL constructs
- Support for procedure definitions with type annotations
- Template line highlighting with substitutions and outputs
- Inline Python expression highlighting
- Python code block support with full Python syntax
- Assignment statement support with type annotations
- Return statement highlighting
- Bracket matching and auto-closing
- Comment support with `#`
- Code folding for procedures and blocks
- Smart indentation
- Comprehensive code snippets library:
  - Procedure definitions (typed and untyped)
  - Template lines with outputs
  - Variable substitutions and calls
  - Inline Python and Python blocks
  - Assignment and return statements
  - Type annotations
- Example files

### Features
- `.kedi` file extension recognition
- Auto-completion for common patterns
- Bracket pair colorization support
- Escaped character recognition (`<<`, `>>`, `[[`, `]]`, `==`, `@@`, `,,`)

### Language Support
- Parameter type annotations: `param: type`
- Return type annotations: `-> type`
- Output type annotations: `[name: type]`
- Assignment type annotations: `[name: type] = expr`
- List types: `list[T]`
- Native Python types: `str`, `int`, `float`, `bool`

## [Unreleased]

### Planned
- Language server for advanced features
- IntelliSense and auto-completion
- Error diagnostics
- Go to definition
- Find references
- Rename refactoring
- Code formatting
- Debugger integration