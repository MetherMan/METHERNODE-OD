"""원본 손그림에서 '어브릴 옆 숲과 바다' 모양과 '라하니아' 모양의 안쪽을 뽑는다."""
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

SRC, OUT, PREV = sys.argv[1:4]
im = Image.open(SRC).convert('RGB'); W, H = im.size; A = 2
a = np.asarray(im.resize((W // A, H // A), Image.LANCZOS)).astype(np.float32)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
lum = 0.299 * R + 0.587 * G + 0.114 * B
mark = ndi.binary_dilation(((R - G) > 45) | ((G - R) > 25), iterations=2)
line0 = (lum < 80) & ~mark
# 가는 선(라하니아·어브릴 문양)도 막히게 살짝만 두껍게
barrier = ndi.binary_dilation(line0, iterations=3)
lab, n = ndi.label(~barrier)


def grab(x_full, y_full):
    k = lab[y_full // A, x_full // A]
    assert k > 0, (x_full, y_full)
    m = lab == k
    # 선 한가운데까지 되돌려 키움
    return ndi.binary_dilation(m, iterations=3 + 6) & ~ndi.binary_dilation(~(m | barrier), iterations=0) if False else ndi.binary_dilation(m, iterations=9)


forest_sea = grab(2547, 2148)   # 숲과 바다 모양 (원본 번호판 12번)
rahania = grab(2205, 1068)      # 라하니아 (원본 번호판 4번)
np.savez_compressed(OUT, forest_sea=forest_sea, rahania=rahania, scale=A)
print('forest_sea px', int(forest_sea.sum()), 'rahania px', int(rahania.sum()))
ys, xs = np.where(forest_sea)
print('forest_sea bbox full', xs.min() * A, ys.min() * A, xs.max() * A, ys.max() * A)
ys, xs = np.where(rahania)
print('rahania bbox full', xs.min() * A, ys.min() * A, xs.max() * A, ys.max() * A)
# 확인용: 원본 위에 덮고 100px(원본) 격자
x0, y0, x1, y1 = 2150, 1500, 3000, 2650
crop = im.crop((x0, y0, x1, y1)).convert('RGBA')
ov = Image.new('RGBA', crop.size, (0, 0, 0, 0))
m = Image.fromarray((forest_sea[y0 // A:y1 // A, x0 // A:x1 // A] * 120).astype(np.uint8)).resize(crop.size)
ov.paste((0, 160, 60, 255), mask=m)
d = ImageDraw.Draw(ov)
for gx in range(x0 - x0 % 100 + 100, x1, 100):
    d.line([(gx - x0, 0), (gx - x0, y1 - y0)], fill=(0, 0, 200, 120), width=1)
    d.text((gx - x0 + 2, 2), str(gx), fill=(0, 0, 200, 255))
for gy in range(y0 - y0 % 100 + 100, y1, 100):
    d.line([(0, gy - y0), (x1 - x0, gy - y0)], fill=(0, 0, 200, 120), width=1)
    d.text((2, gy - y0 + 2), str(gy), fill=(0, 0, 200, 255))
Image.alpha_composite(crop, ov).convert('RGB').save(PREV)
