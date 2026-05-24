# claude-code plugin for DeskFox

> 🌏 Language: [中文](./README.md) | **English**

Lets DeskFox reuse your **Claude Pro/Max subscription via the local Claude Code CLI**, so you can pick Claude Sonnet / Opus / Haiku straight from the chat model selector.

No Anthropic API key needed. You won't be billed per token.

## Get it

Pick either mirror — both are kept in sync:

```bash
# Gitee (faster from mainland China)
git clone https://gitee.com/zoulukuang/deskfox-plugins.git
# GitHub
git clone https://github.com/yuesoue/deskfox-plugins.git
```

Or download a zip from [Gitee](https://gitee.com/zoulukuang/deskfox-plugins) / [GitHub](https://github.com/yuesoue/deskfox-plugins) and unpack.

> The compiled `dist/index.js` is shipped with the repo. **Regular users don't need bun/pnpm/npm** — clone and run the installer directly.

## Prerequisites

**Claude Code CLI must already be set up on your machine — `claude` runs from your terminal.** Any Claude Code installation / login / network issue is out of scope for this plugin; check Claude Code's official docs first.

Supported Claude Code install methods (auto-detected): **official native installer / WinGet / npm global / bun / pnpm / yarn / scoop / chocolatey / manual extract**. Anything in `PATH` or installed in a common location works.

DeskFox itself must be installed (this repo is just a plugin).

## Install (Windows)

1. Go to the `claude-code/` directory
2. **Double-click `install.bat`** (or run `install.ps1` from PowerShell)
3. The script will:
   - Probe for `claude.exe` on your machine
   - Prompt you for the path if not found (loops until valid)
   - Back up your current `%USERPROFILE%\.config\opencode\opencode.jsonc` as `.bak.<timestamp>`
   - Merge the `claude-code` provider section in (**leaves your other providers untouched**)
4. **Fully quit DeskFox and restart** (system tray → Exit; make sure background sidecar `opencode-cli.exe` is also gone)

## Install (macOS)

**Recommended: double-click `claude-code/install.command` in Finder** — it opens Terminal, runs the installer, and keeps the window open so you can read the output.

Command-line users can also run:

```bash
cd /path/to/deskfox-plugins/claude-code
./install.sh
```

> Double-click does nothing on first checkout? macOS may have flagged the file as quarantined. Run once in that directory:
> ```bash
> chmod +x install.command install.sh
> xattr -d com.apple.quarantine install.command 2>/dev/null; true
> ```

## Install (Linux)

```bash
cd /path/to/deskfox-plugins/claude-code
./install.sh
```

## What the macOS / Linux installer does

- Checks for `dist/index.js`. **Shipped with the repo, usually skipped**; if missing, auto-builds via `bun → pnpm → npm` (whichever is available)
- Probes for the `claude` binary in this order: `PATH` → `~/.local/bin/claude` (Anthropic's official installer default) → `/opt/homebrew/bin/claude` (Apple Silicon brew) → `/usr/local/bin/claude` (Intel brew / system npm) → `~/.bun/bin/claude` → `~/.volta/bin/claude` → `~/.npm-global/bin/claude` → yarn / pnpm global → currently active `nvm` / `fnm`
- Falls back to a prompt where you type the full path (`~` expansion supported, loops until valid)
- Backs up your current `~/.config/opencode/opencode.jsonc` as `.bak.<timestamp>`
- Merges the `claude-code` provider section (**leaves your other providers untouched**)

Once finished, **fully quit DeskFox and restart**: on macOS use `Cmd+Q`, and if you're worried the sidecar didn't exit, `pkill -f opencode-cli` as a backstop.

> If your existing config contains `// JSONC comments`, Node's built-in `JSON.parse` won't read it. The script then backs up the original and prints a `"claude-code": { ... }` snippet for you to paste in manually — **it never overwrites your config**.

## Usage

Open DeskFox → model selector → pick one of the three under **Claude Code (订阅)**:

- **Claude Sonnet (via Claude Code)** — balanced (recommended for daily use)
- **Claude Opus (via Claude Code)** — most powerful (slow, expensive, but free under your subscription)
- **Claude Haiku (via Claude Code)** — fastest (good for simple tasks)

Standard chat and tool use (read files, run bash, edit code) are all supported.

## Uninstall

No auto-uninstaller. Two manual steps:

1. Edit `~/.config/opencode/opencode.jsonc` (Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`) and delete the entire `"claude-code": { ... }` block from the `provider` object (keep your other providers intact)
2. Delete this plugin directory (optional — leaving it does no harm, just disk space)

To restore the pre-install config: rename the newest `opencode.jsonc.bak.<timestamp>` back to `opencode.jsonc`.

## Reinstall / change Claude Code path

Just re-run `install.bat` (Windows) or double-click `install.command` / run `install.sh` (macOS / Linux). The script re-probes, auto-backs up, and merges in — same as the first install.

## Troubleshooting

### "Claude Code (订阅)" doesn't appear in the model selector after restart

1. Check `~/.config/opencode/opencode.jsonc` (Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`) actually contains a `"claude-code"` block
2. Check the path in `provider.claude-code.npm` (`file://.../dist/index.js`) — the file must exist
3. **Fully quit and restart DeskFox** — most often it's just a stale sidecar. macOS: `pkill -f opencode-cli`; Windows: tray → Exit

### "Thinking..." spinner hangs forever after sending a message

DeskFox needs to be recent enough to include the step-loop fix. If your build is old, ask the DeskFox maintainer to upgrade or rebuild.

### Red banner: `Model tried to call unavailable tool 'invalid'`

The plugin should already map `PowerShell` → `bash`. If you still see this, the Claude CLI invoked some tool name we haven't mapped.

To diagnose, turn on DEBUG and watch what the plugin sees.

Windows (PowerShell):
```powershell
[Environment]::SetEnvironmentVariable("DEBUG", "opencode-claude-code", "User")
# Restart DeskFox and reproduce
```

macOS / Linux:
```bash
launchctl setenv DEBUG opencode-claude-code   # for DeskFox launched from macOS GUI
# Or `export DEBUG=opencode-claude-code` then launch DeskFox from the same terminal
# Restart DeskFox and reproduce
```

Then look at `debug.log` in the plugin directory for an `unmapped tool fallthrough` line and report the name to the maintainer. To turn off:

```powershell
# Windows
[Environment]::SetEnvironmentVariable("DEBUG", $null, "User")
```

```bash
# macOS
launchctl unsetenv DEBUG
```

### Claude says it's in the wrong project directory

Historically Bug #1. Already fixed via the shared `_opencode.cwd` namespace (paired with a deskfox-fork commit).

If your DeskFox build doesn't include that fix yet, **temporary workaround**: tell Claude the project path explicitly in your message, e.g. "I'm currently in the `~/projects/foo` project, ..."

### Other weird bugs

Turn on DEBUG, capture `debug.log`, and send it to the maintainer. Note that the log may contain sensitive data (code snippets, file paths) — review and redact before sharing.

## File inventory

| File | Purpose |
|---|---|
| `install.bat` / `install.ps1` | Install entry point (Windows) |
| `install.command` | Install entry point (macOS, Finder double-click; calls `install.sh`) |
| `install.sh` | Install entry point (macOS / Linux command line) |
| `dist/index.js` | Compiled plugin (DeskFox loads this; **shipped with the repo**) |
| `src/` | Plugin source |
| `package.json` / `tsup.config.ts` / `bun.lock` | Build configuration |
| `NOTES.md` | Authoritative dev notes (every fork change is logged here; required reading for future maintenance) |
| `HANDOFF-deskfox-fork.md` | DeskFox-main-repo step-loop-fix ticket (resolved) |
| `HANDOFF-deskfox-fork-2-cwd.md` | DeskFox-main-repo cwd-injection ticket (resolved) |
| `README.md` / `README.en.md` | User docs (Chinese / English) |

## Development (only relevant if you modify the plugin source)

```bash
cd path/to/deskfox-plugins/claude-code
bun install
bun run build      # produces dist/index.js
bun run dev        # watch mode
```

After building, **restart DeskFox** (the sidecar imports dist at startup; no hot reload).

⚠️ After any source change, run `bun run build` and **commit the resulting `dist/index.js` together** — otherwise users will pull stale code.

For fork-specific changes / protocol compatibility / upstream-tracking strategy, see [`NOTES.md`](./NOTES.md).

## Credits

Forked from [unixfox/opencode-claude-code-plugin](https://github.com/unixfox/opencode-claude-code-plugin) (now archived). All compatibility / DeskFox-integration changes since the fork are documented in [`NOTES.md`](./NOTES.md).

## License

MIT (inherited from upstream).
