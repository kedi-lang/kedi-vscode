/**
 * Embedded-Python LSP forwarding for Kedi.
 *
 * Inside a fenced ```python``` block or a single-backtick `python_expr`,
 * we want the user to get Pylance/Pyright hover, go-to-def, find
 * references, etc. — without writing a Python parser ourselves.
 *
 * Strategy: for each Kedi document, we materialize a real .py shadow
 * file under VS Code's extension storage, outside the user's workspace.
 * Pylance/Pyright can analyze that opened Python document normally. The
 * Kedi LSP builds that file as valid, scope-aware Python: Kedi
 * procedures become Python stubs, procedure parameters become typed
 * function params, and embedded Python blocks are copied into helper
 * scopes that preserve their runtime context. Source maps translate
 * editor positions to and from the virtual Python document.
 *
 * When the cursor in a real Kedi document is inside a Python region,
 * we ask VS Code's built-in `vscode.execute*Provider` commands to run
 * the corresponding feature against the virtual document URI and
 * return the result. Outside Python regions, our providers return
 * `undefined` and VS Code falls through to the Kedi LSP via the
 * LanguageClient registered in `extension.ts`.
 *
 * Python-region detection comes from the server's lightweight
 * `kedi/pythonRanges` request. Hover / definition / references fetch
 * a position-focused `kedi/pythonVirtualDocument` on demand and sync
 * it to a shadow `.py` file outside the workspace.
 */

import * as vscode from "vscode";
import { createHash } from "crypto";
import { LanguageClient } from "vscode-languageclient/node";

const PYTHON_PROVIDER_RETRY_DELAYS_MS = [0, 25, 75, 150];
const EMBEDDED_PYTHON_DIR = "embedded-python";
const HOVER_KIND_PREFIX_RE = /^\(([^)\r\n]+)\)\s+(.+)$/;
const PYTHON_FENCE_RE = /```(?:python|py)\b/i;

interface RawPosition {
    line: number;
    character: number;
}

interface RawRange {
    start: RawPosition;
    end: RawPosition;
}

interface PythonRange {
    kind: "fenced" | "inline";
    range: vscode.Range;
    text: string;
    virtualRange?: vscode.Range;
}

interface SourceMapEntry {
    sourceRange: vscode.Range;
    virtualRange: vscode.Range;
    kind: string;
    name?: string;
}

interface CachedDoc {
    uri: string;
    version: number;
    focusKey: string;
    ranges: PythonRange[];
    virtualText: string;
    mappings: SourceMapEntry[];
    symbols: SourceMapEntry[];
}

interface RangeCacheEntry {
    version: number;
    ranges: PythonRange[];
}

interface VirtualRoot {
    uri: vscode.Uri;
}

export interface PythonRangeInfo {
    kind: "fenced" | "inline";
    start: vscode.Position;
    end: vscode.Position;
}

export interface EmbeddedPython {
    setClientGetter(getter: () => LanguageClient | undefined): void;
    getPythonRanges(doc: vscode.TextDocument): Promise<PythonRangeInfo[]>;
    isEnabled(): boolean;
    dispose(): void;
}

export function registerEmbeddedPython(
    context: vscode.ExtensionContext,
    initialClientGetter: () => LanguageClient | undefined
): EmbeddedPython {
    let clientGetter = initialClientGetter;
    const rangeCache = new Map<string, RangeCacheEntry>();
    const rangeRequests = new Map<string, Promise<PythonRange[]>>();
    const virtualCache = new Map<string, CachedDoc>();
    const virtualRequests = new Map<string, Promise<CachedDoc>>();
    const shadowCache = new Map<string, string>();
    let pythonProvidersActivation: Promise<void> | undefined;

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.languageId !== "kedi") {
                return;
            }
            void getPythonRangesPublic(doc);
            void activatePythonProviders().catch(() => undefined);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== "kedi") {
                return;
            }
            clearDocumentState(e.document.uri);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            clearDocumentState(doc.uri);
        })
    );

    // ------------------------------------------------------------
    // Forwarding providers
    // ------------------------------------------------------------

    const forwardHover = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Hover | undefined> => {
        if (!isEmbedEnabled()) {
            return undefined;
        }
        const focused = await ensureFocusedVirtualDocument(doc, pos);
        if (!focused) {
            return undefined;
        }
        const { cached, virtualUri } = focused;
        const virtualPos = sourcePositionToVirtual(cached, pos);
        if (!virtualPos) {
            return undefined;
        }
        const hovers = await executePythonProviderWithRetry<vscode.Hover[]>(
            "vscode.executeHoverProvider",
            virtualUri,
            virtualPos
        );
        const first = hovers[0];
        if (!first) {
            return undefined;
        }
        const mappedRange = first?.range
            ? virtualRangeToSource(cached, first.range)
            : undefined;
        const wordRange = virtualWordRangeAt(cached, virtualPos)?.range;
        const fallbackRange = wordRange
            ? virtualRangeToSource(cached, wordRange)
            : undefined;
        return new vscode.Hover(
            formatPythonHoverContents(first.contents),
            mappedRange ?? fallbackRange
        );
    };

    const forwardDefinition = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Definition | vscode.LocationLink[] | undefined> => {
        if (!isEmbedEnabled()) {
            return undefined;
        }
        const focused = await ensureFocusedVirtualDocument(doc, pos);
        if (!focused) {
            return undefined;
        }
        const { cached, virtualUri } = focused;
        const virtualPos = sourcePositionToVirtual(cached, pos);
        if (!virtualPos) {
            return undefined;
        }
        const defs = await executePythonProviderWithRetry<
            vscode.Location[] | vscode.LocationLink[]
        >("vscode.executeDefinitionProvider", virtualUri, virtualPos);
        const mapped = mapDefinitionResults(cached, doc.uri, defs);
        if (hasDefinitionResults(mapped)) {
            return mapped;
        }
        const synthetic = syntheticSymbolAtVirtualPosition(cached, virtualPos);
        return synthetic
            ? [new vscode.Location(doc.uri, synthetic.symbol.sourceRange)]
            : mapped;
    };

    const forwardReferences = async (
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<vscode.Location[] | undefined> => {
        if (!isEmbedEnabled()) {
            return undefined;
        }
        const focused = await ensureFocusedVirtualDocument(doc, pos);
        if (!focused) {
            return undefined;
        }
        const { cached, virtualUri } = focused;
        const virtualPos = sourcePositionToVirtual(cached, pos);
        if (!virtualPos) {
            return undefined;
        }
        const refs = await executePythonProviderWithRetry<vscode.Location[]>(
            "vscode.executeReferenceProvider",
            virtualUri,
            virtualPos
        );
        const mapped = refs
            .map((ref) => mapLocation(cached, doc.uri, ref))
            .filter((ref): ref is vscode.Location => Boolean(ref));
        const synthetic = syntheticSymbolAtVirtualPosition(cached, virtualPos);
        if (!synthetic) {
            return mapped;
        }
        const declaration = new vscode.Location(doc.uri, synthetic.symbol.sourceRange);
        if (!hasLocation(mapped, declaration)) {
            mapped.unshift(declaration);
        }
        const usageRange = virtualRangeToSource(cached, synthetic.wordRange);
        if (usageRange) {
            const usage = new vscode.Location(doc.uri, usageRange);
            if (!hasLocation(mapped, usage)) {
                mapped.push(usage);
            }
        }
        return mapped;
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

    async function ensureFocusedVirtualDocument(
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): Promise<{ cached: CachedDoc; virtualUri: vscode.Uri } | undefined> {
        const hot = findFocusedCachedDoc(doc, pos);
        if (hot) {
            const virtualUri = kediToVirtual(doc.uri, hot.focusKey);
            await activatePythonProviders();
            await syncShadowDocument(virtualUri, hot.virtualText);
            return { cached: hot, virtualUri };
        }

        const requestKey = makeVirtualRequestKey(doc.uri, doc.version, pos.line);
        let request = virtualRequests.get(requestKey);
        if (!request) {
            request = fetchPythonVirtualDocument(
                doc.uri,
                doc.version,
                doc.getText(),
                pos.line
            )
                .then((virtual) =>
                    cacheFocusedVirtualDocument(
                        doc.uri,
                        doc.version,
                        pos.line,
                        virtual
                    )
                )
                .finally(() => {
                    virtualRequests.delete(requestKey);
                });
            virtualRequests.set(requestKey, request);
        }

        const cached = await request;
        const virtualUri = kediToVirtual(doc.uri, cached.focusKey);
        await activatePythonProviders();
        await syncShadowDocument(virtualUri, cached.virtualText);
        return { cached, virtualUri };
    }

    function findFocusedCachedDoc(
        doc: vscode.TextDocument,
        pos: vscode.Position
    ): CachedDoc | undefined {
        for (const cached of virtualCache.values()) {
            if (cached.uri !== doc.uri.toString() || cached.version !== doc.version) {
                continue;
            }
            if (sourcePositionToVirtual(cached, pos)) {
                return cached;
            }
        }
        return undefined;
    }

    async function fetchPythonRanges(
        uri: vscode.Uri,
        version: number,
        text: string
    ): Promise<PythonRange[]> {
        const client = clientGetter();
        if (!client) {
            return [];
        }
        try {
            const response = (await client.sendRequest("kedi/pythonRanges", {
                textDocument: { uri: uri.toString(), version },
                text,
            })) as {
                ranges?: Array<{
                    kind: "fenced" | "inline";
                    range?: RawRange;
                    sourceRange?: RawRange;
                    virtualRange?: RawRange;
                    text: string;
                }>;
            };
            return (response?.ranges ?? []).map((range) => ({
                kind: range.kind,
                text: range.text,
                range: toRange(range.sourceRange ?? range.range),
                virtualRange: range.virtualRange
                    ? toRange(range.virtualRange)
                    : undefined,
            }));
        } catch {
            return [];
        }
    }

    async function fetchPythonVirtualDocument(
        uri: vscode.Uri,
        version: number,
        text: string,
        focusLine: number
    ): Promise<{
        text: string;
        ranges: PythonRange[];
        mappings: SourceMapEntry[];
        symbols: SourceMapEntry[];
        focusKey?: string | null;
    }> {
        const client = clientGetter();
        if (!client) {
            return {
                text: "",
                ranges: [],
                mappings: [],
                symbols: [],
                focusKey: null,
            };
        }
        try {
            const response = (await client.sendRequest("kedi/pythonVirtualDocument", {
                textDocument: { uri: uri.toString(), version },
                text,
                focusLine,
            })) as {
                uri: string;
                text: string;
                focusKey?: string | null;
                ranges: Array<{
                    kind: "fenced" | "inline";
                    range?: RawRange;
                    sourceRange?: RawRange;
                    virtualRange?: RawRange;
                    text: string;
                }>;
                mappings: Array<{
                    kind: "fenced" | "inline";
                    sourceRange: RawRange;
                    virtualRange: RawRange;
                }>;
                symbols: Array<{
                    kind: string;
                    name: string;
                    sourceRange: RawRange;
                    virtualRange: RawRange;
                }>;
            };
            return {
                text: response?.text ?? "",
                focusKey: response?.focusKey,
                ranges: (response?.ranges ?? []).map((range) => ({
                    kind: range.kind,
                    text: range.text,
                    range: toRange(range.sourceRange ?? range.range),
                    virtualRange: range.virtualRange
                        ? toRange(range.virtualRange)
                        : undefined,
                })),
                mappings: (response?.mappings ?? []).map((mapping) => ({
                    kind: mapping.kind,
                    sourceRange: toRange(mapping.sourceRange),
                    virtualRange: toRange(mapping.virtualRange),
                })),
                symbols: (response?.symbols ?? []).map((symbol) => ({
                    kind: symbol.kind,
                    name: symbol.name,
                    sourceRange: toRange(symbol.sourceRange),
                    virtualRange: toRange(symbol.virtualRange),
                })),
            };
        } catch {
            return {
                text: "",
                ranges: [],
                mappings: [],
                symbols: [],
                focusKey: null,
            };
        }
    }

    function cacheFocusedVirtualDocument(
        uri: vscode.Uri,
        version: number,
        focusLine: number,
        virtual: {
            text: string;
            ranges: PythonRange[];
            mappings: SourceMapEntry[];
            symbols: SourceMapEntry[];
            focusKey?: string | null;
        }
    ): CachedDoc {
        const focusKey = normalizeFocusKey(virtual.focusKey);
        const cached: CachedDoc = {
            uri: uri.toString(),
            version,
            focusKey,
            ranges: virtual.ranges,
            virtualText: virtual.text,
            mappings: virtual.mappings,
            symbols: virtual.symbols,
        };
        virtualCache.set(makeVirtualStableKey(uri, version, focusKey), cached);
        virtualCache.set(makeVirtualRequestKey(uri, version, focusLine), cached);
        return cached;
    }

    function makeVirtualStableKey(
        uri: vscode.Uri,
        version: number,
        focusKey: string
    ): string {
        return `${uri.toString()}::${version}::focus:${focusKey}`;
    }

    function makeVirtualRequestKey(
        uri: vscode.Uri,
        version: number,
        focusLine: number
    ): string {
        return `${uri.toString()}::${version}::line:${focusLine}`;
    }

    function toRange(raw: RawRange | undefined): vscode.Range {
        if (!raw) {
            return new vscode.Range(0, 0, 0, 0);
        }
        return new vscode.Range(
            new vscode.Position(raw.start.line, raw.start.character),
            new vscode.Position(raw.end.line, raw.end.character)
        );
    }

    function sourcePositionToVirtual(
        cached: CachedDoc,
        pos: vscode.Position
    ): vscode.Position | undefined {
        for (const mapping of sourceToVirtualEntries(cached)) {
            if (!mapping.sourceRange.contains(pos)) {
                continue;
            }
            return translatePosition(
                mapping.sourceRange,
                mapping.virtualRange,
                pos
            );
        }
        return undefined;
    }

    function virtualPositionToSource(
        cached: CachedDoc,
        pos: vscode.Position
    ): vscode.Position | undefined {
        for (const mapping of virtualToSourceEntries(cached)) {
            if (!mapping.virtualRange.contains(pos)) {
                continue;
            }
            return translatePosition(
                mapping.virtualRange,
                mapping.sourceRange,
                pos
            );
        }
        return undefined;
    }

    function sourceToVirtualEntries(cached: CachedDoc): SourceMapEntry[] {
        return [...cached.mappings, ...rangeSourceMapEntries(cached)];
    }

    function virtualToSourceEntries(cached: CachedDoc): SourceMapEntry[] {
        return [
            ...cached.mappings,
            ...rangeSourceMapEntries(cached),
            ...cached.symbols,
        ];
    }

    function rangeSourceMapEntries(cached: CachedDoc): SourceMapEntry[] {
        return cached.ranges
            .filter((range) => range.virtualRange !== undefined)
            .map((range) => ({
                kind: range.kind,
                sourceRange: range.range,
                virtualRange: range.virtualRange as vscode.Range,
            }));
    }

    function translatePosition(
        fromRange: vscode.Range,
        toRange: vscode.Range,
        pos: vscode.Position
    ): vscode.Position {
        return new vscode.Position(
            toRange.start.line + pos.line - fromRange.start.line,
            pos.character + toRange.start.character - fromRange.start.character
        );
    }

    function virtualRangeToSource(
        cached: CachedDoc,
        range: vscode.Range
    ): vscode.Range | undefined {
        const start = virtualPositionToSource(cached, range.start);
        let end = virtualPositionToSource(cached, range.end);
        let endWasBoundary = false;
        if (!end && range.end.character > 0) {
            end = virtualPositionToSource(cached, range.end.translate(0, -1));
            endWasBoundary = Boolean(end);
        }
        if (!start || !end) {
            return undefined;
        }
        return new vscode.Range(start, endWasBoundary ? end.translate(0, 1) : end);
    }

    function virtualWordRangeAt(
        cached: CachedDoc,
        pos: vscode.Position
    ): { name: string; range: vscode.Range } | undefined {
        const line = cached.virtualText.split(/\r?\n/)[pos.line] ?? "";
        let index = pos.character;
        if (!isIdentifierChar(line[index] ?? "")) {
            index -= 1;
        }
        if (index < 0 || !isIdentifierChar(line[index] ?? "")) {
            return undefined;
        }

        let start = index;
        while (start > 0 && isIdentifierChar(line[start - 1])) {
            start -= 1;
        }
        let end = index + 1;
        while (end < line.length && isIdentifierChar(line[end])) {
            end += 1;
        }
        const name = line.slice(start, end);
        return {
            name,
            range: new vscode.Range(pos.line, start, pos.line, end),
        };
    }

    function syntheticSymbolAtVirtualPosition(
        cached: CachedDoc,
        pos: vscode.Position
    ): { symbol: SourceMapEntry; wordRange: vscode.Range } | undefined {
        const word = virtualWordRangeAt(cached, pos);
        if (!word) {
            return undefined;
        }
        const candidates = cached.symbols
            .filter((symbol) => symbol.name === word.name)
            .sort((a, b) =>
                comparePositions(b.virtualRange.start, a.virtualRange.start)
            );
        return candidates
            .filter((symbol) => comparePositions(symbol.virtualRange.start, pos) <= 0)
            .map((symbol) => ({ symbol, wordRange: word.range }))[0];
    }

    function isIdentifierChar(char: string): boolean {
        return /^[A-Za-z0-9_]$/.test(char);
    }

    function comparePositions(a: vscode.Position, b: vscode.Position): number {
        if (a.line !== b.line) {
            return a.line - b.line;
        }
        return a.character - b.character;
    }

    function hasDefinitionResults(
        defs: vscode.Location[] | vscode.LocationLink[]
    ): boolean {
        return Array.isArray(defs) && defs.length > 0;
    }

    async function activatePythonProviders(): Promise<void> {
        if (!pythonProvidersActivation) {
            pythonProvidersActivation = (async () => {
                await vscode.extensions.getExtension("ms-python.python")?.activate();
                await vscode.extensions
                    .getExtension("ms-python.vscode-pylance")
                    ?.activate();
            })().catch((error) => {
                pythonProvidersActivation = undefined;
                throw error;
            });
        }
        await pythonProvidersActivation;
    }

    async function executePythonProviderWithRetry<T extends unknown[]>(
        command: string,
        uri: vscode.Uri,
        pos: vscode.Position
    ): Promise<T> {
        for (const delayMs of PYTHON_PROVIDER_RETRY_DELAYS_MS) {
            if (delayMs > 0) {
                await delay(delayMs);
            }
            const result =
                (await vscode.commands.executeCommand<T>(command, uri, pos)) || [];
            if (result.length > 0) {
                return result;
            }
        }
        return [] as unknown as T;
    }

    function delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function hasLocation(
        locations: vscode.Location[],
        candidate: vscode.Location
    ): boolean {
        return locations.some(
            (loc) =>
                loc.uri.toString() === candidate.uri.toString() &&
                loc.range.isEqual(candidate.range)
        );
    }

    function mapLocation(
        cached: CachedDoc,
        sourceUri: vscode.Uri,
        loc: vscode.Location
    ): vscode.Location | undefined {
        const mappedRange = virtualRangeToSource(cached, loc.range);
        if (!mappedRange) {
            return undefined;
        }
        return new vscode.Location(sourceUri, mappedRange);
    }

    function mapDefinitionResults(
        cached: CachedDoc,
        sourceUri: vscode.Uri,
        defs: vscode.Location[] | vscode.LocationLink[]
    ): vscode.Location[] | vscode.LocationLink[] {
        const mapped: Array<vscode.Location | vscode.LocationLink> = [];
        for (const def of defs) {
            if (def instanceof vscode.Location) {
                const loc = mapLocation(cached, sourceUri, def);
                if (loc) {
                    mapped.push(loc);
                }
                continue;
            }
            const targetRange = virtualRangeToSource(cached, def.targetRange);
            const targetSelectionRange = virtualRangeToSource(
                cached,
                def.targetSelectionRange ?? def.targetRange
            );
            if (!targetRange || !targetSelectionRange) {
                continue;
            }
            mapped.push({
                ...def,
                targetUri: sourceUri,
                targetRange,
                targetSelectionRange,
            });
        }
        return mapped as vscode.Location[] | vscode.LocationLink[];
    }

    function kediToVirtual(
        kediUri: vscode.Uri,
        focusKey: string = "global"
    ): vscode.Uri {
        const digest = createHash("sha1")
            .update(`${kediUri.toString()}\0${focusKey}`)
            .digest("hex");
        return vscode.Uri.joinPath(virtualRootFor().uri, `${digest}.py`);
    }

    function virtualRootFor(): VirtualRoot {
        const storageUri = context.storageUri ?? context.globalStorageUri;
        return {
            uri: vscode.Uri.joinPath(storageUri, EMBEDDED_PYTHON_DIR),
        };
    }

    async function getPythonRangesPublic(
        doc: vscode.TextDocument
    ): Promise<PythonRangeInfo[]> {
        const key = doc.uri.toString();
        const hit = rangeCache.get(key);
        if (hit && hit.version === doc.version) {
            return hit.ranges.map((range) => ({
                kind: range.kind,
                start: range.range.start,
                end: range.range.end,
            }));
        }

        let request = rangeRequests.get(key);
        if (!request) {
            request = fetchPythonRanges(doc.uri, doc.version, doc.getText()).finally(() =>
                rangeRequests.delete(key)
            );
            rangeRequests.set(key, request);
        }

        const ranges = await request;
        rangeCache.set(key, { version: doc.version, ranges });
        return ranges.map((r) => ({
            kind: r.kind,
            start: r.range.start,
            end: r.range.end,
        }));
    }

    async function syncVirtualDocument(
        virtualUri: vscode.Uri,
        text: string
    ): Promise<vscode.TextDocument> {
        const openDoc = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === virtualUri.toString()
        );
        if (!openDoc) {
            await vscode.workspace.fs.writeFile(virtualUri, Buffer.from(text, "utf8"));
            return vscode.workspace.openTextDocument(virtualUri);
        }
        if (openDoc.getText() === text) {
            return ensurePythonDocumentLanguage(openDoc);
        }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(virtualUri, fullDocumentRange(openDoc), text);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            const refreshed =
                vscode.workspace.textDocuments.find(
                    (candidate) =>
                        candidate.uri.toString() === virtualUri.toString()
                ) ?? openDoc;
            return ensurePythonDocumentLanguage(refreshed);
        }

        await vscode.workspace.fs.writeFile(virtualUri, Buffer.from(text, "utf8"));
        return ensurePythonDocumentLanguage(
            await vscode.workspace.openTextDocument(virtualUri)
        );
    }

    function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
        const lastLine = doc.lineAt(Math.max(0, doc.lineCount - 1));
        return new vscode.Range(new vscode.Position(0, 0), lastLine.range.end);
    }

    return {
        setClientGetter(getter) {
            clientGetter = getter;
            clearAllDocumentState();
            if (clientGetter()) {
                for (const doc of vscode.workspace.textDocuments) {
                    if (doc.languageId === "kedi") {
                        void getPythonRangesPublic(doc);
                    }
                }
            }
        },
        getPythonRanges: getPythonRangesPublic,
        isEnabled: isEmbedEnabled,
        dispose() {
            clearAllDocumentState();
        },
    };

    function clearDocumentState(uri: vscode.Uri): void {
        const uriText = uri.toString();
        rangeCache.delete(uriText);
        rangeRequests.delete(uriText);
        for (const [key, cached] of virtualCache.entries()) {
            if (cached.uri !== uriText) {
                continue;
            }
            shadowCache.delete(kediToVirtual(uri, cached.focusKey).toString());
            virtualCache.delete(key);
        }
        for (const key of virtualRequests.keys()) {
            if (key.startsWith(`${uriText}::`)) {
                virtualRequests.delete(key);
            }
        }
    }

    function clearAllDocumentState(): void {
        rangeCache.clear();
        rangeRequests.clear();
        virtualCache.clear();
        virtualRequests.clear();
        shadowCache.clear();
    }

    async function syncShadowDocument(
        virtualUri: vscode.Uri,
        text: string
    ): Promise<void> {
        const key = virtualUri.toString();
        const openDoc = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === key
        );
        if (shadowCache.get(key) === text) {
            if (openDoc) {
                await ensurePythonDocumentLanguage(openDoc);
            }
            return;
        }
        if (openDoc && openDoc.getText() === text) {
            shadowCache.set(key, text);
            await ensurePythonDocumentLanguage(openDoc);
            return;
        }
        const root = virtualRootFor();
        await vscode.workspace.fs.createDirectory(root.uri);
        await syncVirtualDocument(virtualUri, text);
        shadowCache.set(key, text);
    }

    function normalizeFocusKey(focusKey: string | null | undefined): string {
        return focusKey || "global";
    }

    async function ensurePythonDocumentLanguage(
        doc: vscode.TextDocument
    ): Promise<vscode.TextDocument> {
        if (doc.languageId === "python") {
            return doc;
        }
        return vscode.languages.setTextDocumentLanguage(doc, "python");
    }
}

function formatPythonHoverContents(
    contents: Array<vscode.MarkdownString | vscode.MarkedString>
): Array<vscode.MarkdownString | vscode.MarkedString> {
    return contents.map(formatPythonHoverContent);
}

function formatPythonHoverContent(
    content: vscode.MarkdownString | vscode.MarkedString
): vscode.MarkdownString | vscode.MarkedString {
    if (content instanceof vscode.MarkdownString) {
        return formatMarkdownHoverContent(content);
    }
    if (typeof content === "string") {
        return buildPythonSignatureMarkdown(content) ?? content;
    }
    if (isLanguageMarkedString(content)) {
        if (isPythonLanguage(content.language)) {
            return buildPythonSignatureMarkdown(content.value) ?? codeblockMarkdown(
                content.value,
                content.language
            );
        }
        return codeblockMarkdown(content.value, content.language);
    }
    return content;
}

function formatMarkdownHoverContent(
    content: vscode.MarkdownString
): vscode.MarkdownString {
    if (PYTHON_FENCE_RE.test(content.value)) {
        return content;
    }
    const formatted = buildPythonSignatureMarkdown(content.value);
    if (!formatted) {
        return content;
    }
    formatted.isTrusted = content.isTrusted;
    formatted.supportThemeIcons = content.supportThemeIcons;
    formatted.supportHtml = content.supportHtml;
    formatted.baseUri = content.baseUri;
    return formatted;
}

function buildPythonSignatureMarkdown(
    raw: string
): vscode.MarkdownString | undefined {
    const text = raw.replace(/\r\n?/g, "\n").trim();
    if (!text || text.includes("```")) {
        return undefined;
    }

    const lines = text.split("\n");
    const firstLine = lines[0].trim();
    const match = firstLine.match(HOVER_KIND_PREFIX_RE);
    const kind = match?.[1]?.trim();
    const signature = (match?.[2] ?? firstLine).trim();
    if (!looksLikePythonSignature(signature)) {
        return undefined;
    }

    const markdown = new vscode.MarkdownString();
    if (kind) {
        markdown.appendMarkdown(`(${escapeMarkdownText(kind)})\n\n`);
    }
    markdown.appendCodeblock(signature, "python");

    const tail = lines.slice(1).join("\n").trim();
    if (tail) {
        markdown.appendMarkdown(`\n\n${tail}`);
    }
    return markdown;
}

function looksLikePythonSignature(text: string): boolean {
    return /^(?:async\s+def\s+|def\s+|class\s+|[A-Za-z_]\w*\s*(?:\(|:|=))/.test(
        text
    );
}

function isLanguageMarkedString(
    content: unknown
): content is { language: string; value: string } {
    return (
        typeof content === "object" &&
        content !== null &&
        "language" in content &&
        "value" in content &&
        typeof (content as { language?: unknown }).language === "string" &&
        typeof (content as { value?: unknown }).value === "string"
    );
}

function isPythonLanguage(language: string): boolean {
    return /^(?:python|py)$/i.test(language);
}

function codeblockMarkdown(value: string, language: string): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(value, language);
    return markdown;
}

function escapeMarkdownText(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, "\\$&");
}
