import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Always apply language configuration on activation
    updateLanguageConfiguration();
}

// No global editor setting changes; control colorization by overriding marker brackets

function updateLanguageConfiguration() {
    const languageConfig: vscode.LanguageConfiguration = {
        comments: {
            lineComment: '#',
            blockComment: ['###', '###']
        },
        autoClosingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '<', close: '>' },
            { open: '{', close: '}' },
            { open: '"', close: '"', notIn: ['string' as any] },
            { open: "'", close: "'", notIn: ['string' as any] },
            { open: '`', close: '`', notIn: ['string' as any] }
        ],
        wordPattern: /[A-Za-z_][A-Za-z0-9_]*/
    };

    // Disable bracket colorization for Marker by not declaring bracket pairs
    (languageConfig as any).brackets = [];

    // Register the language configuration for Marker files
    vscode.languages.setLanguageConfiguration('marker', languageConfig);
}

export function deactivate() {}
