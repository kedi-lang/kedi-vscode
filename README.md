# Kedi for Visual Studio Code

Language support for [Kedi](https://kedi-lang.org), a typed orchestration
language for LLM programs: write, run, test and debug `.kedi` files.

```kedi
@get_language(country: str) -> str:
  >> The primary language spoken in <country> is [language: str].
  = <language>

[language: str] = <get_language(Turkey)>
> show: <language>
```

## Features

- **Highlighting.** A bundled TextMate grammar colors Kedi as soon as a file
  opens. Tree-sitter semantic tokens from the language server then refine
  names, types and Python regions.
- **Language server.** Diagnostics, completion, hover, go to definition,
  references, rename, outline, signature help, inlay hints and formatting.
- **Embedded Python.** Completion, hover, go to definition and references from
  Pylance inside fenced Python blocks and inline backtick expressions.
  Auto-imports go into the module's Python prelude.
- **Kedi in Python.** Diagnostics, hover, navigation and highlighting inside
  Python function docstrings whose first line is `kedi`.
- **Run, test and evaluate.** Run the current file, its `@test:` blocks or its
  `@eval:` blocks from the editor title, a code lens or the Command Palette.
- **Debugging.** Breakpoints, stepping, call stack and variables for Kedi
  programs, through the Kedi debugger.
- **Snippets** for procedures, return lines and list types.

## Getting Started

1. Install the extension and open a `.kedi` file in a trusted workspace.
2. The first time the extension starts in a trusted window, it prepares a
   Python environment for its language server and debugger under
   `~/.kedi/editor-venv`. It downloads uv and Python 3.12, then installs
   `kedi==0.1.7`, `tree-sitter-kedi==0.4.11` and `kedi-debugger==0.1.2`. No
   existing Python installation is needed. This needs internet access once;
   later starts reuse the environment.
3. Set the API key of your model provider, for example in a `.env` file, and
   run the file with **Run Kedi File**.

The managed environment is shared with the Kedi Zed extension. An absolute
`KEDI_HOME` relocates it. It serves the editor only: it is not your project's
environment and is not added to your `PATH`. Microsoft's Python extension is not
required, except for the embedded Python features.

## Choosing a Python

The managed environment pins the published Kedi release. To use a development
version of Kedi, or your project's dependencies, run **Kedi: Select Python
Interpreter** and choose one of:

- the managed environment (the default);
- the interpreter selected in Microsoft's Python extension;
- a Python executable you enter.

Kedi must already be installed in a Python you select. The extension never
installs packages into it. The same settings, in `settings.json`:

```json
{
  "kedi.lsp.pythonPath": "/path/to/python",
  "kedi.lsp.usePythonExtension": false
}
```

An explicit `kedi.lsp.pythonPath` takes priority over the Python extension's
selection. Changing either restarts the language server.

## Running

| Command | Runs |
| --- | --- |
| **Kedi: Run Kedi File** | `kedi <file>` |
| **Kedi: Run Tests in File** | `kedi <file> --test` |
| **Kedi: Run Evals in File** | `kedi <file> --eval` |
| **Kedi: Debug Kedi File** | the Kedi debugger, without stopping on entry |

Runs use the language server's Python and start in the workspace folder. They
save the file first and need a trusted workspace. A new run replaces the
previous run's terminal. `--test` and `--eval` run every block in the file.

## Debugging

Open a saved `.kedi` file in a trusted workspace and press F5, or add a
`.vscode/launch.json`:

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

- `program` is an absolute path to a saved `.kedi` file. Unsaved edits are
  saved before launch.
- `cwd` defaults to the workspace folder, or the program's directory.
- `env` maps names to strings; `null` removes an inherited variable.
- `adapter` and `model` optionally override the program's defaults.
- `stopOnEntry` defaults to `true`.

Line breakpoints, the call stack, variables, step into/over/out, continue,
pause and stop are supported. Exception breakpoints can stop on raised Kedi
exceptions, when a model input is ready and when a model result is ready.
Attach, editing variables, arbitrary evaluation, conditional and function
breakpoints are not supported. Pause is cooperative: model and tool calls
already in flight finish first.

The debugger runs in the same Python as the language server. The managed
environment includes it. For a Python you selected, install it yourself:
`pip install kedi-debugger`. Keep credentials out of committed launch files.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kedi.lsp.pythonPath` | `""` | Python executable to run Kedi with, instead of the managed environment. |
| `kedi.lsp.usePythonExtension` | `false` | Follow the Microsoft Python extension's selected interpreter. |
| `kedi.lsp.serverCommand` | `""` | Advanced: a custom language-server command, used when no Python is selected. |
| `kedi.lsp.trace.server` | `off` | Trace the language-server traffic in the **Kedi Language Server** output. |
| `kedi.embeddedPython.enable` | `true` | Python features inside Kedi Python regions. Needs Pylance. |
| `kedi.embeddedKediInPython.enable` | `true` | Kedi features inside `kedi` docstrings in Python files. |
| `kedi.embeddedKediInPython.experimentalSemanticTokens` | `true` | Kedi highlighting inside those docstrings. |
| `kedi.codemode.preloadWarningThreshold` | `5` | Warn when a CodeMode `preload_tools` list has more tools than this. |

For embedded Python, the extension writes generated Python files to its own
storage directory, outside your workspace. They are a cache; it regenerates
them when needed.

## Troubleshooting

- **No diagnostics or completion.** Open the **Kedi Language Server** output.
  A failed setup is retried on the next start, or with **Kedi: Restart
  Language Server**.
- **Wrong Kedi version.** Use **Kedi: Select Python Interpreter** to point the
  extension at the Python where your Kedi is installed.

## Links

- [Documentation](https://docs.kedi-lang.org/tooling/vscode/)
- [Kedi on GitHub](https://github.com/kedi-lang/kedi)
- [Report an issue](https://github.com/kedi-lang/kedi-vscode/issues)
- [Contributing](CONTRIBUTING.md)
