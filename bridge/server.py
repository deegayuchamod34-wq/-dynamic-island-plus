#!/usr/bin/env python3
"""Private Unix IPC broker. No TCP listener, external dependencies or command execution API."""
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time

MAX = 262144
ROOT = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'dynamic-island-plus-v2'
EVENTS = {'SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','SubagentStart','SubagentStop','Stop','Interrupt','SessionEnd','PreCompact','PostCompact'}

def read_line(conn):
    data = bytearray()
    while len(data) <= MAX:
        chunk = conn.recv(min(8192, MAX + 1 - len(data)))
        if not chunk: raise ValueError('Incomplete frame')
        data.extend(chunk)
        if b'\n' in chunk:
            frame = bytes(data).split(b'\n', 1)[0]
            if len(frame) > MAX: raise ValueError('Frame too large')
            return json.loads(frame)
    raise ValueError('Frame too large')

def handle(conn):
    with conn:
        conn.settimeout(3)
        try:
            _, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid(): return
            req = read_line(conn)
            if not isinstance(req, dict): raise ValueError('Object required')
            event = req.get('event')
            if event not in EVENTS: raise ValueError('Unsupported event')
            payload = req.get('payload')
            if not isinstance(payload, dict): raise ValueError('Payload object required')
            agent = req.get('agent', 'Work / Codex')
            if agent not in ('Work / Codex', 'Codex', 'ChatGPT Work'): raise ValueError('Invalid agent')
            timeout = max(1, min(120, int(req.get('timeout', 120))))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('engine.py')), '--event', event, '--agent', agent, '--timeout', str(timeout)], input=json.dumps(payload), text=True, capture_output=True, timeout=timeout+3)
            out = json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else {}
            conn.sendall(json.dumps({'output':out}).encode()+b'\n')
        except (ValueError, OSError, subprocess.SubprocessError):
            try: conn.sendall(b'{"output":{}}\n')
            except OSError: pass

def main():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid != os.getuid(): raise SystemExit('Unsafe runtime directory')
    ROOT.chmod(0o700)
    # flock prevents a second broker from deleting the active socket.
    with (ROOT/'bridge.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise SystemExit('Bridge already running')
        path = ROOT/'bridge.sock'
        path.unlink(missing_ok=True)
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(str(path)); path.chmod(0o600); srv.listen(16); srv.settimeout(1)
        running = True
        def stop(*_):
            nonlocal running
            running = False
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
        import threading
        slots = threading.BoundedSemaphore(16)
        def worker(conn):
            try: handle(conn)
            finally: slots.release()
        def cleanup():
            # Use the same state lock as engine processes and legacy hooks.
            with (ROOT/'state.lock').open('a+') as state_lock:
                fcntl.flock(state_lock, fcntl.LOCK_EX)
                state_path = ROOT/'state.json'
                try: data = json.loads(state_path.read_text())
                except (ValueError, OSError): return
                rows = data.get('sessions', [])
                now = time.time()
                keep = [s for s in rows if now-float(s.get('updated', 0)) < (30 if s.get('status') in ('done','ended') else 1800)]
                if keep != rows:
                    data['sessions'] = keep
                    tmp = ROOT/'cleanup.tmp'; tmp.write_text(json.dumps(data)); tmp.replace(state_path)
            for response in (ROOT/'responses').glob('*.json'):
                try:
                    if time.time()-response.stat().st_mtime > 180: response.unlink()
                except FileNotFoundError: pass
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                while running:
                    try: conn, _ = srv.accept()
                    except socket.timeout:
                        cleanup(); continue
                    if slots.acquire(blocking=False): pool.submit(worker,conn)
                    else: conn.close()
        finally:
            srv.close(); path.unlink(missing_ok=True)
if __name__ == '__main__': main()
