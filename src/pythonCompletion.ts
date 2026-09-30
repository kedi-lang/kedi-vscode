import * as vscode from "vscode";

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
interface Edit { range?: Range; insert?: Range; replace?: Range; newText: string }
export interface CompletionEdit {
    label: string;
    index: number;
    textEdit?: Edit;
    additionalTextEdits: Edit[];
}

const rawRange = (range: vscode.Range): Range => ({
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
});
const editorRange = (range: Range): vscode.Range => new vscode.Range(
    range.start.line, range.start.character, range.end.line, range.end.character,
);

export function completionEdits(items: vscode.CompletionItem[]): CompletionEdit[] {
    return items.map((item, index) => {
        const insertion = item.insertText ?? (typeof item.label === "string" ? item.label : item.label.label);
        const newText = insertion instanceof vscode.SnippetString ? insertion.value : insertion;
        const range = item.range;
        return {
            label: typeof item.label === "string" ? item.label : item.label.label,
            index,
            textEdit: range ? {
                ...(range instanceof vscode.Range ? { range: rawRange(range) } : {
                    insert: rawRange(range.inserting), replace: rawRange(range.replacing),
                }),
                newText,
            } : item.textEdit ? { range: rawRange(item.textEdit.range), newText: item.textEdit.newText } : undefined,
            additionalTextEdits: (item.additionalTextEdits ?? []).map(edit => ({
                range: rawRange(edit.range), newText: edit.newText,
            })),
        };
    });
}

export function mappedCompletions(items: vscode.CompletionItem[], edits: CompletionEdit[]): vscode.CompletionItem[] {
    return edits.map(edit => {
        const original = items[edit.index];
        const item = { ...original, command: undefined, textEdit: undefined };
        if (edit.textEdit) {
            const primary = edit.textEdit;
            item.range = primary.range ? editorRange(primary.range) : {
                inserting: editorRange(primary.insert!), replacing: editorRange(primary.replace!),
            };
            item.insertText = original.insertText instanceof vscode.SnippetString
                ? new vscode.SnippetString(primary.newText) : primary.newText;
        }
        item.additionalTextEdits = edit.additionalTextEdits.map(extra =>
            new vscode.TextEdit(editorRange(extra.range!), extra.newText));
        return item;
    });
}

export function rawMappings(mappings: { sourceRange: vscode.Range; virtualRange: vscode.Range }[]) {
    return mappings.map(mapping => ({
        sourceRange: rawRange(mapping.sourceRange), virtualRange: rawRange(mapping.virtualRange),
    }));
}
