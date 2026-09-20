const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function harness(config = {}, options = {}) {
    const launches = [], errors = [], commands = new Map();
    let callback, configurationCallback, managedCalls = 0;
    const state = { host: "/host environment/bin/python" };
    const api = { environments: {
        onDidChangeActiveEnvironmentPath(fn) { callback = fn; return { dispose() {} }; },
        getActiveEnvironmentPath() { return { path: "/host environment" }; },
        async resolveEnvironment() { return { executable: { uri: { fsPath: state.host } } }; },
    } };
    const vscode = {
        window: {
            createOutputChannel() { return { appendLine() {}, dispose() {} }; },
            async showErrorMessage(message) { errors.push(message); },
        },
        workspace: {
            getConfiguration() { return { get: (key, fallback) => config[key] ?? fallback }; },
            createFileSystemWatcher() { return { dispose() {} }; },
            onDidChangeConfiguration(fn) { configurationCallback = fn; return { dispose() {} }; },
        },
        extensions: { getExtension() { return { isActive: true, exports: api }; } },
        commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } },
    };
    const embedded = { dispose() {}, setClientGetter() {} };
    const modules = {
        vscode,
        "vscode-languageclient/node": {
            TransportKind: { stdio: 0 },
            LanguageClient: class {
                constructor(_id, _name, server) { this.server = server; }
                async start() { launches.push(this.server.run); }
                async stop() {}
            },
        },
        "./embeddedPython": { registerEmbeddedPython: () => embedded },
        "./embeddedKediInPython": { registerEmbeddedKediInPython: () => embedded },
        "./runtime": {
            selectPython() {},
            async managedPython() {
                managedCalls++;
                if (options.fail) throw new Error("setup unavailable");
                return "/shared/editor-venv/bin/python";
            },
        },
    };
    const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module, exports: module.exports, require: name => modules[name], setTimeout, clearTimeout,
    });
    return {
        extension: module.exports, launches, errors, commands, state,
        managedCalls: () => managedCalls,
        activate: () => module.exports.activate({ subscriptions: [] }),
        changePython: () => callback(),
        changeConfig: () => configurationCallback({ affectsConfiguration: () => true }),
    };
}

test("default uses shared runtime, not the project's selected interpreter", async () => {
    const h = harness();
    await h.activate();
    assert.equal(h.launches[0].command, "/shared/editor-venv/bin/python");
    assert.equal(JSON.stringify(h.launches[0].args), JSON.stringify(["-I", "-m", "kedi.lsp.server"]));
    assert.ok(h.commands.has("kedi.selectPythonInterpreter"));
    await h.changePython();
    assert.equal(h.managedCalls(), 1);
    await h.extension.deactivate();
});

test("explicit host wins and never installs into the selected interpreter", async () => {
    const h = harness({ "lsp.pythonPath": "/custom/python", "lsp.usePythonExtension": true });
    await h.activate();
    assert.equal(h.launches[0].command, "/custom/python");
    assert.equal(h.managedCalls(), 0);
    await h.extension.deactivate();
});

test("Python extension folder selection resolves to an executable and follows changes", async () => {
    const h = harness({ "lsp.usePythonExtension": true });
    await h.activate();
    assert.equal(h.launches[0].command, "/host environment/bin/python");
    h.state.host = "/second/python";
    await h.changePython();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.launches[1].command, "/second/python");
    assert.equal(h.managedCalls(), 0);
    await h.extension.deactivate();
});

test("managed installation failure is visible and does not silently launch host Python", async () => {
    const h = harness({}, { fail: true });
    await h.activate();
    assert.equal(h.launches.length, 0);
    assert.match(h.errors[0], /setup unavailable/);
    await h.extension.deactivate();
});

test("advanced server override bypasses managed installation", async () => {
    const h = harness({ "lsp.serverCommand": "custom-kedi-lsp" });
    await h.activate();
    assert.equal(h.launches[0].command, "custom-kedi-lsp");
    assert.equal(h.managedCalls(), 0);
    await h.extension.deactivate();
});

test("configuration bursts coalesce into one restart", async () => {
    const h = harness();
    await h.activate();
    h.changeConfig(); h.changeConfig(); h.changeConfig();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.launches.length, 2);
    await h.extension.deactivate();
});
