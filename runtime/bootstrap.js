// Canonical editor runtime bootstrap. The bundled .cjs is also embedded by kedi-zed.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const lockfile = require("proper-lockfile");

const exec = promisify(execFile);
const UV_VERSION = "0.11.21";
const PYTHON_VERSION = "3.12";
const PACKAGES = ["kedi==0.4.0", "tree-sitter-kedi==0.4.1"];
const OWNER = "kedi-editor-runtime-v1";
const ASSETS = {
    "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "1f921d491ba5ffeea774eb04d6681ecee379101341cbb1500394993b541bf3f4"],
    "darwin-x64": ["x86_64-apple-darwin.tar.gz", "f3c8e5708a84b920c18b691214d54d2b0da6b984789caae95d47c95120cb7765"],
    "linux-arm64": ["aarch64-unknown-linux-musl.tar.gz", "e71badaed2a2c3a404a0a00974b51c7ed5f5bc7be947916846005b739c68a5a2"],
    "linux-x64": ["x86_64-unknown-linux-musl.tar.gz", "9dadff5b9e7b1d2d011e41852a1cbca713d9d5d88194f2eb6bd240fa4fb0a719"],
    "win32-arm64": ["aarch64-pc-windows-msvc.zip", "74e443f8004022dde57a1bd0d10c097830f9ea8feb4ec927db52cd5d805c2f48"],
    "win32-x64": ["x86_64-pc-windows-msvc.zip", "ace861f360c6de2babedc1607d0f454b6b09a820dbc8182dc15af927e4df9589"],
};

function runtimePaths(home = process.env.KEDI_HOME || path.join(os.homedir(), ".kedi"), platform = process.platform) {
    if (!path.isAbsolute(home)) throw new Error("KEDI_HOME must be an absolute path");
    const root = path.join(home, "editor-venv");
    return {
        home, root,
        python: path.join(root, platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        owner: path.join(root, ".kedi-editor-owner"),
        receipt: path.join(root, ".kedi-editor-ready.json"),
        uv: path.join(home, "editor-tools", `uv-${UV_VERSION}`, platform === "win32" ? "uv.exe" : "uv"),
    };
}

function installationEnv(home) {
    const env = { ...process.env };
    // Neither a workspace's Python search path nor an activated venv owns this runtime.
    for (const key of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "CONDA_PREFIX", "UV_PROJECT_ENVIRONMENT", "UV_CONFIG_FILE", "UV_WORKING_DIR", "UV_VENV_CLEAR", "UV_VENV_SEED", "UV_SYSTEM_PYTHON", "UV_PYTHON", "UV_PYTHON_PREFERENCE"]) delete env[key];
    return {
        ...env, PYTHONNOUSERSITE: "1", UV_NO_CONFIG: "1", UV_NO_PROGRESS: "1",
        UV_PYTHON_INSTALL_DIR: path.join(home, "editor-python"),
        UV_CACHE_DIR: path.join(home, "editor-cache"),
    };
}

async function run(command, args, env, timeout = 300000) {
    try {
        return await exec(command, args, {
            env, cwd: os.tmpdir(), timeout, killSignal: "SIGKILL",
            windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        });
    } catch (error) {
        const detail = String(error.stderr || error.message).slice(-4000);
        throw new Error(`${path.basename(command)} failed: ${detail}`);
    }
}

async function exists(file) {
    try { await fs.access(file); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function download(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (!url.startsWith("https://") || redirects > 5) return reject(new Error("Invalid runtime download redirect"));
        const request = https.get(url, { headers: { "User-Agent": "kedi-editor-runtime" } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                clearTimeout(timer);
                try {
                    if (!response.headers.location) throw new Error("Runtime download redirect has no location");
                    return download(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
                } catch (error) { return reject(error); }
            }
            if (response.statusCode !== 200) {
                response.resume();
                clearTimeout(timer);
                return reject(new Error(`Runtime download returned HTTP ${response.statusCode}`));
            }
            const chunks = [];
            let size = 0;
            response.on("data", chunk => {
                size += chunk.length;
                if (size > 100 * 1024 * 1024) request.destroy(new Error("Runtime download exceeded 100 MiB"));
                else chunks.push(chunk);
            });
            response.on("error", error => { clearTimeout(timer); reject(error); });
            response.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
        });
        const timer = setTimeout(() => request.destroy(new Error("Runtime download timed out")), 120000);
        request.on("error", error => { clearTimeout(timer); reject(error); });
    });
}

function verifyDownload(bytes, expected) {
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("uv download checksum mismatch; refusing to execute it");
}

async function ensureUv(paths, env, log) {
    if (await exists(paths.uv)) return paths.uv;
    const asset = ASSETS[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`Automatic Python setup is unsupported on ${process.platform}/${process.arch}; configure a host Python instead.`);
    const [name, expected] = asset;
    log(`Downloading verified uv ${UV_VERSION}`);
    const bytes = await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${name}`);
    verifyDownload(bytes, expected);
    const temp = await fs.mkdtemp(path.join(paths.home, ".editor-uv-"));
    try {
        const archive = path.join(temp, `uv-${name}`);
        await fs.writeFile(archive, bytes, { mode: 0o600 });
        await run("tar", ["-xf", archive, "-C", temp], env, 60000);
        const binary = process.platform === "win32" ? "uv.exe" : "uv";
        const extracted = name.endsWith(".zip") ? path.join(temp, binary) : path.join(temp, `uv-${name.replace(/\.tar\.gz$/, "")}`, binary);
        await fs.mkdir(path.dirname(paths.uv), { recursive: true, mode: 0o700 });
        await fs.chmod(extracted, 0o700);
        await fs.rename(extracted, paths.uv);
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
    return paths.uv;
}

const PROBE = [
    "import sys, importlib.metadata as m",
    "import kedi.lsp.server, kedi.lsp.python_virtual, tree_sitter_kedi",
    "assert sys.version_info[:2] == (3, 12)",
    ...PACKAGES.map(spec => { const [name, version] = spec.split("=="); return `assert m.version(${JSON.stringify(name)}) == ${JSON.stringify(version)}`; }),
].join("; ");

async function healthy(paths, env) {
    if (!await exists(paths.receipt) || !await exists(paths.python)) return false;
    try {
        const receipt = JSON.parse(await fs.readFile(paths.receipt, "utf8"));
        if (JSON.stringify(receipt.packages) !== JSON.stringify(PACKAGES)) return false;
        await run(paths.python, ["-I", "-c", PROBE], env, 30000);
        return true;
    } catch { return false; }
}

async function ensureRuntime(options = {}, dependencies = {}) {
    const paths = runtimePaths(options.home);
    const env = installationEnv(paths.home);
    const log = dependencies.log || (message => process.stderr.write(`[kedi] ${message}\n`));
    const check = dependencies.healthy || healthy;
    const execute = dependencies.run || run;
    const getUv = dependencies.ensureUv || ensureUv;
    await fs.mkdir(paths.home, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(paths.root, {
        realpath: false, stale: 120000, update: 10000,
        retries: { retries: 600, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
    });
    try {
        if (await exists(paths.root)) {
            const stat = await fs.lstat(paths.root);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Managed editor environment must be a real directory, not a symlink");
            if (!await exists(paths.owner) || (await fs.readFile(paths.owner, "utf8")) !== OWNER) {
                throw new Error(`Refusing to modify an unowned environment: ${paths.root}. Move it aside or select a host Python.`);
            }
        }
        if (await check(paths, env)) return { python: paths.python };
        await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
        await fs.writeFile(paths.owner, OWNER, { mode: 0o600 });
        const uv = await getUv(paths, env, log);
        log(`Preparing shared Python ${PYTHON_VERSION} environment`);
        await execute(uv, ["venv", "--no-config", "--no-project", "--allow-existing", "--managed-python", "--python", PYTHON_VERSION, paths.root], env);
        log("Installing Kedi and its language-server dependencies");
        await execute(uv, ["pip", "install", "--no-config", "--python", paths.python, ...(dependencies.installPackages || PACKAGES)], env);
        // A receipt is valid only after import and package-version verification succeeds.
        await execute(paths.python, ["-I", "-c", PROBE], env, 30000);
        await fs.writeFile(paths.receipt, JSON.stringify({ packages: PACKAGES, python: PYTHON_VERSION }), { mode: 0o600 });
        log("Shared Kedi editor environment is ready");
        return { python: paths.python };
    } finally {
        await release();
    }
}

module.exports = { ensureRuntime, runtimePaths, installationEnv, run, verifyDownload, PACKAGES, PROBE };
