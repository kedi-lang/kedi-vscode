const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ensureRuntime, runtimePaths, installationEnv, verifyDownload, PACKAGES, PROBE } = require("./bootstrap.js");
const exec = promisify(execFile);

async function home(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kedi editor tests "));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

function fakeRuntime(calls, fail = false) {
    return {
        log() {},
        ensureUv: async () => "test-uv",
        healthy: async paths => fs.access(paths.receipt).then(() => true, () => false),
        run: async (command, args, env) => {
            calls.push({ command, args, env });
            if (fail && args[0] === "pip") throw new Error("Installation failed");
        },
    };
}

test("shared layout, platform paths and absolute KEDI_HOME", () => {
    const base = path.join(os.tmpdir(), "shared kedi");
    assert.equal(runtimePaths(base).root, path.join(base, "editor-venv"));
    assert.equal(runtimePaths(base, "win32").python, path.join(base, "editor-venv", "Scripts/python.exe"));
    assert.throws(() => runtimePaths("relative"), /absolute/);
});

test("corrupt downloaded executables fail checksum verification", () => {
    assert.throws(() => verifyDownload(Buffer.from("not uv"), "0".repeat(64)), /checksum mismatch/);
    verifyDownload(Buffer.from(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("installation does not inherit the workspace Python environment", () => {
    const prior = process.env.PYTHONPATH;
    process.env.PYTHONPATH = "/untrusted/project";
    try {
        const env = installationEnv(os.tmpdir());
        assert.equal(env.PYTHONPATH, undefined);
        assert.equal(env.VIRTUAL_ENV, undefined);
        assert.equal(process.env.PYTHONPATH, "/untrusted/project");
        assert.equal(env.UV_NO_CONFIG, "1");
    } finally {
        if (prior === undefined) delete process.env.PYTHONPATH;
        else process.env.PYTHONPATH = prior;
    }
});

test("first setup pins packages, imports before receipt, then reuses offline", async t => {
    const dir = await home(t);
    const calls = [];
    const deps = fakeRuntime(calls);
    const first = await ensureRuntime({ home: dir }, deps);
    assert.deepEqual(calls[1].args.slice(-PACKAGES.length), PACKAGES);
    assert.ok(PACKAGES.includes("kedi-debugger==0.1.0"));
    assert.ok(PROBE.includes("import kedi_debugger"));
    assert.ok(PROBE.includes("from kedi.debugging import DebugEvent, observe_execution"));
    assert.ok(calls[0].args.includes("--managed-python"));
    assert.equal(calls[2].command, first.python);
    assert.deepEqual(await ensureRuntime({ home: dir }, {
        ...deps, ensureUv: async () => assert.fail("warm startup must not download uv"),
    }), first);
    assert.equal(calls.length, 3);
});

async function ownedRuntime(t, packages = PACKAGES) {
    const dir = await home(t);
    const paths = runtimePaths(dir);
    await fs.mkdir(path.dirname(paths.python), { recursive: true });
    await fs.writeFile(paths.python, "");
    await fs.writeFile(paths.owner, "kedi-editor-runtime-v1");
    await fs.writeFile(paths.receipt, JSON.stringify({ packages, python: "3.12" }));
    return { dir, paths };
}

test("an existing LSP-only environment gains the debugger once at the same path", async t => {
    const { dir, paths } = await ownedRuntime(t, PACKAGES.filter(spec => !spec.startsWith("kedi-debugger==")));
    const calls = [];
    const deps = fakeRuntime(calls);
    delete deps.healthy; // Exercise real receipt comparison and import probing.
    const result = await ensureRuntime({ home: dir }, deps);
    assert.equal(result.python, paths.python);
    assert.deepEqual(calls[1].args.slice(-PACKAGES.length), PACKAGES);
    assert.equal(calls[2].args[2], PROBE);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.receipt, "utf8")).packages, PACKAGES);
    await ensureRuntime({ home: dir }, {
        ...deps, ensureUv: async () => assert.fail("Warm setup must not install again"),
    });
    assert.equal(calls.length, 4);
    assert.equal(calls[3].command, paths.python);
    assert.equal(calls[3].args[2], PROBE);
});

test("a removed debugger is repaired even when the package receipt is current", async t => {
    const { dir, paths } = await ownedRuntime(t);
    const calls = [];
    const deps = fakeRuntime(calls);
    delete deps.healthy;
    const execute = deps.run;
    let failedProbe = false;
    deps.run = async (command, args, env) => {
        await execute(command, args, env);
        if (command === paths.python && !failedProbe) {
            failedProbe = true;
            throw new Error("No module named kedi_debugger");
        }
    };
    await ensureRuntime({ home: dir }, deps);
    assert.equal(calls.length, 4);
    assert.ok(calls[2].args.includes("kedi-debugger==0.1.0"));
    assert.equal(calls[3].args[2], PROBE);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.receipt, "utf8")).packages, PACKAGES);
});

test("failed debugger upgrade removes stale readiness and can be retried", async t => {
    const { dir, paths } = await ownedRuntime(t, PACKAGES.filter(spec => !spec.startsWith("kedi-debugger==")));
    const deps = fakeRuntime([], true);
    delete deps.healthy;
    await assert.rejects(ensureRuntime({ home: dir }, deps), /Installation failed/);
    await assert.rejects(fs.access(paths.receipt), { code: "ENOENT" });
    await assert.rejects(fs.access(`${paths.root}.lock`), { code: "ENOENT" });
    const retry = fakeRuntime([]);
    delete retry.healthy;
    await ensureRuntime({ home: dir }, retry);
    assert.deepEqual(JSON.parse(await fs.readFile(paths.receipt, "utf8")).packages, PACKAGES);
});

test("a Kedi runtime without debugger hooks is never marked ready", async t => {
    const dir = await home(t);
    const paths = runtimePaths(dir);
    const deps = fakeRuntime([]);
    delete deps.healthy;
    deps.run = async command => {
        if (command === paths.python) throw new Error("Missing kedi.debugging hooks");
    };
    await assert.rejects(ensureRuntime({ home: dir }, deps), /Missing kedi.debugging hooks/);
    await assert.rejects(fs.access(paths.receipt), { code: "ENOENT" });
    await assert.rejects(fs.access(`${paths.root}.lock`), { code: "ENOENT" });
});

test("failed setup is not ready, releases lock, and can be retried", async t => {
    const dir = await home(t);
    await assert.rejects(ensureRuntime({ home: dir }, fakeRuntime([], true)), /Installation failed/);
    await assert.rejects(fs.access(runtimePaths(dir).receipt), { code: "ENOENT" });
    await assert.rejects(fs.access(`${runtimePaths(dir).root}.lock`), { code: "ENOENT" });
    const calls = [];
    await ensureRuntime({ home: dir }, fakeRuntime(calls));
    assert.equal(calls.length, 3);
});

test("failed imports never mark an environment ready", async t => {
    const dir = await home(t);
    const deps = fakeRuntime([]);
    deps.run = async (command) => {
        if (command !== "test-uv") throw new Error("broken tree-sitter wheel");
    };
    await assert.rejects(ensureRuntime({ home: dir }, deps), /broken tree-sitter/);
    await assert.rejects(fs.access(runtimePaths(dir).receipt), { code: "ENOENT" });
});

test("existing non-Kedi directories are never modified", async t => {
    const dir = await home(t);
    const paths = runtimePaths(dir);
    await fs.mkdir(paths.root);
    await fs.writeFile(path.join(paths.root, "user-data"), "keep");
    await assert.rejects(ensureRuntime({ home: dir }, fakeRuntime([])), /unowned/);
    assert.equal(await fs.readFile(path.join(paths.root, "user-data"), "utf8"), "keep");
});

test("managed environment symlinks cannot redirect installation", { skip: process.platform === "win32" }, async t => {
    const dir = await home(t);
    await fs.mkdir(path.join(dir, "external"));
    await fs.symlink(path.join(dir, "external"), runtimePaths(dir).root);
    await assert.rejects(ensureRuntime({ home: dir }, fakeRuntime([])), /symlink/);
    assert.deepEqual(await fs.readdir(path.join(dir, "external")), []);
});

test("missing runtime is recreated at the same shared path", async t => {
    const dir = await home(t);
    const first = await ensureRuntime({ home: dir }, fakeRuntime([]));
    await fs.rm(runtimePaths(dir).root, { recursive: true });
    const calls = [];
    assert.deepEqual(await ensureRuntime({ home: dir }, fakeRuntime(calls)), first);
    assert.equal(calls.length, 3);
});

test("two editor processes perform one installation", async t => {
    const dir = await home(t);
    const log = path.join(dir, "installs.log");
    const code = `
        const fs = require('node:fs/promises');
        const { ensureRuntime } = require(${JSON.stringify(require.resolve("./bootstrap.js"))});
        ensureRuntime({ home: ${JSON.stringify(dir)} }, {
            log() {}, ensureUv: async () => 'uv',
            healthy: async p => fs.access(p.receipt).then(() => true, () => false),
            run: async (_, args) => {
                if(args[0] === 'pip') {
                    await fs.appendFile(${JSON.stringify(log)}, 'install\\n');
                    await new Promise(resolve => setTimeout(resolve, 150));
                }
            }
        }).then(r => process.stdout.write(JSON.stringify(r))).catch(e => { console.error(e); process.exitCode=1; });
    `;
    const [one, two] = await Promise.all([exec(process.execPath, ["-e", code]), exec(process.execPath, ["-e", code])]);
    assert.deepEqual(JSON.parse(one.stdout), JSON.parse(two.stdout));
    assert.equal(await fs.readFile(log, "utf8"), "install\n");
});
