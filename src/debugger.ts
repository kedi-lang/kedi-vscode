import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";

const DEBUG_TYPE = "kedi";
const MODULE_PROBE = "import kedi_debugger; from kedi.debugging import DebugEvent, observe_execution";

type PythonResolver = (resource: vscode.Uri) => Promise<{ python: string; args: string[] }>;

function requireTrust(): void {
    if (!vscode.workspace.isTrusted) {
        throw new Error("Trust this workspace before debugging Kedi programs.");
    }
}

function defaultConfiguration(): vscode.DebugConfiguration {
    return {
        type: DEBUG_TYPE,
        request: "launch",
        name: "Kedi: Current File",
        program: "${file}",
        args: [],
        env: {},
        stopOnEntry: true,
    };
}

function validateConfiguration(config: vscode.DebugConfiguration): void {
    if (config.type !== DEBUG_TYPE || config.request !== "launch") {
        throw new Error("Kedi supports launch debugging only; attach is not supported.");
    }
    if (config.debugServer !== undefined) {
        throw new Error("Kedi uses a local stdio debugger; debugServer is not supported.");
    }
    for (const key of ["python", "pythonPath", "interpreter", "pythonExecutable"]) {
        if (Object.prototype.hasOwnProperty.call(config, key)) {
            throw new Error("Select the Python interpreter in the editor, not launch arguments.");
        }
    }
    if (typeof config.program !== "string" || config.program.includes("\0") || !path.isAbsolute(config.program) || path.extname(config.program) !== ".kedi") {
        throw new Error("Kedi program must be the absolute path of a saved .kedi file.");
    }
    if (typeof config.cwd !== "string" || config.cwd.includes("\0") || !path.isAbsolute(config.cwd)) {
        throw new Error("Kedi cwd must be an absolute directory path.");
    }
    if (!Array.isArray(config.args) || !config.args.every((arg: unknown) => typeof arg === "string" && !arg.includes("\0"))) {
        throw new Error("Kedi args must be an array of strings without NUL characters.");
    }
    if (!config.env || typeof config.env !== "object" || Array.isArray(config.env) ||
        !Object.values(config.env).every(value => typeof value === "string" || value === null)) {
        throw new Error("Kedi env must be an object with string or null values.");
    }
    if (Object.entries(config.env).some(([name, value]) =>
        !name || /[=\0]/.test(name) || (typeof value === "string" && value.includes("\0")))) {
        throw new Error("Kedi env must map valid environment names to strings without NUL characters or null.");
    }
    if (typeof config.stopOnEntry !== "boolean") {
        throw new Error("Kedi stopOnEntry must be a boolean.");
    }
    for (const key of ["adapter", "model"]) {
        if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim())) {
            throw new Error(`Kedi ${key} must be a nonempty string.`);
        }
    }
}

async function checkDebugger(python: string, args: string[], cwd: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        execFile(python, [...args, "-c", MODULE_PROBE], {
            cwd, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true,
        }, error => {
            if (!error) return resolve();
            const quoted = process.platform === "win32" ? JSON.stringify(python) : `'${python.replace(/'/g, "'\\''")}'`;
            // Do not surface subprocess output: interpreter startup can print credentials.
            reject(new Error(
                `Cannot import kedi_debugger and required kedi.debugging hooks with selected Python ${python}. ` +
                "The debugger requires a compatible local Kedi with debugger hooks, not an older 0.4 release. " +
                "Verify that interpreter, then install both local packages explicitly: " +
                `uv pip install --python ${quoted} -e /path/to/kedi -e /path/to/kedi/debugger. ` +
                "No packages were installed by the debugger. Use Kedi: Select Python Interpreter to change Python.",
            ));
        });
    });
}

class KediDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [defaultConfiguration()];
    }

    async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        try {
            requireTrust();
            if (!config.type && !config.request && !config.name) {
                const document = vscode.window.activeTextEditor?.document;
                if (!document || document.uri.scheme !== "file" || document.languageId !== DEBUG_TYPE) {
                    throw new Error("Open a saved .kedi file before starting the Kedi debugger.");
                }
                return defaultConfiguration();
            }
            return config;
        } catch (error) {
            void vscode.window.showErrorMessage(String(error));
            return undefined;
        }
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        try {
            requireTrust();
            const resolved: vscode.DebugConfiguration = {
                ...config,
                args: config.args === undefined ? [] : config.args,
                env: config.env === undefined ? {} : config.env,
                stopOnEntry: config.stopOnEntry === undefined ? true : config.stopOnEntry,
                cwd: config.cwd === undefined
                    ? folder?.uri.fsPath || (typeof config.program === "string" ? path.dirname(config.program) : "")
                    : config.cwd,
            };
            validateConfiguration(resolved);
            const program = vscode.Uri.file(resolved.program);
            const stat = await vscode.workspace.fs.stat(program);
            if (!(stat.type & vscode.FileType.File)) throw new Error("Kedi program must be a saved file, not a directory.");
            const directory = await vscode.workspace.fs.stat(vscode.Uri.file(resolved.cwd));
            if (!(directory.type & vscode.FileType.Directory)) throw new Error("Kedi cwd must be a directory.");
            const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === program.toString());
            if (document?.isDirty) {
                if (!await document.save() || document.isDirty) {
                    throw new Error("Save the Kedi program before debugging; the debugger executes the on-disk source.");
                }
            }
            return resolved;
        } catch (error) {
            void vscode.window.showErrorMessage(String(error));
            return undefined;
        }
    }
}

class KediDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly resolvePython: PythonResolver) {}

    async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterExecutable> {
        requireTrust();
        validateConfiguration(session.configuration);
        const { python, args } = await this.resolvePython(vscode.Uri.file(session.configuration.program));
        requireTrust();
        await checkDebugger(python, args, session.configuration.cwd);
        requireTrust();
        const program = vscode.Uri.file(session.configuration.program);
        if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === program.toString() && doc.isDirty)) {
            throw new Error("Save the Kedi program before debugging; it changed during debugger preparation.");
        }
        return new vscode.DebugAdapterExecutable(python, [...args, "-m", "kedi_debugger", "--stdio"], {
            cwd: session.configuration.cwd,
        });
    }
}

export function registerDebugger(context: vscode.ExtensionContext, resolvePython: PythonResolver): void {
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new KediDebugConfigurationProvider()),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, new KediDebugAdapterFactory(resolvePython)),
    );
}
