import * as path from "path";
import * as vscode from "vscode";

interface RuntimeBootstrap {
    ensureRuntime(options: Record<string, never>, dependencies: { log(message: string): void }): Promise<{ python: string }>;
}

// Bundled independently so Zed executes exactly the same installer.
export async function managedPython(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<string> {
    const runtime: RuntimeBootstrap = require(path.join(context.extensionPath, "runtime", "bootstrap.cjs"));
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Preparing Kedi Python environment" },
        async progress => {
            const result = await runtime.ensureRuntime({}, {
                log(message) { output.appendLine(message); progress.report({ message }); },
            });
            return result.python;
        },
    );
}

export async function selectPython(): Promise<void> {
    const selection = await vscode.window.showQuickPick([
        { label: "Kedi managed environment", mode: "managed", description: "Shared with Zed in ~/.kedi/editor-venv" },
        { label: "Python: selected interpreter", mode: "python", description: "Follow the Microsoft Python extension" },
        { label: "Enter interpreter path", mode: "path", description: "Use an existing Python with Kedi installed" },
    ], { title: "Kedi: Select Python Interpreter" });
    if (!selection) return;
    const config = vscode.workspace.getConfiguration("kedi");
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    let pythonPath = "";
    if (selection.mode === "path") {
        const entered = await vscode.window.showInputBox({
            title: "Kedi Python executable", prompt: "Absolute path to Python with Kedi installed", ignoreFocusOut: true,
            validateInput: value => path.isAbsolute(value.trim()) ? undefined : "Enter an absolute executable path",
        });
        if (!entered) return;
        pythonPath = entered.trim();
    }
    // Set the controlling mode last. The restart queue coalesces these configuration events.
    await config.update("lsp.pythonPath", pythonPath, target);
    await config.update("lsp.serverCommand", "", target);
    await config.update("lsp.usePythonExtension", selection.mode === "python", target);
    if (selection.mode === "python") await vscode.commands.executeCommand("python.setInterpreter");
}
