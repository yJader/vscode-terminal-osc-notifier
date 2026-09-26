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

function harness({ platform = 'darwin', scheme = 'vscode', windowId = '42', failUri = false } = {}) {
    const notifications = [];
    const resolvedUris = [];
    const errors = [];
    let onExecution;
    let uriHandler;
    const disposable = { dispose() {} };
    class Notifier {
        notify(options) { notifications.push(options); }
        on() {}
    }
    const vscode = {
        env: {
            appRoot: '/vscode',
            uriScheme: scheme,
            async asExternalUri(uri) {
                if (failUri) throw new Error('Cannot resolve notification URI');
                const resolved = `${uri.toString()}&windowId=${windowId}`;
                resolvedUris.push(resolved);
                return { toString: () => resolved };
            },
        },
        Uri: { parse: (value) => new URL(value) },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        commands: { registerCommand: () => disposable },
        window: {
            showInformationMessage: async () => undefined,
            registerUriHandler(handler) { uriHandler = handler; return disposable; },
            onDidStartTerminalShellExecution(handler) { onExecution = handler; return disposable; },
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(bundle, {
        module,
        exports: module.exports,
        process: { platform, env: {} },
        URLSearchParams,
        console: { error: (...args) => errors.push(args), warn() {} },
        require(id) {
            if (id === 'vscode') return vscode;
            if (id.startsWith('node-notifier')) return Notifier;
            if (id === 'fs') return { existsSync: () => true };
            if (id === 'child_process') return { execFileSync: () => 'terminal-notifier 3.1.0' };
            return require(id);
        },
    });
    module.exports.activate({ extension: { id: 'yjader.vscode-terminal-osc-notifier' }, subscriptions: [] });
    return {
        notifications, resolvedUris, errors,
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
    await h.emit({ name: ' Remote build ', show() { focused = true; } }, '\x1b]9;Build', ' finished\x07');
    const [notification] = h.notifications;
    assert.equal(notification.title, 'Remote build');
    assert.equal(notification.message, 'Build finished');
    assert.equal(notification.open, h.resolvedUris[0]);
    assert.match(notification.open, /^vscode-insiders:\/\/yjader\.vscode-terminal-osc-notifier\/focus\?tid=.+&windowId=42$/);
    assert.equal(notification.activate, undefined);
    await h.click(notification);
    assert.equal(focused, true);
});

test('separate extension hosts route each notification to their own terminal', async () => {
    const focused = [];
    for (const windowId of ['1', '2']) {
        const h = harness({ windowId });
        await h.emit({ name: 'Same name', show() { focused.push(windowId); } }, '\x1b]9;Done\x07');
        assert.equal(new URL(h.notifications[0].open).searchParams.get('windowId'), windowId);
        await h.click(h.notifications[0]);
    }
    assert.deepEqual(focused, ['1', '2']);
});

test('OSC 777 keeps explicit titles and falls back for empty titles', async () => {
    const h = harness();
    await h.emit({ name: 'Build' }, '\x1b]777;notify; Nightly tests ;Passed\x07');
    await h.emit({ name: 'Build' }, '\x1b]777;notify; ;Passed\x07');
    await h.emit({ name: ' ' }, '\x1b]9;Done\x07');
    assert.deepEqual(h.notifications.map(n => n.title), ['Nightly tests', 'Build', 'Terminal']);
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
