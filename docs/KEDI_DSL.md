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
<capital> is a beautiful city.
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
from earlier rows appear as `[name]` placeholders in the merged prompt; later
rows may reference them with `<name>` (left as literal text for the model).

```kedi
>> What's the [capital] of Turkey?
What's the [population: int] of <capital>?
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

Bare template lines (without `>>`) are **deprecated** at procedure and top level and
should not appear in new code. They remain valid inside `> optimize:` / `> auto:`
bodies only.

### Substitutions (R-values)

Substitutions read values and insert them into templates using `<...>`:

```kedi
# Variable substitution
The city is <city>

# Procedure call
The country is <get_country(Paris)>

# Nested calls
Result: <outer(<inner(x)>)>

# Inline Python expression (note the backticks)
Sum is <`2 + 3`>
```

### Outputs (L-values)

Outputs are placeholders filled by the LLM using `[...]`:

```kedi
# Simple output
The capital of France is [capital].

# Typed output
Top cities: [cities: list[str]]

# Typed output with inline Python type annotation
Top cities: [cities: `list[str]`]

# Multiple outputs on one line
[first_name] [last_name] lives in [city: str]
```

Output names must be valid identifiers: `^[A-Za-z_][A-Za-z0-9_]*$`

Backtick-wrapped type expressions in outputs are evaluated at runtime, giving you access to dynamic types from the prelude or computed values.

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
- Variables in scope are injected and changes reflect back
- The code is dedented relative to its indentation level before execution

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
What's the [population: int] of <capital>?
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

Unknown `>` directives will raise a directive error. Valid directives are `auto`, `data`, `test_data`, `metric`, and `optimize`.

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
