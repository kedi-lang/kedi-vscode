const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');

const waitFor = (subscribe, matches, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`Timed out waiting for ${label}`)); }, 60000);
    const listener = subscribe(value => {
        if (!matches(value)) return;
        clearTimeout(timer);
        listener.dispose();
        resolve(value);
    });
});

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Run smoke needs an isolated workspace');
    const directory = vscode.Uri.joinPath(folder.uri, `.kedi-run-smoke-${randomUUID()}`);
    await vscode.workspace.fs.createDirectory(directory);
    const program = vscode.Uri.joinPath(directory, 'main.kedi');
    try {
        await vscode.workspace.fs.writeFile(program, Buffer.from([
            '@add(a: int, b: int) -> int:',
            '  = `a + b`',
            '',
            '= <add(1, 2)>',
            '',
            '@test: add:',
            '  > case: sums:',
            '    ```',
            '    assert add(1, 2) == 3',
            '    ```',
            '',
        ].join('\n')));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(program));
        const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', program);
        const runTests = lenses.find(lens => lens.command?.command === 'kedi.runTests');
        assert.equal(runTests?.range.start.line, 5, 'Run tests lens on the @test: line');

        await vscode.commands.executeCommand(runTests.command.command, ...runTests.command.arguments);
        const terminal = vscode.window.terminals.find(candidate => candidate.name === 'Kedi tests: main.kedi');
        assert.ok(terminal, 'Run tests opens a terminal');
        // The terminal stays open after its process exits; wait for the exit status.
        for (let attempt = 0; attempt < 200 && !terminal.exitStatus; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        assert.equal(terminal.exitStatus?.code, 0, 'kedi --test exits cleanly');
        terminal.dispose();

        const terminated = waitFor(vscode.debug.onDidTerminateDebugSession, session => session.type === 'kedi', 'the debug session to end');
        await vscode.commands.executeCommand('kedi.debugFile', program);
        const session = await terminated;
        assert.equal(session.configuration.stopOnEntry, false);
        console.log('KEDI_RUN_SMOKE_PASS: test lens, run tests terminal, debug file');
    } finally {
        await vscode.workspace.fs.delete(directory, { recursive: true });
    }
};
