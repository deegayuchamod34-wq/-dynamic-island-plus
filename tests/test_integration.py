#!/usr/bin/env python3
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

BASE=Path(__file__).resolve().parents[1]
CLIENT=BASE/'plugins/dynamic-island-plus/scripts/hook.py'

class IPC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='dip-')
        cls.env=dict(os.environ,XDG_RUNTIME_DIR=cls.temp.name)
        cls.root=Path(cls.temp.name)/'dynamic-island-plus-v2'
        cls.server=subprocess.Popen([sys.executable,str(BASE/'bridge/server.py')],env=cls.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for _ in range(100):
            if (cls.root/'bridge.sock').exists():break
            time.sleep(.02)
        else: raise RuntimeError('Bridge did not start')
    @classmethod
    def tearDownClass(cls):
        cls.server.terminate();cls.server.communicate(timeout=10);cls.temp.cleanup()
    def call(self,event,sid='test',agent='Codex',**kwargs):
        payload={'session_id':sid,**kwargs}
        return subprocess.run([sys.executable,str(CLIENT),'--agent',agent,'--event',event,'--timeout','1'],input=json.dumps(payload),text=True,capture_output=True,env=self.env,timeout=6)
    def state(self):return json.loads((self.root/'state.json').read_text())['sessions']
    def test_lifecycle(self):
        for e,status in [('SessionStart','working'),('UserPromptSubmit','thinking'),('PreToolUse','working'),('PostToolUse','working'),('PreCompact','thinking'),('PostCompact','thinking'),('Interrupt','done'),('Stop','done')]:
            r=self.call(e,'cycle',prompt='PRIVATE PROMPT',last_assistant_message='PRIVATE RESPONSE',tool_name='Bash',tool_input={'command':'echo hello'})
            self.assertEqual(r.returncode,0);self.assertEqual(r.stdout,'')
            row=next(s for s in self.state() if s['id']=='Codex:cycle');self.assertEqual(row['status'],status)
        self.assertNotIn('PRIVATE', (self.root/'state.json').read_text())
        self.call('SessionEnd','cycle');self.assertFalse(any(s['id']=='Codex:cycle' for s in self.state()))
    def test_concurrent(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda i:self.call('UserPromptSubmit',f'parallel-{i}'),range(8)))
        self.assertEqual(sum(s['id'].startswith('Codex:parallel-') for s in self.state()),8)
    def test_work_and_subagent(self):
        self.call('SessionStart','work','ChatGPT Work')
        self.call('SubagentStart','work','ChatGPT Work',agent_id='a',agent_type='Research')
        self.assertTrue(any(s['agent']=='ChatGPT Work · Research' for s in self.state()))
        self.call('SessionEnd','work','ChatGPT Work')
        self.assertFalse(any(s['id'].startswith('ChatGPT Work:work') for s in self.state()))
    def test_permission(self):
        for decision in ('allow','deny'):
            proc=subprocess.Popen([sys.executable,str(CLIENT),'--agent','Codex','--event','PermissionRequest','--timeout','3'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=self.env)
            proc.stdin.write(json.dumps({'session_id':'approval','tool_name':'Bash','tool_input':{'command':'echo harmless-demo'}}));proc.stdin.close();proc.stdin=None
            pending=None
            for _ in range(100):
                try:pending=next((s.get('pending') for s in self.state() if s['id']=='Codex:approval'),None)
                except (ValueError,FileNotFoundError):pass
                if pending:break
                time.sleep(.02)
            self.assertIsNotNone(pending)
            target=self.root/'responses'/f"{pending['request_id']}.json"
            tmp=target.with_suffix('.tmp');tmp.write_text(json.dumps({'decision':decision}));tmp.replace(target)
            out,err=proc.communicate(timeout=5)
            self.assertEqual(json.loads(out)['hookSpecificOutput']['decision']['behavior'],decision)
            self.assertFalse(target.exists())
        r=self.call('PermissionRequest','timeout',tool_name='Bash')
        self.assertEqual(r.stdout,'');self.assertIsNone(next(s for s in self.state() if s['id']=='Codex:timeout')['pending'])
    def test_bad_frames_and_permissions(self):
        self.call('SessionStart','permissions')
        self.assertEqual((self.root.stat().st_mode&0o777),0o700)
        self.assertEqual(((self.root/'bridge.sock').stat().st_mode&0o777),0o600)
        self.assertEqual(((self.root/'state.json').stat().st_mode&0o777),0o600)
        for data in (b'[]\n',b'bad-json\n',b'{"event":"execute","payload":{}}\n'):
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
                s.settimeout(2);s.connect(str(self.root/'bridge.sock'));s.sendall(data)
                self.assertEqual(json.loads(s.recv(1024))['output'],{})
        self.assertIsNone(self.server.poll())
    def test_second_server(self):
        p=subprocess.run([sys.executable,str(BASE/'bridge/server.py')],env=self.env,capture_output=True,timeout=3)
        self.assertNotEqual(p.returncode,0);self.assertTrue((self.root/'bridge.sock').exists())
    def test_unavailable(self):
        with tempfile.TemporaryDirectory() as t:
            r=subprocess.run([sys.executable,str(CLIENT),'--event','PermissionRequest'],input='{}',text=True,capture_output=True,env=dict(self.env,XDG_RUNTIME_DIR=t),timeout=2)
            self.assertEqual(r.returncode,0);self.assertEqual(r.stdout,'')

class Install(unittest.TestCase):
    def test_install_uninstall_and_hook_merge(self):
        spec=importlib.util.spec_from_file_location('manage',BASE/'manage.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with tempfile.TemporaryDirectory(prefix='dip-home-') as t:
            home=Path(t)
            m.HOME=home;m.LIB=home/'.local/lib/dynamic-island-plus-desktop';m.EXT=home/'extension';m.UNIT=home/'systemd/dynamic-island-plus-desktop.service';m.RECORD=home/'state/install.json';m.HOOKS=home/'.codex/hooks.json'
            m.HOOKS.parent.mkdir(parents=True)
            unrelated={'type':'command','command':'echo preserve-me'}
            m.HOOKS.write_text(json.dumps({'custom':True,'hooks':{'Stop':[{'matcher':'','hooks':[unrelated,{'type':'command','command':'old/dynamic-island-codex-hook'}]}]}}))
            m.EXT.mkdir();(m.EXT/'extension.js').write_text('original extension')
            m.run=lambda *a:True
            original_which=m.shutil.which;original_output=m.subprocess.check_output
            m.shutil.which=lambda _: '/usr/bin/python3'
            m.subprocess.check_output=lambda *a,**k:'GNOME Shell 50.1'
            try:
                m.install(True)
                data=json.loads(m.HOOKS.read_text());self.assertTrue(data['custom']);self.assertIn(unrelated,data['hooks']['Stop'][0]['hooks'])
                self.assertNotIn('old/dynamic-island-codex-hook',m.HOOKS.read_text())
                m.edit_hooks();data=json.loads(m.HOOKS.read_text());self.assertEqual(sum(m.MARKER in h['command'] for g in data['hooks']['Stop'] for h in g['hooks']),1)
                m.uninstall()
                self.assertEqual((m.EXT/'extension.js').read_text(),'original extension')
                self.assertIn('preserve-me',m.HOOKS.read_text());self.assertNotIn(m.MARKER,m.HOOKS.read_text())
            finally:m.shutil.which=original_which;m.subprocess.check_output=original_output

if __name__=='__main__':unittest.main(verbosity=2)
