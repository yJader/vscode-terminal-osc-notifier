![Terminal Notification banner](images/banner.png)

# Terminal Notification (Jader)

Personal fork of [wbopan/vscode-terminal-osc-notifier](https://github.com/wbopan/vscode-terminal-osc-notifier), installed locally as `yjader.vscode-terminal-osc-notifier`. This fork uses Homebrew's modern macOS notifier, terminal names for body-only notifications, and window-aware macOS notification links. It is distributed as a local VSIX; no Marketplace account is required.

Turn terminal messages into native system notifications you can click to jump back to the right terminal.

- Stay in the editor and never miss long-running tasks. 🔔
- Click once to focus the exact integrated terminal that sent the alert. 🖱️
- Works the same with local and remote terminals over SSH. 🌐

![Screenshot of notification and highlighted terminal](images/screenshot.png)

## What you get

- Support for two common notification escape sequences: `OSC 9;<message>` and `OSC 777;notify;<title>;<message>`.
- Native notifications on macOS, Windows, and Linux, with a VS Code fallback when the OS cannot send clicks back.
- tmux passthrough handled automatically, so sequences forwarded by tmux still work.

> Tip: Many build tools, test runners, and cloud development tools can emit these sequences to announce status.

## Quick start

1. Install **Terminal Notification (Jader)** using the local VSIX instructions below, and disable the upstream extension.
2. Run a command that emits a supported sequence from your terminal.
3. Click the notification to focus the emitting terminal tab in VS Code.

### Local installation on macOS

Prerequisites: VS Code 1.93+, Node.js 22.12+ with npm, and the `code` command on your PATH. In VS Code, run **Shell Command: Install 'code' command in PATH** if needed.

```sh
brew install terminal-notifier
git clone https://github.com/yJader/vscode-terminal-osc-notifier.git
cd vscode-terminal-osc-notifier
npm ci
npm run install:local
```

For an existing checkout, start with `npm ci` in that directory. Homebrew `terminal-notifier` must be version 3.1 or newer; use `brew upgrade terminal-notifier` if an older version is installed.

`install:local` checks types, runs tests, builds and packages `terminal-notification.vsix`, then installs it with `code --install-extension --force`. To build a VSIX without installing it, run `npm run package`.

In the Extensions view, search for `@id:wenbopan.vscode-terminal-osc-notifier` and choose **Disable** (globally, not just for this workspace). Both extensions register the same commands and settings, so only one should be enabled. Then run **Developer: Reload Window** in each open VS Code window. Existing `terminalNotification.*` settings continue to apply.

Install the fork on the local Mac, including when working in a Remote SSH window connected to xfusion6. Its `extensionKind: ["ui"]` runs the extension on the client; the remote machine does not need Homebrew or `terminal-notifier`.

Allow notifications for **terminal-notifier** in macOS System Settings. macOS controls the sender label and icon; the notification's content title uses the emitting terminal's name for OSC 9. OSC 777 preserves a non-empty sender-supplied title.

### Updates and rollback

After updating the checkout, run `npm ci` and `npm run install:local`, then reload your VS Code windows. Increment `package.json` and the lockfile version when preparing a new release (for example, `npm version patch --no-git-tag-version`). The independent `yjader` publisher prevents Marketplace updates for the upstream extension from replacing this fork. Local VSIX updates are manual.

To roll back, disable **Terminal Notification (Jader)**, re-enable the upstream extension, and reload VS Code. To remove the fork entirely:

```sh
code --uninstall-extension yjader.vscode-terminal-osc-notifier
```

### Verify notifications and window routing

Open two VS Code windows. In the first, create a terminal and rename it to `Notification source`. Run:

```sh
printf '\033]9;Window routing test\007'
```

Switch to another terminal and then to the second window. Click the system notification. Its title should be `Notification source`, and the first window should come forward with the original terminal focused. Repeat from a Remote SSH terminal. If `terminalNotification.skipWhenActive` is enabled, switch away before emitting the notification (for example, add `sleep 5;` before `printf`).

### Examples you can try

```sh
# Simple body-only notification (OSC 9)
printf '\e]9;Build finished\e\\'        # ST terminator
# or
printf '\e]9;Build finished\a'          # BEL terminator

# Title + body (OSC 777)
printf '\e]777;notify;Nightly Tests;All suites passed\a'

# Through tmux passthrough
printf '\ePtmux;\e\e]777;notify;Deploy;Production complete\a\e\\'
```

## What are “OSC sequences”?

OSC stands for Operating System Command. It is a family of escape sequences that terminals interpret as requests, such as setting a window title or asking for a desktop notification. This extension listens to the shell execution stream exposed by VS Code and turns the two sequences above into notifications.

## Remote and tmux

- Remote: Works with VS Code Remote over SSH because parsing happens on the client side in the editor.
- tmux: The extension unwraps tmux passthrough so that sequences forwarded by tmux continue to be recognized.

## Settings

All settings live under **Terminal Notification** (`terminalNotification.*`).

- `terminalNotification.preferOsNotifications` default true. Use native OS notifications. Disable to use VS Code toasts only.
- `terminalNotification.showVsCodeNotification` default true. Show a VS Code toast alongside OS notifications.
- `terminalNotification.ignoreProgressOsc9_4` default true. Ignore `OSC 9;4` progress updates to reduce noise.
- `terminalNotification.skipWhenActive` default false. Skip the notification when VS Code is focused and the emitting terminal is the currently active terminal. Useful for REPL-style tools (e.g. Claude Code) that emit OSC 9 on every response — no notification needed when you are already watching the terminal.
- `terminalNotification.sound` default empty. Play a sound with the OS notification. macOS: system sound names like `Glass`, `Ping`, `Hero`, `Submarine`, or `default` for the system default. Windows: `IM`, `Mail`, `Reminder`, `SMS`, etc. Linux: not supported. Leave empty for no sound.

Commands:

- **Notification: Enable** — resume parsing terminal output.
- **Notification: Disable** — pause parsing without unloading the extension.

## Compatibility

- VS Code 1.93 or newer.
- Shell Integration must be enabled in your integrated terminal. This is the default for supported shells.
- On macOS, install `terminal-notifier` 3.1 or newer with Homebrew (`brew install terminal-notifier`) for native notifications. Without it, VS Code notifications still work when `terminalNotification.showVsCodeNotification` is enabled.

### Notes and limitations

- Linux's `notify-send` backend does not support click-to-focus here. Use the VS Code notification's **Focus Terminal** action.
- On macOS, native notifications open a URI resolved by `vscode.env.asExternalUri`, which includes routing to the originating VS Code window. The URI handler selects the emitting terminal. The current VS Code URI scheme is respected, including VS Code Insiders. VS Code may ask permission to open the extension URI on first use.
- Terminal associations last for the current extension session. Old notifications cannot restore a closed terminal or reliably locate it after reloading or closing its window.
- Icons shown in OS notifications follow the host platform’s rules.

## Development

```sh
npm ci
npm test
npm run watch   # or: npm run build
# press F5 in VS Code to launch an Extension Development Host
```

The tests mock the VS Code and notification APIs to check title selection, URI preservation, terminal selection, and platform branches. Actual Notification Center clicks and multi-window behavior require the manual check above.

## License

MIT © Pan Wenbo
