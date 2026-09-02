# Kedi DSL Language Specification

## Overview

Kedi is a lightweight domain-specific language (DSL) designed to orchestrate LLM interactions through a clean, Python-integrated syntax. It uses indentation-based scoping, supports typed values, and compiles to a runtime that executes prompts and threads values across computational steps.

## Anatomy of a Kedi Template

A Kedi template combines literal text with input substitutions and output placeholders.
At procedure and top level, templates are opened with `>>` (see **Template Blocks** below).

```kedi
>> The capital of <country> is [capital].
```

Components:
- **Literal text**: `The capital of` and `is` - passed as-is to the LLM
- **Input substitution**: `<country>` - replaced with the value of variable `country`
- **Output placeholder**: `[capital]` - the LLM fills this value

If `country` contains "France", the prompt becomes:
```
The capital of France is [capital].
```

### CLI Arguments

Command-line flags are available through the runtime-owned `args` binding (for example,
`args.name`). `args` is reserved and cannot be assigned by Kedi or embedded Python. Embedders can
configure a different reserved name with `kedi.lang.compiler.environment.CLI_ARGS_IDENTIFIER`
before compiling a program.

After execution, `[capital]` is filled by the LLM (e.g., "Paris") and the variable `capital` becomes available in scope:
```kedi
>> The capital of <country> is [capital].
= <capital> is a beautiful city.
```

Multiple inputs and outputs can appear on the same line:
```kedi
>> <person1> and <person2> live in [city] and work at [company].
# After execution, both 'city' and 'company' are available as variables
```

## Core Concepts

### Program Structure

A Kedi program consists of:
- **Imports and exports**: Explicit module boundaries for sharing procedures, types, and values across `.kedi` files
- **Template blocks** (`>>`): LLM prompts with embedded substitutions and outputs
- **Procedures**: Reusable named blocks of code
- **Variables**: Explicit initialization and assignment
- **Returns**: Values returned from procedures or top-level
- **Python blocks**: Embedded Python code for computation
- **Comments**: Inline and block comments for documentation

### Indentation and Scoping

- Indentation defines block scope (like Python)
- Tabs count as width 4 for comparison
- The preprocessor inserts virtual BEGIN/END tokens on indentation changes
- A directive block has one body shape: configuration directives contain
  unprefixed `name: value` subsettings, while composite directives such as
  `> profile:` contain `>`-prefixed subdirectives. The two forms are not mixed
  in one body.

## Basic Syntax Elements

### Comments

```kedi
# This is an inline comment
Use \# to escape a literal # character

###
This is a block comment.
It can span multiple lines.
###
```

- Inline: Everything after `#` is ignored; use `##` for literal `#`
- Block: Lines containing only `###` (trimmed) start/end blocks; must appear in matching pairs
- Procedure docstrings: if the first statement inside a procedure body is a block comment, its body becomes the procedure's Python `__doc__` and is surfaced in editor hovers / virtual stubs

### Module Imports and Exports

Kedi modules can explicitly export top-level procedures, types, and values. Another `.kedi` file imports the module by file name without the `.kedi` suffix:

```kedi
> import: profiles

= <get_profile(`"Ada"`)> has id <`profile_id`>
```

In `profiles.kedi`:

```kedi
~Profile(name: str, id: int)

@get_profile(name: str) -> Profile:
  = `Profile(name=name, id=1)`

[profile_id: int] = `1`

> export:
  Profile
  get_profile
  profile_id
```

Imports resolve relative to the importing file. If no sibling module exists, Kedi falls back to bundled internal modules such as `> import: this`, then packages installed in the local Kedi registry. Only names listed under `> export:` are visible to importers; non-exported procedures, types, and top-level values stay private to the module.

Use `/` to import a module from a nested directory:

```kedi
> import: services/profiles
```

To import only part of a module's exported surface, list the required names in an indented body:

```kedi
> import: services/profiles:
  Profile
  get_profile
```

Selective imports do not create a namespace object; the selected names enter the current environment directly. Imports and top-level declarations share source-order write semantics, so the last declaration or import that provides a name wins. A module is initialized at most once per root program compilation; its already-loaded exported bindings are then published at each import directive's source position. Imports inside nested modules remain relative to the file containing that import.

Each name in one selective-import list must be unique. Repeating a name is a parse error rather
than an ambiguous duplicate binding.

To export every public name in a module, use `> export: *`:

```kedi
@get_name() -> str:
  = Ada

[xd: int] = `1`

> export: *
```

Public names are names that do not start with `_`. If a module has no export directive, importing it does not expose any names.

### Packages

`source` is relative to `package.kedi` and must contain `main.kedi`. From the package root, run `kedi install` (or `kedi install path/to/package.kedi`) to copy the manifest and that source tree into `$HOME/.kedi/registry/<package-name>`. Imports resolve the package root to `main.kedi`, so `> import: kedi_http` loads `src/kedi_http/main.kedi`; `> import: kedi_http/client` loads `src/kedi_http/client.kedi`.

The `python` field accepts only a fixed version (`python@3.11`) or an inclusive closed range (`python@3.11-3.14`). `python_dependencies` records PEP 508 dependency strings for package tooling; `kedi install` does not install them into the active Python environment.

`kedi add <package-name>` uses the future `registry.kedi-lang.org/v1/package/<package-name>` registry contract. Until that service exists, set `KEDI_REGISTRY_MOCK_ROOT` to a directory containing package source directories and the same install path is used. Package installation writes a Kedi-owned `.kedi-install.json` receipt with the source kind, source path, manifest digest, and, for Git installs, the normalized URL and checked-out commit.

To install an explicit GitHub source locally without involving the registry, pass a `git+https` URL:

```sh
kedi add git+https://github.com/user/project.git
```

Kedi performs a shallow, no-checkout clone with Git's blob filter, reads `package.kedi` at the repository root, then sparse-checks out only the declared source tree before installing it and printing the checked-out commit. The Git source must be credential-free and hosted on `github.com`; package sources are limited to regular files/directories, a bounded source-tree size, and literal directory paths rather than Git sparse-checkout patterns. This is intentionally separate from package-registry resolution: when the public registry is available, its response will identify the registry-verified commit for each package rather than treating every Git release as a package release.

`KEDI_HOME`, when set, must be an absolute path. Kedi rejects a relative override so a program cannot switch registries merely because it changes its working directory.

> [!WARNING]
> Kedi packages are executable code. Importing a third-party package can execute its embedded Python with the importing process's permissions. A future registry's verified commit proves package identity and integrity; it does not sandbox that package or audit its capabilities.

### Template Blocks (`>>`)

Template prompts are opened with `>>`. Continuation lines at the same indent
belong to the same block and are **newline-joined into one LLM run**. Outputs
from the block become available only after that single LLM run finishes. A
continuation row cannot read a field produced earlier in the same block with
`<name>`; start a new `>>` block if the next prompt needs that value.

```kedi
>> What's the [capital] of Turkey?
>> What's the [population: int] of <capital>?
```

Inside procedures, multiple blocks are separated by blank lines or a new `>>`:

```kedi
@do_something():
  >> Foo bar [baz]
  Baz foo [bar]
  Bar baz [foo]

  >> Bar baz [foooo]
  = <foooo>
```

Bare template lines (without `>>`) are a **parse error** at procedure and top level.
They remain valid only inside `> optimize:` / `> auto:` bodies.

### Raw Model Invokes (`<<`)

When a `>>` prompt has no output fields, Kedi sends the rendered prompt to the active
adapter as a raw model invoke and discards the model response:

```kedi
>> Summarize the project status in one sentence.
```

To keep the raw model response, put an untyped capture target in front of `<<`:

```kedi
[answer] << Summarize <topic> in one sentence.
= <answer>
```

Raw invoke captures always produce strings. `[answer: str] << ...` is accepted but
redundant, while any other capture type is an error. Raw invoke prompts cannot contain
output fields such as `[capital]`; use `>>` when you want structured field filling.

### Substitutions (R-values)

Substitutions read values and insert them into templates using `<...>`:

```kedi
# Variable substitution
>> The city is <city>

# Procedure call
>> The country is <get_country(Paris)>

# Nested calls
>> Result: <outer(<inner(x)>)>

# Inline Python expression (note the backticks)
>> Sum is <`2 + 3`>

# Bare inline Python segments are also valid in templates
>> Review this code `"def add(a: int, b: int) -> int: return a + b"`.
```

Inside a template, both `<`...`>` and bare `` `...` `` evaluate Python and insert
its string value. Bare backticks are useful when the expression contains characters
such as `>` or `[]` that would otherwise need escaping in literal template text.

### Outputs (L-values)

Outputs are placeholders filled by the LLM using `[...]`:

```kedi
# Simple output
>> The capital of France is [capital].

# Typed output
>> Top cities: [cities: list[str]]

# Typed output with inline Python type annotation
>> Top cities: [cities: `list[str]`]

# Typed output with field description metadata
>> Capital of Turkey is [capital: Annotated[str, "Canonical city name"]].

# Multiple outputs on one line
>> [first_name] [last_name] lives in [city: str]
```

Output names must be valid identifiers: `^[A-Za-z_][A-Za-z0-9_]*$`

Backtick-wrapped type expressions in outputs are evaluated at runtime, giving you access to dynamic types from the prelude or computed values.

`Annotated[type, "description"]` has Kedi-specific meaning: it keeps `type` as the
runtime type and attaches the string as schema/LLM field description metadata without
using inline Python. The description must be a single-line string literal inside the
`Annotated[...]` arguments; standalone string literals are not valid type annotations.
Adapters that expose JSON schema, such as Pydantic AI and LangChain, pass this metadata
as the field description. `Annotated[type]` still resolves as `type`, but the LSP warns
because no description metadata was provided; extra `Annotated[...]` metadata is ignored.

```kedi
>> Extract the customer as [name: Annotated[str, "Full customer name"]].
```

Use backticks only when the type itself must come from runtime Python state:

```kedi
>> Extract [value: `output_type`].
```

### Variable Initialization and Assignment

Use `=` to initialize a variable in the current lexical scope:

```kedi
# Simple initialization
[prev] = <current>

# Typed initialization
[count: int] = `5`

# Typed initialization with inline Python type annotation
[count: `int`] = `5`

# String initialization from an expression
[message] = Hello <name>

# Initialization from a Python block
[total: int] = ```
return sum([1, 2, 3])
```
```

`=` declares a value in the current lexical scope. If a containing scope
already owns the same name, the new declaration shadows it; it does not update
the outer binding. Branch and loop-iteration declarations disappear when their
scope finishes.

Use `:=` to assign a new value to the nearest visible Kedi binding:

```kedi
[count: int] = `0`

> if: `True`:
  [count] := `count + 1`

= `count`
```

`:=` does not declare names and does not accept a new type annotation. The
target must already exist, and the value is validated against the target's
original type contract. A fenced Python result is also supported:

```kedi
[total: int] = `0`
[total] := ```
return sum([1, 2, 3])
```
```

#### Inline Python Type Annotations

You can use backtick-wrapped Python expressions in type annotations:

```kedi
# Basic types
[x: `int`] = `42`
[y: `str`] = `"hello"`
[z: `float`] = `3.14`

# Complex types
[numbers: `list[int]`] = `[1, 2, 3, 4, 5]`
[words: `list[str]`] = `["apple", "banana", "cherry"]`

# Custom types from DSL definitions
~Person(name, age: int)
[person: `Person`] = `Person(name="Alice", age=30)`

# Mix regular and backtick annotations interchangeably
[x: int] = `10`
[y: `int`] = `20`
= <`str(x + y)`>  # Works the same
```

Backtick type annotations are evaluated at runtime with full access to prelude, globals, and local scope. They work identically to regular type annotations.

## Native Control Flow

Kedi provides deterministic and model-classified conditionals, conditional
loops, and sequential iterable loops. A trailing `:` after an inline Python
header selects deterministic evaluation. A condition without that trailing
colon is a Kedi template claim evaluated by the active agent adapter.

### Conditional branches

```kedi
[score: int] = `72`
[result] = pending

> if: `score >= 60`:
  [result] := passed
> else:
  [result] := failed

= <result>
```

The condition is evaluated exactly once and must return an exact Python
`bool`. Kedi does not apply truthiness to integers, strings, containers, or
other objects. The closing `:` after the embedded Python expression is required.
Only the selected body executes. Each selected branch receives a child value
scope: Kedi initializations remain branch-local, while embedded Python may
update a binding that already exists in a containing scope. Python-only names
never become Kedi bindings. `> else:` is optional. There is no
`elif`; use a nested `> if:` when another condition is required.

Directives selected inside a branch apply only within that branch. Existing
Kedi return behavior remains unchanged: a return in a selected body contributes
to the scope's last return value; it does not introduce Python-style early
return.

### Template conditions

```kedi
[city] = Ankara
[minimum_population: int] = `5_000_000`
[result] = unknown

> if: <city> has more than `minimum_population` residents
  [result] := major city
> else:
  [result] := smaller city

= <result>
```

A template condition has no trailing `:` after its claim. Plain text,
`<name>` substitutions, procedure calls, and inline Python values are rendered
with the same native Kedi semantics used by other templates. Output fields such
as `[answer]` are invalid because a condition does not produce a user-visible
binding.

Kedi evaluates the rendered claim using the current agent profile and its
available context. A claim that cannot be established is treated as `false`.
The evaluation does not create a Kedi binding.

The trailing colon is the unambiguous boundary between both forms:

```kedi
> if: `is_ready`:
  # Deterministic: evaluate is_ready as an exact Python bool.
  [mode] = deterministic

> if: `is_ready`
  # Model-classified: render the Python value into the claim.
  [mode] = classified
```

### Conditional loops

```kedi
[remaining: int] = `3`

> loop: `remaining > 0`:
  `remaining -= 1`

= `remaining`
```

The deterministic condition is re-evaluated before every iteration and must
return an exact `bool`. A false first result runs zero iterations. Every body
execution receives a fresh child value scope. State needed by the next
condition must update an existing outer binding through Python write-back or
`:=`; a body-local Kedi initialization is discarded after that iteration.

Template claims use the same no-trailing-colon form and are re-rendered and
classified before every iteration:

```kedi
> loop: <work> remains unfinished
  >> Continue the unfinished work.
```

Conditional loops allow 10,000 body iterations by default. If the condition is
still true after exactly that many completed iterations, Kedi raises
`LoopIterationLimitError` before starting another body. Each nested or dynamic
loop owns an independent counter. Python callers can set the positive
`loop_iteration_limit` through `compile_program()`, `configure()`, `context()`,
or `interactive()`.

### Sequential loops

```kedi
[items: list[int]] = `[1, 2, 3, 4, 5]`
[total: int] = `0`

> loop [n]: `items`:
  `total += n`

= `total`
```

The header expression is evaluated exactly once and must return an `Iterable`.
Iterations run sequentially in source order. Kedi does not materialize the
iterable or introduce implicit parallelism, so lists, tuples, dictionaries,
strings, generators, ranges, and custom iterables preserve their native
iteration behavior. If the iterator exposes `close()`, Kedi calls it when
traversal finishes or exits early because the loop body failed.

The binder receives each yielded value without coercion. Every iteration owns
a fresh child scope containing its binder and body-local Kedi declarations.
That scope is discarded after the iteration unless an attached map stage still
needs it. Outer values change only through `:=` or owner-aware Python
write-back; mutating an outer object, such as appending to a list, naturally
updates that object.

### Map continuations

An iterable loop may be followed immediately by one sibling `> map:` clause:

```kedi
[selected: list[str]] = `[]`

> loop [candidate]: `candidates`:
  >> Determine whether <candidate> qualifies as [qualified: bool] and extract [email].
> map:
  > if: `qualified`:
    `selected.append(email)`

= `selected`
```

`map` is a continuation stage, not Python's collection-producing `map()`.
Kedi first traverses the iterable and starts every loop-body job. It then
schedules one map continuation for each retained iteration scope. A
continuation sees that iteration's binder, declarations, template outputs, and
the containing scopes; values from different iterations cannot overwrite one
another.

The stage uses the configured execution engine. In sequential mode,
continuations complete in source order. With a parallel engine, independent
records may finish out of order, and each continuation waits for the promises
owned by its own record. Kedi joins the full map stage before continuing after
the loop and drains all scheduled continuations before surfacing the first
failure.

Parallel map continuations may overlap. Source-order side effects and atomic
read-modify-write operations are not implied: shared aggregates must use
operations or synchronization appropriate for the active execution engine.

V1 permits one map clause, attached only to an immediately preceding
binder-based iterable loop. It has no binder and creates no implicit result
collection. An orphan map, a map after a conditional loop, or a second chained
map is a parse error.

## Procedures

### Basic Procedures

Define reusable code blocks with `@name():`:

```kedi
@greet(name):
  Hello, <name>!
  = Welcome

# Call the procedure
Message: <greet(Alice)>
```

### Typed Parameters and Returns

```kedi
@add(x: int, y: int) -> int:
  = `x + y`

@process(items: list[str]) -> str:
  Total items: <`len(items)`>
  = Processed <`len(items)`> items

# Inline Python type annotations work too
@double(x: `int`) -> `int`:
  = `x * 2`

@sum_list(nums: `list[int]`) -> `int`:
  = `sum(nums)`

# Mixed usage
@combined(x: int, y: `int`) -> `int`:
  = `x + y`
```

Supported types: `str`, `int`, `float`, `bool`, `list[T]`, plus any custom types defined in your program.

### Default Parameters

Procedure parameters can have single-line inline Python defaults:

```kedi
@format_count(count: int, label = `"items"`) -> str:
  = `f"{count} {label}"`

= <format_count(`3`)>
```

Required positional parameters must come before defaulted parameters, matching Python function semantics. Untyped parameters with defaults keep their native Python value; Kedi does not infer or coerce their type.

You can use either regular or backtick-wrapped type annotations for parameters and return types. They work interchangeably and provide the same type safety guarantees.

### Procedure Arguments

Arguments can be passed as:
1. **Native values** using single backticks: `` `expr` ``
2. **Rendered strings** using any other format

```kedi
@show(n: int, label: str):
  = <label>: <`str(n)`>

# Native int, rendered string
<show(`5`, Count)>

# Both rendered as strings (ERROR if expecting int)
<show(5, Count)>

# Native list
@process(items: list[int]):
  = Sum: <`sum(items)`>

<process(`[1, 2, 3]`)>
```

Use `\,` to escape commas within arguments:
```kedi
<format(alpha\, beta\, gamma)>  # Single arg: "alpha, beta, gamma"
```

## Python Integration

### Inline Python Expressions

Use backticks within substitutions for single-line Python:

```kedi
# In template blocks
>> Result: <`math.sqrt(16)`>
Array: <`[i*2 for i in range(5)]`>

# Variable access in a return (not an LLM template)
[x] = 10
= Double: <`x * 2`>
```

### Multiline Python Blocks

**CRITICAL INDENTATION RULE**: In multiline Python blocks, both the triple backtick fences AND the Python code inside them must be indented to match the surrounding Kedi context. The fences must be alone on their lines.

**Correct** - fences and code align with procedure body:
````kedi
@foo():
  [x] = 5
  ```
  import math
  result = math.pi * x
  print(result)
  ```
  = done
````

**Incorrect** - fences not indented with procedure:
````kedi
@foo():
  [x] = 5
```
import math
result = math.pi * x  # WRONG: fences not indented
```
  = done
````

**Incorrect** - code not matching fence indentation:
````kedi
@foo():
  ```
    print("wrong")  # WRONG: over-indented relative to fence
  ```
````

Rules:
- Opening/closing fences must be alone on their lines (no inline `` ```python code``` ``)
- Code must match the surrounding Kedi indentation level
- Variables in scope are injected, and assignments to those **existing** Kedi variables reflect back to their nearest lexical owner after all changed values pass their Kedi type contracts. New names created inside the block stay local to the block and do **not** leak into Kedi scope — assign to an existing Kedi variable (or use a value-returning block) to surface a result.
- The code is dedented relative to its indentation level before execution

#### Kedi variables are Python *globals*

Inside a Python block, Kedi variables are exposed as **module globals**, not locals. This is invisible most of the time — a bare `x` reads the Kedi variable `x` exactly as you'd expect — but it matters in two specific cases:

- **Reflection.** Read names dynamically with the bare name or `globals()["x"]`, **not** `locals()`. A Kedi variable is not a local of the block, so `locals().get("x")` will not find it.
- **Nested functions and comprehensions.** A `def`/`lambda` nested inside a block that needs to *rebind* a Kedi variable must declare `global x`, **not** `nonlocal x` — there is no enclosing function scope to close over.

````kedi
@counter():
  [n: int] = `0`
  ```
  def bump():
      global n        # ✅ rebinds the Kedi variable; `nonlocal n` would be a SyntaxError
      n = n + 1
  bump()
  bump()
  ```
  = <`str(n)`>        # "2"
````

### Value-Returning Python Blocks

````kedi
# Assignment with return (note aligned indentation)
@compute():
  [area: float] = ```
  import math
  return math.pi * 5 ** 2
  ```
  = <area>

# Direct return
@total():
  = ```
  values = [1, 2, 3]
  return sum(values) * 2
  ```
````

### Side-Effect Python Lines

Single backtick lines execute for side effects only:

```kedi
@process():
  [x] = start
  `x = x + "-modified"`
  `print(f"Debug: {x}")`
  = <x>
```

### Prelude Block

If the first content is a Python block, it becomes the prelude:

````kedi
```
import numpy as np
import matplotlib.pyplot as plt

def helper(x):
    return x * 2
```

# Now numpy, plt, and helper are available everywhere
[data] = `np.array([1, 2, 3])`
````

## Returns

Lines starting with `=` return values:

```kedi
@get_value():
  [result] = computed
  = <result>

# Direct return
= The answer is <value>

# Python return
= `compute_result()`

# Multiline return with backslash continuation
= Start \
  middle \
  end
```

Whitespace is trimmed only at line ends, internal spaces preserved.

## Custom Types

Define Pydantic-compatible models with `~TypeName`:

````kedi
~Person(name, age: int, email)

@create_person() -> Person:
  = `Person(name="Alice", age=30, email="alice@example.com")`

# Use in outputs
[employee: Person] = ```
return Person(name="Bob", age=25, email="bob@example.com")
```

# Use inline Python type annotations with custom types
~Team(name, scores: `list[int]`, members: `dict[str, int]`)

[team: `Team`] = `Team(name="Eagles", scores=[10, 20, 30], members={"Alice": 10, "Bob": 20})`
````

Fields without type annotations default to `str`. You can use backtick-wrapped type expressions in field definitions, parameters, returns, and variable initializations. The expressions are evaluated at runtime with access to prelude, globals, and local scope.

Kedi's built-in type namespace includes common Python and typing types such as `str`,
`int`, `list`, `dict`, `Union`, `Optional`, `Literal`, `Annotated`, plus
serializable runtime types such as `datetime`, `date`, `time`, `timedelta`,
`Regex`, `Email`, `HttpUrl`, and `FileUrl`. These names resolve to Python or
Pydantic types, so generated JSON schemas keep their native formats: `date`,
`time`, `regex`, `email`, or `uri` where applicable. Adapter schema support is
validated before a model call. Codex accepts `date`, `date-time`, `duration`,
`email`, and `time`, but rejects `Regex`, `HttpUrl`, and `FileUrl`; the LSP marks
those output annotations as errors in a Codex scope and runtime raises before
contacting Codex. When plain text with semantic guidance is enough, use a type
such as `Annotated[str, "Exact URL pointing to the file"]` instead. Its
description is included in the generated provider schema while its wire type
remains `string`. Claude currently accepts all of the formats listed above.

Native Kedi annotations reject `tuple`, `Tuple`, `Sequence`, `Mapping`,
`Iterable`, `object`, `bytearray`, `slice`, and `range`. These names remain
ordinary Python values inside Python expressions and blocks; the restriction
applies only when they are used as Kedi type contracts. Prefer `list`, `dict`,
or a named custom type for model-facing schemas.

Type fields can also have single-line inline Python defaults:

```kedi
~Person(name: str, salary: int = `0`, tags: list[str] = `[]`)

= <`Person("Ada").model_dump_json()`>
```

`Annotated[type, "description"]` works on custom type fields too. The generated
Pydantic model keeps `type` as the runtime annotation and exposes the string as
the field description in JSON schema:

```kedi
~Person(name: Annotated[str, "Full display name"], age: int)
```

Defaulted type fields must be annotated. Required fields must come before defaulted fields. Generated Kedi types are Pydantic `BaseModel` subclasses, so keyword construction and model APIs such as `model_dump_json()` remain available; Kedi also supports positional construction in field order.

## Advanced Features

### Multiline Templates and Returns

**Templates** use `>>` blocks — not trailing backslashes. Continuation rows at the
same indent are newline-joined into one LLM run:

```kedi
>> What's the [capital] of Turkey?
This same prompt can ask for [population: int] too.
```

To use an output from the first prompt, start a new block:

```kedi
>> What's the [capital] of Turkey?
>> What's the [population: int] of <capital>?
```

**Returns** may still use backslash continuation to stitch a single return value
across physical lines:

````kedi
= This is a \
  long return that \
  continues across lines
````

Use `\\` for a literal backslash.

### Lexical Closures

Nested procedures capture outer scope:

```kedi
@outer(x):
  [y] = <x>-suffix
  
  @inner():
    = Captured: <y>
  
  = <inner()>
```

### Escaping Special Characters

Use a backslash to escape special characters anywhere they would otherwise be interpreted by the DSL.

Escapable characters:
- `\<` → `<`
- `\>` → `>`
- `\[` → `]`?  // clarified below
- `\]` → `]`
- `\=` → `=`
- `\@` → `@`
- `\,` → `,`
- `\\` → `\`
- `\#` → `#`
- `\~` → `~`
- `` \` `` → `` ` ``
- `\(` → `(`
- `\)` → `)`
- `\t` → tab character
- `\n` → newline character
- `\s` → space character

Notes:
- Inside `<...>` substitutions and `[...]` outputs, use the same `\` escapes for literal delimiters.
- A lone `\` before a non-escapable character is an error.
- **Whitespace preservation**: Regular whitespace (spaces) at the beginning and end of template strings are trimmed, but escaped whitespace characters (`\t`, `\n`, and `\s`) are preserved even at the boundaries. For example, `= \tTab at start\n` will preserve the leading tab and trailing newline.

## Concurrency and Non-Blocking Templates

By default Kedi runs **sequentially**: every template (`>>`) call blocks until the model responds, exactly as before. Concurrency is **opt-in** and requires **no syntax changes** — the same program runs faster when you enable it.

### Enabling parallel execution

Opt in with any one of:

- `KEDI_PARALLEL=1` (environment variable) — `1/true/yes/on` enable it, `0/false/no/off` (or unset) keep sequential, a positive integer sets the worker count. Any other value is rejected loudly rather than silently flipping a mode.
- `kedi.parallel(max_workers=N)` / `kedi.configure(parallel=True)` in the Python API.

When parallel mode is on, independent template calls run concurrently and dependency chains pipeline automatically: in `A → B` and `C → D`, both chains run at once and each `B`/`D` starts the instant its input is ready. There is no new operator — the interpreter discovers the dataflow from how outputs feed into later inputs.

### How it works (and what you can observe)

Each template output becomes an opaque **promise** until its value is actually needed. The interpreter threads promises through the environment and resolves them lazily — when a Python block reads the value, or at end-of-run. You normally never see a promise.

- **Promises are loud, never silent.** If an unresolved promise ever reaches a value context unexpectedly (it is stringified, indexed, compared, …), it raises `KediPromiseLeak` rather than producing a wrong result. This indicates an interpreter bug, not user error.
- **Advanced: passing promises around.** Reading a Kedi variable by **bare name** (or `globals()["x"]`) inside a Python block resolves the promise to its concrete value. The non-resolving dict APIs — `globals().get("x")`, `.items()`, `.values()`, `dict(globals())` — intentionally return the **raw promise** so you can forward a still-pending value without forcing it. To collapse a raw promise to its value yourself, call `kedi.force(x)` (a no-op on non-promises). This laziness is deliberate; resolving on every dict access would defeat pipelining.

### Things to know

- **Sequential and parallel results are identical.** The value-environment is snapshotted by value when a template is scheduled, so a later write on the main thread can't change what an already-scheduled job sees. If you ever observe a difference, report it — it's a bug, not a tuning knob.
- **Failures are never swallowed.** Even unconsumed templates run, and any failure surfaces at end-of-run (the first error is raised; additional concurrent failures are logged). A procedure that raises still drains its scheduled jobs before the error propagates.
- **Adapters must be thread-safe.** In parallel mode an adapter's `produce_sync` is called concurrently across worker threads. A custom adapter must be safe under concurrent calls (or serialize internally). The built-in adapters already are.
- **`max_workers` is process-global per size.** The thread pool is shared across runs and cached by worker count; the first `parallel(max_workers=N)` for a given `N` creates that pool and subsequent requests for the same `N` reuse it.
- **Adaptive job manager (opt-in, advanced).** `JobManagerEngine` layers AIMD concurrency, transient-error retry with backoff + jitter, and a circuit breaker on top of the thread engine for real rate-limited backends. It is not wired through the public `parallel()` surface yet — construct it explicitly via `compile_program(engine=...)` if you need it.

## Testing and Evaluation

### Test Blocks

````kedi
@get_cities(country: str) -> list[str]:
  Cities in <country> are [cities: list[str]]
  = `cities`

@test: get_cities:
  > case: singapore:
    `assert "Singapore" in get_cities("Singapore")`
  
  > case: multiple:
    ```
    cities = get_cities("Japan")
    assert "Tokyo" in cities
    assert "Osaka" in cities
    ```
````

### Evaluation Metrics

Define dataset-aware metrics with automatic iteration:

````kedi
@eval: prime_factors:
  > data: cases:
    = ```
    # Must return an iterable. Supported forms include:
    # - items: [x1, x2, ...]
    # - pairs/tuples: [((args_tuple), label), ...]
    # - mappings: {x: y, ...}  (coerced to .items())
    return {6:[2,3], 28:[2,2,7], 35:[5,7]}.items()
    ```

  > test_data: cases:
    = ```
    return {12:[2,2,3]}.items()
    ```

  > metric: correctness(cases):
    = ```
    # For each item in the dataset, the dataset name (`cases`) is bound.
    # Use it directly or unpack as needed.
    k, v = cases
    return prime_factors(k) == v  # bools map to 1.0/0.0
    ```
````

Rules:
- `> data: NAME:` defines the training dataset for the enclosing `@eval` suite and must return an iterable.
- `> test_data: NAME:` (optional) defines a test dataset; when present, both train and test performance are reported.
- `> metric: metric_name(NAME):` iterates automatically over the dataset named `NAME`, binding the dataset name as a variable for each item.
- Only one metric per `@eval` suite is allowed. Multiple metrics will raise a parse error.
- Per-example results can be: `bool` (mapped to 1.0/0.0), `float`, or `(score, feedback)`.

#### Dataset Item Format

Dataset items can follow two conventions:

1. **`(input, expected_output)` tuples**: When the dataset yields two-tuples, the first element is bound to the dataset variable name in the metric, and the second is bound to a special `expected` variable. Use `None` as `expected_output` for analytical metrics where the metric computes correctness internally.

2. **Raw items**: Single values or `dict.items()` key-value pairs are bound directly to the dataset variable name.

````kedi
@eval: solve_aime:
  > data: train:
    = ```
    return [
      ("What is 2+2?", {'answer': 4}),
      ("What is 3*5?", {'answer': 15}),
    ]
    ```

  > metric: accuracy(train):
    = ```
    # 'train' is bound to the input (first element of tuple)
    # 'expected' is bound to the expected output (second element)
    problem = train
    pred = solve_aime(problem)
    return 1.0 if int(pred) == expected['answer'] else 0.0
    ```
````

## Agent Profiles and Tools

Kedi routes LLM calls through agent adapters. Use `> adapter:`, `> agent:`,
`> model:`, `> effort:`, `> approval:`, `> hooks:`, `> skills:`, `> system:`, `> mcp:`, `> profile:`, and `> use:`
to choose adapter implementations, choose models, set reasoning effort, set
agent instructions, load MCP tools, expose Kedi procedures as agent tools, and
enable scoped skill discovery.

### Model and profile directives

```kedi
> adapter: pydantic
> model: groq:qwen/qwen3-32b
> effort: low
> approval: allow
> system: Answer concisely and avoid extra narration.

> profile: fast:
    > adapter: pydantic
    > model: groq:qwen/qwen3-32b
    > effort: minimal
    > settings:
        temperature: 0.2
        max_tokens: 1024
    > system:
        Prefer short direct answers.
        Adapt examples for <audience>.
> profile: quality:
    > agent: codex
    > model: openrouter/google/gemini-3-flash-preview
    > effort: high
    > system: Be precise and cite the relevant tool output.
    > settings:
        parallel_tool_calls: true
        num_retries: 2
    > mcp:
        command: vsh
        args: `["run", "--mcp"]`
    > use: web_search
> profile: acp_local:
    > agent:
        acp: `["vsh", "run", "--acp"]`
    > settings:
        cwd: /tmp/project
```

- `> adapter: name` — select an agent framework adapter for following LLM
  calls in the current lexical scope. Built-in framework shortnames are
  `pydantic`, `dspy`, and `langchain`.
- `> agent: name` — select an agent harness adapter for following LLM calls
  in the current lexical scope. Built-in harness shortnames are `claude`,
  `codex`, and `acp`. ACP commands can also be declared in multiline form:

  ```kedi
  > agent:
      acp: uv run acp server
  ```

  Literal adapter names are validated by the LSP and at runtime. `> agent:`
  only accepts harness adapters, while `> adapter:` only accepts framework
  adapters; use an inline Python value only when the selected name must be
  determined dynamically at runtime.

  The command value may be plain text or an inline Python expression that
  evaluates to a string or string sequence.
- `> model: name` — set the active model for subsequent procedure captures (plain
  name or `` `expression` ``). With the Pydantic adapter, `codex/<model>` selects
  a Codex-authenticated Responses model on Python 3.11+ through the optional
  `kedi[codex-model]` extra. Run `codex login` before using this model family:

  ```kedi
  > adapter: pydantic
  > model: codex/gpt-5.6-luna
  > effort: high
  ```
- `> effort: level` — set active reasoning effort. Accepted values are
  `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; plain values or
  `` `expression` `` are allowed. Pydantic AI maps `max` to `xhigh`.
  DSPy receives the value directly as `reasoning_effort`.
- `> approval: allow` / `> approval: deny` — configure tool-call approval for
  subsequent agent calls in the current scope. `allow` permits registered
  mutating or sensitive tools; `deny` refuses them. In the Python API, omitting
  a policy allows read-only tools automatically and refuses mutating or sensitive tools.
  The `kedi` CLI instead asks interactively for every mutating or sensitive
  call, offering **Allow once**, **Deny**, and **Allow always for this run**.
  The last option is scoped to the current CLI process and the same tool/risk
  level; it is never persisted. A dynamic Python handler can inspect and
  allow, deny, or edit a call:

  ````kedi
  ```
  from kedi import ApprovalDecision

  def approve_tool(request):
      if request.tool_name == "write_report":
          return ApprovalDecision.edit({**request.arguments, "path": "reports/safe.txt"})
      return ApprovalDecision.deny(reason="tool is not allowed here")
  ```

  > approval: `approve_tool`
  ````

  The handler receives an immutable request with `tool_name`, `arguments`,
  `risk`, adapter metadata, and tool metadata. It must return
  `ApprovalDecision.allow()`, `ApprovalDecision.deny()`, or
  `ApprovalDecision.edit({...})`. `edit` is available only from a handler;
  `> approval: edit` is invalid.

  The bundled `helpers` module provides an LLM-backed handler that uses the
  active model to classify intrinsic risk and allow or deny the call:

  ```kedi
  > import: helpers
  > approval: `llm_approval`
  ```

  `llm_approval` evaluates only the tool name, description, declared risk, and
  call arguments. Approval requests do not currently include a call reason, so
  the model judges with limited information. This helper is experimental and is
  not a stable feature.
- `> hooks:` registers Python lifecycle handlers for subsequent agent runs:

  ````kedi
  ```
  from kedi import PreToolUseDecision, UserPromptSubmitDecision

  def redact_prompt(event):
      return UserPromptSubmitDecision.edit(
          event.content.replace("customer@example.com", "[email]")
      )

  def constrain_write(event):
      if event.tool_name != "write_report":
          return None
      return PreToolUseDecision.edit(
          {**event.arguments, "path": "reports/output.md"}
      )
  ```

  > hooks:
      user_prompt_submit: `redact_prompt`
      pre_tool_use: `constrain_write`
  ````

  The supported events are `user_prompt_submit`, `pre_tool_use`,
  `post_tool_use`, and `post_tool_use_failure`. Prompt and pre-tool handlers
  may return a typed `continue`, `deny`, or `edit` decision. Post handlers are
  observers and must return `None`. Tool arguments are canonicalized before
  `pre_tool_use`; an edit is validated again before approval and execution.
  A denied prompt never reaches the model, and a denied tool never executes.
  `post_tool_use_failure` is emitted only after tool execution starts. Its event
  records the observed execution duration and whether execution was interrupted;
  pre-hook and approval denials are not execution failures.

  Handlers run in registration/source order. Each edit becomes the next
  handler's input, and denial stops the chain. Adapter-instance handlers run
  before lexical/profile handlers. Direct top-level, procedure, and Python API
  hook policy is inherited by subagents as runtime enforcement; hooks declared
  only inside a child profile remain local to that profile.

  The final prompt produced by `user_prompt_submit` is canonical for that turn:
  model transport, request budgeting, telemetry, cache identity, and stateful
  history all observe the same edited value. The pre-hook value is not retained
  as a parallel history entry.

  `> hooks: disabled` disables inherited lexical/profile handlers in that
  scope. It does not remove handlers explicitly registered on an adapter
  instance. Hook support is event-specific: Pydantic AI, LangChain, Claude,
  Codex, and WebGPU support all four events; ACP supports only
  `user_prompt_submit`; DSPy does not support this surface. Unsupported events
  fail before model transport and are reported by the LSP.
- `> system: text` — set active agent instructions for subsequent procedure
  captures and prompt calls.
- `> history: enabled|disabled` — control whether model calls in the current
  lexical scope share conversation history. History is disabled by default.
  `enabled` creates one runtime-owned conversation whose complete successful
  turns are visible to later template and raw-invoke blocks. `disabled`
  creates a stateless nested scope: calls in that scope neither read nor mutate
  an enabled outer conversation.

  ```kedi
  > history: enabled

  >> Remember [project_name].
  >> Using the project name from the previous call, write [tagline].

  @isolated_check():
      > history: disabled
      >> Produce an unrelated [answer].
      = <answer>

  = <project_name>: <tagline>
  ```

  The policy is valid at top level, inside procedures, and in profiles. It is
  lexical like the other profile directives, and a nested `disabled` policy
  overrides an inherited `enabled` policy. Failed, cancelled, or early-closed
  native iterator/stream calls do not commit a partial turn. Successful
  prompt/result history, adapter continuation, cleanup ownership, and cache-epoch
  changes commit atomically. In parallel execution, calls sharing one
  conversation execute their complete stateful transactions in source order;
  independent conversation sessions may still run concurrently.

  History is partitioned by concrete adapter and compatible configuration lane.
  Switching adapter, model, relevant settings, MCP configuration, or tool
  contract starts a fresh native continuation lane rather than feeding an
  incompatible checkpoint to the next call. Kedi does not translate private
  provider messages across frameworks. Pydantic AI and LangChain replay their
  complete portable message sequences, including tool calls and tool results.
  Claude uses its native resumable session. Codex starts a non-ephemeral App
  Server thread, resumes that thread for later calls, and deletes it when the
  Kedi conversation closes or its configuration lane is replaced. Selecting
  `enabled` with an adapter that does not advertise stateful-history support is
  an LSP error and a runtime error.

  Kedi also assigns each adapter lane an opaque, stable cache identity. OpenAI
  integrations use it as the prompt-cache key and may reuse the previous
  response where supported. Pydantic AI's OpenRouter integration receives its
  native instruction, message, and tool-definition cache settings. LangChain's
  OpenRouter integration receives its native sticky-session identity plus
  ephemeral cache-control content blocks on the stable system prompt and latest
  user message. Replayed LangChain history has prior Kedi-generated markers
  removed before the latest marker is placed, so marker metadata does not grow
  on every turn and message order remains unchanged. Anthropic integrations use
  their framework-native cache settings or content blocks without rewriting the
  ordered message prefix. Google Gemini integrations preserve the same ordered
  prefix but add no cache setting: Gemini 2.5 and newer use provider-managed
  implicit caching and report cache-read tokens in usage metadata. Explicit
  Google cached-content resources have a separate lifecycle and are not created
  automatically. Explicit model settings always override Kedi defaults. History
  and cache identities remain append-only within a cache epoch: ordinary
  artifact release or expiry never deletes or reorders prior messages.

  Direct-provider prefix caching follows each provider's native contract:

  | Provider | Kedi integration |
  | --- | --- |
  | Moonshot AI | Reuses the conversation cache identity as `prompt_cache_key`. |
  | Alibaba Cloud Model Studio | Preserves the ordered prefix and relies on provider-managed implicit caching. |
  | Z.AI | Preserves the ordered prefix and relies on provider-managed implicit caching. |
  | Amazon Bedrock | Enables Pydantic AI's instruction, message, and tool-definition cache points. LangChain uses `BedrockPromptCachingMiddleware`. |
  | Azure OpenAI | Reuses the conversation cache identity as `prompt_cache_key`; Responses models may also continue from the previous response. |
  | DeepSeek | Preserves the ordered prefix and relies on provider-managed implicit caching. |
  | xAI | Preserves the ordered prefix and relies on provider-managed automatic prefix caching. |

  These integrations do not emulate a provider cache in Kedi. Alibaba,
  DeepSeek, Z.AI, and xAI require no request flag for their implicit cache.
  Moonshot and Azure receive only their supported stable routing key. Bedrock
  receives explicit framework-native cache points; with LangChain this requires
  the `kedi[langchain-aws]` optional dependency group. Preconstructed LangChain
  `ChatOpenAI` models using the official Moonshot, Alibaba, DeepSeek, or Z.AI
  base URLs are recognized without changing their configured endpoint.

  Use the expanded history form to configure conversation compaction alongside
  history ownership:

  ```kedi
  > history:
      enabled: true
      compaction_mode: native
      compaction_threshold: `100_000`
  ```

  `enabled` is required in the expanded form. `compaction_mode: native`
  delegates compaction to the selected provider. `compaction_threshold` is an
  optional positive input-token count; omit it to use that integration's native
  default. Native compaction requires history to be enabled. The supported paths are:

  - Pydantic AI with `OpenAIResponsesModel`, through `OpenAICompaction`;
  - Pydantic AI with `AnthropicModel`, through `AnthropicCompaction`;
  - LangChain with an OpenAI chat model, through OpenAI
    `context_management`;
  - LangChain with an Anthropic chat model, through Anthropic
    `context_management` and the required compaction beta;
  - Codex App Server, through its persistent thread and
    `model_auto_compact_token_limit` configuration;
  - Claude Agent SDK, through its native automatic session compaction.

  Codex accepts `compaction_threshold` as an explicit thread token limit.
  Claude Agent SDK does not expose an exact compaction threshold: omit
  `compaction_threshold` to use its native policy. Supplying a threshold in a
  Claude scope fails before the model call. `compaction_mode: disabled` stops
  Kedi from adding a compaction policy; it does not override compaction already
  owned internally by an agent harness.

  Kedi does not silently replace an unsupported native provider with a
  summarizer. Selecting `native` with another model or adapter raises a clear
  runtime error. Disable an inherited compaction policy while retaining
  stateful history with:

  ```kedi
  > history:
      enabled: true
      compaction_mode: disabled
  ```

  `compaction_threshold` is invalid together with `compaction_mode: disabled`.
  Existing unrelated provider context-management entries and caller-supplied Pydantic
  capabilities are preserved; Kedi replaces only the native compaction entry
  it owns. With stateful Pydantic history, a newly emitted provider compaction
  checkpoint seals the current cache epoch. Kedi rotates the opaque cache key,
  drops stale continuation state from other adapter lanes, and retains the
  provider's compacted messages as the first state of the new epoch. Replayed
  checkpoints do not rotate the epoch again. LangChain currently owns its
  provider continuation internally because its public message result does not
  expose a stable cross-provider compaction marker.

  Kedi also contains an adapter-neutral, deterministic history processor and
  transactional checkpoint foundation for future Kedi-owned compaction. The
  semantic summarizer that will produce those checkpoints is tracked in
  [issue #80](https://github.com/kedi-lang/kedi/issues/80); `kedi` is not yet a
  public `compaction_mode` value.

  Tool calls and tool results remain native causal messages in adapter history;
  Kedi does not flatten them into user-prompt text. `stateful_history` means an
  adapter can continue successful turns. `history_replay` additionally means
  Kedi can inspect and replay the adapter's complete message representation.
  `native_artifacts` is separate again: it is true only when adapter-native and
  MCP tool results are guaranteed to cross Kedi's artifact-admission boundary.
  Pydantic AI and LangChain provide that guarantee. Their native tool results
  are admitted before model-visible history is committed, while native tool-call
  IDs, error results, approval flow, and existing Kedi artifact wrappers remain
  intact.
- `> settings:` — set active model configuration for subsequent procedure
  captures and prompt calls. Values are `name: value` lines; plain values are
  parsed as simple scalars (`true`, `false`, numbers, `null`) and backtick
  expressions are evaluated as Python for complex values. Kedi keeps the merged
  settings in the active profile, then filters them at adapter boundaries:
  Pydantic AI receives only supported `ModelSettings` keys, and DSPy receives
  only supported `dspy.LM` kwargs. Agent harnesses receive their supported
  settings, such as `cwd`, `env`, and `timeout` for ACP. `cwd` is passed as
  the agent process working directory where supported, including ACP, Codex,
  and Claude. Claude enables the Claude Code built-in tool and system prompt
  presets by default; `> system:` is appended to the Claude Code preset so file
  tools remain part of the agent behavior. Non-interactive Claude runs default
  to `permission_mode: acceptEdits`, allowing those built-in file tools to
  complete; set `permission_mode` explicitly to override it. Set `tools`
  explicitly if you want a narrower Claude tool surface. Codex exposes its
  harness tools through its own `sandbox`, `approval_policy`, and `cwd`
  settings; its default sandbox is `workspace-write` so read/write harness tools
  are eligible unless narrowed by settings. Unknown setting names are parser/LSP
  errors.
  Use backticks when the setting value should be a real Python object instead
  of a string or simple scalar:

  ```kedi
  > settings:
      parallel_tool_calls: `False`
      stop_sequences: `["END", "DONE"]`
      extra_body: `{"mode": "json"}`
  ```

  OpenRouter's gateway-owned exact response cache is available as an explicit
  opt-in and is separate from prompt caching:

  ```kedi
  > settings:
      response_cache: true
      response_cache_ttl: 3600
  ```

  The settings are provider-neutral Kedi API names. The current implementation
  supports OpenRouter and translates them to `X-OpenRouter-Cache` and
  `X-OpenRouter-Cache-TTL`. The TTL is optional and must be between 1 and 86400
  seconds. The setting is rejected for non-OpenRouter models. It is disabled by
  default because replaying a cached assistant response that contains a tool
  call can cause the local tool to execute again; Kedi does not yet journal
  side-effecting tool results. This cache is owned by OpenRouter and should not
  be confused with the opt-in `cache=True` Python API cache.

  Cache efficiency must be evaluated from provider usage rather than hit ratio
  alone. Kedi telemetry records logical input, cache-read, cache-write,
  uncached-input and output tokens, plus provider-reported USD cost when the
  adapter exposes it. Cache-write tokens describe the cached portion of the
  logical input and are not an additional input-token category.

  CodeMode is an explicit Kedi-owned capability directive:

  ```kedi
  > adapter: pydantic
  > codemode: enabled
  ```

  The expanded form enables CodeMode and configures its bounded discovery and
  execution surface. `enabled` is optional in the block and defaults to `true`:

  ```kedi
  > codemode:
      default_search_limit: 10
      max_search_limit: 50
      max_hydrated_tools: 32
      max_nested_calls: 48
      max_concurrent_calls: 8
      request_timeout: 60
  ```

  It replaces the model-facing application tool catalog with
  `search_tools`, `get_tool_schema`, and `execute_code`. Search returns only
  exact tool names and an opaque pagination cursor. Schema hydration makes
  selected tools callable inside a per-run Monty sandbox; only hydrated tools
  may execute. The sandbox preserves Kedi argument validation, approval,
  required-tool tracking, tool telemetry, sequential constraints, and local
  MCP lifecycle behavior. Nested tool outputs remain outside model history
  while code filters or aggregates them. Only the final `execute_code` result
  crosses normal artifact admission.

  Monty language failures return captured standard output and the traceback
  message as separate fields, for example
  `{"output": "loaded 3 rows", "error": "AttributeError: ..."}`. Output emitted
  before the failure therefore remains available for recovery without being
  mixed into the traceback. Variables assigned before the failure remain in
  the run's sandbox. Application-tool failures, approval denials, and Kedi
  execution limits remain failed tool calls rather than successful sandbox
  results.

  CodeMode is disabled by default. It supports Pydantic AI, LangChain, Claude
  Agent SDK, and Codex App Server; DSPy remains unsupported. All four paths use
  the same control names, Monty subset, limits, approval composition, and
  artifact boundary. CodeMode requires inline Kedi approval resolution because
  a deferred approval cannot safely suspend and replay a partially executed
  snippet.

  Pydantic local `MCPToolset` tools, LangChain `MultiServerMCPClient` tools,
  and Claude-declared stdio/SSE/HTTP MCP tools are materialized into the
  CodeMode catalog. Pydantic provider-native MCP is rejected, and Codex MCP
  remains unsupported by that adapter. Claude and Codex keep their own
  filesystem, shell, and other harness control-plane tools native; CodeMode
  hides application tools, not the harness controls needed to operate them.
  `> codemode:` is lexical and may appear at top level, inside a profile, or
  inside a procedure. `> settings:` accepts only adapter/model settings and
  does not accept `codemode`.

  ACP always requires an explicit stdio command, either in multiline
  `> agent:` syntax or through `ACPAdapter(command=...)`. Kedi does not resolve
  ACP commands from CLI options or environment variables.
- Multiline `> system:` bodies are newline-joined like `>>` blocks, but they
  are read-only: literal text, `<name>` substitutions, and inline Python
  substitutions such as ``<`args.name`>`` are allowed; LLM outputs and procedure
  calls are not. Use `<``>` when the instruction text needs to mention a
  literal code fence marker.
- `> profile: name:` — define a reusable profile with nested `> agent:`,
  `> adapter:`, `> model:`, `> effort:`, `> approval:`, `> system:`,
  `> settings:`, `> mcp:`, `> output:`, `> subagent:`, `> workflow:`, and/or `> use:`
  members. A profile that delegates may also set `> max_agents: N`.
- Profile docstrings: if the first statement inside a profile body is a block
  comment, its body becomes profile documentation and is shown in editor hovers.
  A block comment after any other profile statement remains a normal comment.
- Profiles merge when applied: later members override earlier ones of the same kind.
- Adapter selection follows normal lexical scoping. A direct source directive in
  the current scope overrides an active profile, which overrides CLI defaults.
  Nested scopes may switch adapters, but a single lexical scope cannot mix
  `> agent:` and `> adapter:` because those select different adapter classes.
  Use `> agent:` only for `agent-harness` adapters and `> adapter:` only for
  `agent-framework` adapters.
- Editor diagnostics use adapter capability metadata. If the selected adapter
  does not currently support structured template outputs, the LSP reports an
  error on the relevant output field and the adapter raises when that template
  runs. `> use:` tool registration and `> mcp:` servers remain capability
  warnings: when an adapter later advertises support for that feature, the same
  Kedi code stops warning without syntax changes.

### Subagents

The subagent surface is available with the Pydantic AI, Claude Agent SDK,
Codex App Server, LangChain, and DSPy adapters. A profile may expose other
profiles as direct children:

```kedi
~ResearchReport(summary: str, sources: list[str])

> profile: researcher:
    ###
    Investigates one focused question and reports its findings.
    ###
    > adapter: pydantic
    > model: openrouter:google/gemini-3-flash-preview
    > system: Inspect the evidence before answering.
    > output: ResearchReport
    > use: web_search

> profile: coordinator:
    > adapter: pydantic
    > subagent: researcher
    > max_agents: 5

> use: coordinator
[answer] << Delegate the research task, inspect its result, and answer briefly.
= <answer>
```

`> subagent: researcher` registers a `delegate_task` tool for `coordinator`.
The parent may delegate only to profiles named directly in its own body.
Forward references are supported, while unknown profiles and cyclic profile
graphs are rejected.

A child profile may declare a default structured result type with
`> output: Type`. Kedi accepts the same native type expressions used by fields
and procedure signatures, including generic and custom types. When
`delegate_task` or a dynamic child call omits `final_schema`, Kedi converts the
profile output type to JSON Schema and returns the validated value in
`final_result`. An explicit `final_schema` takes precedence. If neither is
present, the child keeps the text-only `task_summary` behavior.

Subagent orchestration has two profile-level modes. Omitting `> workflow:` is
equivalent to `> workflow: delegate` and preserves the delegation and lifecycle
tools described below. `> workflow: dynamic` instead exposes one sequential
`run_workflow(code: str)` tool:

```kedi
> profile: coordinator:
    > adapter: pydantic
    > subagent: researcher
    > subagent: reviewer
    > workflow: dynamic
    > max_agents: 8
```

The parent model writes restricted Python orchestration code for that tool.
Each direct child is available in the code as an async keyword-only function:

```python
import asyncio

research, review = await asyncio.gather(
    researcher(task="Collect evidence for the claim."),
    reviewer(task="List the acceptance criteria."),
)
{
    "research": research["task_summary"],
    "review": review["task_summary"],
}
```

The last expression becomes the workflow result. A child call returns
`run_id`, `subagent`, `task_summary`, and `final_result`. Passing a validated
JSON Schema as `final_schema` populates `final_result`; otherwise the raw child
response is carried by `task_summary`. Independent calls may use
`asyncio.gather`, while ordinary `await` preserves sequential dependencies.

Dynamic code runs in Monty, not host Python. It cannot access Kedi runtime
objects, adapters, credentials, environment variables, the filesystem,
network, processes, or arbitrary imports. Real child work still passes through
the normal coordinator, so profile isolation, model/tool resolution, approval
ceilings, cwd/sandbox limits, usage accounting, cancellation, concurrency, and
ancestor budgets are identical to delegate mode. Dynamic workflows cannot
nest. A child may still use ordinary delegation within the existing depth and
budget ceilings.

Syntax and type errors happen before a child starts. A child failure appears to
the workflow as a sanitized `RuntimeError`, which the generated code may catch
and recover from. Completed identical calls are retained in a bounded retry
salvage table so a corrected workflow does not pay for the same successful
child twice. Exhausting `max_agents` returns a terminal structured error;
canceling `run_workflow` cancels and joins every owned child before returning.
Workflow output and printed diagnostics are bounded, and only JSON-safe values
cross the Monty boundary.

`> max_agents: N` limits how many descendant subagent invocations one
invocation of that profile may start. Repeated calls to the same child count
separately, failed or cancelled calls still consume budget, and rejected calls
do not. Nested descendants consume both their immediate parent's budget and
every active ancestor budget. Kedi also applies a hard runtime ceiling of 100
descendant starts per profile invocation.

Each `delegate_task` call starts a fresh child conversation. The child uses its
own model, system instructions, tools, MCP servers, skills, and approval
policy; parent tools and local variables do not leak into it. The parent must
include all required context in the delegated `task`.

The generated tool accepts:

- `subagent`: one of the direct child profile names,
- `task`: a self-contained instruction,
- `final_schema`: an optional JSON Schema for a validated structured result;
  when omitted, the selected child profile's `> output:` type is used.
- `background`: when supported by the active adapter, start the child without
  blocking and return a run handle.

Without an explicit or profile-derived schema, the child runs through the raw
text `invoke` seam. With either schema source, Kedi asks for a short
`task_summary` plus the schema-conforming result and validates the response
again before returning it. The tool result
always includes `run_id`, `subagent`, `task_summary`, and `final_result`.

In delegate mode, every subagent-capable adapter also exposes
`continue_subagent`. It accepts a
completed `run_id`, a new `task`, and an optional `final_schema`, then creates
a new run in the same bounded child conversation. Only the latest completed
run may be continued, the calling profile must own that conversation, and one
conversation may contain at most eight completed turns. Native adapter resume
state is used when available; otherwise Kedi supplies the child with bounded,
verified prior results.

Pydantic AI, Claude, Codex, and LangChain profiles also expose
`wait_subagent`, `cancel_subagent`, and `subagent_status`. A background child
must be observed with `wait_subagent` before the parent returns; fail-closed
profiles reject unobserved work. Runtime timeouts start when the child starts,
not when it is first waited. Completed results may be waited more than once,
and cancellation is idempotent.

Live background tasks are process-local and runtime-owned. Old terminal
handles may expire after bounded retention.
DSPy keeps blocking `delegate_task` only because its synchronous tool bridge
does not guarantee that later lifecycle calls use the same event loop.

Python callers may opt into restart persistence with
`compile_program(..., subagent_state_path=...)` or
`KediRuntime(..., subagent_state_path=...)`. Kedi stores terminal run records,
validated results, bounded conversation turns, and serializable native resume
state in a versioned owner-only JSON file. Completed results and continuations
then survive a process restart. A run that was still pending or running when
the process stopped is restored as failed with `InterruptedError`; Kedi does
not claim to resume an in-flight provider request.

Adapters without child-execution support reject subagent delegation through
capability validation instead of silently ignoring it. Child execution uses
the same Kedi contract across supported adapters: isolated profile state,
scoped tools and approvals, generic usage limits, raw `invoke` output, and
schema-validated structured output.

### `> mcp:` semantics

Use `> mcp:` to load tools from an MCP server for the active agent scope:

```kedi
> mcp:
    transport: stdio
    command: vsh
    args: `["run", "--mcp"]`
    env: `{}`
```

String fields can be plain Kedi strings or inline Python expressions:

```kedi
> mcp:
    transport: `os.getenv("MCP_TRANSPORT")`
    command: `os.getenv("STDIO_COMMAND")`
    url: https://example.com/mcp
```

- `transport` must be `stdio`, `sse`, `http`, or `streamable-http`. If omitted
  and `command` is present, Kedi treats the directive as `stdio`. `http` is an
  alias for `streamable-http`; both use the same streamable HTTP transport.
- `stdio` servers require `command`; `args` must evaluate to a list of strings
  and `env` must evaluate to a string dictionary when present.
- `http` / `streamable-http` and `sse` servers require `url`; `headers` must
  evaluate to a string dictionary when present.
- MCP directives follow the same scoping model as `> model:` and `> system:`:
  top-level directives are captured by following procedures, profile members
  are applied when the profile is used, and procedure-body directives affect
  following prompt calls in that procedure.

DSPy currently uses the stdio MCP path through `dspy.Tool.from_mcp_tool` and
`ReAct.acall`.

### `> use:` semantics

Single-line form:

```kedi
> use: foo
> use: `web_fetch`
```

1. If a procedure named `foo` exists, register it as an **agent tool** for the
   current indentation block.
2. Otherwise merge the agent profile named `foo`.
Backticks on the single-line form are accepted for symmetry with `> model:`.

Multiline form always lists tools (never profiles):

```kedi
> use:
    web_browse
    `web_fetch`
```

Each entry names a Kedi procedure to expose as an agent tool. Backtick entries
are accepted for symmetry with `> model:`.

### One-file skills

Skills are opt-in instructions stored as one plain file per skill:

```text
.agents/skills/<skill-name>/SKILL.md
```

Enable them at top level, in a procedure, or in a profile:

```kedi
> skills: enabled
```

Use the expanded form to configure discovery:

```kedi
> skills:
    enabled: true
    cwd: workspace
    max_skills: 40
    include_registry: true
    include_all: false
    exclude_paths: `["~/.agents/skills"]`
```

Fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | required in expanded form | Enables or disables inherited skill discovery. |
| `cwd` | program source directory | Base directory used for the project-local `.agents/skills` source. Relative paths resolve from the program source directory. |
| `max_skills` | `20` | Maximum number of skill names exposed by this scope; valid range is 1 through 100. |
| `include_registry` | `true` | Includes `$KEDI_HOME/registry/skills` (normally `~/.kedi/registry/skills`). |
| `include_all` | `false` | When false, use the first source containing valid skills. When true, merge all sources while retaining precedence for duplicate names. |
| `exclude_paths` | `[]` | Files or directories excluded after `~` and relative-path resolution. Use an inline Python list. |

Sources are considered in this order:

1. `$KEDI_HOME/registry/skills`;
2. `<cwd>/.agents/skills`;
3. `~/.agents/skills`.

With `include_all: true`, names are merged and sorted for deterministic listing.
If the same name exists in more than one source, `read_skill` reads the copy
from the highest-priority source. `include_registry: false` removes only the
first source. `exclude_paths` can remove an entire source or one skill path.

This registers two read-only agent tools:

- `list_skills(all: bool = false, limit: int = 20)` returns available skill
  identifiers in deterministic order. Source merging is controlled by
  `include_all`; the `all` argument is retained for API compatibility.
- `read_skill(skill_name: str)` returns the exact UTF-8 `SKILL.md` content for
  one listed identifier.

Names outside the active scope's deterministic `max_skills` set cannot be read
by guessing their identifiers.

Skill instructions are never inserted into the model context automatically.
The agent must first list relevant skills, then explicitly read the one it
needs. Skill names are limited to one directory name; path traversal, absolute
paths, symlink escapes, and files larger than 256 KiB are rejected.

`> use:` remains exclusively a procedure-tool or profile-selection directive.
It does not enable skills. A real procedure or profile named `skills` retains
normal `> use: skills` behavior.

Install a local or GitHub-hosted one-file skill into the user Kedi registry:

```bash
kedi skills add --path ~/my-skill
kedi skills add --repo owner/skill-repository
```

The source directory or repository must contain `SKILL.md` at its root. Kedi
copies only that file into `~/.kedi/registry/skills/<name>/SKILL.md`. Repository
input is the credential-free `OWNER/REPOSITORY` form and records the checked-out
commit. Installation never writes into the current project.

### Large values and artifacts

Artifacts keep large generated fields and tool results out of model prompts
without changing their native Kedi or Python value. They are enabled by
default and can be configured at top level, inside a procedure, or in a profile:

```kedi
> artifacts:
    store: memory
    threshold: 100kb
    ttl: 1h
    idle_ttl: none
    preview_chars: 1200
    read_max_chars: 4000
    session_quota: 256mb
    max_artifacts: 128
    cleanup_interval: 1m
```

Artifact fields and defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enables artifact conversion in the current agent scope. |
| `store` | `memory` | Uses the process-local `memory` store or the bounded `file` store. |
| `path` | `.kedi/artifacts` | File-store root. It is ignored by the memory store. |
| `threshold` | `100kb` | Minimum serialized byte size converted into an artifact. |
| `ttl` | `1h` | Fixed lifetime measured from artifact creation. |
| `idle_ttl` | `none` | Optional lifetime measured from the last successful read. |
| `preview_chars` | `1200` | Maximum model-visible preview length. |
| `read_max_chars` | `4000` | Hard maximum returned by one `read_artifact` call. |
| `session_quota` | `256mb` | Maximum active payload bytes owned by one session. |
| `max_artifacts` | `128` | Maximum active artifact records owned by one session. |
| `cleanup_interval` | `1m` | Background and lazy expiry-check interval. |

Byte fields accept `b`, `kb`, `mb`, `gb`, `kib`, `mib`, and `gib`. Duration
fields accept `ms`, `s`, `m`, `h`, and `d`. Inline Python is supported where a
runtime value is needed:

```kedi
> artifacts:
    enabled: true
    threshold: `args.artifact_threshold`
    ttl: `timedelta(minutes=30)`
```

The policy is lexical. A nested directive changes subsequent calls in that
scope, and `enabled: false` explicitly disables an inherited policy:

```kedi
> profile: compact:
    > adapter: pydantic
    > artifacts:
        enabled: true
        threshold: 64kb

@small_response():
    > artifacts:
        enabled: false
    >> Return a short [answer].
    = `answer`
```

#### Native values and model-visible references

Artifact conversion occurs only after a generated field has passed its normal
Kedi type validation. Each output field is measured independently. A large
successful tool result is handled after approval and tool execution:

```text
approval -> tool call -> validation/measurement -> artifact store -> compact ref
```

The backing Kedi environment keeps an internal lazy handle. Native Kedi and
Python reads resolve that handle to the original typed value:

```kedi
> artifacts:
    enabled: true
    threshold: 1b

>> Produce a detailed [report].

# Python receives the complete native string, not ArtifactRef.
= `report.upper()`
```

Substituting the same value into another model prompt does not load the payload.
The model sees an `ArtifactRef` containing only its ID, logical/media types,
bounded summary and preview, size, timestamps, and sensitivity flag:

```kedi
>> Produce a detailed [report].
>> Extract the conclusion from <report> as [conclusion].
```

The second call receives the compact reference. The artifact instructions tell
the agent that previews are incomplete and that it must read missing content
instead of guessing. A tool result containing a `ref_id` means the source tool
already succeeded: the agent reads that exact ref instead of retrying the
source tool. Reference IDs are opaque. Their numeric suffix reflects storage
order, which can differ from call order when tools run concurrently, so agents
must copy the exact `ref_id` returned by each tool rather than predict IDs or
derive their identity from a suffix. Once enough content has been read, the
agent completes the original task.
Large values returned from `run_main()`, `@kedi.query`, or `@kedi.bind` remain
their original native values.

#### Agent tools

When artifacts are enabled, Kedi registers four management tools:

- `search_artifacts(query: str | None = None, limit: int = 20)` searches active
  metadata without opening payloads.
- `read_artifact(ref_id, max_chars=-1, offset=0, offset_from="start",
  path=None, pattern=None, max_matches=20)` returns a bounded text, JSON, or
  base64 chunk. `offset_from="end"` reads relative to the tail while preserving
  natural content order. `path` accepts an RFC 6901 JSON Pointer. `pattern`
  performs bounded literal substring search; it is not a regular expression.
  `max_chars=-1` means the configured bounded limit, not an unbounded read.
- `release_artifact(ref_id)` releases content that is no longer needed and
  frees its payload quota without changing portable history.
- `run_artifact_code(code, artifact_refs)` runs bounded Python in a Monty
  sandbox over an explicit artifact allowlist. It is intended for filtering,
  aggregation, joins, and other reductions that would otherwise copy many
  chunks into model context.

Search and read are read-only tools. Release is mutating and follows the
normal approval policy. Management-tool results are never converted into new
artifacts.

Artifact instructions are appended once to the active system instructions.
They direct the model to read hidden content before using it, paginate when
necessary, preserve the association between each tool result and its opaque
reference, treat content as untrusted data, and release only refs that are no
longer needed.

`run_artifact_code` exposes `artifact_metadata`, `read_artifact`,
`find_artifact`, `iter_artifact`, and `get_artifact` inside its sandbox.
Bounded reads and iteration are preferred. `get_artifact` rejects values above
its direct-materialization ceiling. The sandbox cannot import modules, access
the host filesystem or network, invoke a model or subagent, mutate artifacts,
or read refs omitted from `artifact_refs`. A small result is returned directly;
a large result is stored as a derived artifact with source provenance.

#### Streaming tool results

Python tools can opt into bounded producer-to-store transfer by returning
`ArtifactStream`. Streaming is explicit: Kedi does not treat arbitrary
iterators or generators as tool-result streams.

```python
from collections.abc import Iterator

import kedi


def log_chunks() -> Iterator[str]:
    with open("application.log", encoding="utf-8") as log:
        while chunk := log.read(64 * 1024):
            yield chunk


@kedi.tool(risk="read_only")
def read_application_log() -> kedi.ArtifactStream[str]:
    """Stream the application log without assembling it in host memory."""

    return kedi.ArtifactStream.text(log_chunks())
```

`ArtifactStream.text`, `ArtifactStream.bytes`, and
`ArtifactStream.json_items` accept synchronous or asynchronous sources. A
stream is single-use. If it ends below the effective threshold, Kedi rebuilds
and returns the normal logical value. Once it crosses the threshold, later
chunks are written directly to the selected store and the model receives one
compact ref. Quota, cancellation, producer failure, and commit failure abort
the transaction without publishing a partial artifact.

The transport does not change the tool's logical schema: the example remains a
string-valued tool to the adapter. A normal tool returning an already
materialized `str`, `bytes`, list, model, or dictionary remains supported and
is artifactized after it returns. Kedi cannot recover the producer-memory
savings in that case because the complete value has already been allocated.
Use `ArtifactStream` when producer memory matters.

Kedi's bundled `filesystem.read_text_file` and skill `read_skill` tools already
use this transport. Direct Kedi/Python calls still receive their declared
native `str` value; only adapter tool execution switches to the incremental
transport. Bounded metadata and directory-listing tools stay materialized
because their outputs are capped, while sandbox and subagent tools are admitted
after completion because those producers expose only a completed result.

File-backed artifacts provide actual payload memory offload. Agent reads,
literal search, and CodeMode iteration use bounded store operations and do not
materialize the complete payload. The memory store intentionally retains the
native value and is best for smaller process-local sessions.

Even when `enabled: false` is selected explicitly, Kedi does not permit an
unbounded tool result to enter model history. Small results remain inline;
oversized results fail with a compact `ToolOutputTooLargeError` that asks the
caller to narrow the operation or enable artifacts. The rejected payload is
not included in the error or telemetry.

#### Storage, lifetime, and history

The memory store accepts JSON-compatible values and process-local opaque Python
objects. Serializable mutable values are snapshotted when stored; an opaque
object remains a live process-local value and cannot be persisted.

The file store persists only supported text, bytes, JSON, Pydantic, and
dataclass snapshots. It does not use pickle or import arbitrary classes while
loading data. Paths are confined to the configured root, symlink escapes are
rejected, and payload/metadata writes are atomic.

Every ref belongs to one artifact session. A different session cannot read it.
Fixed TTL never moves; optional idle TTL is refreshed by successful access.
Release is idempotent. A read already holding a lease may finish while release
is pending, but later reads receive a precise released or expired error.
Expired records are removed lazily and by one process-level cleanup service;
Kedi does not create one cleanup thread per runtime.

Portable conversation history stores compact refs and bounded read chunks, not
raw artifact payloads. History is append-only within a cache epoch: releasing
or expiring a ref removes its payload and quota usage, but does not delete,
rewrite, or reorder earlier messages and does not invalidate provider-native
checkpoints. The store retains lightweight metadata so stale refs still produce
precise released or expired errors. A newly emitted Pydantic provider-compaction
checkpoint starts a new cache epoch while preserving the compacted state;
artifact lifecycle operations never do. Kedi-owned summarizing compaction is a
separate future feature.

Kedi remains stateless by default. DSL programs can opt into runtime-owned
history with `> history: enabled`. Python callers can instead use an explicit
session when they need direct lifecycle control over model history and artifact
ownership:

```python
import kedi

kedi.configure(
    adapter="pydantic",
    artifacts={"enabled": True, "threshold": "100kb", "ttl": "1h"},
)

with kedi.session() as conversation:
    first_result = create_report()
    second_result = review_report()
```

The same `ConversationState` can be supplied to another `kedi.session(state)`
scope while it remains open. Exiting the session closes its owned artifact
manager. A DSL `> history: enabled` conversation is bounded by its
`KediRuntime`; it is not persisted between separate CLI processes.

#### Adapter support

All artifact-aware adapters use the same compact ref and management-tool
schemas. Stateful replay is a separate capability:

| Adapter | Compact Kedi artifacts | Native/MCP admission | Stateful history |
| --- | --- | --- | --- |
| Pydantic AI | Yes | Yes | Yes |
| Claude Agent SDK | Yes | No | Yes |
| Codex App Server | Yes | No | Yes |
| LangChain | Yes | Yes | Yes |
| DSPy | Yes | No | No |
| WebGPU | Yes | No | No |
| ACP | No | No | No |

The LSP derives diagnostics from these capability flags. Enabling artifacts
with an adapter that cannot carry compact refs and register the bounded
management tools produces a targeted capability diagnostic rather than
silently leaking the full value. Stateful history is independent: adapters
without it can still use artifacts within one run, but cannot resume compacted
conversation state across calls.

For Pydantic AI and LangChain, native constructor tools and local MCP tools use
the same admission policy as Kedi `ToolSpec` tools. Large successful values are
replaced by compact refs before the framework records its tool-result message.
The framework's original call ID remains the artifact-history call ID. Error
messages are not converted into artifacts, and tools already wrapped by Kedi are
not admitted a second time.

Artifact metadata, summaries, and bounded chunks may appear in traces when
instrumentation is enabled. Raw stored payloads are not attached to artifact
events. Sensitive application data still requires an appropriate store root,
TTL, approval policy, and telemetry configuration.

### Scoping rules

- Tool registrations apply only inside the indentation block where `> use:` appears.
- When a procedure exits, the previous tool frame is restored.
- An inner `> use: bar` overrides an outer `bar` tool for that inner block only.
- Procedure names take precedence over profile names for single-line `> use:`.

Example:

```kedi
@bar():
    = something

> use: bar

@foo():
    > use: bar
    >> inner scope uses the inner bar tool
    = done

>> outer scope still uses the top-level bar procedure as a tool
```

Agent tools require an adapter that supports tool registration (for example
Pydantic AI). Adapters without tool support surface capability warnings in the
LSP; harness adapters that cannot accept external tools may ignore registrations
until their underlying protocol gains tool support.

### Tool approval and sensitive files

Kedi classifies tool calls as `read_only`, `mutating`, or `sensitive`. Custom
Python tools default to `mutating`; choose a different classification with the
Python API when appropriate:

```python
@kedi.tool(risk="read_only")
def list_public_files() -> list[str]:
    ...
```

The bundled filesystem module treats normal reads as read-only, but refuses
`.env` and `.env.*` files by default. Requesting one requires
`secret_files=True`, which upgrades that call to sensitive and therefore needs
an explicit `allow` policy or a dynamic approval decision.

## Python API

Kedi can be embedded in Python without creating a separate CLI entrypoint. The
Python API keeps the same DSL semantics: templates, `> use:`, profiles,
settings, typed outputs, Python substitutions, and custom Kedi types still work.

### `@kedi.query`

Decorate a Python function whose docstring starts with a standalone `kedi`
header. Function arguments become runtime globals for the Kedi program.

```python
import kedi


@kedi.type
class Review:
    decision: str
    summary: str


@kedi.query(cache=True, settings={"temperature": 0.2})
def review_snippet(language: str, code: str) -> Review:
    """kedi
    >> Review this <language> snippet.
    Return [review: Review].
    = `review`
    """
    ...
```

Rules:
- The Python function body is not executed; it exists for signature, type, and
  docstring metadata.
- Use backtick returns for native typed values. ``= `review` `` returns the
  `Review` object; ``= <review>`` stringifies it.
- Function parameters, defaults, configured `env`, registered tools, and
  auto-injected `@kedi.type` classes are available to inline Python
  substitutions such as ``[output: `output_type`]``.
- `cache=True` enables response caching for identical source, arguments, and
  env. Parse caching is always keyed by the exact source hash.
- `model=`, `adapter=`, and `agent=` override the configured backend only for
  that callable. Use `adapter=` for frameworks (`pydantic`, `dspy`,
  `langchain`) and `agent=` for harnesses (`claude`, `codex`, `acp`).
- `approval=` accepts `"allow"`, `"deny"`, an `ApprovalPolicy`, or a callable.
  `query` and `bind` apply it only to that callable's registered tools.
- `skills=True` on `kedi.configure`, `kedi.context`, `@kedi.query`, or
  `@kedi.bind` enables the same explicit `list_skills` / `read_skill` tools as
  `> skills: enabled`. Pass `SkillsSettings(...)` instead of `True` to configure
  the same source, limit, and exclusion policy from Python.
- Artifact handling is enabled by default. A mapping such as
  `artifacts={"threshold": "100kb", "ttl": "1h"}` applies the same policy
  fields as `> artifacts:`. Pass `artifacts=False` in a nested
  context or callable to disable an inherited policy.
- `conversation=` accepts a `ConversationState` when calls must reuse portable
  history and artifact ownership. Prefer `with kedi.session():` for bounded
  lifecycle management.
- `@kedi.approval` registers a callable as the current Python API's default
  dynamic policy, equivalent to configuring that handler for subsequent calls.
  An explicit `approval=` on `query`, `bind`, or `kedi.context(...)` takes
  precedence in that scope.
- `@kedi.on("event")` registers a lifecycle handler in the current Python API
  configuration. The first argument may be one event name or a sequence, so
  one observer can handle multiple events. Adapter instances expose the same
  decorator through `@adapter.on(...)`; their constructors also accept one
  catch-all `hook_handler=` callable.

  ```python
  import kedi


  @kedi.on(("post_tool_use", "post_tool_use_failure"))
  def audit_tool_terminal_event(event):
      record(event.event, event.tool_name, event.tool_call_id)
  ```

  Events include `run_id`, monotonic per-run `sequence`, adapter identity, and
  optional parent/agent/profile identity. Tool events additionally include
  `tool_call_id`, logical/native names, origin, immutable arguments,
  description, and immutable metadata. Success events carry `result`; failure
  events carry the exception type and message, observed execution duration,
  and interruption state. These payloads are available to handlers but are
  excluded from event repr and default telemetry.

Dynamic output types can be passed as normal Python values:

```python
from typing import TypeVar

T = TypeVar("T")


@kedi.query
def extract_output(*, text: str, output_type: type[T]) -> T:
    """kedi
    >> Extract [output: `output_type`] from <text>.
    = `output`
    """
    ...
```

Low-level adapters expose the same structured-output operation directly through
`produce()` / `produce_sync()`. Here, `template` is ordinary prompt text; it does
not need to contain Kedi output placeholders. Pass either a field mapping through
`output_schema` or one prebuilt Python type through `output_type`:

```python
from typing import Annotated

from pydantic import BaseModel


class Review(BaseModel):
    accepted: bool
    reason: str


fields = await adapter.produce(
    template="Evaluate whether this proposal is safe.",
    output_schema={
        "accepted": Annotated[bool, "Whether the proposal is safe"],
        "reason": Annotated[str, "Short justification for the decision"],
    },
)
review = await adapter.produce(
    template="Evaluate whether this proposal is safe.",
    output_type=Review,
)
```

For `output_schema`, `Annotated[type, "description"]` keeps `type` as the field
type and publishes the second argument as the model-facing field description.
Adapters with structured-output support accept both forms; supplying a schema
takes precedence over a prebuilt type. An adapter must receive at least one output
specification. ACP currently advertises no structured-output capability, so its
`produce()` surface raises `NotImplementedError` for either form.

### Agent adapter capability contract

Custom adapters must advertise behavior they enforce, not only methods they
expose:

- `stateful_history` requires a conversation scope. The adapter reads only the
  supplied resume state, stages the next continuation and cleanup in that scope,
  and marks the scope completed only after a terminal successful result has been
  captured. Failure, cancellation, deferred handoff, and an early-closed native
  iterator or stream must leave the last committed continuation unchanged.
- `history_replay` additionally requires a complete replayable native history.
  Tool calls and results retain their causal IDs and ordering; a provider session
  or thread ID alone is stateful continuation, not replay support.
- `artifacts` means the adapter can carry compact Kedi artifact references and
  register their management tools. `native_artifacts` is stronger: every
  successful adapter-native and MCP tool result crosses artifact admission before
  model-visible history is committed. Error results remain errors, and native
  tool-call IDs are preserved.
- Native run, iterator, and stream methods keep their framework input types and
  call-specific keyword arguments. Adapter lowering must not coerce those public
  APIs into Kedi's string-only template path.
- Continuation payloads, live clients, cleanup callbacks, and provider messages
  stay in the adapter conversation scope. They are not inserted into prompts,
  request diagnostics, or telemetry attributes.

Changing adapter, model, incompatible settings, MCP configuration, or the
semantic tool contract starts a compatible continuation lane. Adapter authors
should test successful commit, failure and cancellation rollback, early close,
tool-call causality, cleanup replacement, and cache-epoch rotation before
enabling the corresponding capability flags.

### `@kedi.bind`

Use `bind` when the Kedi implementation should live in a `.kedi` file while
Python owns the call signature.

```python
@kedi.bind(file="summarize.kedi", cache=True, reload=True)
def summarize(topic: str) -> str:
    ...
```

`summarize.kedi`:

```kedi
>> Summarize <topic> for <audience>.
Return [summary].

= <summary>
```

The Python body is only a stub; the `.kedi` file is the implementation.

Rules:
- Relative files resolve from the Python source file that defines the bound
  function.
- The bound function body is ignored.
- `reload=True` rereads and reparses the file on each call when the source hash
  changes. Without `reload=True`, the file is read when the decorator runs.
- `bind` accepts the same profile override parameters as `query`: `model`,
  `adapter`, `agent`, `system`, `effort`, `settings`, `tools`, `env`,
  `mcp_servers`, `approval`, `skills`, `artifacts`, `conversation`, and
  `cache`.

### Native Pydantic AI integration

`PydanticAdapter` is also a native `pydantic_ai.Agent`. Calls through its
`run`, `run_sync`, `iter`, `run_stream`, and `run_stream_sync` methods retain
the active Kedi profile instead of bypassing it. Profile instructions, model
and effort overrides, model settings, scoped tools, MCP toolsets, required-tool
validation, approvals, and adapter telemetry therefore behave the same way on
the native surface.

The native precedence rules are explicit:

- per-call instructions override the profile system instruction;
- profile model settings override conflicting per-call settings;
- per-call Pydantic toolsets are retained and active Kedi/MCP toolsets are
  appended;
- caller capabilities are retained and each required Kedi capability is
  appended at most once.

Codex-authenticated Pydantic models can also be built directly. The returned
object is a normal Pydantic AI `Model`, so native `PydanticAdapter` tools,
structured outputs, profiles, and effort settings remain active:

```python
from kedi import codex_responses_model
from kedi.agent_adapter import PydanticAdapter

model = codex_responses_model("gpt-5.6-luna", adapter="pydantic")
adapter = PydanticAdapter(model)
```

This bridge requires Python 3.11+ and `codex-auth-helper==1.6.1`, installed with
`uv add 'kedi[codex-model]'`. Authentication comes from the user's Codex login;
Kedi does not accept or persist a second token for this path.

Enable the Kedi-owned CodeMode capability from any supported adapter
constructor. Native Pydantic runs additionally expose a single-run capability:

```python
from kedi.agent_adapter import (
    PydanticAdapter,
    PydanticCodeModeCapability,
)

adapter = PydanticAdapter(model, codemode=True)

# Equivalent for one native Pydantic run:
result = adapter.run_sync(
    "Inspect the available tools and complete the task.",
    capabilities=[PydanticCodeModeCapability()],
)
```

The capability wraps the fully assembled Pydantic toolset, including
constructor tools, caller toolsets, active Kedi tools, and local MCP tools.
Application schemas are disclosed only after an exact `get_tool_schema` call.
The Monty session is isolated to one agent run, persists across that run's
model steps, supports `restart=True`, and closes on success, error, early close,
or cancellation. Native provider tools that are not ordinary callable toolset
members remain framework-owned; provider-native MCP is rejected while CodeMode
is active.

`LangChainAdapter`, `ClaudeAdapter`, and `CodexAdapter` accept the same
`codemode=True` constructor argument. The native `PydanticCodeModeCapability`
class is intentionally Pydantic-specific; the DSL and adapter-level behavior
are not.

Use the public adapter-specific converters when a native Pydantic agent needs
Kedi `ToolSpec` values:

```python
from kedi.agent_adapter import (
    ToolSpec,
    pydantic_tool_from_spec,
    pydantic_toolset_from_specs,
)


def lookup(topic: str) -> str:
    return f"Result for {topic}"


spec = ToolSpec(
    fn=lookup,
    name="lookup",
    description="Look up a topic.",
    json_schema={
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "description": "Topic to look up.",
            }
        },
        "required": ["topic"],
    },
    metadata={"source": "docs"},
)
native_tool = pydantic_tool_from_spec(spec)
native_toolset = pydantic_toolset_from_specs([spec])
```

The conversion preserves the name, descriptions, JSON schema, metadata,
sequential-execution flag, Kedi argument validation, and sync or async callable
behavior. When the converted tool or toolset is supplied to a
`PydanticAdapter`, it also preserves Kedi run-level semantics such as dynamic
risk resolution, approval edits, and `required_before_output` validation.

`PydanticAdapter(..., approval_resolution="kedi")` is the default and resolves
approval-required calls with the active Kedi policy. Set
`approval_resolution="external"` when an outer controller owns the permission
exchange. Tools remain approval-required, but the adapter returns Pydantic AI's
`DeferredToolRequests` instead of consuming them; the outer controller must add
that output type and resume the run with `DeferredToolResults`. This is the mode
used by integrations such as ACP runtimes. Deferred calls carry canonical Kedi
arguments plus resolved risk, description, and metadata. Use
`pydantic_approval_request_from_deferred()` to restore the typed
`ApprovalRequest`, then `pydantic_deferred_results_from_decisions()` to validate
allow, deny, or edited decisions before resuming the run. Edited arguments pass
through the original `ToolSpec.argument_validator` again. Conversation capture,
artifact ownership, skills discovery, and subagent coordination still require
an explicit `KediRuntime` owner.

An external controller should retain the exact `ToolSpec` values used for the
run and use the Kedi helpers for the complete permission round trip:

```python
from typing import cast

from pydantic_ai.tools import DeferredToolRequests

from kedi.agent_adapter import (
    PydanticAdapter,
    pydantic_approval_request_from_deferred,
    pydantic_deferred_results_from_decisions,
    pydantic_toolset_from_specs,
)
from kedi.agent_adapter.approval import ApprovalDecision

tool_specs = [spec]
toolsets = [pydantic_toolset_from_specs(tool_specs)]
adapter = PydanticAdapter(model, approval_resolution="external")

first = adapter.run_sync(
    "Look up the topic.",
    output_type=[str, DeferredToolRequests],
    toolsets=toolsets,
)
pending = cast(DeferredToolRequests, first.output)
call = pending.approvals[0]
request = pydantic_approval_request_from_deferred(pending, call.tool_call_id)

# Present `request` to the permission controller. It contains canonical
# arguments, resolved risk, description, and metadata.
decision = ApprovalDecision.edit({"topic": "Kedi language"})
results = pydantic_deferred_results_from_decisions(
    pending,
    {call.tool_call_id: decision},
    tool_specs=tool_specs,
)

resumed = adapter.run_sync(
    None,
    output_type=[str, DeferredToolRequests],
    message_history=first.all_messages(),
    deferred_tool_results=results,
    toolsets=toolsets,
)
```

Do not use `DeferredToolRequests.build_results()` directly for edited Kedi
tools. That generic Pydantic API cannot run the original Kedi
`argument_validator`; the helper needs the retained `tool_specs` list to do so
before constructing `DeferredToolResults`.

### Agent Stream Events

Kedi exposes an adapter-neutral event stream for completed semantic agent
messages. It is deliberately not a token stream: provider deltas, mutable
snapshots, and hidden reasoning remain private until the adapter identifies a
complete assistant message. Consumers therefore receive stable commentary and
final text without reconstructing provider-specific chunks.

Observation is a side channel and does not replace the adapter result:

```python
import asyncio

from kedi import AgentMessageEvent, AgentRunStateEvent, observe_agent_events
from kedi.agent_adapter import PydanticAdapter

events = []
adapter = PydanticAdapter("openai:gpt-4o-mini")

with observe_agent_events(events.append):
    result = asyncio.run(adapter.invoke(prompt="Inspect the parser."))

for event in events:
    if isinstance(event, AgentMessageEvent):
        print(event.phase, event.content)
    elif isinstance(event, AgentRunStateEvent):
        print(event.state)
```

The result remains the authoritative return value. Event delivery does not
change prompts, tools, schemas, history, usage accounting, or exceptions.
`AsyncAgentEventQueue` is available when an async UI needs a thread-safe queue
sink instead of a callback.

For a tool-backed `invoke()`, a typical observable sequence is:

```text
started
commentary  Checking the registry.
final       The requested value is ready.
completed
```

The tool executes between the commentary and final messages. This API does not
publish a separate tool-call event: the tool boundary seals preceding completed
assistant text as commentary, while text produced after the tool result becomes
the authoritative final response. Tool execution remains available through the
adapter's normal tool and telemetry surfaces.

The public event contract is:

- every observed run emits `started` and exactly one terminal state:
  `completed`, `failed`, or `cancelled`;
- `AgentMessageEvent.phase` is either `commentary` or `final`;
- only completed semantic messages are published, never token deltas;
- `invoke()` may emit one authoritative final message after successful
  completion;
- structured `produce()` does not publish its schema payload as natural-
  language final text;
- tool boundaries can resolve earlier completed text as commentary;
- subagent events use the coordinator run ID and carry `parent_run_id`, so
  concurrent child runs can be rendered independently;
- sink failures are isolated from model execution, and a slow sink cannot
  block provider or SDK reader threads indefinitely.

Stream support is capability-driven. Pydantic AI, LangChain, Claude Agent SDK,
Codex App Server, and ACP currently expose semantic events. DSPy and WebGPU do
not yet provide trustworthy completed-message boundaries and advertise
`supports_stream_events=False`. `LazyAdapter` reports the capability of the
adapter it resolves.

### Configuration and Context

Configure defaults once:

```python
kedi.configure(
    model="openrouter:google/gemini-3-flash-preview",
    adapter="pydantic",
    system="Use tools when they are relevant.",
    effort="low",
    settings={"temperature": 0.2},
    tools=[search_docs],
    approval="allow",
    skills=True,
    artifacts={"enabled": True, "threshold": "100kb", "ttl": "1h"},
    env={"audience": "maintainers"},
)
```

Framework adapters and agent harnesses use separate parameters:

```python
kedi.configure(adapter="pydantic", model="openai:gpt-4o-mini")

with kedi.context(agent="codex", model="gpt-5"):
    run_task()
```

`adapter=` accepts agent frameworks (`pydantic`, `dspy`, `langchain`);
`agent=` accepts agent harnesses (`claude`, `codex`, `acp`). Passing both is an
error. Adapter instances follow the same rule according to their `kind`
metadata.

If no backend is passed explicitly, `configure()` reads `KEDI_AGENT` or
`KEDI_ADAPTER` after loading `.env`; the two variables are mutually exclusive.
`KEDI_ADAPTER_MODEL` supplies the model for either selection. `kedi.context(...)`
temporarily merges the same options and restores the previous configuration
when the block exits. It supports both sync and async context managers.

### Incremental Execution

`kedi.interactive()` executes complete Kedi fragments in one process-local
runtime. Values, procedures, types, imports, profiles, directives, conversation
state, and artifacts remain available to later fragments. Earlier fragments are
not concatenated or replayed:

```python
import kedi


with kedi.interactive() as session:
    session.execute("[base: int] = `40`")
    session.execute(
        """
@add_two() -> int:
    = `base + 2`
""".strip()
    )
    assert session.execute("= `add_two()`") == 42
```

`execute()` returns the same native-value boundary as `run_main()`: an `int`
remains an `int`, and an explicit Kedi string-rendering expression remains the
way to request rendered text. A fragment without a top-level return produces
`None`.

Every fragment receives a distinct traceback identity such as
`<interactive:1>`. Pass `source_name=` when an editor or notebook has a better
identity. A real source path also becomes the base for relative imports;
otherwise imports resolve from the session's `cwd` (the process working
directory by default):

```python
with kedi.interactive(cwd="examples/cells") as session:
    session.execute(
        "> import: helpers\n= `answer`",
        source_name="answer.kedi",
    )
```

The execution model is synchronous and intentionally non-transactional. State
and external side effects completed before an error remain visible, while the
failed fragment is never retried automatically. A session rejects concurrent
or re-entrant `execute()` calls and cannot execute after `close()`.

#### Local Notebook

`kedi notebook` serves a local browser notebook backed by `InteractiveSession`.
The web package is optional and currently runs from a Kedi source checkout:

```bash
uv run --extra notebook kedi notebook
```

This one command resolves the checked-out `notebook` submodule, installs the
local extra, and starts the server. It does not depend on a published notebook
distribution.

The command listens on `127.0.0.1:8788` and opens the notebook in the default
browser. Use `--host`, `--port`, `--cwd`, or `--no-open` to change the local
serve behavior. Binding a non-loopback host requires `--token` or
`KEDI_NOTEBOOK_TOKEN`; all notebook API and bridge requests then require that
token.

The notebook server loads `.env` from `--cwd` at startup without overriding
existing process variables. Configure `KEDI_ADAPTER_MODEL` there or select a
model with `> model:` in an earlier Kedi cell. Calling `load_dotenv()` inside a
host Python cell changes only its isolated worker process, not the server that
owns agent adapters; browser Python cannot read the host project's `.env`.

Use **Secret Manager** in the notebook top bar to configure model names,
provider credentials, and other environment values without placing them in a
notebook. It stores values in `~/.kedi/notebook/secrets.json` with user-only
permissions and exposes only configured names to the browser. Values may be
entered individually or imported from an explicit `.env` path; relative paths
resolve from `--cwd`. Secret Manager values override process and project `.env`
values. Any change closes active runtime sessions so subsequent cells inherit
the updated environment. Values and imported `.env` contents do not enter
browser storage.

Browser-owned Pyodide 3.14 is the default Python executor. The notebook also
discovers compatible Python installations on the host and lists them in the
runtime selector. An explicit executable can be prioritized at startup; pass
`--python` more than once to add multiple paths:

```bash
kedi notebook --python /opt/homebrew/bin/python3.11
kedi notebook --python ~/.pyenv/versions/3.12.4/bin/python --port 8899
```

Selecting host Python does not install packages into that interpreter. Kedi
creates a persistent virtual environment named `kedi-notebook-py...` under
`~/.kedi/notebook/venvs`, keyed by the selected interpreter and notebook
working directory. The first host session installs the active Kedi checkout
and its runtime dependencies; later sessions reuse the environment while it is
valid. Set `KEDI_NOTEBOOK_ENV_HOME` to move this environment store.

The package action beside a selected host runtime lists installed distributions
and installs one or more requirement strings into the managed environment.
Installation output streams in the dialog. `!python` and `!pip` terminal cells
use the same managed environment, so packages installed by either surface are
available to later cells and later notebook server runs for that project.

The Kedi compiler and `InteractiveSession` remain in the notebook server. In
browser mode embedded Python operations are bridged to one persistent Pyodide
worker. In host mode they are bridged to one persistent worker launched by the
managed environment's executable, so Python objects remain available to later
cells without modifying the selected base interpreter.

The browser runtime begins loading when the page opens rather than when the
first cell is run. Its worker and installed packages remain available for the
life of the runtime session. Resetting the runtime deliberately creates a new
worker and discards that browser-owned Python state. The Pyodide interpreter,
standard library, Micropip, and Pydantic wheels are vendored with Kedi Notebook,
so core browser-runtime startup does not depend on jsDelivr. Packages installed
later with Micropip can still require network access.

The download action offers **Just notebook** and **Save progress**. The first
stores sources and cell layout without execution output or environment values.
The second additionally stores retained outputs/results and a strict,
pickle-free snapshot of the current Kedi `InteractiveSession`, including its
KediEnv. Secret Manager and process environment values are never included.
Opening a progress file restores the logical Kedi session on the next
execution. If a live session value cannot be represented without changing its
semantics, saving progress fails instead of writing a partial snapshot.

A source cell whose first non-whitespace character is `!` is a terminal cell.
In host mode commands run in the notebook working directory. `!python` and
`!pip` are bound to the selected host interpreter; other commands use the local
shell. In browser mode there is no operating-system shell. The supported
commands are `!pip install`, `!uv add`, `!pip list`, `!echo`, and `!pwd`.
Browser `!uv add` installs into the current Pyodide worker and does not modify
project dependency files.

Kedi cells run in source order. A successful cell keeps its source editor and
shows its output immediately below the source. It can be edited and run again;
each rerun is a new incremental execution against the current runtime state.
Execution never appends an empty cell automatically. Only one active cell is
sent to the runtime at a time. Markdown cells do not alter runtime state.
Terminal cells share the selected Python runtime with Kedi cells. Displayed
cell numbers follow notebook order and remain stable across reruns; inserting,
moving, or deleting cells recomputes the affected positions. Terminal cells
stream standard output and standard error into their output area while running.
Creating or opening a notebook document does not execute its cells, and the UI
has no hidden replay or implicit run-all path. The downloaded `.kedinb` document
contains source cells, not a serialized Python process.

Moving focus does not collapse cells or replace their editors with plaintext;
all visible cells remain editable, highlighted, and independently runnable.
Each cell header can convert that cell between Kedi, Markdown, and Terminal.
The eye control explicitly hides a cell when compact presentation is wanted;
the remaining row shows its hidden state and provides the corresponding show
action. This explicit hidden state is persisted in local drafts and `.kedinb`
documents.

The interrupt action terminates and replaces the current worker; source remains
editable, but the interrupted runtime state is intentionally discarded. Host
execution also has a 120-second limit, and abandoned sessions expire after 30
minutes. Notebook files, cell source, and retained inline output have explicit
size limits so a local document or verbose command cannot grow the browser
state without a bound.

The Kedi editor provides live Kedi and embedded-Python diagnostics, completion,
hover, references, rename, signature help, definition navigation, and runtime
error markers. A rename that would cross into an earlier notebook cell is
rejected rather than applying a partial edit. `Shift+Enter` runs the active cell;
save, insert, delete, and move commands are available from both the toolbar and
keyboard. Markdown rendering supports common text, list, quote, link, and code
constructs while keeping raw HTML disabled.

Execution is non-transactional, just like direct `InteractiveSession.execute()`.
If a cell performs a side effect or creates a binding before a later statement
fails, that completed state can remain in the session. Rerunning a successful
or failed cell is a new execution attempt rather than a rollback.
Starting a new runtime session clears live execution state and marks Kedi cells
as unexecuted.

#### Durable Session Snapshots

`kedi.dump_session(session, path)` persists a complete, pickle-free snapshot
when every part of the logical session state can be restored without replaying
executable fragments. `kedi.load_session(path)` recompiles source-backed
declarations, restores their native values, and continues with the next cell.
The corresponding `InteractiveSession.dump()` and
`InteractiveSession.load()` methods expose the same operations:

```python
from pathlib import Path

import kedi


snapshot = Path("work.kedi-state")
with kedi.interactive() as session:
    session.execute("[base: int] = `40`")
    session.execute(
        """
@add_two() -> int:
    = `base + 2`
""".strip()
    )
    kedi.dump_session(session, snapshot)

with kedi.load_session(snapshot) as session:
    assert session.execute("= `add_two()`") == 42
```

Snapshots are strict and all-or-nothing. Before touching the destination,
`dump()` validates every fragment, environment binding, active profile,
conversation, and artifact boundary. If any value is not portable,
`SessionDumpError` lists the rejected state and no partial snapshot is
published. An existing destination remains unchanged. Successful writes use a
same-directory temporary file, `fsync`, and atomic replacement with mode
`0600`.

The value codec preserves scalar values, bytes, complex and decimal numbers,
UUIDs, dates and times, paths, regular expressions, lists, tuples, sets,
frozen sets, dictionaries with typed keys, and instances of source-backed Kedi
types. Procedure, type, and profile definitions are rebuilt from the source
stored in the snapshot. Fragment source digests and a document integrity hash
are verified during load. Snapshot format and Kedi versions must match.

The following state is rejected rather than silently dropped or changed:

- arbitrary Python callables, classes, generators, file/socket handles,
  threads, locks, tasks, futures, and unknown object instances;
- shared or cyclic mutable object graphs whose identity would be lost;
- dynamic approval handlers, non-importable lifecycle hook handlers,
  process-bound tool/profile bindings, active artifacts, conversation turns,
  and adapter-native continuation state;
- imports and inline Python preludes, because rebuilding them would rerun
  module or Python initialization;
- runtime-scoped procedure/type declarations and type defaults that require
  Python execution.

Adapters and executors are infrastructure rather than serialized state. Pass
them explicitly when restoring a snapshot that needs them:

```python
session = kedi.load_session(
    "work.kedi-state",
    adapter=adapter,
    executor=executor,
)
```

`load_session()` also accepts a keyword-only `session_type=` factory, which
defaults to `InteractiveSession`. Pass an `InteractiveSession` subclass when
the restored object needs application-specific session behavior.

Lifecycle hooks use module and qualified-name descriptors rather than pickle.
Only importable top-level functions are restorable; lambdas, local functions,
closures, bound methods, and handlers from `__main__` reject the dump. Load only
trusted snapshots: resolving a hook imports its Python module and may run that
module's ordinary import-time code, although the hook itself is not called.

`dump()` also rejects an executing or closed session. Apart from resolving
documented import-addressable hooks, loading never executes old top-level
initializations, template calls, tool calls, or other side effects; only
source-backed declarations are compiled before saved values are installed.

Interactive fragments do not accept package metadata, export directives, or
`@test`/`@eval` suites. Those constructs describe whole files or package/test
surfaces rather than an incremental runtime cell. The existing
`compile_program(...).run_main()` and normal file-execution paths are unchanged.

#### Terminal REPL

`kedi --idle` exposes the same incremental runtime as a Python-style terminal
REPL:

```console
$ kedi --idle
 /\_/\
( o.o )
 > ^ <
Kedi 0.4.0 on darwin
Type "help" for interactive help, ":show" to inspect a value, ":multiline" for a multiline fragment, ":dump" to save, or ":exit" to leave.
+++ [base: int] = `40`
+++ @add_two() -> int:
...     = `base + 2`
...
+++ :show `add_two()`
42
+++
```

A header ending in `:`, an open delimiter, an open Python fence, or an explicit
line continuation switches the next prompt to `... `. Tab inserts indentation
at that prompt. An empty continuation line submits the complete buffered
fragment; it is then executed exactly once. Simple complete lines execute
immediately.

`:multiline` opens a one-shot multiline editor even when the first line would
be a complete fragment. Press Enter once to start an empty line and Enter again
to submit the complete fragment. If the fragment still has an open block,
delimiter, inline expression, or Python fence, the editor keeps accepting
input. `Alt+Enter` forces submission so an invalid fragment can be returned to
the parser and diagnosed. After execution or an error, the REPL returns to the
normal `+++` line mode. Meta commands inside the multiline editor are treated
as Kedi source rather than terminal commands. Terminal copy and paste is
supported; pasted newlines, indentation, and blank lines remain part of the
fragment and do not submit it. Press Enter twice after pasting to execute it.

`kedi --idle --highlight` enables live syntax highlighting for Kedi and
embedded Python input. Highlighting is optional, does not start a language
server, and falls back to plain input for unusually large fragments so typing
remains responsive. Highlighted, multiline, and ordinary input share the same
REPL history.

`:show <expression>` is a terminal-only meta command, not Kedi syntax. It
evaluates any expression accepted on the right-hand side of a Kedi return and
prints its value. For example, `:show <name>` renders a substitution, while
``:show `value` `` inspects a native Python/Kedi value. This keeps forbidden
top-level substitutions out of normal `.kedi` files.

`:dump` atomically saves the current interactive session. The first dump uses
an automatically generated path under `~/.kedi/sessions`; later dumps in the
same process update that path. On success the REPL prints the exact command for
resuming the snapshot:

```console
To resume session, run -- kedi --idle --load <session_path>
```

Start with `--record` to dump automatically before the process leaves through
`:exit`, `Ctrl+C`, `Ctrl+D`, or a `SystemExit` raised by inline Python. The dump
happens before session resources close, and a `SystemExit` status is preserved.
`--load <session_path>` restores the session and keeps recording subsequent
changes back to the same snapshot:

```bash
kedi --idle --record
kedi --idle --load ~/.kedi/sessions/idle-20260826T120000-ab12cd34.kedi-state
```

Top-level results use `repr()` so native values remain visible without changing
their runtime semantics. `:exit` is the only textual exit command; Python's
`exit()` and `quit()` calls have no special meaning. `Ctrl+C` exits silently,
including during active execution, and `Ctrl+D` also closes the session.
Readline history is stored in `~/.kedi_history`; set `KEDI_HISTORY` to
choose another path. Adapter selection remains available through
`--adapter` and `--adapter-model`. Interactive mode does not accept a source
file, `-c/--command`, program arguments, or test/eval/optimization modes.
`--record`, `--load`, and `--highlight` are valid only with `--idle`.

For a dynamic policy, decorate a Python handler and return one explicit
decision. The decorator registers it as the default policy. Kedi passes an
immutable request; only `edit` may replace arguments:

```python
import kedi


@kedi.approval
def protect_writes(request: kedi.ApprovalRequest) -> kedi.ApprovalDecision:
    if request.tool_name == "write_report":
        return kedi.ApprovalDecision.edit(
            {**request.arguments, "path": "reports/latest.md"}
        )
    return kedi.ApprovalDecision.deny(reason="tool is outside this task")


with kedi.context(approval=protect_writes):
    run_task()
```

`McpServerSpec` is available from the root package for Python configuration:

```python
from kedi import McpServerSpec

kedi.configure(
    mcp_servers=[
        McpServerSpec(transport="http", url="http://127.0.0.1:8000/mcp"),
    ]
)
```

Runtime env precedence is:
1. configured tools and query/bind-local tools
2. Python call arguments
3. auto-injected `@kedi.type` classes
4. `kedi.configure(env=...)`
5. `kedi.context(env=...)` or query/bind `env=...`

Later entries override earlier entries. This lets explicit env values override
call arguments when you intentionally want to force a runtime type or value.

### Types and Tools

`@kedi.type` registers Python classes for Kedi type resolution:

```python
@kedi.type
class Person:
    name: str
    age: int


@kedi.type(inject=False)
class InternalPayload(BaseModel):
    raw: str
```

- Existing Pydantic models, Pydantic dataclasses, and standard dataclasses are
  registered as-is.
- Bare classes are converted with `dataclasses.dataclass` and then registered.
- `inject=True` is the default and makes the class available to Kedi programs
  in the same Python module. Use `inject=False` and pass `env={"Name": Type}`
  when you want explicit control.

`@kedi.tool` wraps Python callables for adapter tool registration. The callable
signature and docstring are used for schema and description metadata.

```python
@kedi.tool(name="search_docs", description="Search local project notes.", retries=1)
def search_docs(query: str) -> str:
    return "..."
```

Register tools through `kedi.configure(tools=[...])`, `kedi.context(tools=[...])`,
or per-callable `@kedi.query(tools=[...])` / `@kedi.bind(tools=[...])`. A Kedi
program still uses `> use: search_docs` to expose that registered callable to
the active prompt.

### Cache Helpers

```python
info = kedi.cache_info()
kedi.clear_cache()
```

`cache_info()` returns the number of parse and response cache entries.
`clear_cache()` clears both memory caches. Response caching is opt-in with
`cache=True`; parse caching is always source-hash based.

## Telemetry

Kedi exposes a dependency-free telemetry seam and performs no telemetry work by
default. Install and enable the separate
`opentelemetry-instrumentation-kedi` package to publish native OpenTelemetry
spans and metrics:

```python
from opentelemetry.instrumentation.kedi import KediInstrumentor

KediInstrumentor().instrument()
```

The application owns its OpenTelemetry SDK, resource, sampler, and exporter.
Use `service.name=kedi`; Kedi emits instrumentation under `kedi.runtime`,
`kedi.agent`, and `kedi.artifacts` scopes. Logfire can be used as the configured
OpenTelemetry backend without changing Kedi's instrumentation API.

Runtime telemetry covers parse, compile, program execution, procedure calls,
and embedded Python. Agent telemetry covers agent/model runs, tool calls, MCP,
approvals, subagents, and dynamic workflows. Artifact telemetry covers storage,
reads, releases, expiry, cleanup, quota rejection, and context bytes avoided.
Pydantic AI instrumentation is enabled by default; HTTPX instrumentation is an
explicit opt-in.

History telemetry uses `process history` for deterministic Kedi history
selection after the configured threshold is reached and `compact history` for
an actual native or Kedi-owned compaction attempt. Merely configuring native
compaction does not create a span. Compaction spans report message and token
counts, reduction ratio, retained-prefix validation, checkpoint state, and
cache-epoch changes without recording history, summaries, checkpoint IDs, or
artifact IDs. Cache-read and cache-write token usage remains on the agent/model
telemetry and is not counted again as compaction usage.

The default privacy policy does not capture prompt/output content, binary
content, source paths or snippets, model request parameters, tool definitions,
exception messages, or stack traces. Each class requires its own explicit
capture option. `runtime_detail` accepts `"off"`, `"lifecycle"`, or
`"detailed"`; agent and artifact telemetry can be disabled independently.

See the dedicated **Telemetry** guide in the Kedi documentation for the full
configuration, span hierarchy, attributes, metrics, privacy rules, and
instrumentation lifecycle.

## Terminal-Bench 2.1 with Harbor

Kedi includes an official Harbor custom-agent bridge for running reproducible
Terminal-Bench 2.1 jobs. Harbor requires Python 3.12 or newer; install the host
integration separately from the task-container runtime:

```bash
python3.12 -m pip install 'kedi[terminal-bench]'
```

Daytona runs require `DAYTONA_API_KEY` in the host environment or the current
directory's `.env` file. Codex-backed model routes use the host's existing
`codex login` session. Kedi refreshes the host credential when needed, derives
a short-lived access-only credential without the reusable refresh token,
transfers that credential into the ephemeral agent sandbox outside the task
workspace and logs, and removes it when the agent command exits.

Build the exact Kedi source first, then create an immutable manifest before
running any tasks. The manifest records the declared Harbor revision and freezes
the exact Harbor package version, Kedi commit and wheel digest, pinned
`tree-sitter-kedi` gitlink revision, model route, effort, model settings,
selected tasks, concurrency, retry and timeout policy, history, artifacts, and
compaction policy:

```bash
uv build
kedi-terminal-bench manifest \
  --output runs/pilot.json \
  --harbor-revision 389bd4f8ce796ef4a97de4b62675021e262c8e76 \
  --model codex/gpt-5.6-luna \
  --effort high \
  --kedi-wheel dist/kedi-0.4.0-py3-none-any.whl \
  --timeout-multiplier 1 \
  --agent-timeout-multiplier 1 \
  --verifier-timeout-multiplier 1 \
  --max-retries 0 \
  --task task-a \
  --task task-b
```

The manifest targets the official
`terminal-bench/terminal-bench-2-1@6` Harbor dataset by default. Task names may
use the short form, such as `fix-git`; Kedi converts them to Harbor's canonical
`terminal-bench/fix-git` task identifier when starting the job. Model settings
may be supplied as a JSON object with `--model-settings`. The manifest rejects
credential-like keys and token values; provider credentials come from Harbor's
model connection, while Codex-backed routes use the isolated auth handoff
described above. A manifest is content addressed and cannot be replaced with
materially different settings at the same path.

The setup and environment-build timeout multipliers are also explicit manifest
options. When retries are enabled, use repeatable `--retry-include` and
`--retry-exclude` options to freeze the eligible Harbor exception classes.
`--retry-all-exceptions` intentionally clears Harbor's default exclusion list.

Pass the recorded wheel to the run. Its SHA-256 must match the manifest, which
prevents a different Kedi build from entering the official task container:

```bash
kedi-terminal-bench run runs/pilot.json \
  --kedi-wheel dist/kedi-0.4.0-py3-none-any.whl \
  --jobs-dir runs/jobs \
  --job-name pilot-1
```

The wrapper invokes Harbor's normal `run` command with
`kedi.integrations.harbor:KediAgent`; it does not replace the official dataset,
container, timeout, grader, lock file, or resume mechanism. If `--jobs-dir` or
`--job-name` is omitted, Kedi uses `./jobs` and a name derived from the manifest
digest. The manifest is copied to `kedi-manifest.json` in that Harbor job
directory. Harbor's generated `lock.json` remains authoritative for resolved
task hashes, image digests, resources, and grader inputs. Together these two
files define the reproducible run contract.

Resume an interrupted Harbor job through its native lifecycle:

```bash
kedi-terminal-bench resume runs/jobs/pilot-1
```

Before starting a real job, Kedi verifies that the selected `harbor` executable
reports the manifest's pinned Harbor version. `--dry-run` only prints the exact
command and therefore does not perform this executable check.

Each task runs a benchmark-neutral Kedi coding profile with stateful history and
file-backed Tool Artifacts enabled by default. The task agent receives bounded
foreground and background process tools, exact argv and explicit shell paths,
incremental process output reads, full artifact-backed logs, verification state,
and the regular sandbox-rooted filesystem tools. Terminal subprocesses do not
inherit provider credentials. A command that cannot be started is returned to
the agent as a recorded terminal result with exit code `127` when the executable
is missing or `126` when it cannot be executed; it does not abort the agent run.
The agent runtime is installed into an isolated, uv-managed CPython 3.11
environment, so task images with older Python versions or without development
headers do not determine whether Kedi and `tree-sitter-kedi` can be installed.
The configured command timeout is a hard ceiling: a larger `timeout_seconds`
requested by the model cannot extend it. When an explicit runner deadline is
configured, Kedi also stops admitting commands during the finalization reserve
before that deadline so terminal evidence and the result record can be flushed.
Benchmark approval is non-interactive: read-only and declared task-container
operations are allowed, while sensitive requests and tools outside the
benchmark allowlist are denied.

Background processes are session-owned by default and are terminated with their
complete process group when the agent finishes, fails, times out, or is cancelled.
An agent may call `retain_process` after a successful health check when an external
verifier must reach a service after the final response. Retention transfers that
tracked process to the surrounding execution rather than detaching it: output
continues into the same bounded logs, a fixed lifetime still applies, and failure
or execution teardown terminates the complete process group.

Task logs include `kedi-result.json`, `terminal-events.jsonl`, bounded command
summaries, complete capped terminal logs, artifact payloads, and redacted error
or cleanup records. Trial states distinguish normal completion, agent failure,
integration failure, controlled model-budget exhaustion, timeout, and
cancellation; failures also retain whether they occurred during setup, agent
execution, or teardown. Budget exhaustion preserves the current workspace for
the external verifier and exits successfully, so Harbor does not retry an
otherwise verifiable task merely because the agent reached Kedi's host safety
ceiling. Kedi token usage and cache usage are projected into Harbor's
`AgentContext` only after Harbor has synced the task-container logs back to the
host.

Use `--no-history` to run statelessly and `--no-artifacts` to disable artifact
admission for a controlled comparison. Stateful history always applies Kedi's
provider-native prefix-cache placement where supported; it is not presented as
a separately disableable provider behavior. Native compaction is opt-in through
`--compaction-mode native`, with an optional positive
`--compaction-threshold`. Subagents and dynamic workflows are intentionally not
part of this fixed benchmark profile until separate capability experiments
justify enabling them.

This integration defines the execution and evidence surface only. It does not
embed task solutions, report a Terminal-Bench score, or make an unofficial run
leaderboard-comparable.

## Command-Line Parse Helpers

Use `-c` to run Kedi source from the command line and `-p` / `--parse` to parse
without compiling or executing:

```bash
kedi -c "= done"
kedi -p -c "@broken("
kedi parse program.kedi
kedi program.kedi --parse
```

## Prompt Optimization Blocks

Mark specific template spans in a procedure for optimization using the `> optimize: name:` directive:

````kedi
@solve_math_problem(problem: str) -> int:
  # This template span will be optimized by the optimizer
  > optimize: parse_problem:
    Given the math problem: <problem>
    Parse it and extract: [num1: int] and [num2: int] and [operator: str]
  
  # Another span to optimize
  > optimize: compute_result:
    Calculate <num1> <operator> <num2>.
    The answer is: [answer: int]
  
  = `answer`
````

Rules:
- `> optimize: name:` must be followed by an indented block containing template lines (prompt text with `<variables>`, `<calls>`, and `[outputs]`). The whole indented span is newline-joined and executed as one LLM call, like a `>>` template block. The body may use an explicit leading `>>` or the legacy bare-line form; both have identical single-call behavior.
- Multiple optimize spans can be defined per procedure.
- Optimization requires:
  1. A matching `@eval: procedure_name` suite with training data (`> data:`)
  2. The `--optimize` flag when running evaluations
  3. An optimizer selected via `--optimizer` (default: `gepa`)
- The optimizer uses training data to improve prompts iteratively.
- Test data (if provided) is used to measure generalization after optimization.

## AI-Generated Procedures

Define procedure signatures with an explicit `> auto:` block (replaces the old implicit `>` form):

```kedi
@summarize(texts: list[str]) -> str:
  > auto:
    Takes a list of text documents and produces a concise summary that preserves key information while reducing length by 80%
```

The system will:
1. Generate test cases based on the specification
2. Implement the procedure iteratively until tests pass
3. Cache the implementation in `source.cache.kedi`

Unknown `>` directives will raise a directive error. Valid directives include
`auto`, `data`, `test_data`, `metric`, `optimize`, `model`, `effort`, `skills`,
`system`, `mcp`, `profile`, `use`, `import`, and `export`.

## Complete Example with Explanations

````kedi
# Prelude block - runs once at startup, imports available everywhere
```
import random
import json

def format_result(value):
    return f"==> {value} <=="
```

# Top-level typed variable initializations
[threshold: float] = `0.5`
[max_items: int] = `10`

# Custom type definition
~SearchResult(query, score: float, items: list[str])

# Procedure with typed parameters and return type
@search(query: str, limit: int) -> SearchResult:
  >> Searching for "<query>" with limit <limit>...
  List relevant items for query "<query>" as [results: list[str]]
  
  # Python block for computation (note proper indentation!)
  [score: float] = ```
  # Calculate relevance score
  return min(1.0, len(results) / limit)
  ```
  
  # Side-effect Python line
  `print(f"Found {len(results)} results")`
  
  # Return native SearchResult object
  = `SearchResult(query=query, score=score, items=results[:limit])`

# Procedure using another procedure
@analyze(topic: str):
  # Call with native int argument
  [result: SearchResult] = `search(topic, max_items)`
  
  # Conditional logic in Python (properly indented with procedure)
  [status] = ```
  if result.score > threshold:
      return "Good"
  else:
      return "Poor"
  ```
  
  # Multiline return with continuation
  = Report complete for <topic> \
    with <`len(result.items)`> items \
    and score <`result.score`>

# Test definition with properly indented Python blocks
@test: search:
  > case: basic:
    ```
    result = search("test", 5)
    assert isinstance(result, SearchResult)
    assert result.query == "test"
    ```

# Evaluation with dataset-aware metric
@eval: search:
  > data: queries:
    = ```
    return [
      ("python", {"min_results": 3}),
      ("javascript", {"min_results": 2}),
    ]
    ```

  > metric: relevance(queries):
    = ```
    query = queries
    result = search(query, 10)
    meets_min = len(result.items) >= expected['min_results']
    return (result.score, f"Found {len(result.items)} items") if meets_min else (0.0, "Too few results")
    ```

# Main execution
= <analyze(Programming)>
````
