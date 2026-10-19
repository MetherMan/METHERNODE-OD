"""메러노더 세계 지도 - 아트 디렉션 시안 (4간구 집 양식에 맞춘 숲·바다).
원본 mn_world_render.py 를 고친 사본. 바뀐 점은 보고서 참고.
실행: python render_v2.py world.npz regions.npz 바탕.jpg 이름판.jpg 축소본.jpg [잘라보기_접두사]
환경변수 MN_SPLIT = A (원래 나눔: 아래 둥근 자리 왼쪽+꼬리 = 바다) / B (기본: 허리 아래 전부 = 바다)
"""
import os
import sys
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy import ndimage as ndi

NPZ, REG, OUT_BASE, OUT_NAMED, OUT_PREVIEW = sys.argv[1:6]
CROP_PREFIX = sys.argv[6] if len(sys.argv) > 6 else None
SPLIT = os.environ.get('MN_SPLIT', 'B')
d = np.load(NPZ)
land_h = d['land']
W, H = int(d['W']), int(d['H'])
rg = np.load(REG)
fs_h = rg['forest_sea']; rah_h = rg['rahania']
A = int(rg['scale'])
rng = np.random.default_rng(20261019)
F32 = np.float32

# ---- 팔레트 (4간구 집 양식에서 뽑음) ----
INK = np.array([62, 47, 34], F32)            # 해안선 먹  #3e2f22
LAND = np.array([233, 223, 197], F32)        # 땅 종이   #e9dfc5
SEA_SHALLOW = np.array([184, 200, 190], F32)  # 연안      #b8c8be
SEA_MID = np.array([164, 184, 176], F32)      # 4간구 호수 #a4b8b0
SEA_DEEP = np.array([146, 168, 164], F32)     # 먼바다    #92a8a4
RIPPLE = np.array([86, 112, 114], F32)        # 물결선    #567072
FOREST_FILL = np.array([164, 158, 102], F32)  # 숲 바탕   #a49e66
FOREST_ARCH = (104, 84, 52)                   # 나무 머리 #685434
FOREST_LINE = np.array([88, 66, 44], F32)     # 숲 테두리 #58422c
REG_LINE = np.array([92, 52, 38], F32)        # 영역 바깥선 #5c3426
REG_BAND = np.array([212, 140, 122], F32)     # 영역 안띠  #d48c7a
REG_FILL = np.array([236, 200, 184], F32)     # 영역 속    #ecc8b8


def fractal(cells, power=0.8, seed=0):
    r = np.random.default_rng(seed)
    acc = np.zeros((H, W), F32)
    for c in cells:
        g = r.standard_normal((H // c + 3, W // c + 3)).astype(F32)
        up = Image.fromarray(g, mode='F').resize(((W // c + 3) * c, (H // c + 3) * c), Image.BICUBIC)
        ox, oy = r.integers(0, c), r.integers(0, c)
        acc += np.asarray(up, F32)[oy:oy + H, ox:ox + W] * (c ** power)
    acc -= acc.mean(); acc /= acc.std() + 1e-6
    return acc


def upmask(m, blur=4):
    u = Image.fromarray((m * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)
    return np.asarray(u.filter(ImageFilter.GaussianBlur(blur))) > 127


def blend(img, mask, color, alpha):
    a = (mask.astype(F32) * alpha)[..., None]
    return img * (1 - a) + np.asarray(color, F32) * a


def line_of(mask, width, soft=0.8):
    """마스크 경계 안쪽으로 width 굵기의 선 (0..1)."""
    dd = ndi.distance_transform_edt(mask).astype(F32)
    return np.clip(width + 0.5 - dd, 0, 1) * mask


def disk(r):
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


# 숲·바다 나누기 (원본 좌표)
yh, xh = np.mgrid[0:fs_h.shape[0], 0:fs_h.shape[1]]
X, Y = xh * A, yh * A
if SPLIT == 'A':
    sea_h = fs_h & (Y > 2265) & ~((X > 2425) & (Y < 2420))
else:
    # 허리(가장 좁은 곳, y≈2250) 아래 둥근 자리 + 꼬리 = 바다. 경계는 살짝 비스듬히
    # 자로 자른 듯한 직선이 되지 않게: 살짝 비스듬히 + 숲 쪽으로 파고든 작은 만 + 굽이
    ycut = (2256 + (X - 2412) * 0.12 - 30 * np.exp(-((X - 2485) / 38.0) ** 2)
            + 10 * np.sin(X / 23.0) + 6 * np.sin(X / 9.0 + 1.3))
    sea_h = fs_h & (Y > ycut)
del yh, xh, X, Y

# 1) 땅
land0 = upmask(land_h)
sdf = (ndi.distance_transform_edt(land0) - ndi.distance_transform_edt(~land0)).astype(F32)
n_coast = fractal([640, 320, 160, 80, 40, 20, 10, 5], power=0.75, seed=1)
land = (sdf + 34 * n_coast) > 0
# 1~3px 잔털 같은 톱니 제거 (모양은 그대로, 선만 깔끔하게)
land = ndi.gaussian_filter(land.astype(F32), 1.6) > 0.5
n_isle = fractal([90, 45, 22, 11], power=0.6, seed=2)
isles = (sdf < -20) & (sdf > -260) & (n_isle > 2.15 + (-sdf) / 160)
land |= isles
# 먼지 같은 점 섬 없애기: 300px 보다 작은 섬과 400px 보다 작은 웅덩이는 지운다
for target, lim in ((True, 300), (False, 400)):
    lab, n = ndi.label(land == target)
    if n:
        sz = ndi.sum(np.ones(lab.shape, np.int8), lab, np.arange(1, n + 1))
        land[np.isin(lab, np.where(sz < lim)[0] + 1)] = not target
del n_isle, isles, sdf

# 2) 안쪽 바다
fs_full = upmask(fs_h, 3)
sea_in = upmask(sea_h, 6)
forest_part = upmask(fs_h & ~sea_h, 4)
wx0, wy0, wx1, wy1 = 2150, 1600, 2950, 2700
fs_big = ndi.binary_dilation(fs_full[wy0:wy1, wx0:wx1], iterations=10)
# 바다는 손그림 둘레선 바깥 가장자리까지 꽉 (숲 띠가 바다를 두르지 않게)
sub = ndi.binary_dilation(sea_in[wy0:wy1, wx0:wx1], iterations=10) & fs_big
ssdf = ndi.distance_transform_edt(sub) - ndi.distance_transform_edt(~sub)
sub = ((ssdf + 8 * n_coast[wy0:wy1, wx0:wx1]) > 0) & fs_big
sea_in[:] = False
sea_in[wy0:wy1, wx0:wx1] = sub
land &= ~sea_in

# 3) 어브릴: 원본 손그림 윤곽을 그대로 딴 각진 선 (작가 지시 2026-10-19: 원본 모양 그대로, 절도 있게 각지게)
#    점은 원본 7배 확대(원점 2270,2180)에서 딴 것: 뾰족한 왼쪽 끝과 아래가 들린 왼쪽 봉우리,
#    가운데 네모 턱과 골, 키 큰 오른쪽 봉우리, 바다에 닿는 밑변.
TRACE = [(140, 430), (175, 340), (230, 270), (275, 255), (320, 290), (400, 380), (450, 398), (478, 366),
         (560, 366), (572, 440), (650, 440), (682, 330), (720, 225), (790, 205), (860, 225), (895, 290),
         (905, 420), (900, 540), (420, 540), (330, 452), (200, 445)]
ABRIL_SCALE = 0.45                       # 원본(약 109px)보다 훨씬 작게
ox = [2270 + x / 7 for x, _ in TRACE]; oy = [2180 + y / 7 for _, y in TRACE]
bx_c = (min(ox) + max(ox)) / 2           # 원본 가로 가운데
cols = np.arange(int(bx_c - 30), int(bx_c + 30))
# 밑변을 그 자리 안쪽 바다 해안에 맞춘다 (해안보다 2px 바다 쪽으로)
tops = [np.argmax(sea_in[2150:2400, c]) + 2150 for c in cols if sea_in[2150:2400, c].any()]
base_y = int(np.median(tops)) + 2 if tops else 2257
pts_full = [(bx_c + (x - bx_c) * ABRIL_SCALE, base_y + (y - max(oy)) * ABRIL_SCALE) for x, y in zip(ox, oy)]
PX0 = int(min(p[0] for p in pts_full)) - 4; PY0 = int(min(p[1] for p in pts_full)) - 4
PW = int(max(p[0] for p in pts_full)) - PX0 + 5; PH = int(max(p[1] for p in pts_full)) - PY0 + 5
SS = 8
loc = [((x - PX0) * SS, (y - PY0) * SS) for x, y in pts_full]
mcv = Image.new('L', (PW * SS, PH * SS), 0)
ImageDraw.Draw(mcv).polygon(loc, fill=255)
m_hi = np.asarray(mcv) > 127
stroke_hi = m_hi & ~ndi.binary_erosion(m_hi, iterations=int(2.2 * SS))   # 모서리가 뾰족하게 남는 안쪽 테
a_fill = np.asarray(Image.fromarray((m_hi * 255).astype(np.uint8)).resize((PW, PH), Image.BOX), F32) / 255
a_line = np.asarray(Image.fromarray((stroke_hi * 255).astype(np.uint8)).resize((PW, PH), Image.BOX), F32) / 255
abril_full = np.zeros((H, W), bool)
abril_full[PY0:PY0 + PH, PX0:PX0 + PW] = a_fill > 0.5
# 어브릴 둘레(밑변 위쪽)는 대륙 땅: 봉우리 사이 골로 바다가 파고들지 않게
land[PY0:int(base_y) - 1, PX0:PX0 + PW] = True
sea_in[PY0:int(base_y) - 1, PX0:PX0 + PW] = False
land |= abril_full
AX, AY = int(bx_c), int((PY0 + base_y) / 2)

# 4) 숲 모양: 손그림 둘레선 한가운데까지 채우고, 테두리를 4간구처럼 몽글몽글(나무 머리)하게
fwin = ndi.binary_dilation(forest_part[wy0:wy1, wx0:wx1], iterations=10) & fs_big & ~ndi.binary_dilation(sub, iterations=2) \
    & land[wy0:wy1, wx0:wx1] & ~ndi.binary_dilation(abril_full[wy0:wy1, wx0:wx1], iterations=6)
core = ndi.binary_erosion(fwin, structure=disk(9))
cb = core & ~ndi.binary_erosion(core)
by, bx = np.where(cb)
order = rng.permutation(len(by))
kept = []
grid = {}
SP = 14
for i in order:
    y, x = by[i], bx[i]
    gk = (y // SP, x // SP)
    ok = True
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for (py, px) in grid.get((gk[0] + dy, gk[1] + dx), ()):
                if (py - y) ** 2 + (px - x) ** 2 < SP * SP:
                    ok = False; break
            if not ok: break
        if not ok: break
    if ok:
        grid.setdefault(gk, []).append((y, x)); kept.append((y, x))
bumps = Image.new('L', (wx1 - wx0, wy1 - wy0), 0)
db = ImageDraw.Draw(bumps)
for (y, x) in kept:
    r = rng.uniform(9.0, 12.5)
    db.ellipse([x - r, y - r, x + r, y + r], fill=255)
scal = core | (np.asarray(bumps) > 127)
# 바다와 닿는 쪽은 해안선이 맡으므로 물가까지 꽉 채운다
near_sea = ndi.binary_dilation(sub, iterations=14)
scal = (scal | (fwin & near_sea)) & land[wy0:wy1, wx0:wx1]
forest = np.zeros((H, W), bool)
forest[wy0:wy1, wx0:wx1] = scal
del core, cb, bumps

# 5) 거리장
d_sea = ndi.distance_transform_edt(~land).astype(F32)
d_land = ndi.distance_transform_edt(land).astype(F32)
# 물결선은 큰 땅만 기준으로 (작은 섬 둘레의 과녁 무늬 방지) + 매끈하게
lab, n = ndi.label(land)
sz = ndi.sum(np.ones(lab.shape, np.int8), lab, np.arange(1, n + 1))
big = np.isin(lab, np.where(sz >= 4000)[0] + 1)
del lab
big_s = ndi.gaussian_filter(big.astype(F32), 5) > 0.5
d_big = ndi.distance_transform_edt(~big_s).astype(F32)
del big, big_s

# 6) 색
paper_lo = fractal([900, 450, 225], power=1.0, seed=3)
grain = ndi.gaussian_filter(rng.standard_normal((H, W)).astype(F32), 0.7)
grain /= grain.std()
inland = np.clip(d_land / 900, 0, 1)
land_col = (LAND[None, None, :]
            + (inland[..., None] * np.array([-6, -7, -9], F32))
            + (paper_lo[..., None] * 3.5))
# 바다: 구름 얼룩 없이 거리로만 얕음→깊음. 아주 낮은 주파수만 살짝
t1 = np.clip(d_sea / 70, 0, 1)[..., None]
t2 = np.clip((d_sea - 70) / 500, 0, 1)[..., None] ** 0.8
sea_col = SEA_SHALLOW * (1 - t1) + SEA_MID * t1
sea_col = sea_col * (1 - t2) + SEA_DEEP * t2 + paper_lo[..., None] * 1.5
img = np.where(land[..., None], land_col, sea_col).astype(F32)
del land_col, sea_col, inland, t1, t2

# 물결선 두 줄 (해안에서 13px, 30px). 가늘고 옅게
for dist, alpha, wdt in ((13, 0.42, 1.1), (30, 0.20, 0.9)):
    band = np.clip(wdt + 0.3 - np.abs(d_big - dist), 0, 1) * (~land) * (d_sea > dist * 0.6)
    img = img * (1 - band[..., None] * alpha) + RIPPLE * (band[..., None] * alpha)
del d_big

# 먼바다 물결 표시 (4간구 호수의 작은 호 모양) - 드문드문
wave = Image.new('RGBA', (W, H), (0, 0, 0, 0))
dw = ImageDraw.Draw(wave)
G = 190
for gy in range(G // 2, H, G):
    for gx in range(G // 2, W, G):
        x = gx + rng.uniform(-G * 0.4, G * 0.4); y = gy + rng.uniform(-G * 0.4, G * 0.4)
        ix, iy = int(x), int(y)
        if not (0 <= ix < W and 0 <= iy < H) or d_sea[iy, ix] < 110 or rng.random() > 0.55:
            continue
        r = rng.uniform(10, 13)
        for k in (0,):  # 홑 호 하나 (짝 호는 갈매기처럼 보임)
            cx = x + k * r * 1.05
            dw.arc([cx - r, y - r * 0.75, cx + r, y + r * 0.75], 200, 340, fill=(80, 108, 112, 150), width=2)
wave = np.asarray(wave, F32) / 255
img = img * (1 - wave[..., 3:4]) + wave[..., :3] * 255 * wave[..., 3:4]
del wave

# 6-1) 숲: 바탕 + 열린 반원 나무 머리(4간구) + 몽글 테두리
fn = fractal([300, 150, 75], power=1.0, seed=7)
img[forest] = FOREST_FILL + fn[forest][:, None] * np.array([3, 3, 2], F32)
fwin2 = forest[wy0:wy1, wx0:wx1]
inner = ndi.binary_erosion(fwin2, structure=disk(6))
S2 = 3
trees = Image.new('RGBA', ((wx1 - wx0) * S2, (wy1 - wy0) * S2), (0, 0, 0, 0))
dt = ImageDraw.Draw(trees)
dens = fn[wy0:wy1, wx0:wx1]
RY, RX = 15, 21
row = 0
for ty in range(0, wy1 - wy0, RY):
    off = (RX / 2) if row % 2 else 0
    row += 1
    for tx in np.arange(off, wx1 - wx0, RX):
        jx = tx + rng.uniform(-5, 5); jy = ty + rng.uniform(-3, 3)
        ix, iy = int(jx), int(jy)
        if not (0 <= iy < inner.shape[0] and 0 <= ix < inner.shape[1] and inner[iy, ix]):
            continue
        # 성기게 비는 곳: 낮은 주파수 잡음으로 빈자리 15~35%
        if rng.random() < 0.16 + 0.22 * np.clip(dens[iy, ix], 0, 1.2):
            continue
        r = rng.uniform(6.5, 9.5)
        cx, cy = jx * S2, jy * S2
        rr = r * S2
        a0 = rng.uniform(182, 200); a1 = rng.uniform(340, 358)
        dt.arc([cx - rr, cy - rr, cx + rr, cy + rr], a0, a1, fill=FOREST_ARCH + (215,), width=int(2.0 * S2))
trees = np.asarray(trees.resize((wx1 - wx0, wy1 - wy0), Image.LANCZOS), F32) / 255
ta = trees[..., 3:4]
img[wy0:wy1, wx0:wx1] = img[wy0:wy1, wx0:wx1] * (1 - ta) + trees[..., :3] * 255 * ta
del trees, ta
# 숲 테두리 (땅 쪽만; 물가는 해안선이 그림)
fl = ndi.gaussian_filter(line_of(fwin2, 3.0), 0.6) * ~ndi.binary_dilation(sub, iterations=5)
img[wy0:wy1, wx0:wx1] = img[wy0:wy1, wx0:wx1] * (1 - fl[..., None] * 0.92) + FOREST_LINE * (fl[..., None] * 0.92)
del fl

# 6-2) 라하니아: 4간구 영역 양식 (바깥 먹선 + 안쪽 색띠 + 옅은 속)
rah_full = upmask(ndi.binary_erosion(rah_h, iterations=4), 5) & land
rd = ndi.distance_transform_edt(rah_full).astype(F32)
img = blend(img, rah_full, REG_FILL, 0.38)
band = np.clip((16 - rd) / 12, 0, 1) * rah_full
img = img * (1 - band[..., None] * 0.55) + REG_BAND * (band[..., None] * 0.55)
rl = ndi.gaussian_filter(np.clip(3.2 - rd, 0, 1) * rah_full, 0.6)
img = img * (1 - rl[..., None] * 0.9) + REG_LINE * (rl[..., None] * 0.9)
del rd, band, rl

# 7) 해안선 먹
coast = ndi.gaussian_filter(np.clip(3.4 - d_land, 0, 1) * land, 0.6)
img = img * (1 - coast[..., None] * 0.92) + INK * (coast[..., None] * 0.92)
del coast, d_land

# 어브릴: 4간구 영역 양식 (옅은 붉은 속 + 뾰족한 모서리의 먹 테두리)
sl = (slice(PY0, PY0 + PH), slice(PX0, PX0 + PW))
fa = a_fill[..., None]; la = a_line[..., None]
img[sl] = img[sl] * (1 - fa) + (REG_FILL * 0.6 + REG_BAND * 0.4) * fa
img[sl] = img[sl] * (1 - la) + REG_LINE * la

# 종이 결, 가장자리 그늘
img *= (1 + grain[..., None] * 0.016)
yv, xv = np.mgrid[0:H, 0:W].astype(F32)
vig = ((xv / W - 0.5) ** 2 * 1.2 + (yv / H - 0.5) ** 2 * 1.6)
img *= (1 - np.clip(vig - 0.15, 0, 1)[..., None] * 0.25)
del grain, yv, xv, vig, d_sea
img = np.clip(img, 0, 255).astype(np.uint8)
base = Image.fromarray(img)
del img

# 8) 테두리, 나침반, 제목판 (원본 그대로)
dr = ImageDraw.Draw(base)
ink = (70, 50, 36)
m1, m2 = 46, 64
dr.rectangle([m1, m1, W - m1, H - m1], outline=ink, width=6)
dr.rectangle([m2, m2, W - m2, H - m2], outline=(150, 70, 55), width=2)


def compass(cx, cy, r):
    pts_big = []
    for k in range(4):
        a = math.pi / 2 * k - math.pi / 2
        tip = (cx + r * math.cos(a), cy + r * math.sin(a))
        l = (cx + r * 0.16 * math.cos(a - math.pi / 4), cy + r * 0.16 * math.sin(a - math.pi / 4))
        rr = (cx + r * 0.16 * math.cos(a + math.pi / 4), cy + r * 0.16 * math.sin(a + math.pi / 4))
        pts_big.append((tip, l, rr))
    for k in range(4):
        a = math.pi / 2 * k - math.pi / 4
        tip = (cx + r * 0.62 * math.cos(a), cy + r * 0.62 * math.sin(a))
        l = (cx + r * 0.12 * math.cos(a - math.pi / 4), cy + r * 0.12 * math.sin(a - math.pi / 4))
        rr = (cx + r * 0.12 * math.cos(a + math.pi / 4), cy + r * 0.12 * math.sin(a + math.pi / 4))
        dr.polygon([tip, l, (cx, cy)], fill=(150, 112, 82))
        dr.polygon([tip, rr, (cx, cy)], fill=(232, 216, 186), outline=ink)
    dr.ellipse([cx - r * 0.78, cy - r * 0.78, cx + r * 0.78, cy + r * 0.78], outline=ink, width=3)
    dr.ellipse([cx - r * 0.72, cy - r * 0.72, cx + r * 0.72, cy + r * 0.72], outline=(150, 70, 55), width=2)
    for tip, l, rr in pts_big:
        dr.polygon([tip, l, (cx, cy)], fill=(96, 40, 32))
        dr.polygon([tip, rr, (cx, cy)], fill=(240, 226, 198), outline=ink)
    f = ImageFont.truetype('C:/Windows/Fonts/batang.ttc', int(r * 0.32))
    t = 'N'; tw = dr.textlength(t, font=f)
    dr.text((cx - tw / 2, cy - r - r * 0.42), t, font=f, fill=(120, 40, 32))


compass(W - 420, H - 440, 250)
f_title = ImageFont.truetype('C:/Windows/Fonts/batang.ttc', 150)
f_sub = ImageFont.truetype('C:/Windows/Fonts/batang.ttc', 46)
bx0, by0, bx1, by1 = 150, H - 520, 1150, H - 150
dr.rectangle([bx0, by0, bx1, by1], fill=(238, 226, 200), outline=ink, width=5)
dr.rectangle([bx0 + 16, by0 + 16, bx1 - 16, by1 - 16], outline=(150, 70, 55), width=2)
t = '메러노더'; tw = dr.textlength(t, font=f_title)
dr.text(((bx0 + bx1) / 2 - tw / 2, by0 + 70), t, font=f_title, fill=(52, 36, 26))
t = '세 계  전 도'; tw = dr.textlength(t, font=f_sub)
dr.text(((bx0 + bx1) / 2 - tw / 2, by0 + 260), t, font=f_sub, fill=(150, 70, 55))
base.save(OUT_BASE, quality=92)

# 9) 이름판: 4간구처럼 고딕 굵은 글씨 + 크림색 테
named = base.copy()
dn = ImageDraw.Draw(named)
f_lab = ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf', 58)
f_small = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 32)


def halo_text(x, y, text, font, fill, r=4):
    dn.text((x, y), text, font=font, fill=fill, stroke_width=r, stroke_fill=(243, 233, 208))


LBL = (58, 40, 28)
cx, cy = AX, AY
dn.ellipse([cx - 46, cy - 40, cx + 46, cy + 40], outline=(140, 48, 36), width=3)
lx, ly = cx - 440, cy - 230
dn.line([(cx - 40, cy - 26), (lx + 230, ly + 96)], fill=(140, 48, 36), width=3)
halo_text(lx, ly, '어브릴', f_lab, LBL)
halo_text(lx + 2, ly + 78, '1간구~8간구', f_small, (120, 60, 48), 3)
ys, xs = np.where(rah_h)
rcx, rcy = xs.mean() * A, ys.mean() * A
t = '라하니아'
# 영역이 좁아 이름이 둘레선을 가로지르므로 동쪽 바깥에 둔다
ly0 = int(rcy - 70); band_rows = rah_h[(ly0 - 10) // A:(ly0 + 80) // A]
bx = np.where(band_rows.any(0))[0].max() * A
halo_text(bx + 30, ly0, t, f_lab, LBL)
named.save(OUT_NAMED, quality=92)
named.resize((W // 3, H // 3), Image.LANCZOS).save(OUT_PREVIEW, quality=90)
if CROP_PREFIX:
    named.crop((1950, 900, 3050, 2700)).save(CROP_PREFIX + '_center.png')
    named.crop((2250, 1650, 2850, 2600)).save(CROP_PREFIX + '_center_1to1.png')
    named.crop((1950, 900, 4200, 3100)).resize((1125, 1100), Image.LANCZOS).save(CROP_PREFIX + '_wide.jpg', quality=90)
    named.crop((2950, 2150, 3750, 2750)).save(CROP_PREFIX + '_coast_1to1.png')
print('done', SPLIT, 'land%', round(float(land.mean()) * 100, 1), 'forest px', int(forest.sum()), 'inner sea px', int(sea_in.sum()))
