const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('backticks are explicit syntax, not automatic pairs or snippet triggers', () => {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../language-configuration.json'), 'utf8'));
    const snippets = JSON.parse(fs.readFileSync(path.join(__dirname, '../snippets/marker.code-snippets'), 'utf8'));
    assert.ok(config.autoClosingPairs.every(pair => pair.open !== '`'));
    assert.ok(Object.values(snippets).every(item => [item.prefix].flat().every(prefix => !prefix.includes('`'))));
});
