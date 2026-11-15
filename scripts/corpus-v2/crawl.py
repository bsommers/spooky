# Calibration corpus v2 provenance script (crawl). Run with python3 -I from a scratch directory that has a raw/ subdirectory; see 07-CORPUS-V2.md. Live pages change, so a rerun will not reproduce the same excerpts.
import re,sys,json,html,hashlib,urllib.request,urllib.parse,datetime,time,concurrent.futures as cf
UA='Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0'
TODAY=datetime.date.today().isoformat()
def get(u):
    for i in range(2):
        try:
            return urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':UA}),timeout=30).read().decode('utf8','replace')
        except Exception as e: err=e
    return None
def feed_links(u):
    h=get(u) or ''
    return re.findall(r'<link>\s*(?:<!\[CDATA\[)?(https?://[^<\]\s]+)',h)[1:]
def page_links(u,pat):
    h=get(u) or ''
    return sorted(set(urllib.parse.urljoin(u,x) for x in re.findall(r'href="([^"#]+)"',h) if re.search(pat,urllib.parse.urljoin(u,x))))
BAD=re.compile(r'(credit:|image credit|photo credit|share|subscribe|follow|media contact|contact:|read more|related|©|copyright|click here|cookie|javascript|sign up|newsletter|for more information|visit |www\.|\.gov|@|press release|embargo|^\W*updated|last updated|view all|http|\bFAQ\b)',re.I)
def paras(h):
    h=re.sub(r'(?is)<(script|style|nav|header|footer|aside|form|figure|figcaption|noscript|button|select)\b.*?</\1>','',h)
    m=re.search(r'(?is)<(main|article)\b.*?</\1>',h)
    if m: h=m.group(0)
    out=[]
    for p in re.findall(r'(?is)<p\b[^>]*>(.*?)</p>',h):
        t=html.unescape(re.sub(r'(?s)<[^>]+>','',p)); t=re.sub(r'\s+',' ',t).strip()
        n=len(t.split())
        if n<18 or BAD.search(t): continue
        if t.count('|')>0: continue
        out.append(t)
    return out
def excerpt(ps,seed):
    if not ps: return None
    start=int(hashlib.sha256(seed.encode()).hexdigest(),16)%max(1,len(ps))
    for s in (start,0):
        acc=[];n=0
        for p in ps[s:]:
            w=len(p.split())
            if n+w>340 and n>=110: break
            if n+w>340: break
            acc.append(p);n+=w
            if n>=150: break
        if n>=110: return ' '.join(acc),n
    return None
def fetch(u):
    h=get(u)
    if not h: return None
    ps=paras(h)
    e=excerpt(ps,u)
    if not e: return None
    t=re.search(r'(?is)<title>(.*?)</title>',h)
    return dict(url=u,title=re.sub(r'\s+',' ',html.unescape(t.group(1))).strip() if t else '',text=e[0],words=e[1],retrieved=TODAY)
if __name__=='__main__':
    seeds={}
    L=[]
    for i in range(1,16): L+= [('nasa',x) for x in feed_links(f'https://www.nasa.gov/feed/?paged={i}')]
    for i in range(1,6): L+= [('nasa',x) for x in feed_links(f'https://science.nasa.gov/feed/?paged={i}')]
    L+=[('nih',x) for x in feed_links('https://www.nih.gov/news-releases/feed.xml')]
    for i in range(0,8): L+=[('nih',x) for x in page_links(f'https://www.nih.gov/news-events/news-releases?page={i}',r'/news-releases/[a-z0-9-]{25,}')]
    L+=[('nist',x) for x in feed_links('https://www.nist.gov/news-events/news/rss.xml')]
    L+=[('noaa',x) for x in feed_links('https://www.noaa.gov/rss.xml')]
    L+=[('doe',x) for x in feed_links('https://www.energy.gov/rss.xml')]
    L+=[('fda',x.replace('http://','https://')) for x in feed_links('https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml')]
    L+=[('nsf',x) for x in feed_links('https://www.nsf.gov/rss/rss_www_news.xml')]
    for i in range(0,12): L+=[('whitehouse',x) for x in page_links(f'https://obamawhitehouse.archives.gov/briefing-room/speeches-and-remarks?page={i}',r'/the-press-office/\d{4}/\d\d/\d\d/')]
    seen=set();L2=[]
    for s,u in L:
        if u not in seen: seen.add(u);L2.append((s,u))
    print('candidates',len(L2),file=sys.stderr)
    res=[]
    with cf.ThreadPoolExecutor(8) as ex:
        for (s,u),r in zip(L2,ex.map(lambda su:fetch(su[1]),L2)):
            if r: r['site']=s;res.append(r)
    json.dump(res,open('raw/cands.json','w'),indent=1)
    from collections import Counter
    print(Counter(r['site'] for r in res),file=sys.stderr)
