"""4간구 바탕 지도의 산(크림 몸통 + 먹선)을 지우고, 같은 자리에 새 산 기호(큰 산 · 작은 산 섞어, 크기 들쭉날쭉)를 찍은 시험본.
원본은 읽기만 함. python g4_swap.py <4간구.jpg> <기호/산 폴더> <출력 jpg>"""
import sys, os, glob, math
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC, STAMP_DIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
RACE = sys.argv[4] if len(sys.argv) > 4 else None  # 종족 땅 가림(흰색 = 종족 땅): 그 안과 경계 옆엔 새 산을 찍지 않음
rng = np.random.default_rng(4)
im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(float)
H, W = a.shape[:2]
r, g, b = a[..., 0], a[..., 1], a[..., 2]

# 1) 산 몸통: 크림색 덩어리 (종이 반점은 열기로 지우고 작은 덩어리는 버림)
# 둘레 종이보다 밝은 곳 (가장자리 종이가 어두워도 잡히게): 파랑 채널이 둘레보다 확 밝고 무채색에 가까움
# 둘레 종이 밝기: 종이처럼 보이는 곳만으로 (숲 · 물 · 먹선 · 산 몸통 후보는 빼고)
paperish = (r > 200) & (r < 242) & (g > 188) & ((r - b) > 25) & ((r - b) < 70) & ((g - b) < 52)
pv = ndi.binary_erosion(paperish, iterations=2).astype(float)
dp = ndi.gaussian_filter(pv, 30)
bgb = ndi.gaussian_filter(b * pv, 30) / np.maximum(dp, 1e-3)
bgr = ndi.gaussian_filter(r * pv, 30) / np.maximum(dp, 1e-3)
cream = ((b - bgb) > 13) & ((r - bgr) > 4) & (r > 215) & (g > 205) & ((r - b) < 42)
cream |= (r > 241) & (g > 232) & (b > 205)  # 밝은 종이 위의 산은 그냥 밝기로도
cream = ndi.binary_opening(cream, iterations=2)
lab, n = ndi.label(cream)
sizes = ndi.sum(cream, lab, range(1, n + 1))
keep = np.zeros(n + 1, bool)
keep[1:] = (sizes > 60) & (sizes < 2500)  # 산 몸통 크기만 (큰 밝은 얼룩은 산이 아님)
body = keep[lab]
# 한 산의 크기: 작은(외톨이) 덩어리들의 높이 가운데값
objs = ndi.find_objects(lab)
hs = [o[0].stop - o[0].start for i, o in enumerate(objs) if o is not None and keep[i + 1] and sizes[i] < np.percentile(sizes[keep[1:]], 50)]
mh = float(np.median(hs)) if hs else 30.0
print('산 덩어리', int(keep.sum()), '한 산 몸통 높이(가운데값)', mh)

# 2) 지울 자리: 산 무리 전체 (몸통을 넓히고 메워서 무리 하나로), 강은 지키기
region = ndi.binary_dilation(body, iterations=13)
# 먹선 · 빗금이 빽빽한 곳도 산 무리 (어두운 가장자리에서 몸통 밝기로 안 잡히는 산)
inkp = (r < 165) & ((r - b) > 25) & (g < 150)
olive = ((g - b) > 38) & (r > 110) & (r < 200) & (g > 110)
forest = ndi.binary_dilation(ndi.binary_closing(olive, iterations=3), iterations=6)
dens = ndi.uniform_filter((inkp & ~forest).astype(float), 25)
dense = ndi.binary_opening(dens > 0.10, iterations=3)
dl, dn = ndi.label(dense)
dsz = ndi.sum(dense, dl, range(1, dn + 1))
dk = np.zeros(dn + 1, bool)
dk[1:] = dsz > 400
dense = dk[dl]
# 제목판 · 나침반 자리는 빼기
deco = np.zeros((H, W), bool)
deco[1990:2230, 90:720] = True
deco[1900:2200, 3480:3870] = True
frame0 = np.zeros((H, W), bool)  # 바깥 테두리 띠 (먼저 빼야 테두리 안이 통째로 메워지지 않음)
frame0[:36, :] = frame0[-36:, :] = True
frame0[:, :36] = frame0[:, -36:] = True
region |= ndi.binary_dilation(dense & ~deco & ~frame0, iterations=6)
region &= ~deco & ~frame0
region = ndi.binary_closing(region, iterations=12)
region = ndi.binary_fill_holes(region)
region |= np.roll(region, -10, axis=0)  # 봉우리 먹선이 몸통보다 위로 솟아 있어서
river = (b > r + 15) & (r < 120)
river = ndi.binary_dilation(river, iterations=1)
# 테두리(바깥 먹선 · 붉은 안쪽 선)는 지키기: 가장자리 46px 안은 건드리지 않음
M = 36
frame = np.zeros((H, W), bool)
frame[:M, :] = frame[-M:, :] = True
frame[:, :M] = frame[:, -M:] = True
erase = region & ~river & ~frame
ink = (r < 175)

# 3) 지운 자리 채우기: 무리 바깥의 종이색만으로 번지게 (먹선 · 무리는 빼고) + 종이 결
valid = ((~region) & (~ink)).astype(float)
def spread(sig):
    o = np.zeros_like(a)
    den = ndi.gaussian_filter(valid, sig)
    for c in range(3):
        o[..., c] = ndi.gaussian_filter(a[..., c] * valid, sig) / np.maximum(den, 1e-4)
    return o, den
f1, d1 = spread(25)
f2, d2 = spread(90)
w = np.clip(d1 / 0.25, 0, 1)[..., None]
fill = f1 * w + f2 * (1 - w)
fill = fill + rng.normal(0, 2.0, (H, W, 1))
out = a.copy()
out[erase] = fill[erase]

# 4) 새 산 자리: 무리 안에 고르게 (자리끼리 최소 거리)
S_MEAN = 30.0  # 옛 산 하나의 높이쯤 (지도 px)
rdist = ndi.distance_transform_edt(~river)
if RACE:
    race = np.asarray(Image.open(RACE).convert('L').resize((W, H), Image.NEAREST)) > 200
    near = ndi.binary_dilation(race, iterations=26)
    noStamp = near | np.roll(near, 42, axis=0)  # 산은 밑동 위로 솟으니, 땅 바로 아래 자리도 비움
else:
    noStamp = np.zeros((H, W), bool)
ys, xs = np.nonzero(erase)
cand = rng.permutation(len(xs))[:400000]
gap = 23.0
grid = {}
sites = []
for i in cand:
    x, y = xs[i], ys[i]
    gx, gy = int(x // gap), int(y // gap)
    ok = True
    for u in range(gx - 1, gx + 2):
        for v in range(gy - 1, gy + 2):
            for (qx, qy) in grid.get((u, v), ()):
                if (qx - x) ** 2 + (qy - y) ** 2 < gap * gap:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            break
    if ok and not noStamp[y, x] and rdist[y, x] > 20 and M + 14 < x < W - M - 14 and M + 30 < y < H - M:
        grid.setdefault((gx, gy), []).append((x, y))
        sites.append((x, y))
print('새 산', len(sites))
mh = S_MEAN

# 5) 기호 불러와 찍기 (밑동 = 몸통 자리보다 조금 아래)
def load(folder):
    return [Image.open(p).convert('RGBA') for p in sorted(glob.glob(os.path.join(STAMP_DIR, folder, '*.png')))]
BIG, SMALL = load('큰 산'), load('작은 산')
res = Image.fromarray(out.clip(0, 255).astype('uint8')).convert('RGBA')
base_s = mh
for (x, y) in sorted(sites, key=lambda p: p[1]):
    f = 0.6 + 0.95 * rng.random() ** 1.6
    big = (rng.random() < 0.85) if f > 1.12 else (rng.random() < 0.15)
    st = (BIG if big else SMALL)[rng.integers(len(BIG if big else SMALL))]
    s = base_s * f
    tw = s * (1.5 if big else 2.0)
    th = st.height * tw / st.width
    sm = st.resize((max(1, int(tw)), max(1, int(th))), Image.LANCZOS)
    bx = int(x - tw / 2)
    by = int(y + s * 0.25 - th)
    res.alpha_composite(sm, (max(0, bx), max(0, by)), (max(0, -bx), max(0, -by)))
# 강은 산 위로 다시 (가장자리 몇 px 겹친 것), 테두리도 원본 그대로
res = np.asarray(res.convert('RGB')).copy()
keep_px = river | frame
res[keep_px] = a[keep_px].astype('uint8')
Image.fromarray(res).save(OUT, quality=92)
print('ok', OUT)
