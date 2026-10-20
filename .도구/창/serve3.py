"""세계판 창(Claude 앱 브라우저에서 Obsidian 없이 세계판 쓰기)용 작은 서버. 127.0.0.1 전용.
- 읽기: /vault/... = 보관소, /out/... = 이 폴더의 out/, /list = 세계판이 쓰는 파일 목록 (지역·인물 노트 포함)
- 쓰기(POST /save?name=경로): 늘 out/ 에 쓰고, 세계판 데이터만 보관소에도 그대로 씀
  (The Archive - 자료 바로 아래의 .지형.json · .영역.json · 지도 .jpg, 세계판 설정 data.json,
   The Main - 지리 · The Main - 인물 · The Rule - TRPG/기록 아래의 .md, 판 스케치 .스케치.png. 원본 그림은 보호)
- Codex로 그리기(POST /codex?map=판이름&w=폭&h=높이&note=설명, 본문 = 스케치 PNG): 이 PC의 Codex 그림 생성으로
  스케치대로 지도를 그려 The Archive - 자료/<판이름> 후보 N.jpg 로 (판 크기에 맞춰) 저장하고 그 경로를 돌려줌
실행: python serve3.py "<보관소>" "<이 폴더>" 8732
"""
import os, sys, json, glob, time, subprocess, http.server, urllib.parse
VAULT, HARN, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])
OUT = os.path.join(HARN, 'out')
os.makedirs(OUT, exist_ok=True)
ARCH = 'The Archive - 자료/'
SETTINGS = '.obsidian/plugins/mn-sekaipan/data.json'
NOTES = ('The Main - 지리/', 'The Main - 인물/', 'The Rule - TRPG/기록/')
PROTECT = {'MN2.jpg', 'MN2 (번호판).jpg', '4간구.jpg', '4간구 (그림 v13).jpg', '4간구 (이름).jpg'}


def mirror_ok(raw):
    if raw == SETTINGS:
        return True
    if raw.startswith(NOTES) and raw.endswith('.md'):
        parts = raw.split('/')
        return chr(92) not in raw and all(x and x not in ('.', '..') and ':' not in x for x in parts)
    if not raw.startswith(ARCH):
        return False
    name = raw[len(ARCH):]
    if not name or '/' in name or '\\' in name or '..' in name or name in PROTECT:
        return False
    return name.endswith(('.지형.json', '.영역.json', '.jpg', '.스케치.png', '.마을.json'))


def codex_exe():
    env = os.environ.get('CODEX_EXE')
    if env and os.path.isfile(env):
        return env
    base = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'OpenAI', 'Codex', 'bin')
    found = sorted(glob.glob(os.path.join(base, '*', 'codex.exe')), key=os.path.getmtime)
    return found[-1] if found else None


CITY_STYLE = (
    'Top-down hand-drawn map for a fantasy world atlas, drawn like an antique engraved and hand-tinted map: '
    'aged cream parchment background (about #E9DEC4), fine warm brown ink linework (about #5C3E28), and a MUTED, FADED, '
    'low-saturation palette only (faded terracotta roofs, pale stone, faded sage green for parks and fields, muted teal-grey water), '
    'calm and cohesive with an old parchment world map. An advanced civilization powered by magic: orderly, refined and monumental; '
    'NOT science fiction (no neon, no skyscrapers, no spaceships) and NOT a medieval walled town (no castle walls, no church crosses). '
    'Orthographic view straight from above. Building blocks drawn as small ink-outlined masses, parks with tiny tree symbols, '
    'farmland outside the built-up area. Landscape 3:2. Absolutely no text, no letters, no labels, no legend, no compass rose, no frame border.'
)
SKETCH_GUIDE = (
    "The attached image is the author's rough layout sketch."
    ' Follow it closely: keep every element in the same position, size and shape. '
    'Color key of the sketch: blue = water (rivers, lakes, canals); green = parks, gardens and woods; tan/apricot = built-up city area with '
    'streets and building blocks; brown lines = main avenues and roads; red marks = major landmark complexes or plazas; plain parchment = open '
    'countryside and farmland. Do not copy the flat sketch colors; render everything in the detailed map style described.'
)


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = urllib.parse.unquote(urllib.parse.urlparse(path).path)
        if p.startswith('/vault/'):
            return os.path.join(VAULT, p[len('/vault/'):])
        if p.startswith('/out/'):
            return os.path.join(OUT, p[len('/out/'):])
        return os.path.join(HARN, p.lstrip('/'))

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == '/list':
            files = []
            arch = os.path.join(VAULT, ARCH)
            if os.path.isdir(arch):
                files += [ARCH + n for n in os.listdir(arch) if os.path.isfile(os.path.join(arch, n))]
            if os.path.isfile(os.path.join(VAULT, SETTINGS)):
                files.append(SETTINGS)
            for top in NOTES:
                base = os.path.join(VAULT, top)
                for d, _, names in os.walk(base):
                    rel = os.path.relpath(d, VAULT).replace(os.sep, '/')
                    files += [rel + '/' + n for n in names if n.endswith('.md')]
            body = json.dumps(files, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def reply_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(body)

    def do_codex(self, q):
        qs = urllib.parse.parse_qs(q.query)
        name = qs.get('map', [''])[0].strip()
        note = qs.get('note', [''])[0][:600]
        try:
            W = max(256, min(8000, int(qs.get('w', ['6000'])[0])))
            H = max(256, min(8000, int(qs.get('h', ['4000'])[0])))
        except ValueError:
            W, H = 6000, 4000
        n = int(self.headers.get('Content-Length', 0))
        if not name or len(name) > 80 or any(c in name for c in '/:*?"<>|' + chr(92)) or '..' in name or n <= 0 or n > 30_000_000:
            return self.reply_json({'ok': False, 'error': '판 이름이나 스케치가 이상해요.'}, 400)
        sketch = self.rfile.read(n)
        exe = codex_exe()
        if not exe:
            return self.reply_json({'ok': False, 'error': '이 PC에서 Codex를 찾지 못했어요.'}, 500)
        work = os.path.join(OUT, 'codex_' + time.strftime('%Y%m%d_%H%M%S'))
        os.makedirs(work, exist_ok=True)
        sp = os.path.join(work, 'sketch.png')
        with open(sp, 'wb') as f:
            f.write(sketch)
        prompt = (
            'Use your image generation tool to create ONE image from this description, using the attached sketch as the layout, '
            'then copy the generated PNG file into the current working directory as result.png. Do nothing else.'
            + chr(10) * 2 +
            f'Description: {CITY_STYLE} {SKETCH_GUIDE}' + (f' Notes from the author: {note}' if note.strip() else '')
        )
        try:
            r = subprocess.run([exe, 'exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', work, '-i', sp, '-'],
                               input=prompt.encode('utf-8'), capture_output=True, timeout=600)
            with open(os.path.join(work, 'log.txt'), 'wb') as f:
                f.write(r.stdout + b'\n----\n' + r.stderr)
        except subprocess.TimeoutExpired:
            return self.reply_json({'ok': False, 'error': 'Codex가 10분 안에 끝내지 못했어요.'}, 500)
        res = os.path.join(work, 'result.png')
        if not os.path.isfile(res):
            return self.reply_json({'ok': False, 'error': 'Codex가 그림을 만들지 못했어요. 로그: ' + work}, 500)
        from PIL import Image
        k = 1
        while os.path.exists(os.path.join(VAULT, ARCH, f'{name} 후보 {k}.jpg')):
            k += 1
        rel = f'{ARCH}{name} 후보 {k}.jpg'
        Image.open(res).convert('RGB').resize((W, H), Image.LANCZOS).save(os.path.join(VAULT, *rel.split('/')), quality=90)
        return self.reply_json({'ok': True, 'path': rel})

    def do_POST(self):
        q = urllib.parse.urlparse(self.path)
        if q.path == '/codex':
            return self.do_codex(q)
        raw = urllib.parse.parse_qs(q.query).get('name', ['x.bin'])[0]
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n)
        with open(os.path.join(OUT, raw.replace('/', '__')), 'wb') as f:
            f.write(body)
        if mirror_ok(raw):
            dst = os.path.join(VAULT, *raw.split('/'))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + '.tmp'
            with open(tmp, 'wb') as f:
                f.write(body)
            os.replace(tmp, dst)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
