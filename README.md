![Terminal Notification banner](images/banner.png)

# Terminal Notification

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

1. Install **Terminal Notification** from the VS Code Marketplace or sideload the `.vsix`.
2. Run a command that emits a supported sequence from your terminal.
3. Click the notification to focus the emitting terminal tab in VS Code.

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

- Some Linux environments cannot route notification click events back to the app. The extension opens a deep link to return focus to the right terminal as a fallback.
- On macOS, native notification clicks activate VS Code. The VS Code notification's **Focus Terminal** action selects the originating terminal.
- Icons shown in OS notifications follow the host platform’s rules.

## Development

```sh
npm install
npm run watch   # or: npm run compile
# press F5 in VS Code to launch an Extension Development Host
```

## License

MIT © Pan Wenbo
