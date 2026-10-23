# Dynamic Island Plus Desktop 3.0

Installable update for GNOME Shell 49/50, ChatGPT Work and Codex on the **same Linux desktop user session**. It preserves the global mascot extension and adds a private local lifecycle bridge. No API key, web service, third-party Python package, or TCP port is needed.

## Baseline and preserved features

The source is the latest global-mascot build available locally from the referenced Ubuntu multitasking conversation: `dynamic-island-plus-v2-global-mascot`, byte-identical to the installed extension before this update, plus its `dynamic-island-plus-v2-codex` add-on. The later `v2-complete.zip` linked in that conversation was not accessible; this package does not claim to reproduce that missing consolidation. See `docs/BASELINE.json` for original file hashes.

Existing UUID: `dynamic-island-plus-v2@local`. Existing media controls/MPRIS, system information, battery/charging, Bluetooth, network transitions, notification history, volume/brightness OSD, drag positioning, expandable pages, and animated global mascot remain in place. Upstream: https://github.com/shoyoshaurya/gnome-dynamic-island (MIT).

## Install

Requirements: GNOME Shell 49 or 50, Python 3.10+, systemd user services, `gnome-extensions`, and a local Work/Codex client supporting lifecycle hooks. Tested for syntax on the build host with GNOME 50.1; interactive GNOME behavior still needs a desktop smoke test.

Extract the ZIP, open a terminal in its `dynamic-island-plus-desktop` folder, and run **without sudo**:

```bash
bash install.sh
```

The installer backs up replaced files, copies the extension and bridge, and enables the user service. It leaves existing extension settings and other hooks intact. Check the service:

```bash
systemctl --user status dynamic-island-plus-desktop.service
```

On Wayland, log out and log in to reload the extension, then:

```bash
gnome-extensions enable dynamic-island-plus-v2@local
```

If another Dynamic Island extension is enabled, disable it to avoid overlapping islands. Your current extension UUID is reused and backed up. This package has not been installed automatically on the build machine.

## Connect ChatGPT Work and Codex through the plugin

Register the installed package as a local marketplace:

```bash
codex plugin marketplace add "$HOME/.local/lib/dynamic-island-plus-desktop"
```

Restart the desktop app. In Plugins Directory, select **Dynamic Island Plus**, install its plugin, and enable it. Review and trust the hook definitions using the client's hooks interface (`/hooks` in Codex CLI). Changed definitions need trust again. Installing alone does not trust them.

If you do not have the Codex CLI marketplace command, use the personal marketplace procedure in the official plugin docs. Add this entry to the existing `plugins` array in `~/.agents/plugins/marketplace.json`, keeping its other entries. Create the catalog if absent with a top-level `name`, `interface.displayName`, and `plugins` array:

```json
{
  "name": "dynamic-island-plus",
  "source": {"source": "local", "path": "./.local/lib/dynamic-island-plus-desktop/plugins/dynamic-island-plus"},
  "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
  "category": "Productivity"
}
```

That personal catalog path is relative to your home marketplace root. Restart the app and select the catalog you edited. Do not replace an existing catalog wholesale.

The shared plugin displays **Work / Codex** because the common event schema does not provide a dependable product identifier. The optional CLI configuration below displays **Codex**. Local execution is required: web/cloud installation cannot reach your GNOME session socket.

## Optional direct Codex CLI hooks

Use this **instead of enabling the plugin in the same runtime**, to avoid duplicate events:

```bash
bash install.sh --codex-hooks
# Or, after a normal install:
bash codex/install-codex.sh
```

This merges hooks into `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`), backs it up, and migrates the previous `dynamic-island-codex-hook` handlers. Unrelated handlers are preserved, including handlers sharing the same event group. Malformed configuration stops the installation. Inline TOML hooks and hooks in other config layers are untouched; disable old Island hooks there if present. Restart Codex and review `/hooks`.

## Events and approval behavior

| Event | Island behavior |
|---|---|
| SessionStart / UserPromptSubmit | Connected / thinking |
| PreToolUse / PostToolUse | Tool activity / completed step |
| PermissionRequest | Existing Allow and Deny controls |
| SubagentStart / SubagentStop | Separate child cards |
| PreCompact / PostCompact | Context compaction / ready |
| Stop / Interrupt | Finished / interrupted |
| SessionEnd | Remove the session and its children |

Approval requests carry random IDs. Explicit island Allow/Deny clicks return the documented `PermissionRequest` response. After 120 seconds without a reply, or if the bridge is unavailable, the hook prints no decision and the normal app approval flow continues. Hooks do not run tools or issue approvals by themselves. The demo never executes its displayed command. The existing compact card truncates long details; for commands that need fuller review, let the native approval prompt handle the decision.

Ordinary Chat uses the existing desktop notification integration and observed ChatGPT/Codex window focus changes. A notification is shown as a notification; it is not proof that an assistant response finished. Ordinary Chat has no added thinking/tool lifecycle stream. Window identification uses the app name, so browser-hosted ChatGPT may not be identified as a ChatGPT window.

## Test and troubleshoot

```bash
python3 tests/test_integration.py
bash tests/demo.sh
# Run this separately and click Allow or Deny in the island:
bash tests/demo.sh permission
```

The automated suite starts its own bridge in a temporary runtime directory and tests both approval decisions by writing synthetic responses. It does not change the live installation or execute any tool command. The demo connects to the installed bridge and changes only demo cards.

```bash
journalctl --user -u dynamic-island-plus-desktop.service -n 50
systemctl --user restart dynamic-island-plus-desktop.service
gnome-extensions info dynamic-island-plus-v2@local
```

If nothing appears: check the service, extension enablement, local execution, plugin enablement, and hook trust. State lives at `$XDG_RUNTIME_DIR/dynamic-island-plus-v2/state.json`; the bridge socket is `bridge.sock` inside the same directory. Both sides fall back to `/run/user/UID` when XDG_RUNTIME_DIR is absent. Different users, remote machines, or containers with a different runtime directory cannot connect automatically.

## Uninstall and restore

First uninstall/disable the plugin in the desktop Plugins Directory. If registered through the CLI:

```bash
codex plugin marketplace remove dynamic-island-local
bash uninstall.sh
```

If you manually edited a personal marketplace, remove only the plugin entry you added. The uninstaller stops and disables the service, removes unchanged installed files, restores backed-up files, and preserves files modified since installation. It removes only this package's direct CLI hooks; older replaced Island hooks stay in the timestamped hook backup so they cannot accidentally resume beside the plugin. To restore them, review the backup before merging them back. Backups and the last uninstall report are retained under `~/.local/state/dynamic-island-plus-desktop/`. Re-enable the restored extension after logging out/in if desired. The installer does not remember the original service/extension enable state.

To remove only direct CLI hooks, use `bash codex/uninstall-codex.sh`. Reinstallation requires uninstalling the previous package first. Keep the extracted ZIP until uninstalling. Extension preferences/position files are retained.

## Privacy and architecture

```
Work / Codex lifecycle hook
  -> plugin client (JSON over private AF_UNIX socket)
  -> per-user bridge -> serialized atomic state file
  -> GNOME extension (400 ms poll, existing UI/mascot)
  -> response file with request ID -> waiting hook -> app decision
```

The socket directory is mode 0700; socket and state are 0600; Linux peer credentials are checked. Requests have a size limit, bounded timeouts and a maximum of 16 workers. Concurrent writers share a file lock. Finished cards expire after about 30 seconds; inactive cards after 30 minutes. Session keys separate product labels, sessions, and subagents. The bridge never evaluates payload text as code. Prompts and assistant response bodies are excluded; tool descriptions/arguments can appear in the local state. Any process running as your user can access this IPC, as with other same-user desktop integrations. The bridge is a local status component, not a security boundary between same-user processes.

## Verified documentation

Hook events, input/output shape and trust: https://learn.chatgpt.com/docs/hooks

Plugin manifests, local marketplaces and Work/Codex execution: https://developers.openai.com/plugins/build/plugins

These docs were checked on 2026-10-24. Hook-bearing plugins are for supported manual/local installs; hook support and UI can vary by client version. No public-directory publication is implied.
