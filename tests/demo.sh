#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT="$HERE/plugins/dynamic-island-plus/scripts/hook.py"
if [[ "${1:-}" == permission ]]; then
  printf '%s\n' '{"session_id":"island-demo","tool_name":"Bash","tool_input":{"command":"echo harmless-demo (display only; never executed)"}}' | python3 "$CLIENT" --event PermissionRequest --agent Codex
else
  for event in SessionStart UserPromptSubmit PreToolUse PostToolUse Stop; do
    printf '%s\n' '{"session_id":"island-demo","tool_name":"Demo tool"}' | python3 "$CLIENT" --event "$event" --agent Codex
    sleep 1
  done
fi
