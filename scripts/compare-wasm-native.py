#!/usr/bin/env python3
"""Run stock native simpleFoam on a captured browser mesh and compare wall forces."""
import argparse,json,pathlib,re,shutil,subprocess,math

parser=argparse.ArgumentParser()
parser.add_argument('evidence',type=pathlib.Path)
parser.add_argument('--image',default='opencfd/openfoam-default@sha256:33fb575aa9980d2bc42fd58c75ae698c489293ba30c991380fe3f899c622f319')
args=parser.parse_args()
root=args.evidence.resolve();expected=json.loads((root/'verification.json').read_text())['result']
native=root/'native-case'
if not native.exists():shutil.copytree(root/'case',native)
control=native/'system/controlDict';text=control.read_text()
config=(native/'system/easycfdDict').read_text()
value=lambda key:re.search(r'\b'+key+r'\s+([^;]+);',config).group(1)
functions=f'''functions {{
coefficients {{type forceCoeffs; libs (forces); patches {value('patches')};
p p; U U; rho rhoInf; rhoInf {value('rho')}; CofR {value('origin')};
liftDir (0 0 1); dragDir (1 0 0); pitchAxis (0 1 0); magUInf {value('speed')};
lRef {expected['length']}; Aref {value('area')}; writeControl timeStep; writeInterval 1; log true;}}
forcesTotal {{type forces; libs (forces); patches {value('patches')};
p p; U U; rho rhoInf; rhoInf {value('rho')}; CofR {value('origin')}; writeControl timeStep; writeInterval 1; log false;}}
}}'''
text=re.sub(r'functions\s*\{\s*\}',functions,text).replace('application browserFoam;','application simpleFoam;')
control.write_text(text)
with (root/'native-solver.log').open('w') as log:
 subprocess.run(['docker','run','--rm','--cpus=4','--memory=4g','-v',f'{native}:/case',args.image,'bash','-lc','simpleFoam -case /case'],stdout=log,stderr=subprocess.STDOUT,check=True)
files=list((native/'postProcessing/coefficients').glob('*/coefficient.dat'))
if not files:raise RuntimeError('Native OpenFOAM did not write coefficients.')
lines=[line for line in files[0].read_text().splitlines() if line and not line.startswith('#')]
header=[line for line in files[0].read_text().splitlines() if line.startswith('# Time')][-1].lstrip('#').split()
rows=[[float(v) for v in line.split()] for line in lines];last=rows[-expected['openfoam']['averagingIterations']:]
mean=lambda key:sum(row[header.index(key)] for row in last)/len(last)
cd,cl=mean('Cd'),mean('Cl')
report={'nativeImage':args.image,'nativeVersion':'v2512','browserVersion':'v2512','sameMesh':True,'nativeSolver':'stock simpleFoam',
 'browser':{'cd':expected['cd'],'cl':expected['cl']},'native':{'cd':cd,'cl':cl},
 'difference':{'cd':abs(cd-expected['cd']),'cl':abs(cl-expected['cl'])},
 'tolerance':0.0001,'passed':abs(cd-expected['cd'])<.0001 and abs(cl-expected['cl'])<.0001}
(root/'native-parity.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if not report['passed']:raise SystemExit('Native numerical parity check failed.')
