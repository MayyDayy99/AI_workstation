#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A stúdió frontendjének (dub_server: frontend/static) mostani állapotát a statikus demóba viszi,
   a demó szabályaival: relatív útvonalak (GitHub Pages alútvonalon is), a mock motor az első scriptek
   között, service worker ki. A demó saját fájljai (mock_*.js, info_cards.js, sw.js, api/) érintetlenek.

   Használat:  python3 tools/sync_frontend.py <a dub_server repó>/frontend/static
   Utána: új vagy megváltozott API-hívás esetén a mock_routes_*.js-t is bővíteni kell (lásd README)."""
import pathlib, re, shutil, sys
if len(sys.argv) < 2 or not (pathlib.Path(sys.argv[1]) / 'index.html').exists():
    sys.exit('Használat: python3 tools/sync_frontend.py <dub_server>/frontend/static')
SRC = pathlib.Path(sys.argv[1])
DST = pathlib.Path(__file__).resolve().parent.parent
DEMO_ONLY = {'mock_core.js', 'mock_routes_core.js', 'mock_routes_batch.js', 'mock_routes_ppt.js', 'mock_routes_flow.js',
             'mock_routes_subtitle.js', 'mock_routes_misc.js', 'mock_routes_extra.js', 'info_cards.js', 'sw.js', 'README.md'}
SKIP = {'styleguide.html'}            # belső design-referencia, nem a termék része
MOCKS = ['mock_core.js', 'mock_routes_core.js', 'mock_routes_batch.js', 'mock_routes_ppt.js', 'mock_routes_flow.js',
         'mock_routes_subtitle.js', 'mock_routes_misc.js', 'mock_routes_extra.js']
PAGES = r'(?:index|login|dub|subtitle|subtitle_batch|transcribe|transcribe_batch|intro_outro|intro_outro_batch|ppt_replace|ppt_narrate|ppt_narrate_batch|course|flow|profile|admin|batch|scan|convert)\.html'

def rel(t):
    # API-hívások és oldal-hivatkozások: a gyökér-relatívból sima relatív
    t = re.sub(r"""(['"`(])/api([/'"`?])""", r"\1api\2", t)
    t = re.sub(r"""(['"`])/(%s)""" % PAGES, r"\1\2", t)
    t = re.sub(r"""(['"`])/(manifest\.json|sw\.js|icons/)""", r"\1\2", t)
    t = re.sub(r"""href=(['"])/\1""", r"href=\1index.html\1", t)
    t = re.sub(r'(http-equiv="refresh" content="\d+;\s*url=)/', r'\1', t)
    t = re.sub(r"""(location\.href\s*=\s*|location\.replace\(\s*|location\.assign\(\s*)(['"])/\2""", r"\1\2index.html\2", t)
    t = t.replace("pathname.endsWith(\"/login.html\")", "pathname.endsWith(\"login.html\")").replace("pathname.endsWith('/login.html')", "pathname.endsWith('login.html')")
    return t

def html(t, name):
    t = rel(t)
    tags = '\n'.join('<script src="%s"></script>' % m for m in MOCKS)
    if name == 'index.html':
        tags_after = '\n<script src="info_cards.js"></script>'
    else:
        tags_after = ''
    first = re.search(r'<script\b', t); assert first, name
    t = t[:first.start()] + tags + '\n' + t[first.start():]
    if tags_after:
        m = re.search(r'<script\b[^>]*\bsrc="shared\.js[^"]*"[^>]*></script>', t); assert m, name
        t = t[:m.end()] + tags_after + t[m.end():]
    # a service worker regisztrációja ki
    t, n = re.subn(r"if\s*\(\s*['\"]serviceWorker['\"]\s+in\s+navigator\s*\)", "if (false /* demo: SW off */)", t)
    return t, n

removed = []
for f in sorted(DST.glob('*')):
    if f.is_file() and f.suffix in ('.html', '.js', '.css', '.json') and f.name not in DEMO_ONLY and not (SRC / f.name).exists():
        removed.append(f.name); f.unlink()
report = []
for f in sorted(SRC.rglob('*')):
    if f.is_dir() or f.name in SKIP: continue
    r = f.relative_to(SRC); out = DST / r; out.parent.mkdir(parents=True, exist_ok=True)
    if f.name == 'sw.js': continue                      # a demó saját, önmagát leregisztráló sw.js-e marad
    if f.suffix in ('.html', '.js', '.css', '.json'):
        t = f.read_text(encoding='utf-8')
        if f.suffix == '.html':
            t, n = html(t, f.name); report.append('%s (SW-blokk: %d)' % (r, n))
        else:
            t = rel(t)
            if f.name == 'manifest.json': t = t.replace('"start_url": "/"', '"start_url": "./"')
        out.write_text(t, encoding='utf-8')
    else:
        shutil.copy2(f, out)
print('törölve (a dub_serverből is kikerült):', removed)
print('HTML:', ', '.join(report))
