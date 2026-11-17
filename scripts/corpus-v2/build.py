# Calibration corpus v2 provenance script (build). Run with python3 -I from a scratch directory that has a raw/ subdirectory; see 07-CORPUS-V2.md. Live pages change, so a rerun will not reproduce the same excerpts.
import json,re,hashlib,os
ROOT='/home/bill/src/tools/dag/tests/fixtures/corpus'
H=lambda s:int(hashlib.sha256(s.encode()).hexdigest(),16)
man=json.load(open(f'{ROOT}/manifest.json'))
for e in man['files']:
    if 'set' not in e:
        e['set']='v1'
        if e['label']=='human': e['genre']='rfc' if 'rfc-editor' in e.get('url','') else 'literary-19c'
        else: e['genre']='mixed'
hs=json.load(open('raw/human_sel.json'))
LIC={'nasa':'US government work, public domain (17 U.S.C. 105); NASA pages may embed third-party material that is not covered',
 'nih':'US government work, public domain (17 U.S.C. 105)','nist':'US government work, public domain (17 U.S.C. 105)','fda':'US government work, public domain (17 U.S.C. 105)',
 'nsf':'US government work, public domain (17 U.S.C. 105)','noaa':'US government work, public domain (17 U.S.C. 105)','doe':'US government work, public domain (17 U.S.C. 105)',
 'whitehouse':'US government work, public domain (17 U.S.C. 105); transcript stage directions such as (Applause.) removed',
 'gutenberg':'public domain in the US (published before 1929; Project Gutenberg header/footer removed)'}
for sub in ('human','ai'):
    for f in os.listdir(f'{ROOT}/{sub}'):
        if f.startswith('v2-'): os.remove(f'{ROOT}/{sub}/{f}')
man['files']=[e for e in man['files'] if e['set']=='v1']
def slug(s): return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')[:36]
for i,r in enumerate(sorted(hs,key=lambda r:H('order'+r['url']+str(r.get('id',''))))):
    name=f"human/v2-{i+1:03d}-{r['site']}-{slug(r.get('title') or str(r.get('id')))}.txt"
    open(f'{ROOT}/{name}','w').write(r['text']+'\n')
    src=r['title'] if r['site']!='gutenberg' else f"{r['title']} ({r['author']}), {r['year']}"
    note='contiguous whole paragraphs from one page, no other edits (paragraph filter drops captions, credits and boilerplate)'
    if r['site']=='gutenberg': note=f"{r['para_count']} consecutive paragraphs starting at paragraph index {r['para_start']} of the body, line wraps joined; no other edits"
    if r['site']=='whitehouse': note+='; (Applause.) style stage directions removed'
    man['files'].append(dict(file=name,label='human',source=src,url=r['url'],license=LIC[r['site']],note=note,set='v2',genre=r['genre'],retrieved=r['retrieved'],era='1899-1925' if r['site']=='gutenberg' else ('2017' if r['site']=='whitehouse' else '2026')))
def smart(t):
    t=re.sub(r'(^|[\s(\[—])"',lambda m:m.group(1)+'“',t)
    t=t.replace('"','”')
    t=re.sub(r"(\w)'(\w)",lambda m:m.group(1)+'’'+m.group(2),t)
    t=re.sub(r"(\w)'(\s|$|[.,;])",lambda m:m.group(1)+'’'+m.group(2),t)
    return t
n=0
for k,f in enumerate(('ai1.txt','ai2.txt','ai3.txt')):
    for blk in re.split(r'^### ',open(f).read(),flags=re.M)[1:]:
        hdr,text=blk.split('\n',1); text=text.strip()
        genre,reg,prompt=[x.strip() for x in hdr.split('|',2)]
        n+=1
        typo='as written'
        if k==0 and H('smart'+str(n))%2==0 and '"' in text:
            text=smart(text); typo='smart quotes applied by script'
        name=f"ai/v2-{n:03d}-{genre}-{reg}.txt"
        open(f'{ROOT}/{name}','w').write(text+'\n')
        man['files'].append(dict(file=name,label='ai',source='Claude (Sonnet 5.5), written in the Phase 7 calibration-v2 session; same model as the v1 AI samples',prompt=prompt,license='original text written for this repository; no third-party material',note=f'register: {reg}; typography: {typo}; written before any v2 scoring was run',set='v2',genre=genre,register=reg))
man['description']='Labeled calibration corpus for the AI-likeness scorer. set v1 = original 73 files (Phase 7); set v2 = genre-matched additions (calibration v2). One entry per file; scripts/calibrate.ts and tests/unit/scoring/corpus.test.ts reject a file without an entry and an entry without a file.'
json.dump(man,open(f'{ROOT}/manifest.json','w'),indent=2,ensure_ascii=False); open(f'{ROOT}/manifest.json','a').write('\n')
print(n,len(man['files']))
