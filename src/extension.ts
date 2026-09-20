/**
 * Kedi VS Code extension — LSP client + embedded-Python forwarding.
 *
 * Kedi document highlighting comes from LSP semantic tokens.
 * Hover / Go-to-Def / References / Rename / Outline /
 * Signature Help / Inlay Hints / Formatting are served by
 * `kedi-lsp` (Python, pygls).
 *
 * For positions inside a fenced ```python``` block or an inline
 * `python_expr` region, the `embeddedPython` module forwards
 * Hover/Definition/References to whatever Python LSP the user has
 * (Pylance/Pyright via ms-python.python). The Kedi LSP also emits
 * Python semantic tokens for those embedded regions so Python
 * keywords, strings, functions, etc. light up inside Kedi documents.
 *
 * A shared managed Python is the default. Following the Python extension's
 * selected interpreter is an explicit opt-in.
 */

import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";

import { registerEmbeddedPython, EmbeddedPython } from "./embeddedPython";
import {
    registerEmbeddedKediInPython,
    EmbeddedKediInPython,
} from "./embeddedKediInPython";
import { managedPython, selectPython } from "./runtime";

let client: LanguageClient | undefined;
let embedded: EmbeddedPython | undefined;
let embeddedKedi: EmbeddedKediInPython | undefined;
let pythonApi: any | undefined;
let outputChannel: vscode.OutputChannel | undefined;

let restartQueue: Promise<void> = Promise.resolve();
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    disposed = false;
    outputChannel = vscode.window.createOutputChannel("Kedi Language Server");
    context.subscriptions.push(outputChannel);

    // Build the embedded-Python module first — the LSP middleware
    // closes over its public surface (range fetch + virtual-doc URI).
    embedded = registerEmbeddedPython(context, () => client);
    embeddedKedi = registerEmbeddedKediInPython(context, () => client);

    context.subscriptions.push(vscode.commands.registerCommand("kedi.selectPythonInterpreter", selectPython));

    // Restart when the user changes their Python interpreter.
    try {
        pythonApi = await getPythonApi();
        if (pythonApi?.environments?.onDidChangeActiveEnvironmentPath) {
            context.subscriptions.push(
                pythonApi.environments.onDidChangeActiveEnvironmentPath(async () => {
                    const cfg = vscode.workspace.getConfiguration("kedi");
                    if (!cfg.get<boolean>("lsp.usePythonExtension", false) || cfg.get<string>("lsp.pythonPath", "")) return;
                    outputChannel?.appendLine(
                        "Active Python interpreter changed — restarting kedi-lsp."
                    );
                    scheduleRestart(context);
                })
            );
        }
    } catch (err) {
        outputChannel?.appendLine(
            `Python extension API unavailable: ${err}. Falling back to settings.`
        );
    }

    // Restart on configuration changes that affect server spawn.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (
                e.affectsConfiguration("kedi.lsp.usePythonExtension") ||
                e.affectsConfiguration("kedi.lsp.pythonPath") ||
                e.affectsConfiguration("kedi.lsp.serverCommand")
            ) {
                scheduleRestart(context);
            }
        })
    );

    // Manual restart command.
    context.subscriptions.push(
        vscode.commands.registerCommand("kedi.restartServer", async () => {
            await restartClient(context);
        })
    );
    await restartClient(context);
}

export async function deactivate(): Promise<void> {
    disposed = true;
    if (restartTimer) clearTimeout(restartTimer);
    await restartQueue;
    if (client) {
        await client.stop();
        client = undefined;
    }
    embedded?.dispose();
    embedded = undefined;
    embeddedKedi?.dispose();
    embeddedKedi = undefined;
}

function scheduleRestart(context: vscode.ExtensionContext): void {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => { void restartClient(context); }, 300);
}

function restartClient(context: vscode.ExtensionContext): Promise<void> {
    restartQueue = restartQueue.then(async () => {
        if (!disposed) await restartNow(context);
    }).catch(err => { outputChannel?.appendLine(`Kedi startup failed: ${err}`); });
    return restartQueue;
}

async function restartNow(context: vscode.ExtensionContext): Promise<void> {
    if (client) {
        try {
            await client.stop();
        } catch {
            /* ignore */
        }
        client = undefined;
    }
    if (embedded) {
        await startClient(context, embedded);
        embedded.setClientGetter(() => client);
        embeddedKedi?.setClientGetter(() => client);
    }
}

async function startClient(
    context: vscode.ExtensionContext,
    emb: EmbeddedPython
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("kedi");
    const usePythonExtension = cfg.get<boolean>("lsp.usePythonExtension", false);
    const explicitPath = cfg.get<string>("lsp.pythonPath", "");
    const serverCommand = cfg.get<string>("lsp.serverCommand", "");
    const trace = cfg.get<string>("lsp.trace.server", "off");

    let serverOptions: ServerOptions;
    try {
        serverOptions = await resolveServerOptions(context, usePythonExtension, explicitPath, serverCommand);
    } catch (err) {
        void showStartupError(err);
        return;
    }
    if (disposed) return;

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "kedi" },
            { scheme: "untitled", language: "kedi" },
        ],
        outputChannel,
        traceOutputChannel: outputChannel,
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.kedi"),
        },
        initializationOptions: {
            trace,
        },
        middleware: {
            provideHover: async (document, position, token, next) => {
                if (await isEmbeddedPythonPosition(emb, document, position)) {
                    return undefined;
                }
                return next(document, position, token);
            },
        },
    };

    client = new LanguageClient(
        "kedi-lsp",
        "Kedi Language Server",
        serverOptions,
        clientOptions
    );

    try {
        await client.start();
        outputChannel?.appendLine("kedi-lsp started.");
    } catch (err) {
        void showStartupError(err);
        client = undefined;
    }
}

async function showStartupError(err: unknown): Promise<void> {
    outputChannel?.appendLine(`Failed to start kedi-lsp: ${err}`);
    const action = await vscode.window.showErrorMessage(
        `Could not start Kedi language server. ${err}`,
        "Select Python Interpreter", "Open Output",
    );
    if (action === "Select Python Interpreter") await selectPython();
    if (action === "Open Output") outputChannel?.show(true);
}

async function isEmbeddedPythonPosition(
    emb: EmbeddedPython,
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<boolean> {
    if (!emb.isEnabled()) {
        return false;
    }
    try {
        const ranges = await emb.getPythonRanges(document);
        return ranges.some((range) =>
            new vscode.Range(range.start, range.end).contains(position)
        );
    } catch {
        return false;
    }
}

async function resolveServerOptions(
    context: vscode.ExtensionContext,
    usePythonExtension: boolean,
    explicitPath: string,
    serverCommand: string
): Promise<ServerOptions> {
    if (serverCommand && !explicitPath && !usePythonExtension) {
        return {
            run: { command: serverCommand, transport: TransportKind.stdio },
            debug: { command: serverCommand, transport: TransportKind.stdio },
        };
    }

    const host = usePythonExtension || Boolean(explicitPath);
    const py = host ? await resolveInterpreterPath(usePythonExtension, explicitPath) : await managedPython(context, outputChannel!);
    if (!py) throw new Error("No host Python selected. Use Kedi: Select Python Interpreter. Host environments must have Kedi installed.");
    outputChannel?.appendLine(`Using Python interpreter: ${py}`);
    const args = [...(host ? [] : ["-I"]), "-m", "kedi.lsp.server"];
    return {
        run: { command: py, args, transport: TransportKind.stdio },
        debug: { command: py, args, transport: TransportKind.stdio },
    };
}

async function resolveInterpreterPath(
    usePythonExtension: boolean,
    explicitPath: string
): Promise<string | undefined> {
    if (explicitPath) {
        return explicitPath;
    }
    if (!usePythonExtension) {
        return undefined;
    }
    try {
        const api = await getPythonApi();
        if (api?.environments?.getActiveEnvironmentPath) {
            const envPath = api.environments.getActiveEnvironmentPath(
                vscode.window.activeTextEditor?.document?.uri
            );
            if (envPath?.path) {
                const resolved = await api.environments.resolveEnvironment(envPath);
                return resolved?.executable?.uri?.fsPath;
            }
        }
    } catch (err) {
        outputChannel?.appendLine(
            `Could not query active Python interpreter: ${err}`
        );
    }
    return undefined;
}

async function getPythonApi(): Promise<any | undefined> {
    if (pythonApi) {
        return pythonApi;
    }
    const ext = vscode.extensions.getExtension("ms-python.python");
    if (!ext) {
        return undefined;
    }
    if (!ext.isActive) {
        await ext.activate();
    }
    await ext.exports.ready;
    pythonApi = ext.exports;
    return pythonApi;
}
