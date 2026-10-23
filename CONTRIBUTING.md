# Contributing to Dynamic Island Plus

Bug reports, focused fixes, and feature suggestions are welcome. Search existing issues first and use the bug report or feature request template.

## Development

- GNOME Shell 49 or 50, Python 3.10+, systemd user services, and Node.js for JavaScript syntax checks.
- Keep the existing media, system, notification, and mascot features working.
- Preserve native approval fallback. Never approve a request merely because a hook or bridge failed.
- Do not store prompt text, assistant responses, credentials, or unnecessary tool arguments.
- Keep the bridge local, dependency-free, and compatible with the existing extension UUID.

Run `python3 tests/test_integration.py`. It uses a temporary runtime directory; Unix sockets must be permitted. Check shell scripts with `bash -n` and extension JavaScript with `node --input-type=module --check < extension/extension.js`.

For GNOME UI changes, also follow the desktop smoke test in [docs/VALIDATION.md](docs/VALIDATION.md). Describe what you tested and any hardware or client limitations. Automated tests do not replace interactive GNOME validation.

## Pull requests

Explain the problem, the resulting behavior, and relevant validation. Keep changes focused. Update installation or troubleshooting documentation when behavior changes. Preserve upstream MIT attribution. Contributions are provided under the repository's MIT license.

## Reports and privacy

Include GNOME Shell and client versions, steps to reproduce, expected/actual behavior, and only relevant redacted logs. Never post API keys, tokens, private prompts, or sensitive command arguments. For an issue that requires sharing private security details, first ask the maintainer for a private reporting channel without including exploit details or secrets in a public issue.
