import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { hostname } from 'os';
import { execFileSync } from 'child_process';

// -- node-notifier: choose a backend appropriate for each platform --
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BaseNotifier = require('node-notifier');
// These sub-reporters are exposed as part of the public API
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NotificationCenter = require('node-notifier/notifiers/notificationcenter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WindowsToaster = require('node-notifier/notifiers/toaster');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NotifySend = require('node-notifier/notifiers/notifysend');

type Notifier = {
    notify: (opts: Record<string, any>, cb?: (...args: any[]) => void) => void;
    on?: (event: string, handler: (...args: any[]) => void) => void;
};

let notifier: Notifier | undefined;   // Platform-specific notifier instance
let iconPathForOS: string | undefined; // VS Code icon path (absolute)
let extensionCtx: vscode.ExtensionContext;

const SETTINGS_SECTION = 'terminalNotification';

function getSetting<T>(key: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration(SETTINGS_SECTION).get<T>(key, defaultValue);
}

// -- Terminal data parsing --
// Detects:
//   1) OSC 9 ; <body> BEL|ST
//   2) OSC 777 ; notify ; <title> ; <body> BEL|ST
// Terminators: BEL (0x07) or ST (ESC \ -> \x1b\\)
// Additionally unwraps tmux passthrough: ESC P tmux; <payload> ESC \, restoring \x1b\x1b to \x1b inside <payload>
// Reference: tmux FAQ on passthrough / DCS tmux; prefix (see the description above)

type ParsedNotification = { kind: 'osc9' | 'osc777'; title?: string; body: string };

class OscParser {
    private buffer = '';

    constructor(
        private readonly onNotify: (n: ParsedNotification) => void,
        private readonly ignoreOsc9_4: boolean
    ) { }

    feed(chunk: string) {
        this.buffer += chunk;
        if (this.buffer.length > 256 * 1024) {
            this.buffer = this.buffer.slice(-128 * 1024);
        }
        // First unwrap tmux DCS passthrough (possibly nested) so the inner payload becomes a normal stream
        this.unwrapTmuxPassthrough();

        const ESC = '\x1b';
        const BEL = '\x07';
        const OSC_PREFIX = ESC + ']';
        const ST = ESC + '\\';

        while (true) {
            const start = this.buffer.indexOf(OSC_PREFIX);
            if (start === -1) {
                if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-4096);
                return;
            }
            const afterStart = start + OSC_PREFIX.length;
            const endBel = this.buffer.indexOf(BEL, afterStart);
            const endSt = this.buffer.indexOf(ST, afterStart);

            let end = -1;
            let consume = 0;
            if (endBel !== -1 && (endSt === -1 || endBel < endSt)) {
                end = endBel; consume = 1;
            } else if (endSt !== -1) {
                end = endSt; consume = 2;
            } else {
                if (start > 0) this.buffer = this.buffer.slice(start);
                return;
            }

            const content = this.buffer.slice(afterStart, end);
            this.buffer = this.buffer.slice(end + consume);

            this.tryParseOsc(content);
        }
    }

    private tryParseOsc(content: string) {
        const s = content.trim();

        if (s.startsWith('9;')) {
            // Ghostty: 9;4 may indicate progress updates; optionally ignore
            if (this.ignoreOsc9_4 && s.startsWith('9;4;')) return;
            const body = s.slice(2).trim();
            if (body.length > 0) this.onNotify({ kind: 'osc9', body });
            return;
        }

        if (s.startsWith('777;')) {
            // 777;notify;title;body
            const parts = s.split(';');
            if (parts.length >= 2 && parts[1].toLowerCase() === 'notify') {
                const title = parts.length >= 3 ? parts[2] : 'Terminal';
                const body = parts.length >= 4 ? parts.slice(3).join(';') : '';
                if (body.length > 0 || title.length > 0) {
                    this.onNotify({ kind: 'osc777', title, body });
                }
            }
            return;
        }

        // Ignore other OSC types
    }

    // Unwrap ESC P tmux; ... ESC \ and turn inner \x1b\x1b sequences back into \x1b
    private unwrapTmuxPassthrough() {
        const ESC = '\x1b';
        const DCS_TMUX = ESC + 'Ptmux;';
        const ST = ESC + '\\';

        // Use a loop to handle multiple or nested frames
        // If the frame is incomplete (no ST), wait for the next chunk
        while (true) {
            const i = this.buffer.indexOf(DCS_TMUX);
            if (i === -1) return;

            const after = i + DCS_TMUX.length;
            const end = this.buffer.indexOf(ST, after);
            if (end === -1) {
                // Incomplete frame: keep data from i onward to control memory growth and wait for more
                if (i > 0) this.buffer = this.buffer.slice(i);
                return;
            }

            // Extract the inner payload and convert \x1b\x1b back to \x1b
            const inner = this.buffer.slice(after, end).replace(/\x1b\x1b/g, '\x1b');
            // Replace the entire DCS block with the inner payload, then continue to process the next block
            this.buffer = this.buffer.slice(0, i) + inner + this.buffer.slice(end + ST.length);
        }
    }
}

// -- Terminal/notification association and focus --
// Focus the matching terminal tab when a system notification is clicked

const terminalIdMap = new Map<vscode.Terminal, string>();
const idToTerminal = new Map<string, vscode.Terminal>();

function getOrAssignTerminalId(t: vscode.Terminal): string {
    const existing = terminalIdMap.get(t);
    if (existing) return existing;

    // Use crypto.randomUUID when available to produce a stable per-session ID
    const id = (globalThis as any).crypto?.randomUUID?.() ?? String(Math.random());
    terminalIdMap.set(t, id);
    idToTerminal.set(id, t);
    return id;
}

async function focusTerminalById(tid: string) {
    const term = idToTerminal.get(tid);
    if (!term) return;
    // The URI is routed to this extension host's window, even with multiple remotes.
    try { await vscode.commands.executeCommand('workbench.action.focusWindow'); } catch { /* older VS Code */ }
    try { term.show(false); } catch { /* terminal may have closed during activation */ }
}

function notificationTitle(term: vscode.Terminal): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let workspace = vscode.workspace.name?.trim() || folders[0]?.name?.trim() || 'No workspace';
    const uris = [vscode.workspace.workspaceFile, ...folders.map(folder => folder.uri), term.shellIntegration?.cwd];
    const remote = uris.find(uri => uri?.scheme === 'vscode-remote' && uri.authority);
    let machine = vscode.env.remoteName || hostname();
    if (remote) {
        const separator = remote.authority.indexOf('+');
        machine = separator < 0 ? remote.authority : remote.authority.slice(separator + 1);
        // Remote SSH can encode connection metadata instead of a plain SSH alias.
        if (remote.authority.startsWith('ssh-remote+') && /^(?:[0-9a-f]{2})+$/i.test(machine)) {
            try {
                const connection = JSON.parse(Buffer.from(machine, 'hex').toString('utf8'));
                if (typeof connection.hostName === 'string' && connection.hostName.trim()) {
                    machine = connection.hostName.trim();
                }
            } catch { /* a plain SSH alias can also consist of hex characters */ }
        }
        machine ||= vscode.env.remoteName || 'Remote';
    }
    const provider = remote?.authority.split('+', 1)[0] || vscode.env.remoteName;
    const label = provider === 'ssh-remote' ? 'SSH' : provider === 'wsl' ? 'WSL' : undefined;
    const suffix = label ? ` [${label}: ${machine}]` : undefined;
    // workspace.name can already include VS Code's remote label.
    if (suffix && workspace.endsWith(suffix)) {
        workspace = workspace.slice(0, -suffix.length).trimEnd() || 'No workspace';
    }
    return `${workspace}[${machine}]|${term.name?.trim() || 'Terminal'}`;
}

async function focusUriForTerminal(tid: string): Promise<string> {
    const scheme = vscode.env.uriScheme;
    const extId = extensionCtx.extension.id;
    const uri = vscode.Uri.parse(`${scheme}://${extId}/focus?tid=${encodeURIComponent(tid)}`);
    // VS Code adds routing for this window. Preserve the returned URI unchanged.
    return (await vscode.env.asExternalUri(uri)).toString();
}

// -- OS notifications and VS Code notifications --

// One shared click handler: node-notifier returns the options we originally passed in
function installGlobalNotifierClickHandler() {
    if (!notifier?.on) return;
    // Avoid duplicate registration
    const anyNotifier = notifier as any;
    if (anyNotifier.__terminalNotificationClickHooked) return;
    anyNotifier.__terminalNotificationClickHooked = true;

    notifier.on!('click', (_obj: any, options: any) => {
        const tid = options?.tid as string | undefined;
        if (tid) focusTerminalById(tid);
    });
}

// Resolve the built-in VS Code icon path across platforms
// Windows: prefer common sizes (256 or 128)
// macOS: use the .icns asset so Notification Center shows the app icon
// Linux: use the PNG asset
function resolveVSCodeIconPath(): string | undefined {
    try {
        const root = vscode.env.appRoot; // .../resources/app
        if (process.platform === 'darwin') {
            const p = path.join(root, 'resources', 'darwin', 'code.icns');
            return fs.existsSync(p) ? p : undefined;
        }
        if (process.platform === 'win32') {
            const candidates = ['code_256x256x32.png', 'code_128x128x32.png', 'code_64x64x32.png'];
            for (const f of candidates) {
                const p = path.join(root, 'resources', 'win32', f);
                if (fs.existsSync(p)) return p;
            }
            return undefined;
        }
        // linux
        const p = path.join(root, 'resources', 'linux', 'code.png');
        return fs.existsSync(p) ? p : undefined;
    } catch {
        return undefined;
    }
}

function findModernMacNotifier(): string | undefined {
    const prefixes = [process.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'];
    for (const prefix of prefixes) {
        if (!prefix) continue;
        const binary = path.join(prefix, 'opt', 'terminal-notifier', 'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier');
        if (!fs.existsSync(binary)) continue;
        try {
            const version = execFileSync(binary, ['-version'], { encoding: 'utf8', timeout: 2000 });
            const match = version.match(/terminal-notifier (\d+)\.(\d+)\./);
            if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 1))) {
                return binary;
            }
        } catch { /* try the next Homebrew prefix */ }
    }
    return undefined;
}

// Create a more controllable notifier per platform
function createPlatformNotifier(): Notifier | undefined {
    try {
        if (process.platform === 'darwin') {
            const binary = findModernMacNotifier();
            return binary ? new NotificationCenter({ withFallback: false, customPath: binary }) : undefined;
        }
        if (process.platform === 'win32') {
            // Windows: rely on the SnoreToast toaster and set appID so VS Code's name/icon are shown
            return new WindowsToaster({ withFallback: false, appID: 'Visual Studio Code' });
        }
        // Linux: rely on notify-send
        return new NotifySend({ withFallback: false });
    } catch {
        return process.platform === 'darwin' ? undefined : BaseNotifier;
    }
}

async function sendOsNotification(tid: string, title: string, message: string) {
    const preferOs = getSetting('preferOsNotifications', true);
    if (!preferOs || !notifier) return;

    try {
        const opts: any = {
            title: title || 'Terminal',
            message: message || '',
            wait: process.platform !== 'darwin',
            tid,          // Custom field retrieved later in the click callback
        };

        // Optional sound. Passed through to node-notifier; platform support varies:
        //   macOS NotificationCenter: system sound names like "Glass", "Ping", "Hero",
        //                             or "default" for the system default.
        //   Windows Toaster: "IM", "Mail", "Reminder", "SMS", etc.
        //   Linux notify-send: no sound support.
        const sound = getSetting<string>('sound', '');
        if (sound) {
            // node-notifier translates `true` to the fixed macOS `Bottle` sound.
            // terminal-notifier accepts the literal `default`, which lets
            // Notification Center select macOS's current default sound.
            opts.sound = process.platform === 'darwin'
                ? sound
                : sound === 'default' ? true : sound;
        }

        // Try to set the VS Code icon (each platform uses a different mechanism)
        if (process.platform === 'darwin') {
            // UserNotifications does not permit overriding the notification sender.
            opts.timeout = false;
            opts.open = await focusUriForTerminal(tid);
            if (iconPathForOS) opts.contentImage = iconPathForOS; // Display as the notification content image (not the header badge)
        } else if (process.platform === 'win32') {
            // Windows: appID is already configured; also pass an icon for consistency
            if (iconPathForOS) opts.icon = iconPathForOS;
        } else {
            // Linux: notify-send accepts icon paths but does not support wait/click events
            if (iconPathForOS) opts.icon = iconPathForOS;

            // notify-send cannot open a URI; use the VS Code toast's focus action.
        }

        notifier.notify(opts);
    } catch (err) {
        console.error('OS notification failed', err);
    }
}

function sendVsCodeNotification(tid: string, title: string, message: string) {
    const show = getSetting('showVsCodeNotification', true);
    if (!show) return;

    const text = title ? `${title}: ${message}` : message;
    vscode.window.showInformationMessage(text, 'Focus Terminal').then(sel => {
        if (sel === 'Focus Terminal') focusTerminalById(tid);
    });
}

// -- Entry point --
let enabled = true;

export function activate(ctx: vscode.ExtensionContext) {
    extensionCtx = ctx;
    iconPathForOS = resolveVSCodeIconPath();
    notifier = createPlatformNotifier();
    installGlobalNotifierClickHandler();

    // Commands: enable/disable parsing
    ctx.subscriptions.push(
        vscode.commands.registerCommand('terminalNotification.enable', () => { enabled = true; vscode.window.showInformationMessage('Terminal notifications enabled'); }),
        vscode.commands.registerCommand('terminalNotification.disable', () => { enabled = false; vscode.window.showInformationMessage('Terminal notifications disabled'); }),
    );

    // URI handler for macOS native notification clicks.
    ctx.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri: (uri) => {
                if (uri.path === '/focus') {
                    const tid = new URLSearchParams(uri.query).get('tid') || '';
                    return focusTerminalById(tid);
                }
            }
        })
    );

    ctx.subscriptions.push(vscode.window.onDidCloseTerminal(term => {
        const tid = terminalIdMap.get(term);
        if (tid) idToTerminal.delete(tid);
        terminalIdMap.delete(term);
    }));

    // Observe raw command execution output (VS Code Shell Integration API 1.93+)
    ctx.subscriptions.push(
        vscode.window.onDidStartTerminalShellExecution(async (event: vscode.TerminalShellExecutionStartEvent) => {
            if (!enabled) return;

            const term = event.terminal;
            const execution = event.execution;
            const tid = getOrAssignTerminalId(term);

            const parser = new OscParser(
                (n) => {
                    const title = notificationTitle(term);
                    const senderTitle = n.kind === 'osc777' ? n.title?.trim() : '';
                    const body = senderTitle ? `${senderTitle}: ${n.body}` : n.body;
                    // Skip when the emitting terminal is already the focused one
                    // (user is clearly watching it — no need to interrupt).
                    if (getSetting('skipWhenActive', false)) {
                        const vscodeFocused = vscode.window.state.focused;
                        const isActiveTerm = vscode.window.activeTerminal === term;
                        if (vscodeFocused && isActiveTerm) return;
                    }
                    void sendOsNotification(tid, title, body);
                    sendVsCodeNotification(tid, title, body);
                },
                getSetting('ignoreProgressOsc9_4', true)
            );

            const stream = execution.read();
            try {
                for await (const data of stream) {
                    parser.feed(String(data));
                }
            } catch (e) {
                console.warn('Terminal data stream ended with error:', e);
            }
        })
    );

}

export function deactivate() {
    // noop
}
