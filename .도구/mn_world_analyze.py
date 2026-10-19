"""MN2.jpg 손그림에서 땅/바다와 땅 안의 선(경계)을 뽑아 npz로 저장한다.
밝은 부분 = 땅, 어두운 갈색 = 바다 (작가 확정 2026-10-19).
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC, OUT, PREVIEW = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(SRC).convert('RGB')
W, H = im.size
A = 2  # 절반 크기에서 분석
a = np.asarray(im.resize((W // A, H // A), Image.LANCZOS)).astype(np.float32)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
lum = 0.299 * R + 0.587 * G + 0.114 * B

# 빨강·주황·초록 표식은 선이 아니다
mark = ((R - G) > 45) | ((G - R) > 25)
mark = ndi.binary_dilation(mark, iterations=2)
line0 = (lum < 80) & ~mark

# 표식 자리를 주변 종이색으로 메워서 밝기 판정에 섞이지 않게
# 밝기는 종이 가장자리 그늘에 흔들려서, 색감(파랑/빨강 비율)으로 판정한다.
# 땅(밝은 종이) ≈ 0.58 이상, 바다(갈색 칠) ≈ 0.48 이하.
ratio = B / (R + 1)
keep = (~mark & ~line0).astype(np.float32)
num = ndi.gaussian_filter(ratio * keep, 20)
den = ndi.gaussian_filter(keep, 20) + 1e-6
ratio_f = np.where(keep > 0, ratio, num / den)
sm = ndi.gaussian_filter(ratio_f, 4)
THR = 0.53

# 굵은 장벽으로 큰 구역 나누기 (점선 틈, 표식 밑 끊긴 선까지 막음)
barrier = ndi.binary_dilation(line0 | mark, iterations=12)
lab_c, n_c = ndi.label(~barrier)
idx = np.arange(1, n_c + 1)
area_c = ndi.sum(np.ones_like(lab_c), lab_c, idx)
tone_c = ndi.mean(sm, lab_c, idx)
big = area_c >= lab_c.size * 0.0002

otsu = THR
land_c = tone_c >= otsu

# 가는 선 기준 작은 구역 (작은 섬·고리 섬까지 살림)
fine_free = ~ndi.binary_dilation(line0, iterations=1) & ~mark
lab_f, n_f = ndi.label(fine_free)
fidx = np.arange(1, n_f + 1)
# 좁은 띠는 번진 값이 섞이므로, 선에서 한 칸 떨어진 원래 색만 평균
core = ndi.binary_erosion(fine_free, iterations=2)
lab_core = np.where(core, lab_f, 0)
tone_f = ndi.mean(ratio, lab_core, fidx)
tone_all = ndi.mean(ratio, lab_f, fidx)
tone_f = np.where(np.isnan(tone_f), tone_all, tone_f)
# 큰 구역 픽셀은 큰 구역 판정을 그대로 쓰고,
# 큰 구역과 전혀 안 겹치는 작은 구역(작은 섬·고리 섬)만 제 색으로 판정한다.
# (가는 선 기준 구역은 끊긴 선 틈으로 바다와 땅이 이어질 수 있어서 큰 판정에 쓰지 않음)
bigmask = (lab_c > 0) & big[np.maximum(lab_c, 1) - 1]
known = bigmask.copy()
land = np.zeros(lab_c.shape, bool)
land[bigmask] = land_c[lab_c[bigmask] - 1]
touch = np.unique(lab_f[bigmask])
small_ids = np.setdiff1d(fidx, touch)
small_px = np.isin(lab_f, small_ids)
land[small_px] = tone_f[lab_f[small_px] - 1] >= otsu
known |= small_px
# 큰 구역에서 떨어진 좁은 띠(바다 팔, 좁은 곶)는 그 자리 원래 색으로 판정
core4 = ndi.binary_erosion(fine_free, iterations=7)  # 선 번짐(회색 그늘)을 피한다
den5 = ndi.gaussian_filter(core4.astype(np.float32), 5)
loc = ndi.gaussian_filter(ratio * core4, 5) / (den5 + 1e-6)
strip = ~known & core4 & (den5 > 0.08)
land[strip] = loc[strip] >= otsu
known |= strip
_, (iy, ix) = ndi.distance_transform_edt(~known, return_indices=True)
land = land[iy, ix]
# 남서쪽 고리 모양: 선 자체가 고리 섬의 몸이다 (원본 좌표 약 900~1160, 3140~3370)
rx0, ry0, rx1, ry1 = 880 // A, 3120 // A, 1180 // A, 3390 // A
ring = np.zeros_like(land)
ring[ry0:ry1, rx0:rx1] = line0[ry0:ry1, rx0:rx1]
land |= ndi.binary_dilation(ring, iterations=2)
# 정리: 선 그늘에서 생긴 가는 띠·점 없애기
ring_zone = np.zeros_like(land); ring_zone[ry0:ry1, rx0:rx1] = True
cleaned = ndi.binary_closing(ndi.binary_opening(land, iterations=5), iterations=5)
land = np.where(ring_zone, land, cleaned)
for target in (True, False):
    lab_x, n_x = ndi.label(land == target)
    if n_x:
        sz = ndi.sum(np.ones_like(lab_x), lab_x, np.arange(1, n_x + 1))
        lim = 400 if target else 2500  # 바다 쪽은 종이 가장자리 그늘 얼룩까지 지움
        tiny = np.isin(lab_x, np.where(sz < lim)[0] + 1) & ~ring_zone
        land[tiny] = not target
holes = lab_f == 0

# 땅 안의 선 = 경계 (양쪽이 다 땅인 선)
# 바다에서 충분히 떨어진 선만 경계로 친다 (해안선 굵기 때문에 생기는 오판 방지)
# 주변 반경 25칸 안에 바다가 거의 없는 선 = 땅 안의 경계 (해안선은 한쪽이 바다)
sea_frac = ndi.uniform_filter((~land).astype(np.float32), 51)
border = line0 & (sea_frac < 0.03)
border = ndi.binary_opening(border, iterations=1)


def thin(mask):
    """Zhang-Suen 세선화: 굵은 붓선을 한 줄 중심선으로."""
    m = np.pad(mask.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            P = m
            p2 = P[:-2, 1:-1]; p3 = P[:-2, 2:]; p4 = P[1:-1, 2:]; p5 = P[2:, 2:]
            p6 = P[2:, 1:-1]; p7 = P[2:, :-2]; p8 = P[1:-1, :-2]; p9 = P[:-2, :-2]
            c = P[1:-1, 1:-1]
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            Bn = sum(x.astype(np.int32) for x in nb)
            seq = nb + [p2]
            An = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.int32) for i in range(8))
            if step == 0:
                cond = (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                cond = (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            rm = (c == 1) & (Bn >= 2) & (Bn <= 6) & (An == 1) & cond
            if rm.any():
                changed = True
                m[1:-1, 1:-1][rm] = 0
        if not changed:
            break
    return m[1:-1, 1:-1].astype(bool)


border = thin(border)
lab_b, n_b = ndi.label(border, structure=np.ones((3, 3)))
if n_b:
    sz_b = ndi.sum(np.ones_like(lab_b), lab_b, np.arange(1, n_b + 1))
    border &= ~np.isin(lab_b, np.where(sz_b < 30)[0] + 1)
# 원래 어브릴 문양 자리(원본 좌표 약 2288~2400, 2208~2260)는 새로 작게 그리므로 지운다
ax0, ay0, ax1, ay1 = 2270 // A, 2190 // A, 2420 // A, 2275 // A
border[ay0:ay1, ax0:ax1] = False
# 원래 어브릴 문양 모양 (새로 작게 그릴 때 본뜸). 섬 해안선 아래쪽 굵은 선은 빼고 가는 선만.
thin_line = (lum < 80) & ~mark & ~ndi.binary_opening(line0, iterations=4)
abril = np.zeros_like(line0)
abril[ay0:ay1, ax0:ax1] = thin_line[ay0:ay1, ax0:ax1]
abril = ndi.binary_fill_holes(ndi.binary_closing(abril, iterations=2))


np.savez_compressed(OUT, land=land, border=border, abril=abril, abril_box=np.array([ax0, ay0, ax1, ay1]), scale=A, W=W, H=H, otsu=otsu)

# 확인용 미리보기: 땅 = 베이지, 바다 = 파랑, 경계 = 빨강
pv = np.zeros(land.shape + (3,), np.uint8)
pv[land] = (232, 220, 190)
pv[~land] = (120, 150, 175)
pv[ndi.binary_dilation(border, iterations=1)] = (190, 30, 30)
Image.fromarray(pv).resize((1500, 1000), Image.LANCZOS).save(PREVIEW)
# 원본 위에 바다를 파랗게 덮은 확인용
orig = a.astype(np.uint8).copy()
tint = orig.astype(np.float32)
tint[~land] = tint[~land] * 0.45 + np.array([40, 90, 200]) * 0.55
tint[ndi.binary_dilation(border, iterations=2)] = (220, 20, 20)
Image.fromarray(tint.astype(np.uint8)).resize((1500, 1000), Image.LANCZOS).save(PREVIEW.replace('.png', '_over.png'))
print('otsu', round(otsu, 1), 'land%', round(land.mean() * 100, 1), 'big regions', int(big.sum()))
