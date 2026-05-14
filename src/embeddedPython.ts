/**
 * Embedded-Python LSP forwarding for Kedi.
 *
 * Inside a fenced ```python``` block or a single-backtick `python_expr`,
 * we want the user to get Pylance/Pyright hover, go-to-def, find
 * references, etc. — without writing a Python parser ourselves.
 *
 * Strategy: for each Kedi document, we expose a virtual sibling
 * document under the `kedi-py:` scheme whose contents are the *same
 * shape* as the Kedi source but with everything outside Python regions
 * replaced by whitespace (preserving line/column positions). The
 * virtual document is valid-ish Python where the only non-whitespace
 * content sits exactly where the Python regions live in the Kedi
 * source. Because positions are preserved, requests forwarded to the
 * Python LSP need **no coordinate translation**.
 *
 * When the cursor in a real Kedi document is inside a Python region,
 * we ask VS Code's built-in `vscode.execute*Provider` commands to run
 * the corresponding feature against the virtual document URI and
 * return the result. Outside Python regions, our providers return
 * `undefined` and VS Code falls through to the Kedi LSP via the
 * LanguageClient registered in `extension.ts`.
 *
 * The list of Python ranges per Kedi document is fetched via the
 * server's `kedi/pythonRanges` custom request and cached / refreshed
 * on `onDidChangeTextDocument`.
 */

import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";

const EMBED_SCHEME = "kedi-py";

interface PythonRange {
    kind: "fenced" | "inline";
    range: vscode.Range;
    text: string;
}

interface CachedDoc {
    version: number;
    ranges: PythonRange[];
    blankedText: string;
}

export interface PythonRangeInfo {
    kind: "fenced" | "inline";
    start: vscode.Position;
    end: vscode.Position;
}

export interface EmbeddedPython {
    setClientGetter(getter: () => LanguageClient | undefined): void;
    getPythonRanges(doc: vscode.TextDocument): Promise<PythonRangeInfo[]>;
    kediToVirtual(uri: vscode.Uri): vscode.Uri;
    ensureVirtualOpen(doc: vscode.TextDocument): Promise<void>;
    isEnabled(): boolean;
    dispose(): void;
}

export function registerEmbeddedPython(
    context: vscode.ExtensionContext,
    initialClientGetter: () => LanguageClient | undefined
): EmbeddedPython {
    let clientGetter = initialClientGetter;
    const cache = new Map<string, CachedDoc>(); // key = kedi-doc URI string
    const onContentChange = new vscode.EventEmitter<vscode.Uri>();

    const contentProvider: vscode.TextDocumentContentProvider = {
        onDidChange: onContentChange.event,
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            const kediUri = virtualToKedi(uri);
            if (!kediUri) {
                return "";
            }
            const doc = vscode.workspace.textDocuments.find(
                (d) => d.uri.toString() === kediUri.toString()
            );
            if (!doc) {
                return "";
            }
            const cached = await ensureCached(doc);
            return cached.blankedText;
        },
    };

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            EMBED_SCHEME,
            contentProvider
        )
    );

    // Refresh + notify on Kedi-doc edits.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document.languageId !== "kedi") {
                return;
            }
            cache.delete(e.document.uri.toString());
            const virtualUri = kediToVirtual(e.document.uri);
            onContentChange.fire(virtualUri);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            cache.delete(doc.uri.toString());
        })
    );

    // ------------------------------------------------------------
    // Forwarding providers
    // ------------------------------------------------------------

    const forwardHover = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Hover | undefined> => {
        if (!isEmbedEnabled() || !(await isInPythonRange(doc, pos))) {
            return undefined;
        }
        const virtualUri = kediToVirtual(doc.uri);
        const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider",
            virtualUri,
            pos
        )) || [];
        // Return the first hover the Python LSP gave us. VS Code merges
        // multiple hovers in newer versions but the API expects one.
        return hovers[0];
    };

    const forwardDefinition = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> => {
        if (!isEmbedEnabled() || !(await isInPythonRange(doc, pos))) {
            return undefined;
        }
        const virtualUri = kediToVirtual(doc.uri);
        const defs =
            (await vscode.commands.executeCommand<
                vscode.Location[] | vscode.LocationLink[]
            >("vscode.executeDefinitionProvider", virtualUri, pos)) || [];
        return defs;
    };

    const forwardReferences = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Location[] | undefined> => {
        if (!isEmbedEnabled() || !(await isInPythonRange(doc, pos))) {
            return undefined;
        }
        const virtualUri = kediToVirtual(doc.uri);
        const refs =
            (await vscode.commands.executeCommand<vscode.Location[]>(
                "vscode.executeReferenceProvider",
                virtualUri,
                pos
            )) || [];
        return refs;
    };

    context.subscriptions.push(
        vscode.languages.registerHoverProvider("kedi", {
            provideHover: forwardHover,
        }),
        vscode.languages.registerDefinitionProvider("kedi", {
            provideDefinition: forwardDefinition,
        }),
        vscode.languages.registerReferenceProvider("kedi", {
            provideReferences: forwardReferences,
        })
    );

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------

    function isEmbedEnabled(): boolean {
        return vscode.workspace
            .getConfiguration("kedi")
            .get<boolean>("embeddedPython.enable", true);
    }

    async function isInPythonRange(
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<boolean> {
        const cached = await ensureCached(doc);
        return cached.ranges.some((r) => r.range.contains(pos));
    }

    async function ensureCached(doc: vscode.TextDocument): Promise<CachedDoc> {
        const key = doc.uri.toString();
        const hit = cache.get(key);
        if (hit && hit.version === doc.version) {
            return hit;
        }
        const ranges = await fetchPythonRanges(doc);
        const blanked = buildBlankedDocument(doc, ranges);
        const fresh: CachedDoc = {
            version: doc.version,
            ranges,
            blankedText: blanked,
        };
        cache.set(key, fresh);
        return fresh;
    }

    async function fetchPythonRanges(
        doc: vscode.TextDocument
    ): Promise<PythonRange[]> {
        const client = clientGetter();
        if (!client) {
            return [];
        }
        try {
            const response = (await client.sendRequest("kedi/pythonRanges", {
                textDocument: { uri: doc.uri.toString() },
            })) as {
                uri: string;
                ranges: Array<{
                    kind: "fenced" | "inline";
                    range: {
                        start: { line: number; character: number };
                        end: { line: number; character: number };
                    };
                    text: string;
                }>;
            };
            return (response?.ranges ?? []).map((r) => ({
                kind: r.kind,
                text: r.text,
                range: new vscode.Range(
                    new vscode.Position(r.range.start.line, r.range.start.character),
                    new vscode.Position(r.range.end.line, r.range.end.character)
                ),
            }));
        } catch {
            return [];
        }
    }

    function buildBlankedDocument(
        doc: vscode.TextDocument,
        ranges: PythonRange[]
    ): string {
        // Build a same-shape document where every non-Python byte is
        // replaced by whitespace. Newlines stay as newlines so line
        // numbers match the Kedi document one-to-one.
        const text = doc.getText();
        if (ranges.length === 0) {
            return text.replace(/[^\n]/g, " ");
        }
        // Convert ranges to absolute byte offsets so we can do a simple
        // mask in a char array.
        const chars = text.split("");
        const keepMask = new Array(chars.length).fill(false);
        for (const r of ranges) {
            const startOffset = doc.offsetAt(r.range.start);
            const endOffset = doc.offsetAt(r.range.end);
            for (let i = startOffset; i < endOffset && i < chars.length; i++) {
                keepMask[i] = true;
            }
        }
        const out: string[] = new Array(chars.length);
        for (let i = 0; i < chars.length; i++) {
            if (keepMask[i] || chars[i] === "\n") {
                out[i] = chars[i];
            } else {
                out[i] = " ";
            }
        }
        return out.join("");
    }

    function kediToVirtual(kediUri: vscode.Uri): vscode.Uri {
        // Encode the original URI into the path so we can recover it
        // in the content provider. Append `.py` so Python tooling
        // identifies the document as Python.
        return vscode.Uri.parse(
            `${EMBED_SCHEME}:${encodeURIComponent(kediUri.toString())}.py`
        );
    }

    function virtualToKedi(virtualUri: vscode.Uri): vscode.Uri | undefined {
        if (virtualUri.scheme !== EMBED_SCHEME) {
            return undefined;
        }
        const raw = virtualUri.path.replace(/\.py$/, "");
        try {
            return vscode.Uri.parse(decodeURIComponent(raw));
        } catch {
            return undefined;
        }
    }

    async function getPythonRangesPublic(
        doc: vscode.TextDocument
    ): Promise<PythonRangeInfo[]> {
        const cached = await ensureCached(doc);
        return cached.ranges.map((r) => ({
            kind: r.kind,
            start: r.range.start,
            end: r.range.end,
        }));
    }

    async function ensureVirtualOpen(doc: vscode.TextDocument): Promise<void> {
        // Pre-populate cache so the content provider has something to
        // return on first read; opening the virtual URI triggers
        // VS Code to call our provider.
        await ensureCached(doc);
        const virtualUri = kediToVirtual(doc.uri);
        try {
            await vscode.workspace.openTextDocument(virtualUri);
        } catch {
            /* swallow — provider may already have it open */
        }
    }

    return {
        setClientGetter(getter) {
            clientGetter = getter;
            // Invalidate cache after a restart — server may have
            // changed and the previous ranges may be stale.
            cache.clear();
        },
        getPythonRanges: getPythonRangesPublic,
        kediToVirtual,
        ensureVirtualOpen,
        isEnabled: isEmbedEnabled,
        dispose() {
            cache.clear();
            onContentChange.dispose();
        },
    };
}
