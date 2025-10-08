# Marker Language Support for Visual Studio Code

Provides syntax highlighting, snippets, and language support for the Marker DSL - a lightweight domain-specific language for orchestrating LLM interactions.

## Features

### Syntax Highlighting
- **Procedure definitions** with parameter and return type annotations
- **Template lines** with variable substitutions and LLM outputs
- **Inline Python expressions** within `<` backticks `>`
- **Python code blocks** with full Python syntax highlighting
- **Variable assignments** with type annotations
- **Return statements**
- **Escaped special characters**

### Language Features
- **Auto-closing pairs** for brackets, parentheses, and quotes
- **Bracket matching** for all delimiter types
- **Comment support** with `#`
- **Code folding** for procedures and Python blocks
- **Smart indentation** based on procedure definitions

### Code Snippets
Pre-built snippets for common patterns:
- `proc` - Basic procedure definition
- `proctyped` - Typed procedure definition
- `out` - Template with output
- `outtype` - Typed output
- `sub` - Variable substitution
- `call` - Procedure call
- `pyinline` - Inline Python expression
- `pyblock` - Python code block
- `assign` - Assignment statement
- `assigntype` - Typed assignment
- `ret` - Return statement
- And more...

## Quick Start

1. Install the extension
2. Create a file with `.marker` extension
3. Start writing Marker code with full syntax highlighting

## Example

```marker
@get_country(city):
  <city> is located in [country: str].
  = <country>

@get_language(country):
  The primary language in <country> is [language: str].
  = <language>

@translate_greeting(language):
  'Hello' in <language> is [greeting: str]
  = <greeting>

# Nested procedure calls
= <translate_greeting(<get_language(<get_country(Paris)>)>)>
```

## Syntax Overview

### Procedures
```marker
@procedure_name(param1, param2: type):
  # procedure body
  = result
```

### Template Lines with Outputs
```marker
Generate [output_name: type] from <input_variable>
```

### Variable Substitution
```marker
<variable_name>
<procedure_call(arg1, arg2)>
```

### Inline Python
```marker
<`python_expression`>
```

### Python Blocks
```marker
```
python_code()
```
```

### Assignments
```marker
[variable: type] = expression
```

### Return Statements
```marker
= expression
```

## Language Specification

For complete language specification, visit the [Marker DSL Documentation](https://github.com/your-repo/marker-pattern).

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for version history.

## Contributing

Contributions are welcome! Please submit issues and pull requests on [GitHub](https://github.com/your-repo/marker-vscode).

## License

MIT License - See LICENSE file for details.

---