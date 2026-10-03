// Run in a real VS Code extension host via --extensionTestsPath.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');

async function runChecks() {
    const source = [
        '> profile: reviewer:',
        '  > model: openai:gpt-5.6-luna',
        '  > instructions: Be precise.',
        '  > output: str',
        '',
        '@hello(name: str) -> str:',
        '  = <name>',
        '',
        '>> The capital is [city].',
        '> show: <city>',
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'kedi', content: source });
    await vscode.window.showTextDocument(doc);
    const extension = vscode.extensions.getExtension('dyigitpolat.kedi-vscode');
    assert.ok(extension, 'Kedi extension must be installed');
    await extension.activate();
    let legend, tokens;
    for (let attempt = 0; attempt < 100; attempt++) {
        legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', doc.uri);
        tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', doc.uri);
        if (tokens?.data?.length) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(tokens?.data?.length, 'LSP must return semantic tokens, not only TextMate colors');
    const decoded = [];
    let line = 0, column = 0;
    for (let i = 0; i < tokens.data.length; i += 5) {
        const [dl, dc, length, kind] = tokens.data.slice(i, i + 5);
        line += dl;
        column = dl ? dc : column + dc;
        decoded.push({ line, word: source.split('\n')[line].slice(column, column + length), kind: legend.tokenTypes[kind] });
    }
    for (const word of ['profile', 'model', 'instructions', 'output', 'show', '=']) {
        assert.ok(decoded.some(t => t.word === word && t.kind === 'keyword'), `missing keyword: ${word}`);
    }
    assert.ok(decoded.some(t => t.word === 'city' && ['variable','keyword'].includes(t.kind)));
    const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(3, 6));
    assert.ok(hover?.length, 'output directive hover');
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    assert.ok(symbols?.some(s => s.name.includes('hello')), 'procedure outline');
    const completionDoc = await vscode.workspace.openTextDocument({ language: 'kedi', content: '> mo' });
    await vscode.window.showTextDocument(completionDoc);
    const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', completionDoc.uri, new vscode.Position(0, 4));
    assert.ok(completions?.items?.some(item => String(item.label?.label || item.label).includes('model')), 'model completion');
    await vscode.commands.executeCommand('kedi.restartServer');
    const restarted = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', doc.uri);
    assert.ok(restarted?.data?.length, 'semantic tokens after LSP restart');
    console.log('KEDI_EDITOR_SMOKE_PASS: semantic keywords, output, captures, hover, outline, completion, restart');
    await require('./debugger.cjs').run();
}

exports.run = async function () {
    try {
        await runChecks();
        if (process.env.KEDI_EDITOR_TEST_RESULT) {
            await fs.writeFile(process.env.KEDI_EDITOR_TEST_RESULT, JSON.stringify({ passed: true }));
        }
    } catch (error) {
        if (process.env.KEDI_EDITOR_TEST_RESULT) {
            await fs.writeFile(process.env.KEDI_EDITOR_TEST_RESULT, JSON.stringify({ passed: false, error: error.stack }));
        }
        throw error;
    }
};
