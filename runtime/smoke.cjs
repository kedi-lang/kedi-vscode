// Run explicitly: node runtime/smoke.cjs /absolute/test/home [local Kedi wheel] [local parser wheel] [local debugger wheel]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ensureRuntime, runtimePaths } = require("./bootstrap.cjs");

async function lspHandshake(python) {
    const process = spawn(python, ["-I", "-m", "kedi.lsp.server"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = Buffer.alloc(0), stderr = "";
    const pending = new Map();
    const send = message => {
        const data = Buffer.from(JSON.stringify(message));
        process.stdin.write(`Content-Length: ${data.length}\r\n\r\n`);
        process.stdin.write(data);
    };
    const request = (id, method, params) => new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
    });
    process.stderr.on("data", data => { stderr += data; });
    process.on("error", error => { for (const value of pending.values()) value.reject(error); });
    process.stdout.on("data", data => {
        buffer = Buffer.concat([buffer, data]);
        while (true) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) return;
            const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
            if (!Number.isFinite(length)) throw new Error("Invalid LSP frame");
            if (buffer.length < end + 4 + length) return;
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
            buffer = buffer.subarray(end + 4 + length);
            const waiter = pending.get(message.id);
            if (waiter) {
                pending.delete(message.id);
                if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
                else waiter.resolve(message.result);
            }
        }
    });
    const timer = setTimeout(() => {
        for (const value of pending.values()) value.reject(new Error(`LSP timed out: ${stderr}`));
        process.kill();
    }, 30000);
    try {
        const init = await request(1, "initialize", { processId: null, rootUri: null, capabilities: {} });
        assert.ok(init.capabilities.hoverProvider);
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        await request(2, "shutdown", null);
        send({ jsonrpc: "2.0", method: "exit", params: null });
        console.log("Real Kedi LSP initialize/shutdown: passed");
    } finally {
        clearTimeout(timer);
        process.kill();
    }
}

async function debuggerHandshake(python) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kedi-debugger-smoke-"));
    const program = path.join(directory, "smoke.kedi");
    await fs.writeFile(program, "[answer: int] = `42`\n= <answer>\n");
    const child = spawn(python, ["-I", "-m", "kedi_debugger", "--stdio"], {
        cwd: directory, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    const messages = [], waiters = [];
    let buffer = Buffer.alloc(0), sequence = 0, failure;
    const fail = error => {
        failure = error;
        for (const waiter of waiters.splice(0)) waiter.reject(error);
    };
    const wait = predicate => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const index = messages.findIndex(predicate);
        if (index >= 0) resolve(messages.splice(index, 1)[0]);
        else waiters.push({ predicate, resolve, reject });
    });
    const request = async (command, args = {}) => {
        const seq = ++sequence;
        const data = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }));
        child.stdin.write(`Content-Length: ${data.length}\r\n\r\n`);
        child.stdin.write(data);
        const response = await wait(message => message.type === "response" && message.request_seq === seq);
        assert.equal(response.success, true, response.message);
        return response.body;
    };
    const event = name => wait(message => message.type === "event" && message.event === name);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", () => fail(new Error("Debugger smoke process closed")));
    child.stderr.resume();
    child.stdout.on("data", data => {
        try {
            buffer = Buffer.concat([buffer, data]);
            while (true) {
                const end = buffer.indexOf("\r\n\r\n");
                if (end < 0) return;
                const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
                assert.ok(Number.isSafeInteger(length) && length > 0 && length <= 4 * 1024 * 1024);
                if (buffer.length < end + 4 + length) return;
                const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
                buffer = buffer.subarray(end + 4 + length);
                const index = waiters.findIndex(waiter => waiter.predicate(message));
                if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
                else messages.push(message);
            }
        } catch (error) { fail(error); }
    });
    const timer = setTimeout(() => {
        fail(new Error("Debugger smoke timed out"));
        child.kill();
    }, 30000);
    try {
        const capabilities = await request("initialize", { adapterID: "kedi" });
        assert.equal(capabilities.supportsConfigurationDoneRequest, true);
        const launch = request("launch", { program, cwd: directory, stopOnEntry: true });
        launch.catch(fail);
        await event("initialized");
        await request("configurationDone");
        await launch;
        const stop = await event("stopped");
        const threadId = stop.body.threadId;
        const stack = await request("stackTrace", { threadId });
        assert.equal(stack.stackFrames[0].line, 1);
        await request("continue", { threadId });
        assert.equal((await event("exited")).body.exitCode, 0);
        await event("terminated");
        await request("disconnect");
        assert.equal(await closed, 0);
        console.log("Real installed debugger initialize/launch/stop/continue/exit: passed");
    } finally {
        clearTimeout(timer);
        child.kill();
        await closed;
        await fs.rm(directory, { recursive: true, force: true });
    }
}

(async () => {
    const home = process.argv[2];
    assert.ok(home, "An explicit isolated test home is required");
    const wheels = process.argv.slice(3);
    const result = await ensureRuntime({ home }, wheels.length ? { installPackages: wheels } : {});
    const receipt = runtimePaths(home).receipt;
    const before = (await fs.stat(receipt)).mtimeMs;
    const again = await ensureRuntime({ home }, {
        ensureUv: async () => assert.fail("Warm setup must not download or install"),
    });
    assert.equal(again.python, result.python);
    assert.equal((await fs.stat(receipt)).mtimeMs, before);
    console.log("Warm startup reused the same Python without installation: passed");
    await lspHandshake(result.python);
    const { stdout } = await promisify(execFile)(result.python, ["-I", "-c", "from kedi.lsp.python_virtual import main_loop; print('virtualizer import: passed')"]);
    console.log(stdout.trim());
    await debuggerHandshake(result.python);
})().catch(error => { console.error(error); process.exitCode = 1; });
