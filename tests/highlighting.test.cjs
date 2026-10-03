const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Registry, parseRawGrammar, INITIAL } = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');

const root = path.join(__dirname, '..');
let grammar;
test.before(async () => {
    await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
    const registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
            createOnigString: text => new oniguruma.OnigString(text),
        }),
        loadGrammar: async scope => scope === 'source.kedi'
            ? parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes/kedi.tmLanguage.json'), 'utf8'), 'kedi.json')
            : { scopeName: 'source.python', patterns: [{ match: '\\b(print|return)\\b', name: 'keyword.control.python' }] },
    });
    grammar = await registry.loadGrammar('source.kedi');
});

test('syntax fallback is bundled and does not require the language server', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.contributes.grammars[0].scopeName, 'source.kedi');
    assert.ok(fs.existsSync(path.join(root, pkg.contributes.grammars[0].path)));
    assert.equal(pkg.contributes.configurationDefaults['[kedi]']['editor.semanticHighlighting.enabled'], true);
});

test('all supported directive names highlight, including output and task controls', () => {
    const words = 'agent adapter model effort approval hooks history skills codemode requires budget show tool instructions mcp settings artifacts output subagent max_agents workflow profile use package import export auto optimize case data test_data metric if else loop task await send interrupt task_group process map'.split(' ');
    for (const word of words) {
        const source = `  > ${word}: value`;
        const { tokens } = grammar.tokenizeLine(source, INITIAL);
        assert.ok(tokens.some(t => source.slice(t.startIndex, t.endIndex) === word && t.scopes.includes('keyword.control.kedi')), word);
    }
});

test('templates retain capture and input scopes without LSP', () => {
    const source = '>> The capital of <country> is [city: str].';
    const { tokens } = grammar.tokenizeLine(source, INITIAL);
    for (const word of ['country', 'city']) {
        assert.ok(tokens.some(t => source.slice(t.startIndex, t.endIndex) === word && t.scopes.includes('variable.other.kedi')));
    }
});

test('comments and fenced Python do not become Kedi directives', () => {
    for (const first of ['###', '```python']) {
        const state = grammar.tokenizeLine(first, INITIAL).ruleStack;
        const { tokens } = grammar.tokenizeLine('> output: str', state);
        assert.ok(tokens.every(t => !t.scopes.includes('keyword.control.kedi')));
    }
    const { tokens } = grammar.tokenizeLine('>> Please use output and model in the explanation.', INITIAL);
    assert.ok(tokens.filter(t => t.scopes.includes('keyword.control.kedi')).length === 1);
});
