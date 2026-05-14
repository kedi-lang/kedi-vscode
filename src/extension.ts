/**
 * Kedi VS Code extension — LSP client + embedded-Python forwarding.
 *
 * Highlighting comes entirely from LSP semantic tokens (no TextMate
 * grammar). Hover / Go-to-Def / References / Rename / Outline /
 * Signature Help / Inlay Hints / Formatting are all served by
 * `kedi-lsp` (Python, pygls).
 *
 * For positions inside a fenced ```python``` block or an inline
 * `python_expr` region, the `embeddedPython` module forwards
 * Hover/Definition/References to whatever Python LSP the user has
 * (Pylance/Pyright via ms-python.python), and the `embeddedTokens`
 * middleware merges Python *semantic tokens* into the Kedi LSP's
 * token stream so Python keywords, strings, functions, etc. light
 * up inside Kedi documents.
 *
 * The server is spawned with the **editor's** active Python
 * interpreter — read from the official Python extension's API so
 * venv/conda/pyenv/poetry/uv all "just work". When the user switches
 * interpreter, the server restarts transparently.
 */

import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";

import { registerEmbeddedPython, EmbeddedPython } from "./embeddedPython";

let client: LanguageClient | undefined;
let embedded: EmbeddedPython | undefined;
let pythonApi: any | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel("Kedi Language Server");
    context.subscriptions.push(outputChannel);

    // Build the embedded-Python module first — the LSP middleware
    // closes over its public surface (range fetch + virtual-doc URI).
    embedded = registerEmbeddedPython(context, () => client);

    await startClient(context, embedded);

    // Restart when the user changes their Python interpreter.
    try {
        pythonApi = await getPythonApi();
        if (pythonApi?.environments?.onDidChangeActiveEnvironmentPath) {
            context.subscriptions.push(
                pythonApi.environments.onDidChangeActiveEnvironmentPath(async () => {
                    outputChannel?.appendLine(
                        "Active Python interpreter changed — restarting kedi-lsp."
                    );
                    await restartClient(context);
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
                await restartClient(context);
            }
        })
    );

    // Manual restart command.
    context.subscriptions.push(
        vscode.commands.registerCommand("kedi.restartServer", async () => {
            await restartClient(context);
            vscode.window.showInformationMessage("Kedi LSP restarted.");
        })
    );
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.stop();
        client = undefined;
    }
    embedded?.dispose();
    embedded = undefined;
}

async function restartClient(context: vscode.ExtensionContext): Promise<void> {
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
    }
}

async function startClient(
    context: vscode.ExtensionContext,
    emb: EmbeddedPython
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("kedi");
    const usePythonExtension = cfg.get<boolean>("lsp.usePythonExtension", true);
    const explicitPath = cfg.get<string>("lsp.pythonPath", "");
    const serverCommand = cfg.get<string>("lsp.serverCommand", "kedi-lsp");
    const trace = cfg.get<string>("lsp.trace.server", "off");

    const serverOptions = await resolveServerOptions(
        usePythonExtension,
        explicitPath,
        serverCommand
    );
    if (serverOptions === null) {
        return;
    }

    // Semantic tokens for both Kedi *and* embedded Python come from
    // the LSP server (kedi-lsp parses Python regions with
    // tree-sitter-python and emits LSP tokens in the same response).
    // No middleware needed.
    void emb;

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
        outputChannel?.appendLine(`Failed to start kedi-lsp: ${err}`);
        const action = await vscode.window.showErrorMessage(
            `Could not start Kedi language server. ${err}`,
            "Install (pip install kedi)",
            "Open Output"
        );
        if (action === "Install (pip install kedi)") {
            const term = vscode.window.createTerminal("Install Kedi");
            term.show();
            const py = await resolveInterpreterPath(
                usePythonExtension,
                explicitPath
            );
            if (py) {
                term.sendText(`${py} -m pip install kedi`);
            } else {
                term.sendText(`pip install kedi`);
            }
        } else if (action === "Open Output") {
            outputChannel?.show(true);
        }
        client = undefined;
    }
}

async function resolveServerOptions(
    usePythonExtension: boolean,
    explicitPath: string,
    serverCommand: string
): Promise<ServerOptions | null> {
    const py = await resolveInterpreterPath(usePythonExtension, explicitPath);
    if (py) {
        outputChannel?.appendLine(`Using Python interpreter: ${py}`);
        return {
            run: {
                command: py,
                args: ["-m", "kedi.lsp.server"],
                transport: TransportKind.stdio,
            },
            debug: {
                command: py,
                args: ["-m", "kedi.lsp.server"],
                transport: TransportKind.stdio,
            },
        };
    }

    outputChannel?.appendLine(
        `Falling back to '${serverCommand}' on PATH (set kedi.lsp.pythonPath or install kedi into the active interpreter to override).`
    );
    return {
        run: { command: serverCommand, transport: TransportKind.stdio },
        debug: { command: serverCommand, transport: TransportKind.stdio },
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
                return envPath.path;
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
    pythonApi = ext.exports;
    return pythonApi;
}
