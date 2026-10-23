#!/usr/bin/env python3
"""Install/remove owned files with backups. Does not enable or trust plugin hooks."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

UUID='dynamic-island-plus-v2@local'
SOURCE=Path(__file__).resolve().parent
HOME=Path.home()
LIB=HOME/'.local/lib/dynamic-island-plus-desktop'
EXT=HOME/'.local/share/gnome-shell/extensions'/UUID
UNIT=HOME/'.config/systemd/user/dynamic-island-plus-desktop.service'
RECORD=HOME/'.local/state/dynamic-island-plus-desktop/install.json'
HOOKS=Path(os.environ.get('CODEX_HOME',str(HOME/'.codex')))/'hooks.json'
MARKER='dynamic-island-plus-desktop-hook'

def run(*cmd):
    try: return subprocess.run(cmd,check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    except FileNotFoundError: return False

def load_hooks():
    data=json.loads(HOOKS.read_text()) if HOOKS.exists() else {'hooks':{}}
    if not isinstance(data,dict) or not isinstance(data.get('hooks',{}),dict): raise ValueError('Invalid hooks object; nothing changed')
    for groups in data.get('hooks',{}).values():
        if not isinstance(groups,list): raise ValueError('Invalid hook group; nothing changed')
        for g in groups:
            if not isinstance(g,dict) or not isinstance(g.get('hooks',[]),list): raise ValueError('Invalid hook handler; nothing changed')
    return data

def atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.dip-tmp')
    temp.write_text(json.dumps(data,indent=2)+'\n');temp.replace(path)

def edit_hooks(remove=False):
    data=load_hooks()
    if HOOKS.exists(): shutil.copy2(HOOKS,HOOKS.with_name('hooks.json.backup-dip-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')))
    hooks=data.setdefault('hooks',{})
    for event,groups in hooks.items():
        cleaned=[]
        for group in groups:
            group=dict(group)
            # Preserve unrelated handlers even if they shared an old island group.
            group['hooks']=[h for h in group.get('hooks',[]) if not (isinstance(h,dict) and (MARKER in str(h.get('command','')) or (not remove and 'dynamic-island-codex-hook' in str(h.get('command','')))))]
            if group['hooks']: cleaned.append(group)
        hooks[event]=cleaned
    if not remove:
        template=json.loads((SOURCE/'plugins/dynamic-island-plus/hooks/hooks.json').read_text())['hooks']
        script=LIB/'plugins/dynamic-island-plus/scripts/hook.py'
        for event,groups in template.items():
            handler=dict(groups[0]['hooks'][0])
            handler['command']=f'python3 {shlex.quote(str(script))} --agent Codex --event {event} # {MARKER}'
            hooks.setdefault(event,[]).append({'hooks':[handler]})
    atomic(HOOKS,data)

def install(with_codex=False):
    if with_codex: load_hooks() # Validate before any installation changes.
    if RECORD.exists(): raise SystemExit('Already installed. Run uninstall.sh before reinstalling; previous files will be restored.')
    for command in ('python3','systemctl','gnome-extensions','gnome-shell'):
        if not shutil.which(command): raise SystemExit(f'Missing dependency: {command}')
    version=subprocess.check_output(['gnome-shell','--version'],text=True).strip()
    if not any((' '+v+'.') in version or version.endswith(' '+v) for v in ('49','50')):
        raise SystemExit('This baseline supports GNOME Shell 49/50; found '+version)
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup=RECORD.parent/('backup-'+stamp)
    backup.mkdir(parents=True)
    records=[]
    def put(src,dest):
        rel=str(len(records))
        old=backup/rel
        if dest.exists():
            if dest.is_symlink(): raise ValueError(f'Refusing symlink destination: {dest}')
            shutil.copy2(dest,old)
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(src,dest)
        records.append({'path':str(dest),'backup':str(old) if old.exists() else None,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()})
        atomic(RECORD,{'files':records,'codex':with_codex,'backup':str(backup)})
    run('gnome-extensions','disable',UUID)
    for folder,target in [('extension',EXT),('bridge',LIB/'bridge'),('plugins',LIB/'plugins'),('.agents',LIB/'.agents')]:
        for f in (SOURCE/folder).rglob('*'):
            if f.is_file() and '__pycache__' not in f.parts: put(f,target/f.relative_to(SOURCE/folder))
    unit=backup/'new-unit'
    # systemd ExecStart uses its own quoting and specifier escaping.
    python=shutil.which('python3')
    def quote(s): return '"'+s.replace('\\','\\\\').replace('"','\\"').replace('%','%%')+'"'
    unit.write_text('[Unit]\nDescription=Dynamic Island Plus local desktop bridge\nAfter=graphical-session.target\nPartOf=graphical-session.target\n\n[Service]\nType=simple\nExecStart='+quote(python)+' '+quote(str(LIB/'bridge/server.py'))+'\nRestart=on-failure\nRestartSec=2\nUMask=0077\nNoNewPrivileges=yes\n\n[Install]\nWantedBy=default.target\n')
    put(unit,UNIT)
    if with_codex: edit_hooks()
    run('systemctl','--user','daemon-reload')
    active=run('systemctl','--user','enable','--now',UNIT.name)
    print('Installed. Bridge '+('started.' if active else 'could not start; inspect systemctl --user status '+UNIT.name))
    print('Log out/in, then: gnome-extensions enable '+UUID)
    print('Plugin marketplace: '+str(LIB))
    print('Add with: codex plugin marketplace add '+shlex.quote(str(LIB)))
    print('Restart desktop, install Dynamic Island Plus from that marketplace, then review and trust hooks in /hooks.')
    if with_codex: print('CLI hooks installed. Do not enable the plugin in the same runtime: it would emit duplicate events.')

def uninstall():
    if not RECORD.exists(): raise SystemExit('No installation record; no files changed.')
    data=json.loads(RECORD.read_text())
    if data.get('codex'): edit_hooks(remove=True)
    run('systemctl','--user','disable','--now',UNIT.name)
    run('gnome-extensions','disable',UUID)
    preserved=[]
    for row in reversed(data['files']):
        dest=Path(row['path'])
        if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest()!=row['sha256']:
            preserved.append(str(dest));continue
        if row['backup']:
            dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(row['backup'],dest)
        else: dest.unlink(missing_ok=True)
    run('systemctl','--user','daemon-reload')
    data['preserved_modified_files']=preserved
    atomic(RECORD.with_name('last-uninstall.json'),data)
    RECORD.unlink()
    print('Removed installed files and restored backups. Backups retained at '+data['backup'])
    if preserved: print('Preserved modified files:\n'+'\n'.join(preserved))
    print('Remove the plugin through the desktop Plugins Directory, and remove marketplace dynamic-island-local if registered. Log out/in, then enable your restored extension if desired.')

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('action',choices=['install','uninstall','codex-install','codex-uninstall']);ap.add_argument('--codex-hooks',action='store_true');args=ap.parse_args()
    if os.geteuid()==0: raise SystemExit('Run as your desktop user, without sudo.')
    if args.action=='install':install(args.codex_hooks)
    elif args.action=='uninstall':uninstall()
    elif args.action=='codex-install':
        if not (LIB/'bridge/server.py').exists():raise SystemExit('Run install.sh first.')
        edit_hooks()
        if RECORD.exists():
            record=json.loads(RECORD.read_text());record['codex']=True;atomic(RECORD,record)
        print('CLI hooks installed; restart Codex, review /hooks. Avoid enabling duplicate plugin hooks.')
    else:edit_hooks(remove=True)
