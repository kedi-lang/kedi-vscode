/**
 * Embedded-Kedi support for Python docstrings.
 *
 * Kedi's Python API treats function docstrings whose first cleaned line
 * is `kedi` as Kedi programs.  These providers ask kedi-lsp to locate
 * and analyze those islands, while leaving the normal Python language
 * server responsible for the rest of the file.
 */

import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

interface RawPosition {
    line: number;
    character: number;
}

interface RawRange {
    start: RawPosition;
    end: RawPosition;
}

interface RawLocation {
    uri: string;
    range: RawRange;
}

interface RawDiagnostic {
    range: RawRange;
    message: string;
    severity?: number;
    source?: string;
}

interface RawHover {
    contents?: string | { kind?: string; value?: string };
    range?: RawRange;
}

export interface EmbeddedKediInPython {
    setClientGetter(getter: () => LanguageClient | undefined): void;
    dispose(): void;
}

export function registerEmbeddedKediInPython(
    context: vscode.ExtensionContext,
    initialClientGetter: () => LanguageClient | undefined
): EmbeddedKediInPython {
    let clientGetter = initialClientGetter;
    const diagnostics = vscode.languages.createDiagnosticCollection(
        "kedi-python-docstrings"
    );
    let semanticProvider: vscode.Disposable | undefined;

    context.subscriptions.push(diagnostics);

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (isPythonDocument(doc)) {
                void refreshDiagnostics(doc);
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isPythonDocument(event.document)) {
                void refreshDiagnostics(event.document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            diagnostics.delete(doc.uri);
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("kedi.embeddedKediInPython.enable") ||
                event.affectsConfiguration(
                    "kedi.embeddedKediInPython.experimentalSemanticTokens"
                )
            ) {
                refreshSemanticProvider();
                for (const doc of vscode.workspace.textDocuments) {
                    if (isPythonDocument(doc)) {
                        void refreshDiagnostics(doc);
                    }
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider("python", {
            provideHover: async (doc, pos) => {
                if (!isEnabled() || !isPythonDocument(doc)) {
                    return undefined;
                }
                const response = await sendRequest<RawHover | undefined>(
                    "kedi/kediDocstringHover",
                    doc,
                    { position: toRawPosition(pos) }
                );
                if (!response?.contents) {
                    return undefined;
                }
                return new vscode.Hover(
                    hoverContents(response.contents),
                    response.range ? toRange(response.range) : undefined
                );
            },
        }),
        vscode.languages.registerDefinitionProvider("python", {
            provideDefinition: async (doc, pos) => {
                if (!isEnabled() || !isPythonDocument(doc)) {
                    return undefined;
                }
                const response = await sendRequest<{ locations?: RawLocation[] }>(
                    "kedi/kediDocstringDefinition",
                    doc,
                    { position: toRawPosition(pos) }
                );
                const locations = (response?.locations ?? []).map(toLocation);
                return locations.length ? locations : undefined;
            },
        }),
        vscode.languages.registerReferenceProvider("python", {
            provideReferences: async (doc, pos, options) => {
                if (!isEnabled() || !isPythonDocument(doc)) {
                    return undefined;
                }
                const response = await sendRequest<{ locations?: RawLocation[] }>(
                    "kedi/kediDocstringReferences",
                    doc,
                    {
                        position: toRawPosition(pos),
                        includeDeclaration: options.includeDeclaration,
                    }
                );
                const locations = (response?.locations ?? []).map(toLocation);
                return locations.length ? locations : undefined;
            },
        })
    );

    refreshSemanticProvider();
    for (const doc of vscode.workspace.textDocuments) {
        if (isPythonDocument(doc)) {
            void refreshDiagnostics(doc);
        }
    }

    return {
        setClientGetter(getter) {
            clientGetter = getter;
            for (const doc of vscode.workspace.textDocuments) {
                if (isPythonDocument(doc)) {
                    void refreshDiagnostics(doc);
                }
            }
        },
        dispose() {
            diagnostics.clear();
            semanticProvider?.dispose();
            semanticProvider = undefined;
        },
    };

    async function refreshDiagnostics(doc: vscode.TextDocument): Promise<void> {
        if (!isEnabled()) {
            diagnostics.delete(doc.uri);
            return;
        }
        const response = await sendRequest<{ diagnostics?: RawDiagnostic[] }>(
            "kedi/kediDocstringDiagnostics",
            doc
        );
        const items = (response?.diagnostics ?? []).map((diagnostic) => {
            const item = new vscode.Diagnostic(
                toRange(diagnostic.range),
                diagnostic.message,
                toDiagnosticSeverity(diagnostic.severity)
            );
            item.source = diagnostic.source ?? "kedi";
            return item;
        });
        diagnostics.set(doc.uri, items);
    }

    function refreshSemanticProvider(): void {
        semanticProvider?.dispose();
        semanticProvider = undefined;
        if (!isEnabled() || !experimentalSemanticTokensEnabled()) {
            return;
        }
        const legend = new vscode.SemanticTokensLegend(
            [
                "namespace",
                "type",
                "class",
                "enum",
                "interface",
                "struct",
                "typeParameter",
                "parameter",
                "variable",
                "property",
                "enumMember",
                "event",
                "function",
                "method",
                "macro",
                "keyword",
                "modifier",
                "comment",
                "string",
                "number",
                "regexp",
                "operator",
                "decorator",
            ],
            [
                "declaration",
                "definition",
                "readonly",
                "static",
                "deprecated",
                "abstract",
                "async",
                "modification",
                "documentation",
                "defaultLibrary",
            ]
        );
        semanticProvider = vscode.languages.registerDocumentSemanticTokensProvider(
            "python",
            {
                provideDocumentSemanticTokens: async (doc) => {
                    if (!isEnabled() || !isPythonDocument(doc)) {
                        return new vscode.SemanticTokensBuilder(legend).build();
                    }
                    const response = await sendRequest<{ data?: number[] }>(
                        "kedi/kediDocstringSemanticTokens",
                        doc
                    );
                    const builder = new vscode.SemanticTokensBuilder(legend);
                    for (const token of decodeSemanticTokens(response?.data ?? [])) {
                        builder.push(
                            token.line,
                            token.character,
                            token.length,
                            token.tokenType,
                            token.tokenModifiers
                        );
                    }
                    return builder.build();
                },
            },
            legend
        );
        context.subscriptions.push(semanticProvider);
    }

    async function sendRequest<T>(
        method: string,
        doc: vscode.TextDocument,
        extra: object = {}
    ): Promise<T | undefined> {
        const client = clientGetter();
        if (!client) {
            return undefined;
        }
        try {
            return (await client.sendRequest(method, {
                textDocument: { uri: doc.uri.toString(), version: doc.version },
                text: doc.getText(),
                ...extra,
            })) as T;
        } catch {
            return undefined;
        }
    }
}

function isEnabled(): boolean {
    return vscode.workspace
        .getConfiguration("kedi")
        .get<boolean>("embeddedKediInPython.enable", true);
}

function experimentalSemanticTokensEnabled(): boolean {
    return vscode.workspace
        .getConfiguration("kedi")
        .get<boolean>("embeddedKediInPython.experimentalSemanticTokens", true);
}

function isPythonDocument(doc: vscode.TextDocument): boolean {
    return doc.languageId === "python";
}

function toRawPosition(pos: vscode.Position): RawPosition {
    return { line: pos.line, character: pos.character };
}

function toRange(raw: RawRange): vscode.Range {
    return new vscode.Range(
        new vscode.Position(raw.start.line, raw.start.character),
        new vscode.Position(raw.end.line, raw.end.character)
    );
}

function toLocation(raw: RawLocation): vscode.Location {
    return new vscode.Location(vscode.Uri.parse(raw.uri), toRange(raw.range));
}

function toDiagnosticSeverity(value: number | undefined): vscode.DiagnosticSeverity {
    switch (value) {
        case 1:
            return vscode.DiagnosticSeverity.Error;
        case 2:
            return vscode.DiagnosticSeverity.Warning;
        case 3:
            return vscode.DiagnosticSeverity.Information;
        case 4:
            return vscode.DiagnosticSeverity.Hint;
        default:
            return vscode.DiagnosticSeverity.Error;
    }
}

function hoverContents(
    contents: string | { kind?: string; value?: string }
): vscode.MarkdownString {
    if (typeof contents === "string") {
        return new vscode.MarkdownString(contents);
    }
    return new vscode.MarkdownString(contents.value ?? "");
}

function decodeSemanticTokens(
    data: number[]
): Array<{
    line: number;
    character: number;
    length: number;
    tokenType: number;
    tokenModifiers: number;
}> {
    const out = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        line += data[i];
        character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
        out.push({
            line,
            character,
            length: data[i + 2],
            tokenType: data[i + 3],
            tokenModifiers: data[i + 4],
        });
    }
    return out;
}
