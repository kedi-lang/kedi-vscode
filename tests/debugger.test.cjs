const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transformSync } = require("esbuild");

const root = path.resolve("project with spaces");
const program = path.join(root, "main.kedi");
const configuration = overrides => ({ type: "kedi", request: "launch", name: "Kedi test", program, ...overrides });
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
    const errors = [], probes = [], resources = [], registrations = [], subscriptions = [];
    const state = { python: "/selected venv/bin/python", resolverCalls: 0, saves: 0 };
    const uri = file => ({ scheme: "file", fsPath: file, toString: () => `file://${file}` });
    const vscode = {
        FileType: { File: 1, Directory: 2 },
        Uri: { file: uri },
        window: {
            activeTextEditor: { document: { uri: uri(program), languageId: "kedi" } },
            async showErrorMessage(message) { errors.push(message); },
        },
        workspace: {
            isTrusted: options.trusted !== false,
            textDocuments: options.dirty ? [{ uri: uri(program), isDirty: true, async save() {
                state.saves++;
                this.isDirty = options.stillDirty === true || options.save === false;
                return options.save !== false;
            } }] : [],
            fs: { async stat(resource) {
                if (options.missing) throw new Error("File not found");
                return { type: resource.fsPath === program ? (options.directoryProgram ? 2 : 1) : 2 };
            } },
        },
        DebugAdapterExecutable: class {
            constructor(command, args, options) { Object.assign(this, { command, args, options }); }
        },
        debug: {
            registerDebugConfigurationProvider(type, provider) {
                registrations.push(type); state.provider = provider; return { dispose() {} };
            },
            registerDebugAdapterDescriptorFactory(type, factory) {
                registrations.push(type); state.factory = factory; return { dispose() {} };
            },
        },
    };
    const source = transformSync(fs.readFileSync(path.join(__dirname, "../src/debugger.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module, exports: module.exports, process,
        require(name) {
            if (name === "vscode") return vscode;
            if (name === "child_process") return { execFile(command, args, settings, done) {
                probes.push({ command, args: plain(args), settings });
                if (options.untrustDuringProbe) vscode.workspace.isTrusted = false;
                if (options.editDuringProbe) vscode.workspace.textDocuments.push({ uri: uri(program), isDirty: true });
                done(options.probeError ? Object.assign(new Error("startup failed"), { stderr: "SECRET" }) : null);
            } };
            return require(name);
        },
    });
    module.exports.registerDebugger({ subscriptions }, async resource => {
        state.resolverCalls++;
        resources.push(resource);
        if (options.untrustDuringResolution) vscode.workspace.isTrusted = false;
        if (options.editDuringResolution) vscode.workspace.textDocuments.push({ uri: uri(program), isDirty: true });
        if (options.resolverError) throw new Error("Selected Python unavailable");
        return { python: state.python, args: options.managed ? ["-I"] : [] };
    });
    return { ...state, state, vscode, errors, probes, resources, registrations, subscriptions };
}

test("registers the native kedi provider, executable factory, and disposable ownership", () => {
    const h = harness();
    assert.deepEqual(h.registrations, ["kedi", "kedi"]);
    assert.equal(h.subscriptions.length, 2);
    assert.deepEqual(plain(h.provider.provideDebugConfigurations()[0]), {
        type: "kedi", request: "launch", name: "Kedi: Current File", program: "${file}",
        args: [], env: {}, stopOnEntry: true,
    });
});

test("F5 without launch.json targets a saved active Kedi file", async () => {
    const h = harness();
    assert.equal((await h.provider.resolveDebugConfiguration(undefined, {})).program, "${file}");
    h.vscode.window.activeTextEditor.document.uri.scheme = "untitled";
    assert.equal(await h.provider.resolveDebugConfiguration(undefined, {}), undefined);
    assert.match(h.errors[0], /saved .kedi file/);
});

test("normalizes defaults only after substitution and saves dirty source", async () => {
    const h = harness({ dirty: true });
    const input = configuration();
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, input);
    assert.deepEqual(plain(config), { ...input, cwd: root, args: [], env: {}, stopOnEntry: true });
    assert.equal(input.cwd, undefined);
    assert.equal(h.state.saves, 1);
});

test("passes launch args, env, model, adapter and explicit entry preference unchanged", async () => {
    const h = harness();
    const input = configuration({ cwd: root, args: ["--name", "two words"], env: { APP_MODE: "test" }, adapter: "pydantic", model: "test-model", stopOnEntry: false });
    assert.deepEqual(plain(await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, input)), input);
});

test("preserves null environment removals and empty string overrides", async () => {
    const h = harness();
    const input = configuration({ env: { APP_MODE: "test", EMPTY: "", REMOVE_ME: null } });
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, input);
    assert.deepEqual(plain(config.env), input.env);
    await h.factory.createDebugAdapterDescriptor({ configuration: config });
    assert.deepEqual(plain(config.env), input.env);
    assert.equal(h.probes[0].settings.env, undefined);
});

test("workspace folder supplies cwd instead of the active editor's folder", async () => {
    const h = harness();
    const folder = { uri: h.vscode.Uri.file(path.dirname(root)) };
    const result = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(folder, configuration());
    assert.equal(result.cwd, folder.uri.fsPath);
});

for (const [field, value, message] of [
    ["request", "attach", /launch debugging only/],
    ["debugServer", 4711, /stdio/],
    ["program", "main.kedi", /absolute path/],
    ["program", path.join(root, "main.py"), /saved .kedi/],
    ["program", undefined, /saved .kedi/],
    ["program", path.join(root, "bad\0.kedi"), /saved .kedi/],
    ["cwd", "relative", /absolute directory/],
    ["cwd", `${root}\0`, /absolute directory/],
    ["args", "--name Ada", /array of strings/],
    ["args", [1], /array of strings/],
    ["args", ["bad\0arg"], /without NUL/],
    ["env", [], /object with string or null values/],
    ["env", null, /object with string or null values/],
    ["env", { X: 1 }, /object with string or null values/],
    ["env", { X: false }, /object with string or null values/],
    ["env", { X: {} }, /object with string or null values/],
    ["env", { "": "value" }, /valid environment names/],
    ["env", { "A=B": "value" }, /valid environment names/],
    ["env", { "A\0B": null }, /valid environment names/],
    ["env", { X: "bad\0value" }, /without NUL/],
    ["python", "/other/python", /interpreter in the editor/],
    ["pythonPath", null, /interpreter in the editor/],
    ["interpreter", "/other/python", /interpreter in the editor/],
    ["pythonExecutable", "/other/python", /interpreter in the editor/],
    ["stopOnEntry", null, /boolean/],
    ["adapter", {}, /nonempty string/],
    ["model", "", /nonempty string/],
]) {
    test(`rejects invalid ${field}: ${JSON.stringify(value)} before starting Python`, async () => {
        const h = harness();
        assert.equal(await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration({ [field]: value })), undefined);
        assert.match(h.errors[0], message);
        assert.equal(h.state.resolverCalls, 0);
        assert.equal(h.probes.length, 0);
    });
}

test("missing files, directory programs, and failed saves abort launch", async () => {
    for (const options of [{ missing: true }, { directoryProgram: true }, { dirty: true, save: false }, { dirty: true, stillDirty: true }]) {
        const h = harness(options);
        assert.equal(await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration()), undefined);
        assert.equal(h.errors.length, 1);
    }
});

test("trust revoked during interpreter selection or preflight aborts the descriptor", async () => {
    for (const options of [{ untrustDuringResolution: true }, { untrustDuringProbe: true }]) {
        const h = harness(options);
        const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration());
        await assert.rejects(h.factory.createDebugAdapterDescriptor({ configuration: config }), /Trust this workspace/);
        assert.equal(h.probes.length, options.untrustDuringResolution ? 0 : 1);
    }
});

test("editing the program during interpreter resolution or preflight aborts launch", async () => {
    for (const options of [{ editDuringResolution: true }, { editDuringProbe: true }]) {
        const h = harness(options);
        const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration());
        await assert.rejects(h.factory.createDebugAdapterDescriptor({ configuration: config }), /changed during debugger preparation/);
        assert.equal(h.state.saves, 0);
    }
});

test("untrusted workspaces cannot resolve or spawn even when factory is called directly", async () => {
    const h = harness({ trusted: false });
    assert.equal(await h.provider.resolveDebugConfiguration(undefined, {}), undefined);
    assert.equal(await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration()), undefined);
    await assert.rejects(h.factory.createDebugAdapterDescriptor({ configuration: configuration() }), /Trust this workspace/);
    assert.equal(h.state.resolverCalls, 0);
    assert.equal(h.probes.length, 0);
});

test("stdio factory uses the selected executable, not a shell or a separate debug runtime", async () => {
    const h = harness();
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration({ env: { DEBUGGEE_ONLY: "yes" } }));
    const descriptor = await h.factory.createDebugAdapterDescriptor({ configuration: config });
    assert.equal(descriptor.command, h.state.python);
    assert.deepEqual(plain(descriptor.args), ["-m", "kedi_debugger", "--stdio"]);
    assert.equal(descriptor.options.cwd, root);
    assert.equal(descriptor.options.env, undefined);
    assert.equal(h.resources[0].fsPath, program);
    assert.equal(h.probes[0].command, h.state.python);
    assert.equal(h.probes[0].args[1], "import kedi_debugger; from kedi.debugging import DebugEvent, observe_execution");
    assert.equal(h.probes[0].settings.timeout, 15000);
    h.state.python = "/changed/python";
    assert.equal((await h.factory.createDebugAdapterDescriptor({ configuration: config })).command, "/changed/python");
});

test("managed debugger and its import probe preserve Python isolation", async () => {
    const h = harness({ managed: true });
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration());
    const descriptor = await h.factory.createDebugAdapterDescriptor({ configuration: config });
    assert.deepEqual(plain(descriptor.args), ["-I", "-m", "kedi_debugger", "--stdio"]);
    assert.deepEqual(h.probes[0].args.slice(0, 2), ["-I", "-c"]);
});

test("missing module has a local editable install hint without logs, install or fallback", async () => {
    const h = harness({ probeError: true });
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration());
    await assert.rejects(h.factory.createDebugAdapterDescriptor({ configuration: config }), error => {
        assert.match(error.message, /selected Python \/selected venv\/bin\/python/);
        assert.match(error.message, /uv pip install --python .* -e \/path\/to\/kedi\/debugger/);
        assert.match(error.message, /kedi.debugging/);
        assert.match(error.message, /-e \/path\/to\/kedi -e/);
        assert.match(error.message, /No packages were installed/);
        assert.doesNotMatch(error.message, /SECRET|pip install kedi-debugger/);
        return true;
    });
    assert.equal(h.probes.length, 1);
    assert.equal(h.state.resolverCalls, 1);
});

test("interpreter resolution failure never probes a fallback", async () => {
    const h = harness({ resolverError: true });
    const config = await h.provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration());
    await assert.rejects(h.factory.createDebugAdapterDescriptor({ configuration: config }), /Selected Python unavailable/);
    assert.equal(h.probes.length, 0);
});

test("manifest contributes launch schema, breakpoints and debugger activation only", () => {
    const manifest = require("../package.json");
    const debuggerContribution = manifest.contributes.debuggers.find(debugger_ => debugger_.type === "kedi");
    assert.ok(manifest.activationEvents.includes("onDebugResolve:kedi"));
    assert.ok(manifest.contributes.breakpoints.some(breakpoint => breakpoint.language === "kedi"));
    assert.deepEqual(Object.keys(debuggerContribution.configurationAttributes), ["launch"]);
    assert.equal(debuggerContribution.configurationAttributes.launch.properties.stopOnEntry.default, true);
    assert.deepEqual(debuggerContribution.configurationAttributes.launch.properties.env.additionalProperties.type, ["string", "null"]);
    assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
});

test("launch schema rejects backend-invalid process inputs without banning null removals", () => {
    const schema = require("../package.json").contributes.debuggers[0].configurationAttributes.launch;
    assert.deepEqual(schema.not.anyOf.map(rule => rule.required[0]), ["python", "pythonPath", "interpreter", "pythonExecutable"]);
    const env = schema.properties.env;
    const names = new RegExp(env.propertyNames.pattern);
    for (const name of ["", "A=B", "A\0B"]) assert.equal(names.test(name), false);
    for (const name of ["PATH", "APP_MODE", "a.b"]) assert.equal(names.test(name), true);
    for (const value of [schema.properties.program, schema.properties.cwd, schema.properties.args.items, env.additionalProperties]) {
        const pattern = new RegExp(value.pattern);
        assert.equal(pattern.test("bad\0value"), false);
        assert.equal(pattern.test("two words"), true);
    }
    assert.deepEqual(env.additionalProperties.type, ["string", "null"]);
});
