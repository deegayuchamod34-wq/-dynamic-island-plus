#!/usr/bin/env python3
"""Bounded, fail-open lifecycle client. Only explicit permission replies reach stdout."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--event', required=True)
    ap.add_argument('--agent', choices=['Codex','ChatGPT Work','Work / Codex'], default='Work / Codex')
    ap.add_argument('--timeout', type=int, default=120)
    args=ap.parse_args()
    try:
        raw=sys.stdin.buffer.read(262145)
        if len(raw)>262144: return
        payload=json.loads(raw or b'{}')
        if not isinstance(payload,dict): return
        # Keep protocol data small and exclude prompt/response bodies.
        payload={k:v for k,v in payload.items() if k in ('session_id','thread_id','agent_id','agent_type','tool_name','tool_input','source','trigger','model')}
        root=Path(os.environ.get('XDG_RUNTIME_DIR',f'/run/user/{os.getuid()}'))/'dynamic-island-plus-v2'
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as conn:
            conn.settimeout(0.5); conn.connect(str(root/'bridge.sock'))
            conn.sendall(json.dumps({'event':args.event,'agent':args.agent,'payload':payload,'timeout':args.timeout}).encode()+b'\n')
            conn.settimeout(max(1,min(120,args.timeout))+4 if args.event=='PermissionRequest' else 3)
            buf=bytearray()
            while len(buf)<65536:
                part=conn.recv(4096)
                if not part: break
                buf.extend(part)
                if b'\n' in part: break
            out=json.loads(buf).get('output',{})
            if args.event=='PermissionRequest' and out.get('hookSpecificOutput',{}).get('decision',{}).get('behavior') in ('allow','deny'):
                print(json.dumps(out))
    except (OSError,ValueError,TypeError): pass
if __name__=='__main__': main()
