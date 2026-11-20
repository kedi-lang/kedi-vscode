const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

// Minimal vscode API mock with the real Position contract: negative
// line/character throws RangeError, exactly like vscode.Position.
class Position {
    constructor(line, character) {
        if (line < 0 || character < 0) throw new RangeError(`Position(${line}, ${character}) invalid`);
        this.line = line; this.character = character;
    }
    translate(lineDelta = 0, characterDelta = 0) {
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }
    isEqual(other) { return this.line === other.line && this.character === other.character; }
}
class Range {
    constructor(a, b, c, d) {
        if (a instanceof Position) { this.start = a; this.end = b; }
        else { this.start = new Position(a, b); this.end = new Position(c, d); }
    }
    contains(p) {
        const cmp = (x, y) => (x.line - y.line) || (x.character - y.character);
        return cmp(p, this.start) >= 0 && cmp(p, this.end) <= 0;
    }
    isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
    translate(lineDelta = 0, characterDelta = 0) {
        return new Range(this.start.translate(lineDelta, characterDelta), this.end.translate(lineDelta, characterDelta));
    }
}
class Location {
    constructor(uri, range) { this.uri = uri; this.range = range; }
}
class CompletionList {
    constructor(items, isIncomplete) { this.items = items; this.isIncomplete = isIncomplete; }
}
class SnippetString { constructor(value) { this.value = value; } }
class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } }
const Uri = {
    parse: (s) => ({ toString: () => s, fsPath: s }),
    joinPath: (uri, segment) => ({ toString: () => `${uri.toString()}/${segment}`, fsPath: `${uri.fsPath}/${segment}` }),
};

function loadPythonCompletion(vscode) {
    const module_ = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, "../src/pythonCompletion.ts"), "utf8"), { loader: "ts", format: "cjs" }).code, {
        module: module_, exports: module_.exports,
        require: (name) => (name === "vscode" ? vscode : require(name)),
    });
    return module_.exports;
}

function loadEmbeddedPython(vscode) {
    const pythonCompletion = loadPythonCompletion(vscode);
    const module_ = { exports: {} };
    vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, "../src/embeddedPython.ts"), "utf8"), { loader: "ts", format: "cjs" }).code, {
        module: module_, exports: module_.exports, Buffer,
        require: (name) => {
            if (name === "vscode") return vscode;
            if (name === "./pythonCompletion") return pythonCompletion;
            if (name === "vscode-languageclient/node") return {};
            return require(name);
        },
    });
    return module_.exports;
}

function mockVscode() {
    return {
        Position, Range, Location, CompletionList, SnippetString, TextEdit, Uri,
        workspace: {
            onDidOpenTextDocument: () => ({ dispose() {} }),
            onDidChangeTextDocument: () => ({ dispose() {} }),
            onDidCloseTextDocument: () => ({ dispose() {} }),
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            textDocuments: [],
            fs: {
                createDirectory: async () => {},
                writeFile: async () => {},
                readDirectory: async () => { throw new Error("no directory"); },
                stat: async () => { throw new Error("no file"); },
                delete: async () => {},
            },
            openTextDocument: async (uri) => ({ uri, languageId: "python", getText: () => "x = 1\n", lineCount: 1, lineAt: () => ({ range: { end: new Position(0, 3) } }) }),
        },
        languages: {
            registerCompletionItemProvider: () => ({ dispose() {} }),
            registerHoverProvider: () => ({ dispose() {} }),
            registerDefinitionProvider: () => ({ dispose() {} }),
            registerReferenceProvider: () => ({ dispose() {} }),
            setTextDocumentLanguage: async (doc) => doc,
        },
        extensions: { getExtension: () => undefined },
        commands: { executeCommand: async () => { throw new Error("no provider"); } },
        window: {},
    };
}

// One virtual mapping: .kedi lines 10-12 <-> virtual .py lines 0-2.
function cachedDoc() {
    return {
        uri: "file:///ws/main.kedi", version: 1, focusKey: "global",
        ranges: [], virtualText: "x = 1\n", mappings: [{
            kind: "fenced",
            sourceRange: new Range(10, 0, 12, 0),
            virtualRange: new Range(0, 0, 2, 0),
        }], symbols: [],
    };
}

const sourceUri = Uri.parse("file:///ws/main.kedi");
const virtualUri = Uri.parse("file:///storage/embedded-python/abc123.py");
const externalUri = Uri.parse("file:///ws/venv/lib/site-packages/numpy/core.py");

test("external definition/reference locations are returned unchanged (audit #215 V1)", () => {
    const { mapLocation, mapDefinitionResults } = loadEmbeddedPython(mockVscode());
    const cached = cachedDoc();

    // Mocked Pyright reply pointing at a .py file, inside the mapped range:
    // it must NOT be rewritten onto the .kedi file.
    const inMap = new Location(externalUri, new Range(0, 5, 0, 10));
    const keptA = mapLocation(cached, sourceUri, virtualUri, inMap);
    assert.equal(keptA, inMap);
    assert.equal(keptA.uri.toString(), externalUri.toString());
    assert.ok(keptA.range.isEqual(new Range(0, 5, 0, 10)));

    // Outside the virtual map: it must NOT be dropped either.
    const outOfMap = new Location(externalUri, new Range(50, 0, 50, 8));
    const keptB = mapLocation(cached, sourceUri, virtualUri, outOfMap);
    assert.equal(keptB, outOfMap);

    // LocationLink with an external target keeps its targetUri.
    const link = { targetUri: externalUri, targetRange: new Range(0, 5, 0, 10), targetSelectionRange: new Range(0, 5, 0, 8) };
    const mappedLinks = mapDefinitionResults(cached, sourceUri, virtualUri, [link]);
    assert.equal(mappedLinks.length, 1);
    assert.equal(mappedLinks[0], link);
    assert.equal(mappedLinks[0].targetUri.toString(), externalUri.toString());
});

test("virtual locations are still mapped onto the .kedi file (audit #215 V1)", () => {
    const { mapLocation, mapDefinitionResults } = loadEmbeddedPython(mockVscode());
    const cached = cachedDoc();

    const virtual = new Location(virtualUri, new Range(0, 5, 0, 10));
    const mapped = mapLocation(cached, sourceUri, virtualUri, virtual);
    assert.ok(mapped);
    assert.equal(mapped.uri.toString(), sourceUri.toString());
    assert.ok(mapped.range.isEqual(new Range(10, 5, 10, 10)));

    // A virtual location with no mapping is still dropped.
    assert.equal(mapLocation(cached, sourceUri, virtualUri, new Location(virtualUri, new Range(50, 0, 50, 8))), undefined);

    const link = { targetUri: virtualUri, targetRange: new Range(0, 5, 0, 10), targetSelectionRange: new Range(0, 5, 0, 8) };
    const mappedLinks = mapDefinitionResults(cached, sourceUri, virtualUri, [link]);
    assert.equal(mappedLinks.length, 1);
    assert.equal(mappedLinks[0].targetUri.toString(), sourceUri.toString());
    assert.ok(mappedLinks[0].targetRange.isEqual(new Range(10, 5, 10, 10)));
});

test("translatePosition keeps multi-line characters and never goes negative (audit #215 V2)", () => {
    const { translatePosition } = loadEmbeddedPython(mockVscode());

    // Verification repro (7,3): from (5,10)-(9,0), to (0,0)-(4,0).
    // Old formula gave character 3 + 0 - 10 = -7 (RangeError).
    const out = translatePosition(new Range(5, 10, 9, 0), new Range(0, 0, 4, 0), new Position(7, 3));
    assert.equal(out.line, 2);
    assert.equal(out.character, 3);

    // Same-line positions still get the start offset.
    const sameLine = translatePosition(new Range(5, 10, 5, 20), new Range(0, 0, 0, 10), new Position(5, 13));
    assert.equal(sameLine.line, 0);
    assert.equal(sameLine.character, 3);

    // Last line of a multi-line range keeps its character.
    const lastLine = translatePosition(new Range(5, 10, 9, 0), new Range(0, 0, 4, 0), new Position(9, 0));
    assert.equal(lastLine.line, 4);
    assert.equal(lastLine.character, 0);

    // A same-line position left of the range start clamps to 0 instead of throwing.
    const clamped = translatePosition(new Range(5, 10, 5, 20), new Range(0, 0, 0, 10), new Position(5, 5));
    assert.equal(clamped.character, 0);
});

// --- forwardCompletion (audit #215 V3): a rejecting
// `kedi/pythonCompletions` request must resolve to an empty list, not
// reject the provider promise. The harness drives the real
// registerEmbeddedPython with mocked vscode + a fake language client
// whose pythonCompletions request either throws or answers.
function completionHarness({ rejectCompletions }) {
    const captured = {};
    const vscode = mockVscode();
    vscode.languages.registerCompletionItemProvider = (_lang, provider) => { captured.completion = provider; return { dispose() {} }; };
    vscode.commands.executeCommand = async (cmd) => {
        if (cmd === "vscode.executeCompletionItemProvider") {
            return { items: [{ label: "foo", insertText: "foo" }, { label: "bar", insertText: "bar" }], isIncomplete: false };
        }
        throw new Error(`unexpected command ${cmd}`);
    };
    const embedded = loadEmbeddedPython(vscode);
    const context = { subscriptions: [], storageUri: Uri.parse("file:///storage"), globalStorageUri: Uri.parse("file:///storage") };
    const oneRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
    const virtualDoc = {
        text: "x = 1\n", focusKey: "global",
        ranges: [{ kind: "fenced", sourceRange: oneRange, virtualRange: oneRange, text: "x=1" }],
        mappings: [{ kind: "fenced", sourceRange: oneRange, virtualRange: oneRange }],
        symbols: [],
    };
    const client = {
        async sendRequest(method) {
            if (method === "kedi/pythonVirtualDocument") return virtualDoc;
            if (method === "kedi/pythonCompletions") {
                if (rejectCompletions) throw new Error("Language server not running");
                return [{ label: "foo", index: 0, additionalTextEdits: [] }];
            }
            throw new Error(`unexpected request ${method}`);
        },
    };
    embedded.registerEmbeddedPython(context, () => client);
    const doc = { uri: Uri.parse("file:///ws/main.kedi"), version: 1, languageId: "kedi", getText: () => "x=1" };
    return { provider: captured.completion, doc, token: { isCancellationRequested: false } };
}

test("forwardCompletion returns an empty list when the pythonCompletions request rejects (audit #215 V3)", async () => {
    const h = completionHarness({ rejectCompletions: true });
    const list = await h.provider.provideCompletionItems(h.doc, new Position(0, 1), h.token, {});
    assert.ok(list);
    assert.equal(list.items.length, 0);
    assert.equal(list.isIncomplete, false);
});

test("forwardCompletion still maps completions when the request succeeds (audit #215 V3)", async () => {
    const h = completionHarness({ rejectCompletions: false });
    const list = await h.provider.provideCompletionItems(h.doc, new Position(0, 1), h.token, {});
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].label, "foo");
});
