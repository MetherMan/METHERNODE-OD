"""MN2.jpg 위에 구역 번호 + 좌표 격자를 얹은 참고 그림을 만든다."""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
W0, H0 = im.size
S = 4  # 처리용 축소 배율
small = im.resize((W0 // S, H0 // S), Image.LANCZOS)
a = np.asarray(small).astype(np.float32)
lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

# 검은 윤곽선 → 경계. 틈을 막으려고 살짝 두껍게.
line = lum < 75
line = ndi.binary_dilation(line, iterations=6)  # 점선 틈까지 막을 만큼 두껍게
free = ~line
# 밝기 판정용 (구역 나누기에는 안 씀)
sm = ndi.gaussian_filter(lum, 4)
vals = sm[free]
hist, edges = np.histogram(vals, bins=256)
w = np.cumsum(hist); mu = np.cumsum(hist * edges[:-1]); tot = mu[-1]
between = (tot * w / w[-1] - mu) ** 2 / (w * (w[-1] - w) + 1e-9)
otsu = edges[np.argmax(between)]
tone_light = sm >= otsu
lab, n = ndi.label(free)
areas = ndi.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
min_area = (W0 // S) * (H0 // S) * 0.00025
keep = [i + 1 for i, ar in enumerate(areas) if ar >= min_area]

# 구역마다 밝기, 번호 놓을 자리(가장 안쪽 점)
regions = []
for k in keep:
    m = lab == k
    mean = float(sm[m].mean())
    mp = np.pad(m, 1)  # 그림 가장자리도 경계로 쳐서 번호가 잘리지 않게
    dt = ndi.distance_transform_edt(mp)[1:-1, 1:-1]
    y, x = np.unravel_index(np.argmax(dt), dt.shape)
    regions.append(dict(k=k, mean=mean, x=x * S, y=y * S, r=float(dt[y, x]) * S, area=int(m.sum())))

# 위→아래, 왼→오 순으로 번호
regions.sort(key=lambda r: (round(r['y'] / (H0 / 8)), r['x']))
means = np.array([r['mean'] for r in regions])
thr = otsu

# 출력: 3000px 폭
OW = 3000
sc = OW / W0
base = im.resize((OW, int(H0 * sc)), Image.LANCZOS).convert('RGBA')
ov = Image.new('RGBA', base.size, (0, 0, 0, 0))
d = ImageDraw.Draw(ov)
font_path = 'C:/Windows/Fonts/malgunbd.ttf'
f_grid = ImageFont.truetype(font_path, 34)

# 격자 12 x 8 (A~L, 1~8)
cols, rows = 12, 8
gw, gh = base.size[0] / cols, base.size[1] / rows
for i in range(1, cols):
    d.line([(i * gw, 0), (i * gw, base.size[1])], fill=(40, 70, 160, 90), width=2)
for j in range(1, rows):
    d.line([(0, j * gh), (base.size[0], j * gh)], fill=(40, 70, 160, 90), width=2)
for i in range(cols):
    for j in range(rows):
        t = f'{chr(65 + i)}{j + 1}'
        d.text((i * gw + 8, j * gh + 4), t, font=f_grid, fill=(40, 70, 160, 150))

# 구역 번호 배지 (밝은 구역 = 흰 배지, 어두운 구역 = 갈색 배지)
for idx, r in enumerate(regions, 1):
    cx, cy = r['x'] * sc, r['y'] * sc
    size = int(np.clip(r['r'] * sc * 0.55, 24, 56))
    f = ImageFont.truetype(font_path, size)
    t = str(idx)
    tw = d.textlength(t, font=f)
    pad = size * 0.35
    rad = max(tw, size) / 2 + pad
    light = r['mean'] >= thr
    fill = (255, 255, 255, 235)  # 색으로 땅/바다를 암시하지 않게 한 가지로
    txt = (150, 20, 20, 255)
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=fill, outline=(150, 20, 20, 255), width=3)
    d.text((cx - tw / 2, cy - size * 0.62), t, font=f, fill=txt)
    r['no'] = idx
    r['tone'] = '밝음' if light else '어두움'
    r['cell'] = f"{chr(65 + int(cx // gw))}{int(cy // gh) + 1}"

Image.alpha_composite(base, ov).convert('RGB').save(out, quality=92)
print(f'구역 {len(regions)}개 (경계 기준 밝기 {thr:.0f})')
for r in regions:
    print(r['no'], r['tone'], r['cell'], f"{r['area']}")
