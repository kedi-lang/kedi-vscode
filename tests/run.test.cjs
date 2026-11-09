const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const root = path.resolve("project with spaces");
const program = path.join(root, "main.kedi");
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
    const errors = [], terminals = [], debugs = [], commands = new Map(), state = { saves: 0 };
    const uri = file => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
    const document = {
        uri: uri(program), isDirty: options.dirty === true,
        async save() { state.saves++; this.isDirty = options.save === false; return options.save !== false; },
    };
    const vscode = {
        Range: class { constructor(line) { this.line = line; } },
        CodeLens: class { constructor(range, command) { Object.assign(this, { range, command }); } },
        window: {
            activeTextEditor: options.noEditor ? undefined : { document },
            async showErrorMessage(message) { errors.push(message); },
            createTerminal(settings) {
                const terminal = { settings: plain(settings), shown: false, disposed: false,
                    show() { this.shown = true; }, dispose() { this.disposed = true; } };
                terminals.push(terminal);
                return terminal;
            },
        },
        workspace: {
            isTrusted: options.trusted !== false,
            textDocuments: [document],
            getWorkspaceFolder: () => options.noFolder ? undefined : { uri: uri(root) },
        },
        debug: { async startDebugging(folder, config) { debugs.push({ folder: folder?.uri.fsPath, config: plain(config) }); return true; } },
        commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } },
        languages: { registerCodeLensProvider(selector, provider) { state.selector = plain(selector); state.lenses = provider; return { dispose() {} }; } },
    };
    const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/run.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
    const module = { exports: {} };
    vm.runInNewContext(source, { module, exports: module.exports, require: name => name === "vscode" ? vscode : require(name) });
    module.exports.registerRunCommands({ subscriptions: [] }, async resource => {
        state.resource = resource.fsPath;
        return { python: "/shared/editor-venv/bin/python", args: ["-I"] };
    });
    return { errors, terminals, debugs, commands, state, uri };
}

test("run, test and eval start the file with the language server's Python", async () => {
    const h = harness();
    await h.commands.get("kedi.runFile")();
    await h.commands.get("kedi.runTests")(h.uri(program));
    await h.commands.get("kedi.runEvals")(h.uri(program));

    assert.deepEqual(h.terminals.map(terminal => terminal.settings), [
        ["Kedi", []], ["Kedi tests", ["--test"]], ["Kedi evals", ["--eval"]],
    ].map(([name, flags]) => ({
        name: `${name}: main.kedi`,
        shellPath: "/shared/editor-venv/bin/python",
        shellArgs: ["-I", "-m", "kedi", program, ...flags],
        cwd: root,
    })));
    // A new run replaces the previous run's terminal.
    assert.deepEqual(h.terminals.map(terminal => [terminal.shown, terminal.disposed]), [[true, true], [true, true], [true, false]]);
    assert.equal(h.state.resource, program);
    assert.deepEqual(h.errors, []);
});

test("debug launches the Kedi debugger without stopping on entry", async () => {
    const h = harness({ noFolder: true });
    await h.commands.get("kedi.debugFile")(h.uri(program));

    assert.deepEqual(h.debugs, [{ folder: undefined, config: {
        type: "kedi", request: "launch", name: "Kedi: main.kedi", program, args: [], env: {}, stopOnEntry: false,
    } }]);
});

test("running saves the file first and refuses unsaved, untrusted or non-Kedi files", async () => {
    const saved = harness({ dirty: true });
    await saved.commands.get("kedi.runFile")();
    assert.equal(saved.state.saves, 1);
    assert.equal(saved.terminals.length, 1);

    const cases = [
        [{ dirty: true, save: false }, h => h.commands.get("kedi.runFile")(), /Save the Kedi file/],
        [{ trusted: false }, h => h.commands.get("kedi.debugFile")(), /Trust this workspace/],
        [{ noEditor: true }, h => h.commands.get("kedi.runFile")(), /Open a saved \.kedi file/],
        [{}, h => h.commands.get("kedi.runFile")(h.uri(path.join(root, "notes.md"))), /Open a saved \.kedi file/],
        [{}, h => h.commands.get("kedi.runFile")({ ...h.uri(program), scheme: "untitled" }), /Open a saved \.kedi file/],
    ];
    for (const [options, invoke, message] of cases) {
        const h = harness(options);
        await invoke(h);
        assert.equal(h.terminals.length + h.debugs.length, 0);
        assert.match(h.errors[0], message);
    }
});

test("code lenses run tests and evals from each top-level validation block", () => {
    const h = harness();
    const lines = [
        "@add(a: int, b: int) -> int:",
        "  = `a + b`",
        "@test: add:",
        "  > case: sums:",
        "@eval:  add :",
        "@test(x: str) -> str:",
        "  @test: add:",
    ];
    const lenses = h.state.lenses.provideCodeLenses({
        uri: h.uri(program), lineCount: lines.length, lineAt: line => ({ text: lines[line] }),
    });

    assert.deepEqual(h.state.selector, { language: "kedi", scheme: "file" });
    assert.deepEqual(plain(lenses.map(lens => [lens.range.line, lens.command.title, lens.command.command])), [
        [2, "$(play) Run tests", "kedi.runTests"],
        [4, "$(play) Run evals", "kedi.runEvals"],
    ]);
    assert.equal(lenses[0].command.arguments[0].fsPath, program);
});
