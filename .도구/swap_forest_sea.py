"""어브릴 옆 '숲과 바다' 모양 안에서 숲과 바다 자리를 맞바꾼다 (작가 지시 2026-10-19: 지금 반대).
실행: python swap_forest_sea.py regions.npz _자료/메러노더.지형.json
"""
import sys, json
import numpy as np
from scipy import ndimage as ndi

REG, TER = sys.argv[1:3]
fs = np.load(REG)['forest_sea'].astype(bool)
o = json.load(open(TER, encoding='utf-8'))
w, h = o['w'], o['h']


def un(r):
    a = np.zeros(w * h, np.uint8); q = 0
    for i in range(0, len(r), 2):
        a[q:q + r[i + 1]] = r[i]; q += r[i + 1]
    return a.reshape(h, w)


def rle(a):
    a = a.astype(np.uint8).ravel()
    st = np.concatenate([[0], np.flatnonzero(np.diff(a)) + 1])
    ln = np.diff(np.concatenate([st, [a.size]]))
    out = []
    for s_, n in zip(st, ln):
        out += [int(a[s_]), int(n)]
    return out


g, c = un(o['ground']), un(o['cover'])
Z = ndi.binary_dilation(fs, iterations=6)          # 모양 둘레까지
# 모양 안의 바다는 바깥 바다와 이어져 있지 않은지 확인 (안쪽 바다만 바꿈)
lab, n = ndi.label(g == 0)
inner_ids = set(np.unique(lab[Z & (g == 0)])) - {0}
touch_out = {i for i in inner_ids if (lab[~ndi.binary_dilation(Z, iterations=2)] == i).any()}
inner_sea = Z & (g == 0) & ~np.isin(lab, list(touch_out))
forest = Z & (c == 1)
print('안쪽 바다 칸', int(inner_sea.sum()), '숲 칸', int(forest.sum()), '바깥 바다와 이어진 덩어리', len(touch_out))
g2, c2 = g.copy(), c.copy()
g2[forest] = 0; c2[forest] = 0                      # 숲 → 바다
g2[inner_sea] = 1; c2[inner_sea] = 1                # 바다 → 숲
o['ground'], o['cover'] = rle(g2), rle(c2)
json.dump(o, open(TER, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('바꿈 완료')
