const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');

exports.run = async function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'Debugger smoke needs an isolated workspace');
    const directory = vscode.Uri.joinPath(folder.uri, `.kedi-debugger-smoke-${randomUUID()}`);
    await vscode.workspace.fs.createDirectory(directory);
    const program = vscode.Uri.joinPath(directory, 'main.kedi');
    const envFile = vscode.Uri.joinPath(directory, '.env');
    const events = [], waiters = [];
    const publish = event => {
        const index = waiters.findIndex(w => w.name === event.event);
        if (index < 0) events.push(event);
        else waiters.splice(index, 1)[0].resolve(event);
    };
    const terminated = vscode.debug.onDidTerminateDebugSession(session => {
        if (session.type === 'kedi') publish({ event: 'sessionTerminated', session });
    });
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory('kedi', {
        createDebugAdapterTracker(session) {
            return { onDidSendMessage(message) {
                if (message.type !== 'event') return;
                publish({ session, ...message });
            } };
        },
    });
    const wait = name => new Promise((resolve, reject) => {
        const index = events.findIndex(event => event.event === name);
        if (index >= 0) return resolve(events.splice(index, 1)[0]);
        const timer = setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Debugger event timed out: ${name}`));
        }, 30000);
        const waiter = { name, resolve(value) { clearTimeout(timer); resolve(value); } };
        waiters.push(waiter);
    });
    let session;
    try {
        for (const revision of [42, 43]) {
            events.length = 0;
            await vscode.workspace.fs.writeFile(program, Buffer.from(
                `[answer: int] = \`${revision}\`\n` +
                '[setting: str] = `__import__("os").environ["KEDI_SMOKE_SETTING"]`\n' +
                '= <answer>\n',
            ));
            await vscode.workspace.fs.writeFile(envFile, Buffer.from(`KEDI_SMOKE_SETTING=revision-${revision}\n`));
            assert.equal(await vscode.debug.startDebugging(folder, {
                type: 'kedi', request: 'launch', name: 'Kedi managed smoke',
                program: program.fsPath, cwd: directory.fsPath, stopOnEntry: true,
            }), true);
            let stopped = await wait('stopped');
            session = stopped.session;
            for (const line of [1, 2]) {
                const stack = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
                assert.equal(stack.stackFrames[0].line, line);
                await session.customRequest('next', { threadId: stopped.body.threadId });
                stopped = await wait('stopped');
            }
            const stack = await session.customRequest('stackTrace', { threadId: stopped.body.threadId });
            const frameId = stack.stackFrames[0].id;
            assert.equal(stack.stackFrames[0].line, 3);
            const scopes = await session.customRequest('scopes', { frameId });
            const variables = [];
            for (const scope of scopes.scopes) {
                variables.push(...(await session.customRequest('variables', {
                    variablesReference: scope.variablesReference,
                })).variables);
            }
            assert.ok(variables.some(v => v.name === 'answer' && v.value === String(revision)));
            assert.equal((await session.customRequest('evaluate', { frameId, expression: 'setting' })).result,
                `revision-${revision}`);
            await session.customRequest('continue', { threadId: stopped.body.threadId });
            assert.equal((await wait('exited')).body.exitCode, 0);
            await wait('terminated');
            await wait('sessionTerminated');
            session = undefined;
        }
        console.log('KEDI_DEBUGGER_SMOKE_PASS: managed launch, stepping, variables, env reload, relaunch, clean exit');
    } finally {
        if (session) await vscode.debug.stopDebugging(session);
        tracker.dispose();
        terminated.dispose();
        await vscode.workspace.fs.delete(directory, { recursive: true });
    }
};
