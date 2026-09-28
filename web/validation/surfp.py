# Centreline surface pressure (top / bottom) of the sample car from a slices JSON.
import json, sys, numpy as np
d=json.load(open(sys.argv[1] if len(sys.argv)>1 else 'validation/results/slices/sample-planes.json'))
pl=[p for p in d['planes'] if p['axis']=='y' and abs(p['at'])<1e-6][0]
W,H=pl['width'],pl['height']; P=np.array(pl['fields']['p'],float).reshape(H,W)*1.225; S=np.array(pl['fields']['solid']).reshape(H,W)
xs=np.array(pl['colCoord'])
top=[];bot=[]
for c in range(W):
    col=S[:,c]
    if col.any():
        ks=np.where(col==1)[0]; kb, kt = ks.min(), ks.max()
        if kb>0 and np.isfinite(P[kb-1,c]): bot.append((xs[c],P[kb-1,c]))
        if kt<H-1 and np.isfinite(P[kt+1,c]): top.append((xs[c],P[kt+1,c]))
for name,arr in (('top',top),('bottom',bot)):
    arr=np.array(arr); bins=np.linspace(-2.1,2.1,22); idx=np.digitize(arr[:,0],bins)
    print(name,' '.join(f"{bins[i-1]:.1f}:{arr[idx==i,1].mean():.0f}" for i in range(1,len(bins)) if (idx==i).any()))
print('cd',round(d['cd'],4),'cl',round(d['cl'],4), {k:[round(x) for x in v] for k,v in d['breakdown'].items()})
