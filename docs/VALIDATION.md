# Validation — 2026-10-24

Result: **PASS**, eight automated tests in 4.182 seconds.

- Lifecycle states, compaction, interruption, session removal; prompt/response privacy.
- Eight simultaneous session updates without lost writes.
- Work label and independent subagent cards, including child cleanup on SessionEnd.
- Permission Allow and Deny responses, unique request files, response consumption, timeout fallback.
- Private directory/socket/state permissions and malformed IPC rejection.
- Second broker refuses to replace a live socket.
- Missing bridge exits successfully without an approval decision.
- Isolated installation, backup restoration, old-hook migration, idempotent hook merge and preservation of unrelated handlers.

Additional checks passed: Python AST/byte compilation, all JSON parse checks, `bash -n` for shell scripts, JavaScript module syntax with Node. GNOME Shell version on build host: 50.1.

Tests used a temporary runtime and mocked desktop service commands for installation; they did not install or enable the extension on the live desktop. Unix IPC tests ran outside the restricted execution environment because it prevented socket creation. No test executed a displayed tool command.

Not verified: full interactive GNOME Shell rendering/media/Bluetooth/OSD behavior, actual plugin installation/discovery in Work/Codex, hook trust UI, and live permission clicks. Those require a running desktop and client smoke test. Preserved baseline subsystems were retained in source; syntax checks cannot guarantee GNOME API runtime compatibility.

## Desktop smoke test after installation

1. Confirm service status, log out/in, enable extension, confirm idle mascot and dragging.
2. Play/pause media; check title and transport controls. Change volume/brightness.
3. Check notifications, battery/network state and Bluetooth state when hardware is available.
4. Install/enable plugin from local marketplace and review/trust hooks.
5. Start a local Work/Codex task; check thinking, tool, finished, interrupt and independent sessions.
6. Run `bash tests/demo.sh permission`, click Deny, repeat with Allow; no command is executed by this demo.
7. Run again without clicking; confirm no decision after timeout.
8. Disable plugin and run uninstall; inspect restoration report and re-enable restored extension if needed.
