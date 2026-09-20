// Run explicitly: node runtime/smoke.cjs /absolute/test/home [local Kedi wheel] [local parser wheel]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
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
})().catch(error => { console.error(error); process.exitCode = 1; });
