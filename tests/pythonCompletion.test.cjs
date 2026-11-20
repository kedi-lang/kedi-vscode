const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

class Range {
    constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; }
}
class SnippetString { constructor(value) { this.value = value; } }
class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } }
const module_ = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, "../src/pythonCompletion.ts"), "utf8"), { loader: "ts", format: "cjs" }).code, {
    module: module_, exports: module_.exports, require: () => ({ Range, SnippetString, TextEdit }),
});
const { completionEdits, mappedCompletions } = module_.exports;

test("snippets, insert/replace ranges, import edits and documentation survive projection", () => {
    const items = [{ label: { label: "Path" }, insertText: new SnippetString("Path($0)"),
        range: { inserting: new Range(10, 2, 10, 4), replacing: new Range(10, 2, 10, 6) },
        documentation: "Path documentation", command: { command: "unsafe" },
        additionalTextEdits: [new TextEdit(new Range(0, 0, 0, 0), "import pathlib\n")],
    }];
    const raw = completionEdits(items);
    assert.equal(raw[0].textEdit.newText, "Path($0)");
    raw[0].textEdit.insert.start.line = 3;
    raw[0].textEdit.replace.start.line = 3;
    const mapped = mappedCompletions(items, raw)[0];
    assert.equal(mapped.range.inserting.start.line, 3);
    assert.ok(mapped.insertText instanceof SnippetString);
    assert.equal(mapped.documentation, "Path documentation");
    assert.equal(mapped.command, undefined);
    assert.equal(mapped.additionalTextEdits[0].newText, "import pathlib\n");
    assert.equal(items[0].range.inserting.start.line, 10);
});

test("deprecated text edits and items without edits retain their insertion", () => {
    const items = [{ label: "upper", textEdit: new TextEdit(new Range(1, 2, 1, 3), "upper") }, { label: "lower" }];
    const mapped = mappedCompletions(items, completionEdits(items));
    assert.equal(mapped[0].insertText, "upper");
    assert.ok(mapped[0].range instanceof Range);
    assert.equal(mapped[0].textEdit, undefined);
    assert.equal(mapped[1].label, "lower");
});

test("out-of-range completion edit indexes are skipped, not dereferenced (audit #215 V3)", () => {
    const items = [{ label: "foo", insertText: "foo" }, { label: "bar", insertText: "bar" }];
    // Verification repro: index 5 with 2 items threw TypeError on
    // `original.insertText`; a textEdit-less out-of-range index silently
    // produced a broken item with its label/insertText lost.
    const bad = [
        { label: "zzz", index: 5, textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "zzz" }, additionalTextEdits: [] },
        { label: "yyy", index: 99, additionalTextEdits: [] },
        { label: "neg", index: -1, additionalTextEdits: [] },
    ];
    assert.equal(mappedCompletions(items, bad).length, 0);
    assert.equal(mappedCompletions(items, null).length, 0);
    // In-range edits still map.
    const good = [{ label: "bar", index: 1, additionalTextEdits: [] }];
    const mapped = mappedCompletions(items, good);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].label, "bar");
    assert.equal(mapped[0].insertText, "bar");
});
