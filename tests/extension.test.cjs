const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const bundle = buildSync({
    entryPoints: [path.join(__dirname, '../src/extension.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
}).outputFiles[0].text;

function harness({ platform = 'darwin', scheme = 'vscode', windowId = '42', failUri = false,
    workspaceName = 'research', authority = 'ssh-remote+xfusion6', remoteName = 'ssh-remote',
    folderName = 'research', workspaceAuthority, focusCommandFails = false, sound = '' } = {}) {
    const notifications = [];
    const resolvedUris = [];
    const errors = [];
    const commands = [];
    let onExecution;
    let uriHandler;
    let onClose;
    const disposable = { dispose() {} };
    class Notifier {
        notify(options) { notifications.push(options); }
        on() {}
    }
    const vscode = {
        env: {
            appRoot: '/vscode',
            uriScheme: scheme,
            remoteName,
            async asExternalUri(uri) {
                if (failUri) throw new Error('Cannot resolve notification URI');
                const resolved = `${uri.toString()}&windowId=${windowId}`;
                resolvedUris.push(resolved);
                return { toString: () => resolved };
            },
        },
        Uri: { parse: (value) => new URL(value) },
        workspace: {
            name: workspaceName,
            workspaceFile: workspaceAuthority ? { scheme: 'vscode-remote', authority: workspaceAuthority } : undefined,
            workspaceFolders: folderName ? [{ name: folderName, uri: {
                scheme: authority ? 'vscode-remote' : 'file', authority,
            } }] : [],
            getConfiguration: () => ({ get: (key, fallback) => key === 'sound' ? sound : fallback }),
        },
        commands: {
            registerCommand: () => disposable,
            async executeCommand(command) {
                commands.push(command);
                if (focusCommandFails) throw new Error('Unavailable command');
            },
        },
        window: {
            showInformationMessage: async () => undefined,
            registerUriHandler(handler) { uriHandler = handler; return disposable; },
            onDidStartTerminalShellExecution(handler) { onExecution = handler; return disposable; },
            onDidCloseTerminal(handler) { onClose = handler; return disposable; },
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(bundle, {
        module,
        exports: module.exports,
        process: { platform, env: {} },
        URLSearchParams,
        Buffer,
        console: { error: (...args) => errors.push(args), warn() {} },
        require(id) {
            if (id === 'vscode') return vscode;
            if (id.startsWith('node-notifier')) return Notifier;
            if (id === 'fs') return { existsSync: () => true };
            if (id === 'child_process') return { execFileSync: () => 'terminal-notifier 3.1.0' };
            if (id === 'os') return { hostname: () => 'local-mac' };
            return require(id);
        },
    });
    module.exports.activate({ extension: { id: 'yjader.vscode-terminal-osc-notifier' }, subscriptions: [] });
    return {
        notifications, resolvedUris, errors, commands,
        close(terminal) { onClose(terminal); },
        async emit(terminal, ...chunks) {
            await onExecution({
                terminal,
                execution: { async *read() { yield* chunks; } },
            });
            await new Promise(setImmediate);
        },
        async click(notification) {
            const uri = new URL(notification.open);
            await uriHandler.handleUri({ path: uri.pathname, query: uri.search.slice(1) });
        },
    };
}

test('macOS uses the terminal title and the unmodified window routing URI', async () => {
    const h = harness({ scheme: 'vscode-insiders' });
    let focused = false;
    await h.emit({ name: ' Remote build ', show(preserveFocus) {
        assert.equal(preserveFocus, false);
        assert.deepEqual(h.commands, ['workbench.action.focusWindow']);
        focused = true;
    } }, '\x1b]9;Build', ' finished\x07');
    const [notification] = h.notifications;
    assert.equal(notification.title, 'research[xfusion6]|Remote build');
    assert.equal(notification.message, 'Build finished');
    assert.equal(notification.open, h.resolvedUris[0]);
    assert.match(notification.open, /^vscode-insiders:\/\/yjader\.vscode-terminal-osc-notifier\/focus\?tid=.+&windowId=42$/);
    assert.equal(notification.activate, undefined);
    await h.click(notification);
    assert.equal(focused, true);
});

test('macOS passes the default sound through to terminal-notifier', async () => {
    const h = harness({ sound: 'default' });
    await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
    assert.equal(h.notifications[0].sound, 'default');
});

test('macOS preserves explicitly selected system sounds', async () => {
    const h = harness({ sound: 'Glass' });
    await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
    assert.equal(h.notifications[0].sound, 'Glass');
});

test('non-macOS keeps node-notifier default sound compatibility', async () => {
    const h = harness({ platform: 'win32', sound: 'default' });
    await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
    assert.equal(h.notifications[0].sound, true);
});

test('different machines and workspaces route each notification to their own window and terminal', async () => {
    const focused = [];
    const hosts = [
        { windowId: '1', workspaceName: 'research', authority: 'ssh-remote+xfusion6' },
        { windowId: '2', workspaceName: 'research', authority: 'ssh-remote+xfusion7' },
        { windowId: '3', workspaceName: 'tools', authority: 'ssh-remote+xfusion6' },
    ];
    const windows = [];
    for (const options of hosts) {
        const { windowId, workspaceName, authority } = options;
        const h = harness(options);
        await h.emit({ name: 'Same name', show() { focused.push(windowId); } }, '\x1b]9;Done\x07');
        assert.equal(h.notifications[0].title, `${workspaceName}[${authority.split('+')[1]}]|Same name`);
        assert.equal(new URL(h.notifications[0].open).searchParams.get('windowId'), windowId);
        windows.push(h);
    }
    for (const h of windows.reverse()) {
        await h.click(h.notifications[0]);
        assert.deepEqual(h.commands, ['workbench.action.focusWindow']);
    }
    assert.deepEqual(focused, ['3', '2', '1']);
});

test('OSC 777 preserves sender titles in the body while keeping source information in the title', async () => {
    const h = harness();
    await h.emit({ name: 'Build' }, '\x1b]777;notify; Nightly tests ;Passed\x07');
    await h.emit({ name: 'Build' }, '\x1b]777;notify; ;Passed\x07');
    await h.emit({ name: ' ' }, '\x1b]9;Done\x07');
    assert.deepEqual(h.notifications.map(n => n.title), [
        'research[xfusion6]|Build', 'research[xfusion6]|Build', 'research[xfusion6]|Terminal',
    ]);
    assert.deepEqual(h.notifications.map(n => n.message), ['Nightly tests: Passed', 'Passed', 'Done']);
});

test('local, empty, multi-root, WSL and encoded SSH workspaces have meaningful titles', async () => {
    const encoded = Buffer.from(JSON.stringify({ hostName: 'xfusion6', user: 'someone' })).toString('hex');
    const cases = [
        [{ authority: '', remoteName: '' }, 'research[local-mac]|Build'],
        [{ authority: '', remoteName: '', workspaceName: '', folderName: '' }, 'No workspace[local-mac]|Build'],
        [{ workspaceName: '', folderName: 'tools' }, 'tools[xfusion6]|Build'],
        [{ workspaceName: 'Multi-root', workspaceAuthority: 'ssh-remote+xfusion7' }, 'Multi-root[xfusion7]|Build'],
        [{ authority: 'wsl+Ubuntu', remoteName: 'wsl' }, 'research[Ubuntu]|Build'],
        [{ authority: `ssh-remote+${encoded}` }, 'research[xfusion6]|Build'],
        [{ authority: 'ssh-remote+deadbeef' }, 'research[deadbeef]|Build'],
        [{ authority: '', folderName: '' }, 'research[ssh-remote]|Build'],
    ];
    for (const [options, expected] of cases) {
        const h = harness(options);
        await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
        assert.equal(h.notifications[0].title, expected);
    }
});

test('VS Code remote labels are removed only when they match the current machine', async () => {
    const cases = [
        [{ workspaceName: 'research [SSH: xfusion6]' }, 'research[xfusion6]|Notification source'],
        [{ workspaceName: 'research [SSH: xfusion7]' }, 'research [SSH: xfusion7][xfusion6]|Notification source'],
        [{ workspaceName: 'research [notes] [SSH: xfusion6]' }, 'research [notes][xfusion6]|Notification source'],
        [{ workspaceName: 'research [WSL: Ubuntu]', authority: 'wsl+Ubuntu', remoteName: 'wsl' }, 'research[Ubuntu]|Notification source'],
        [{ workspaceName: 'research [SSH: xfusion6]', authority: '', remoteName: '' }, 'research [SSH: xfusion6][local-mac]|Notification source'],
    ];
    for (const [options, expected] of cases) {
        const h = harness(options);
        await h.emit({ name: 'Notification source' }, '\x1b]9;Post-restart native notification test\x07');
        assert.equal(h.notifications[0].title, expected);
    }
});

test('a remote terminal cwd identifies the machine in a folderless window', async () => {
    const h = harness({ workspaceName: '', folderName: '' });
    await h.emit({ name: 'Build', shellIntegration: { cwd: {
        scheme: 'vscode-remote', authority: 'ssh-remote+xfusion7',
    } } }, '\x1b]9;Done\x07');
    assert.equal(h.notifications[0].title, 'No workspace[xfusion7]|Build');
});

test('closed terminals and IDs belonging to another window do not focus unrelated terminals', async () => {
    const h = harness();
    let focused = false;
    const terminal = { name: 'Build', show() { focused = true; } };
    await h.emit(terminal, '\x1b]9;Done\x07');
    const otherWindow = harness({ windowId: '2' });
    await otherWindow.click(h.notifications[0]);
    assert.deepEqual(otherWindow.commands, []);
    h.close(terminal);
    await h.click(h.notifications[0]);
    assert.equal(focused, false);
    assert.deepEqual(h.commands, []);
});

test('older hosts without the focusWindow command still focus the terminal', async () => {
    const h = harness({ focusCommandFails: true });
    let focused = false;
    await h.emit({ name: 'Build', show() { focused = true; } }, '\x1b]9;Done\x07');
    await h.click(h.notifications[0]);
    assert.equal(focused, true);
});

test('URI resolution failures are caught', async () => {
    const h = harness({ failUri: true });
    await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
    assert.equal(h.notifications.length, 0);
    assert.equal(h.errors.length, 1);
});

test('Windows and Linux do not require macOS URI routing', async () => {
    for (const platform of ['win32', 'linux']) {
        const h = harness({ platform, failUri: true });
        await h.emit({ name: 'Build' }, '\x1b]9;Done\x07');
        assert.equal(h.notifications.length, 1);
        assert.equal(h.notifications[0].open, undefined);
        assert.equal(h.errors.length, 0);
    }
});
