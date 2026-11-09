#!/usr/bin/env python3
"""Install a persistent, loopback-only static host. No simulation service."""
from pathlib import Path
import plistlib, shutil, subprocess, os
root=Path(__file__).resolve().parent.parent
home=Path.home()
dest=home/'Library/Application Support/EasyCFD-vvflow'
dest.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'web/dist',dest/'web',dirs_exist_ok=True)
shutil.copy2(root/'scripts/serve-vvflow.mjs',dest/'serve.mjs')
label='local.easycfd.vvflow-preview'
plist=home/'Library/LaunchAgents'/f'{label}.plist'
plist.parent.mkdir(parents=True,exist_ok=True)
node=shutil.which('node')
if not node: raise RuntimeError('Node is required for the static file host')
config={'Label':label,'ProgramArguments':[node,str(dest/'serve.mjs'),str(dest/'web'),'5218'],'RunAtLoad':True,'KeepAlive':True,'StandardOutPath':str(dest/'stdout.log'),'StandardErrorPath':str(dest/'stderr.log'),'WorkingDirectory':str(dest)}
plist.write_bytes(plistlib.dumps(config))
service=f'gui/{os.getuid()}/{label}'
loaded=subprocess.run(['launchctl','print',service],capture_output=True).returncode == 0
if loaded:
    subprocess.run(['launchctl','kickstart','-k',service],check=True)
else:
    subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(plist)],check=True)
subprocess.run(['tailscale','serve','--bg','--https=8458','http://127.0.0.1:5218'],check=True)
print(dest)
