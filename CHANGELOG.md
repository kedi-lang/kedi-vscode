# Change Log

All notable changes to the Kedi VS Code extension are documented here.

## [3.3.0] - Unreleased

### Added

- Debug Kedi programs from the editor through the integrated Kedi debugger;
  the managed runtime installs `kedi-debugger`.
- Highlight capability, workflow and conditional profile members, and
  highlight Kedi files without a running language server.
- Show CodeMode preload diagnostics from the language server.

### Changed

- The managed runtime installs `kedi==0.1.4`, `tree-sitter-kedi==0.4.6` and
  `kedi-debugger==0.1.0`, and reinstalls when these pins change.
- Harden the managed editor runtime and align it with directive value
  contracts.
- Bundle the current Kedi language specification, including typed raw invoke
  captures, workflow blocks, task groups and native tasks.

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
