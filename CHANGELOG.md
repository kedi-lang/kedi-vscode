# Change Log

All notable changes to the Kedi VS Code extension are documented here.

## [3.1.0] - 2026-09-20

### Added

- Provision a shared, managed Python 3.12 environment under
  `~/.kedi/editor-venv` on first activation.
- Add **Kedi: Select Python Interpreter** for switching between the managed
  runtime, the Microsoft Python extension's interpreter, and an explicit host
  Python executable.

### Changed

- Share installation locking and runtime validation with the Kedi Zed
  extension.
- Make the managed runtime the default and keep selected host environments
  read-only.
- Restart the language server when an opted-in Python interpreter changes.

## [2.1.0] - 2026-05-14

### Changed

- Package the VS Code extension without local Zed/tree-sitter build artifacts.
- Keep embedded Python feature documentation aligned with the implemented hover, go-to-definition, and references forwarding.
- Refresh README configuration guidance for the LSP-backed 2.x extension.
