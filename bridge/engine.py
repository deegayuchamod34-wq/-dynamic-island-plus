#!/usr/bin/env python3
import argparse, fcntl, json, os, pathlib, sys, time, uuid

os.umask(0o077)
RUNTIME = pathlib.Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}') / 'dynamic-island-plus-v2'
STATE = RUNTIME / 'state.json'
RESP = RUNTIME / 'responses'
LOCK = RUNTIME / 'state.lock'
RUNTIME.mkdir(parents=True, exist_ok=True)
RESP.mkdir(parents=True, exist_ok=True)


def read_stdin_json():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {'raw': raw[:4000]}


def load_state_locked(_lockf):
    try:
        obj = json.loads(STATE.read_text())
        if not isinstance(obj, dict):
            raise ValueError
        return obj
    except Exception:
        return {'sessions': []}


def save_state_locked(data):
    tmp = STATE.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    os.replace(tmp, STATE)


def update_session(session_id, mutator):
    with open(LOCK, 'a+') as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
        data = load_state_locked(lockf)
        sessions = data.setdefault('sessions', [])
        row = next((s for s in sessions if s.get('id') == session_id), None)
        if row is None:
            row = {
                'id': session_id,
                'agent': 'Codex',
                'status': 'working',
                'summary': '',
                'tool': '',
                'updated': time.time(),
                'pending': None,
            }
            sessions.insert(0, row)
        mutator(row)
        row['updated'] = time.time()
        now = time.time()
        # Keep recent sessions for 30 minutes, newest first.
        data['sessions'] = sorted(
            [s for s in sessions if now - float(s.get('updated', now)) < 1800],
            key=lambda s: float(s.get('updated', 0)),
            reverse=True,
        )[:12]
        save_state_locked(data)
        fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)


def remove_session(session_id):
    with open(LOCK, 'a+') as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
        data = load_state_locked(lockf)
        data['sessions'] = [s for s in data.get('sessions', []) if s.get('id') != session_id]
        save_state_locked(data)
        fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)


def summarize_tool(name, inp):
    name = name or 'Tool'
    if not isinstance(inp, dict):
        return name, ''
    description = None
    if description:
        return name, str(description).replace('\n', ' ').strip()[:180]
    for key in ('command', 'cmd', 'file_path', 'path', 'query', 'url', 'pattern'):
        value = inp.get(key)
        if value:
            text = str(value).replace('\n', ' ').strip()
            return name, text[:180]
    # MCP/local tools often use arbitrary arguments. Show one compact field if possible.
    for key, value in inp.items():
        if isinstance(value, (str, int, float, bool)):
            return name, f'{key}: {value}'[:180]
    return name, ''


def wait_response(request_id, timeout):
    p = RESP / f'{request_id}.json'
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if p.exists():
                data = json.loads(p.read_text())
                try:
                    p.unlink()
                except OSError:
                    pass
                return data if isinstance(data, dict) else None
        except Exception:
            pass
        time.sleep(0.12)
    return None


def clear_pending(session_id, request_id):
    def clear(row):
        if (row.get('pending') or {}).get('request_id') == request_id:
            row.update(pending=None, status='working', summary='Continuing…')
    update_session(session_id, clear)


def permission_output(decision):
    if decision == 'allow':
        return {
            'hookSpecificOutput': {
                'hookEventName': 'PermissionRequest',
                'decision': {'behavior': 'allow'},
            }
        }
    if decision == 'deny':
        return {
            'hookSpecificOutput': {
                'hookEventName': 'PermissionRequest',
                'decision': {
                    'behavior': 'deny',
                    'message': 'Denied from Dynamic Island Plus',
                },
            }
        }
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', default='Codex')
    ap.add_argument('--event', default='')
    ap.add_argument('--timeout', type=int, default=120)
    args = ap.parse_args()

    payload = read_stdin_json()
    event = args.event or payload.get('hook_event_name') or payload.get('event') or 'Event'
    sid_base = args.agent + ':' + str(payload.get('session_id') or payload.get('thread_id') or 'default')[:160]
    tool_name = payload.get('tool_name') or ''
    tool_input = payload.get('tool_input') or {}
    model = str(payload.get('model') or '')

    # Give subagents independent cards while still grouping them under the same Codex session.
    agent_id = payload.get('agent_id')
    if event in ('SubagentStart', 'SubagentStop') and agent_id:
        sid = f'{sid_base}:subagent:{agent_id}'
        agent_type = str(payload.get('agent_type') or 'Subagent')
        display_agent = f'{args.agent} · {agent_type}'
    else:
        sid = sid_base
        display_agent = args.agent

    def base(row):
        row['agent'] = display_agent
        row['pending'] = None
        if model:
            row['model'] = model

    if event == 'SessionStart':
        source = str(payload.get('source') or payload.get('trigger') or '')
        summary = 'Session started' + (f' · {source}' if source else '')
        update_session(sid, lambda s: (base(s), s.update({'status': 'working', 'summary': summary, 'tool': ''})))
        return 0

    if event == 'UserPromptSubmit':
        prompt = 'Thinking…' # Do not persist private prompt text
        text = str(prompt).replace('\n', ' ').strip()[:180]
        update_session(sid, lambda s: (base(s), s.update({'status': 'thinking', 'summary': text or 'Thinking…', 'tool': ''})))
        return 0

    if event == 'PreToolUse':
        tool, detail = summarize_tool(tool_name, tool_input)
        summary = detail or f'Using {tool}'
        update_session(sid, lambda s: (base(s), s.update({'status': 'working', 'summary': summary, 'tool': tool})))
        return 0

    if event == 'PostToolUse':
        tool, _detail = summarize_tool(tool_name, tool_input)
        update_session(sid, lambda s: (base(s), s.update({'status': 'working', 'summary': f'{tool} completed', 'tool': tool})))
        return 0

    if event == 'PermissionRequest':
        tool, detail = summarize_tool(tool_name, tool_input)
        req = uuid.uuid4().hex

        def setperm(s):
            base(s)
            s.update({
                'status': 'waiting',
                'summary': f'{tool} needs permission',
                'tool': tool,
                'pending': {
                    'kind': 'permission',
                    'request_id': req,
                    'tool': tool,
                    'detail': detail or tool,
                },
            })

        update_session(sid, setperm)
        reply = wait_response(req, args.timeout)
        clear_pending(sid, req)
        if reply:
            out = permission_output(reply.get('decision'))
            if out:
                print(json.dumps(out))
        # No reply => print nothing. Codex falls back to its native approval prompt.
        return 0

    if event == 'SubagentStart':
        typ = str(payload.get('agent_type') or 'Subagent')
        update_session(sid, lambda s: (base(s), s.update({'status': 'working', 'summary': f'{typ} started', 'tool': 'Subagent'})))
        return 0

    if event == 'SubagentStop':
        msg = '' # Do not persist response contents
        update_session(sid, lambda s: (base(s), s.update({'status': 'done', 'summary': msg or 'Subagent finished', 'tool': ''})))
        return 0

    if event in ('PreCompact', 'PostCompact'):
        update_session(sid, lambda s: (base(s), s.update({'status': 'thinking', 'summary': 'Compacting context' if event == 'PreCompact' else 'Context ready', 'tool': ''})))
        return 0

    if event == 'Stop':
        msg = '' # Do not persist response contents
        update_session(sid, lambda s: (base(s), s.update({'status': 'done', 'summary': msg or 'Finished', 'tool': ''})))
        return 0

    if event == 'Interrupt':
        update_session(sid, lambda s: (base(s), s.update({'status': 'done', 'summary': 'Interrupted', 'tool': ''})))
        return 0

    if event == 'SessionEnd':
        with open(LOCK, 'a+') as lockf:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
            data = load_state_locked(lockf)
            data['sessions'] = [s for s in data.get('sessions', []) if s.get('id') != sid and not s.get('id', '').startswith(sid + ':subagent:')]
            save_state_locked(data)
        return 0

    update_session(sid, lambda s: (base(s), s.update({'status': 'working', 'summary': event, 'tool': tool_name})))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
