const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

function harness(config = {}, options = {}) {
    const launches = [], errors = [], commands = new Map();
    let callback, configurationCallback, debugResolver, managedCalls = 0;
    const state = { host: "/host environment/bin/python" };
    const api = { environments: {
        onDidChangeActiveEnvironmentPath(fn) { callback = fn; return { dispose() {} }; },
        getActiveEnvironmentPath(resource) { state.resource = resource; return { path: "/host environment" }; },
        async resolveEnvironment() { return { executable: { uri: { fsPath: state.host } } }; },
    } };
    const vscode = {
        window: {
            createOutputChannel() { return { appendLine() {}, dispose() {} }; },
            async showErrorMessage(message) { errors.push(message); },
        },
        workspace: {
            getConfiguration() { return { get: (key, fallback) => config[key] === undefined ? fallback : config[key] }; },
            createFileSystemWatcher() { return { dispose() {} }; },
            onDidChangeConfiguration(fn) { configurationCallback = fn; return { dispose() {} }; },
        },
        extensions: { getExtension() { return { isActive: true, exports: api }; } },
        commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; } },
    };
    const embedded = { dispose() {}, setClientGetter() {} };
    const modules = {
        "./debugger": { registerDebugger(_context, resolvePython) { debugResolver = resolvePython; } },
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
        debugPython: resource => debugResolver(resource),
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

test("debugging reuses managed Python and follows explicit interpreter changes", async () => {
    const config = {};
    const h = harness(config);
    await h.activate();
    assert.equal(await h.debugPython({ fsPath: "/project/main.kedi" }), "/shared/editor-venv/bin/python");
    const managedCalls = h.managedCalls();
    config["lsp.pythonPath"] = "/host/python";
    assert.equal(await h.debugPython({ fsPath: "/project/main.kedi" }), "/host/python");
    config["lsp.pythonPath"] = "/other/python";
    assert.equal(await h.debugPython({ fsPath: "/project/main.kedi" }), "/other/python");
    assert.equal(h.managedCalls(), managedCalls);
    await h.extension.deactivate();
});

test("debugging does not guess Python from an opaque LSP command", async () => {
    const h = harness({ "lsp.serverCommand": "custom-kedi-lsp" });
    await h.activate();
    await assert.rejects(h.debugPython({}), /does not identify a debug Python/);
    assert.equal(h.managedCalls(), 0);
    await h.extension.deactivate();
});

test("debugging follows the Python extension for the launched file, not the active editor", async () => {
    const h = harness({ "lsp.usePythonExtension": true });
    await h.activate();
    const resource = { fsPath: "/second project/main.kedi" };
    assert.equal(await h.debugPython(resource), h.state.host);
    assert.equal(h.state.resource, resource);
    h.state.host = undefined;
    await assert.rejects(h.debugPython(resource), /No host Python selected/);
    assert.equal(h.managedCalls(), 0);
    await h.extension.deactivate();
});

test("invalid Python settings fail both services without fallback or installation", async () => {
    for (const [key, value] of [
        ["lsp.pythonPath", false], ["lsp.pythonPath", null], ["lsp.pythonPath", 42],
        ["lsp.pythonPath", "/bad\0python"], ["lsp.usePythonExtension", "false"],
        ["lsp.usePythonExtension", null], ["lsp.serverCommand", []], ["lsp.serverCommand", null],
    ]) {
        const h = harness({ [key]: value });
        await h.activate();
        assert.equal(h.launches.length, 0, key);
        assert.ok(h.errors[0].includes(`kedi.${key} must be`), key);
        await assert.rejects(h.debugPython({}), error => error.message.includes(`kedi.${key} must be`));
        assert.equal(h.managedCalls(), 0, key);
        await h.extension.deactivate();
    }
});

test("LSP and debugger normalize interpreter settings identically", async () => {
    const config = { "lsp.pythonPath": "  /host environment/bin/python  " };
    const h = harness(config);
    await h.activate();
    assert.equal(h.launches[0].command, "/host environment/bin/python");
    assert.equal(await h.debugPython({}), h.launches[0].command);
    config["lsp.pythonPath"] = "  ";
    config["lsp.serverCommand"] = "  ";
    assert.equal(await h.debugPython({}), "/shared/editor-venv/bin/python");
    await h.extension.deactivate();
});
