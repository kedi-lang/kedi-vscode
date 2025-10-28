# Kedi DSL Language Specification

## Overview

Kedi is a lightweight domain-specific language (DSL) designed to orchestrate LLM interactions through a clean, Python-integrated syntax. It uses indentation-based scoping, supports typed values, and compiles to a runtime that executes prompts and threads values across computational steps.

## Anatomy of a Kedi Template

A Kedi template string combines literal text with input substitutions and output placeholders:

```kedi
The capital of <country> is [capital].
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
The capital of <country> is [capital].
# Now 'capital' variable contains "Paris" and can be used:
<capital> is a beautiful city.
```

Multiple inputs and outputs can appear on the same line:
```kedi
<person1> and <person2> live in [city] and work at [company].
# After execution, both 'city' and 'company' are available as variables
```

## Core Concepts

### Program Structure

A Kedi program consists of:
- **Template lines**: Free text with embedded substitutions and outputs
- **Procedures**: Reusable named blocks of code
- **Assignments**: Variable initialization and storage
- **Returns**: Values returned from procedures or top-level
- **Python blocks**: Embedded Python code for computation
- **Comments**: Inline and block comments for documentation

### Indentation and Scoping

- Indentation defines block scope (like Python)
- Tabs count as width 4 for comparison
- The preprocessor inserts virtual BEGIN/END kedis on indentation changes

## Basic Syntax Elements

### Comments

```kedi
# This is an inline comment
Use ## to escape a literal # character

###
This is a block comment.
It can span multiple lines.
###
```

- Inline: Everything after `#` is ignored; use `##` for literal `#`
- Block: Lines containing only `###` (trimmed) start/end blocks; must appear in matching pairs

### Template Lines

Template lines are the basic building blocks that mix literal text with dynamic content:

```kedi
Hello, this is plain text
The answer is <variable> and result is <compute(5)>
Please provide [output] for this query
```

### Substitutions (R-values)

Substitutions read values and insert them into template lines using `<...>`:

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
# In template lines
Result: <`math.sqrt(16)`>
Array: <`[i*2 for i in range(5)]`>

# Variable access
[x] = 10
Double: <`x * 2`>
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

## Advanced Features

### Multiline Strings

Use backslash for line continuation:

````kedi
= This is a \
  long string that \
  continues across lines

# Results in: "This is a long string that continues across lines"
````

Use `\\` for literal backslash.

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

````kedi
@eval: get_cities:
  > metric: city_count:
    = ```
    cities = get_cities("USA")
    score = len(cities) / 50.0  # Normalize by expected
    return (score, f"Found {len(cities)} cities")
```
````

## AI-Generated Procedures

Define procedure signatures with a specification line starting with `>`:

```kedi
@summarize(texts: list[str]) -> str:
  > Takes a list of text documents and produces a concise summary that preserves key information while reducing length by 80%
```

The system will:
1. Generate test cases based on the specification
2. Implement the procedure iteratively until tests pass
3. Cache the implementation in `source.cache.kedi`

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
  Searching for "<query>" with limit <limit>...
  
  # LLM output with type annotation
  [results: list[str]] = List relevant items for query "<query>"
  
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

# Evaluation metric
@eval: search:
  > metric: relevance:
    = ```
    result = search("python", 10)
    return (result.score, None)
    ```

# Main execution
= <analyze(Programming)>
````