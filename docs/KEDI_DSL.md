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
- **Assignments**: Variable initialization and storage
- **Returns**: Values returned from procedures or top-level
- **Python blocks**: Embedded Python code for computation
- **Comments**: Inline and block comments for documentation

### Indentation and Scoping

- Indentation defines block scope (like Python)
- Tabs count as width 4 for comparison
- The preprocessor inserts virtual BEGIN/END tokens on indentation changes

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

Imports resolve relative to the importing file. If no sibling module exists, Kedi falls back to bundled internal modules such as `> import: this`. Only names listed under `> export:` are visible to importers; non-exported procedures, types, and top-level values stay private to the module.

To export every public name in a module, use `> export: *`:

```kedi
@get_name() -> str:
  = Ada

[xd: int] = `1`

> export: *
```

Public names are names that do not start with `_`. If a module has no export directive, importing it does not expose any names.

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
```

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

`Annotated[type, "description"]` can attach schema descriptions to output fields without
using inline Python. The description must be a single-line string literal inside the
`Annotated[...]` arguments; standalone string literals are not valid type annotations.
Adapters that expose JSON schema, such as Pydantic AI and LangChain, pass this metadata
as the field description:

```kedi
>> Extract the customer as [name: Annotated[str, "Full customer name"]].
```

Use backticks only when the type itself must come from runtime Python state:

```kedi
>> Extract [value: `output_type`].
```

### Variable Assignment

Variables can be assigned using output syntax on the left side:

```kedi
# Simple assignment
[prev] = <current>

# Typed assignment
[count: int] = `5`

# Typed assignment with inline Python type annotation
[count: `int`] = `5`

# String assignment from expression
[message] = Hello <name>

# Assignment from Python block
[total: int] = ```
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
- Variables in scope are injected, and reassignments to those **existing** Kedi variables reflect back. New names created inside the block stay local to the block and do **not** leak into Kedi scope — assign to an existing Kedi variable (or use a value-returning block) to surface a result.
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

Fields without type annotations default to `str`. You can use backtick-wrapped type expressions in field definitions, parameters, returns, and variable assignments. The expressions are evaluated at runtime with access to prelude, globals, and local scope.

Type fields can also have single-line inline Python defaults:

```kedi
~Person(name: str, salary: int = `0`, tags: list[str] = `[]`)

= <`Person("Ada").model_dump_json()`>
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
`> model:`, `> effort:`, `> system:`, `> mcp:`, `> profile:`, and `> use:`
to choose adapter implementations, choose models, set reasoning effort, set
agent instructions, load MCP tools, and expose Kedi procedures as agent tools.

### Model and profile directives

```kedi
> adapter: pydantic
> model: groq:qwen/qwen3-32b
> effort: low
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
    > agent: acp
    > settings:
        command: `["vsh", "run", "--acp"]`
```

- `> adapter: name` — select an agent framework adapter for following LLM
  calls in the current lexical scope. Built-in framework shortnames are
  `pydantic`, `dspy`, and `langchain`.
- `> agent: name` — select an agent harness adapter for following LLM calls
  in the current lexical scope. Built-in harness shortnames are `claude`,
  `codex`, and `acp`.
- `> model: name` — set the active model for subsequent procedure captures (plain
  name or `` `expression` ``).
- `> effort: level` — set active reasoning effort. Accepted values are
  `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; plain values or
  `` `expression` `` are allowed. Pydantic AI maps `max` to `xhigh`.
  DSPy receives the value directly as `reasoning_effort`.
- `> system: text` — set active agent instructions for subsequent procedure
  captures and prompt calls.
- `> settings:` — set active model configuration for subsequent procedure
  captures and prompt calls. Values are `name: value` lines; plain values are
  parsed as simple scalars (`true`, `false`, numbers, `null`) and backtick
  expressions are evaluated as Python for complex values. Kedi keeps the merged
  settings in the active profile, then filters them at adapter boundaries:
  Pydantic AI receives only supported `ModelSettings` keys, and DSPy receives
  only supported `dspy.LM` kwargs. ACP receives harness process settings such as
  `command`, `cwd`, `env`, and `timeout`. Unknown setting names are parser/LSP errors.
  Use backticks when the setting value should be a real Python object instead
  of a string or simple scalar:

  ```kedi
  > settings:
      parallel_tool_calls: `False`
      stop_sequences: `["END", "DONE"]`
      extra_body: `{"mode": "json"}`
  ```
  For ACP harnesses, `command` may also come from CLI/env:

  ```kedi
  > agent: acp

  > settings:
      command: `["vsh", "run", "--acp"]`
  ```

  If `command` is omitted, Kedi reads `KEDI_ACP_AGENT_COMMAND`; the CLI
  `--acp-command` option writes the same setting for the process.
- Multiline `> system:` bodies are newline-joined like `>>` blocks, but they
  are read-only: literal text, `<name>` substitutions, and inline Python
  substitutions such as ``<`args.name`>`` are allowed; LLM outputs and procedure
  calls are not. Use `<``>` when the instruction text needs to mention a
  literal code fence marker.
- `> profile: name:` — define a reusable profile with nested `> agent:`,
  `> adapter:`, `> model:`, `> effort:`, `> system:`, `> settings:`, `> mcp:`,
  and/or `> use:` members.
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
  does not currently support structured template outputs, `> use:` tool
  registration, or `> mcp:` servers, the LSP reports warnings on the relevant
  output field, tool name, or directive keyword. These are capability warnings:
  when an adapter later advertises support for that feature, the same Kedi code
  stops warning without syntax changes.

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
- `bind` accepts the same profile override parameters as `query`: `system`,
  `effort`, `settings`, `tools`, `env`, `mcp_servers`, and `cache`.

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
    env={"audience": "maintainers"},
)
```

If `model` or `adapter` are not passed explicitly, `configure()` reads
`KEDI_ADAPTER_MODEL` and `KEDI_ADAPTER` from the environment after loading
`.env`. `kedi.context(...)` temporarily merges the same options and restores
the previous configuration when the block exits. It supports both sync and async
context managers.

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
- `> optimize: name:` must be followed by an indented block containing template lines (prompt text with `<variables>`, `<calls>`, and `[outputs]`).
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
`auto`, `data`, `test_data`, `metric`, `optimize`, `model`, `effort`, `system`, `mcp`,
`profile`, `use`, `import`, and `export`.

## Complete Example with Explanations

````kedi
# Prelude block - runs once at startup, imports available everywhere
```
import random
import json

def format_result(value):
    return f"==> {value} <=="
```

# Top-level typed variable assignments
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
