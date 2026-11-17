# Calibration corpus v2 provenance script (select). Run with python3 -I from a scratch directory that has a raw/ subdirectory; see 07-CORPUS-V2.md. Live pages change, so a rerun will not reproduce the same excerpts.
import json,re,hashlib,os
H=lambda s:int(hashlib.sha256(s.encode()).hexdigest(),16)
gov=json.load(open('raw/cands.json')); gut=json.load(open('raw/gut.json'))
def english(t): return len(re.findall(r'\b(the|and|of|to)\b',t))>=8
def clean(t):
    t=re.sub(r'\s*\((?:Applause|Laughter|Audience[^)]*|Inaudible)[^)]*\.?\)\.?\s*',' ',t,flags=re.I)
    t=re.sub(r'\s+',' ',t).strip()
    return t
Q={'nasa':20,'nih':16,'nist':12,'fda':7,'nsf':4,'noaa':5,'doe':1,'whitehouse':7}
out=[]
for site,q in Q.items():
    c=[r for r in gov if r['site']==site and english(r['text']) and '/es/' not in r['url']]
    c.sort(key=lambda r:H('sel'+r['url']))
    for r in c[:q]:
        t=clean(r['text']); r=dict(r,text=t,words=len(t.split())); r['genre']={'nasa':'science-news','nih':'health-science','nist':'technical-policy','fda':'regulatory','nsf':'science-news','noaa':'science-news','doe':'technical-policy','whitehouse':'speech'}[site]
        out.append(r)
nf=sorted([g for g in gut if g['genre']=='nonfiction'],key=lambda r:H('s'+str(r['id'])))
fi=sorted([g for g in gut if g['genre']=='fiction'],key=lambda r:H('s'+str(r['id'])))
sel=nf[:16]+fi[:30-len(nf[:16])]
for g in sel: out.append(dict(g,site='gutenberg',genre='essay-nonfiction' if g['genre']=='nonfiction' else 'narrative-fiction'))
json.dump(out,open('raw/human_sel.json','w'),indent=1)
from collections import Counter
print(len(out),Counter(r['genre'] for r in out),sum(r['words'] for r in out)/len(out))
for r in out: print(r['site'],r['genre'],r['words'],(r.get('title') or '')[:70])
