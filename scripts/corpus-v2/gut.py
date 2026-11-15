# Calibration corpus v2 provenance script (gut). Run with python3 -I from a scratch directory that has a raw/ subdirectory; see 07-CORPUS-V2.md. Live pages change, so a rerun will not reproduce the same excerpts.
import re,json,hashlib,urllib.request,datetime,concurrent.futures as cf
UA='Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0'
IDS={408:('nonfiction',1903),3076:('nonfiction',1919),5001:('nonfiction',1920),7213:('nonfiction',1922),2397:('nonfiction',1903),2044:('nonfiction',1907),470:('nonfiction',1905),130:('nonfiction',1908),1325:('nonfiction',1910),6456:('nonfiction',1922),852:('nonfiction',1916),5827:('nonfiction',1912),15776:('nonfiction',1919),14811:('nonfiction',1913),833:('nonfiction',1899),1717:('nonfiction',1910),498:('fiction',1912),
140:('fiction',1906),1156:('fiction',1922),64317:('fiction',1925),543:('fiction',1920),242:('fiction',1918),416:('fiction',1919),217:('fiction',1913),289:('fiction',1908),45:('fiction',1908),2814:('fiction',1914),113:('fiction',1911),863:('fiction',1920),16:('fiction',1911),1056:('fiction',1909),24:('fiction',1913),541:('fiction',1920),805:('fiction',1920),233:('fiction',1900),2781:('fiction',1902),974:('fiction',1907),2946:('fiction',1910),2641:('fiction',1908),351:('fiction',1915),1300:('fiction',1912),15408:('fiction',1909)}
def get(i):
    for u in (f'https://www.gutenberg.org/cache/epub/{i}/pg{i}.txt',f'https://www.gutenberg.org/files/{i}/{i}-0.txt'):
        try: return u,urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':UA}),timeout=60).read().decode('utf8','replace')
        except Exception: pass
    return None,None
def one(i):
    u,t=get(i)
    if not t: return None
    title=re.search(r'Title:\s*(.+)',t); au=re.search(r'Author:\s*(.+)',t)
    a=t.find('*** START'); a=t.find('\n',a)+1; b=t.find('*** END')
    body=t[a:b].replace('\r','')
    ps=[re.sub(r'\s+',' ',p).strip() for p in re.split(r'\n\s*\n',body)]
    ok=[]
    for p in ps:
        w=len(p.split())
        if w<8 or p.isupper() or re.search(r'\[|\]|Illustration|CHAPTER|Chapter [IVXL0-9]|_{2}|\*\*|Gutenberg|Transcriber|Produced by',p): ok.append(None);continue
        ok.append(p)
    n=len(ok); lo,hi=int(n*.2),int(n*.8)
    s0=lo+int(hashlib.sha256(f'gut{i}'.encode()).hexdigest(),16)%(hi-lo)
    for k in range(60):
        s=lo+(s0-lo+k*37)%(hi-lo)
        acc=[];wc=0;idx=s
        while idx<n and wc<150:
            p=ok[idx]
            if p is None: break
            w=len(p.split())
            if wc+w>340: break
            acc.append(p);wc+=w;idx+=1
        if wc>=110: break
    if wc<110: return None
    return dict(id=i,url=f'https://www.gutenberg.org/ebooks/{i}',title=title.group(1).strip() if title else '',author=au.group(1).strip() if au else '',genre=IDS[i][0],year=IDS[i][1],text=' '.join(acc),words=wc,para_start=s,para_count=len(acc),retrieved=datetime.date.today().isoformat())
R=[]
for i in IDS:
    try:
        r=one(i)
    except Exception as e:
        print("ERR",i,e); continue
    if r: R.append(r)
    else: print("none",i)
json.dump(R,open('raw/gut.json','w'),indent=1)
for r in R: print(r['id'],r['year'],r['title'][:40],'|',r['author'][:25],r['words'],r['text'][:70])
