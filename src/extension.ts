import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Always apply language configuration on activation
    updateLanguageConfiguration();
}

// No global editor setting changes; control colorization by overriding kedi brackets

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
            { open: '{', close: '}' }
        ],
        wordPattern: /[A-Za-z_][A-Za-z0-9_]*/
    };

    // Disable bracket colorization for Kedi by not declaring bracket pairs
    (languageConfig as any).brackets = [];

    // Register the language configuration for Kedi files
    vscode.languages.setLanguageConfiguration('kedi', languageConfig);
}

export function deactivate() {}
