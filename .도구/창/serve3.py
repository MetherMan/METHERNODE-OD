"""세계판 창(Claude 앱 브라우저에서 Obsidian 없이 세계판 쓰기)용 작은 서버. 127.0.0.1 전용.
- 읽기: /vault/... = 보관소, /out/... = 이 폴더의 out/, /list = 세계판이 쓰는 파일 목록 (지역·인물 노트 포함)
- 쓰기(POST /save?name=경로): 늘 out/ 에 쓰고, 세계판 데이터만 보관소에도 그대로 씀
  (The Archive - 자료 바로 아래의 .지형.json · .영역.json · 지도 .jpg, 세계판 설정 data.json,
   The Main - 지리 · The Main - 인물 · The Rule - TRPG/기록 아래의 .md. 원본 그림은 보호)
실행: python serve3.py "<보관소>" "<이 폴더>" 8732
"""
import os, sys, json, http.server, urllib.parse
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
    return name.endswith(('.지형.json', '.영역.json', '.jpg'))


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

    def do_POST(self):
        q = urllib.parse.urlparse(self.path)
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
