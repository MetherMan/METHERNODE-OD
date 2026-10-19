"""지금 메러노더 지도(분석 결과)를 세계판 '지형 그리기' 데이터로 옮긴다.
출력: _자료/메러노더.지형.json  (ground: 땅1/바다0, cover: 숲1, regions: 각진 영역, 지도 1/2 크기 칸)
실행: python terrain_from_map.py world.npz regions.npz 출력.json
"""
import sys
import json
import numpy as np
from scipy import ndimage as ndi

NPZ, REG, OUT = sys.argv[1:4]
d = np.load(NPZ)
land = d['land'].astype(bool)          # 3000x2000 (지도 1/2)
W, H = int(d['W']), int(d['H'])
rg = np.load(REG)
fs = rg['forest_sea'].astype(bool)
rah = rg['rahania'].astype(bool)
A = int(rg['scale'])
h, w = land.shape

# 숲·바다 나눔 B (허리 아래 = 바다), 렌더러와 같은 곡선
yy, xx = np.mgrid[0:h, 0:w]
X, Y = xx * A, yy * A
ycut = (2256 + (X - 2412) * 0.12 - 30 * np.exp(-((X - 2485) / 38.0) ** 2)
        + 10 * np.sin(X / 23.0) + 6 * np.sin(X / 9.0 + 1.3))
sea_part = fs & (Y > ycut)
forest_part = fs & ~sea_part
fs_big = ndi.binary_dilation(fs, iterations=5)
inner_sea = ndi.binary_dilation(sea_part, iterations=5) & fs_big
ground = land & ~inner_sea
cover = ndi.binary_dilation(forest_part, iterations=5) & fs_big & ~ndi.binary_dilation(inner_sea, iterations=1) & ground


def rle(a):
    a = a.astype(np.uint8).ravel()
    change = np.flatnonzero(np.diff(a)) + 1
    starts = np.concatenate([[0], change])
    lens = np.diff(np.concatenate([starts, [a.size]]))
    out = []
    for s, n in zip(starts, lens):
        out += [int(a[s]), int(n)]
    return out


def trace(mask):
    """이진 마스크의 가장 큰 덩어리 바깥 둘레를 순서대로 (무어 이웃 따라가기)."""
    lab, n = ndi.label(mask)
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    m = lab == (np.argmax(sizes) + 1)
    m = np.pad(m, 1)
    ys, xs = np.nonzero(m)
    start = (ys[0], xs[0])
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    pts = [start]
    cur, back = start, 6  # 왼쪽에서 들어왔다고 친다
    for _ in range(200000):
        found = False
        for k in range(8):
            dd = (back + 1 + k) % 8
            ny, nx = cur[0] + dirs[dd][0], cur[1] + dirs[dd][1]
            if m[ny, nx]:
                back = (dd + 4) % 8
                cur = (ny, nx)
                found = True
                break
        if not found or cur == start:
            break
        pts.append(cur)
    return [(x - 1, y - 1) for y, x in pts]


def rdp(pts, eps):
    pts = np.asarray(pts, float)
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    ab = b - a
    L = np.hypot(*ab) or 1.0
    rel = pts - a
    dist = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / L
    i = int(np.argmax(dist))
    if dist[i] > eps:
        left = rdp(pts[:i + 1], eps)
        right = rdp(pts[i:], eps)
        return np.vstack([left[:-1], right])
    return np.vstack([a, b])


def closed_rdp(pts, eps):
    pts = np.asarray(pts, float)
    far = int(np.argmax(np.hypot(*(pts - pts[0]).T)))
    p1 = rdp(pts[:far + 1], eps)
    p2 = rdp(np.vstack([pts[far:], pts[:1]]), eps)
    return np.vstack([p1[:-1], p2[:-1]])


regions = []
# 라하니아: 손그림 둘레를 따라 각진 다각형 (지도 px)
rah_pts = closed_rdp(trace(ndi.binary_erosion(rah, iterations=2)), 1.6) * A + A / 2
regions.append({'name': '라하니아', 'pts': [[round(float(x), 1), round(float(y), 1)] for x, y in rah_pts]})

# 어브릴: 원본 7배 확대에서 딴 윤곽, 원본의 45% 크기, 밑변은 바로 아래 바다 해안에 닿게
TRACE = [(140, 430), (175, 340), (230, 270), (275, 255), (320, 290), (400, 380), (450, 398), (478, 366),
         (560, 366), (572, 440), (650, 440), (682, 330), (720, 225), (790, 205), (860, 225), (895, 290),
         (905, 420), (900, 540), (420, 540), (330, 452), (200, 445)]
ox = [2270 + x / 7 for x, _ in TRACE]; oy = [2180 + y / 7 for _, y in TRACE]
bx_c = (min(ox) + max(ox)) / 2
tops = []
for c in range(int(bx_c - 30) // A, int(bx_c + 30) // A):
    col = ~ground[2150 // A:2400 // A, c]
    if col.any():
        tops.append((np.argmax(col) + 2150 // A) * A)
base_y = (float(np.median(tops)) + 3) if tops else 2257.0
S = 0.45
abril = [[round(bx_c + (x - bx_c) * S, 1), round(base_y + (y - max(oy)) * S, 1)] for x, y in zip(ox, oy)]
regions.insert(0, {'name': '어브릴', 'pts': abril})

out = {
    'version': 1, 'w': w, 'h': h, 'scale': A, 'seed': 20261019,
    'coast': 1.0, 'isles': True, 'deco': True, 'underlay': '_자료/MN2.jpg', 'title': '메러노더', 'output': '_자료/메러노더.jpg',
    'ground': rle(ground), 'cover': rle(cover), 'regions': regions,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print('ground land%', round(ground.mean() * 100, 1), 'forest cells', int(cover.sum()),
      'rahania pts', len(rah_pts), 'abril base_y', base_y)
