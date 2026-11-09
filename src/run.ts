import * as path from "path";
import * as vscode from "vscode";

type PythonResolver = (resource: vscode.Uri) => Promise<{ python: string; args: string[] }>;
type Mode = "run" | "test" | "eval";

const FLAGS: Record<Mode, string[]> = { run: [], test: ["--test"], eval: ["--eval"] };
const TITLES: Record<Mode, string> = { run: "Kedi", test: "Kedi tests", eval: "Kedi evals" };
// `@test: <procedure>:` and `@eval: <procedure>:` open validation blocks at the top level.
const VALIDATION_BLOCK = /^@(test|eval):\s*[A-Za-z_]\w*\s*:/;

async function savedKediFile(resource: vscode.Uri | undefined): Promise<vscode.Uri> {
    if (!vscode.workspace.isTrusted) {
        throw new Error("Trust this workspace before running Kedi programs.");
    }
    const file = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || file.scheme !== "file" || path.extname(file.fsPath) !== ".kedi") {
        throw new Error("Open a saved .kedi file to run it.");
    }
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === file.toString());
    if (document?.isDirty && (!await document.save() || document.isDirty)) {
        throw new Error("Save the Kedi file before running it; Kedi runs the on-disk source.");
    }
    return file;
}

class ValidationBlockLenses implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const lenses: vscode.CodeLens[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            const mode = VALIDATION_BLOCK.exec(document.lineAt(line).text)?.[1];
            if (mode !== "test" && mode !== "eval") continue;
            lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
                title: mode === "test" ? "$(play) Run tests" : "$(play) Run evals",
                tooltip: `Run every @${mode} block in this file`,
                command: mode === "test" ? "kedi.runTests" : "kedi.runEvals",
                arguments: [document.uri],
            }));
        }
        return lenses;
    }
}

/** Run, test, evaluate and debug the current file with the language server's Python. */
export function registerRunCommands(context: vscode.ExtensionContext, resolvePython: PythonResolver): void {
    let terminal: vscode.Terminal | undefined;
    const run = (mode: Mode) => async (resource?: vscode.Uri): Promise<void> => {
        try {
            const file = await savedKediFile(resource);
            const { python, args } = await resolvePython(file);
            // One run at a time: a new run replaces the previous one's terminal.
            terminal?.dispose();
            terminal = vscode.window.createTerminal({
                name: `${TITLES[mode]}: ${path.basename(file.fsPath)}`,
                shellPath: python,
                shellArgs: [...args, "-m", "kedi", file.fsPath, ...FLAGS[mode]],
                cwd: vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath ?? path.dirname(file.fsPath),
            });
            terminal.show();
        } catch (error) {
            void vscode.window.showErrorMessage(String(error));
        }
    };
    const debug = async (resource?: vscode.Uri): Promise<void> => {
        try {
            const file = await savedKediFile(resource);
            await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(file), {
                type: "kedi",
                request: "launch",
                name: `Kedi: ${path.basename(file.fsPath)}`,
                program: file.fsPath,
                args: [],
                env: {},
                stopOnEntry: false,
            });
        } catch (error) {
            void vscode.window.showErrorMessage(String(error));
        }
    };
    context.subscriptions.push(
        vscode.commands.registerCommand("kedi.runFile", run("run")),
        vscode.commands.registerCommand("kedi.runTests", run("test")),
        vscode.commands.registerCommand("kedi.runEvals", run("eval")),
        vscode.commands.registerCommand("kedi.debugFile", debug),
        vscode.languages.registerCodeLensProvider({ language: "kedi", scheme: "file" }, new ValidationBlockLenses()),
    );
}
