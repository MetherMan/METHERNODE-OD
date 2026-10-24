'use strict';
/*
 * MN 세계판 v0.6 (땅 칠하기 · 자동 경계 · 지형 그리기 · 판 타고 들어가기 · 펼쳐지는 마을 그림책)
 * 노트 속성이 곧 데이터예요. 따로 저장하는 파일이 없어요.
 *   지역: 분류: 지역, 지도: 4간구, 좌표: [x, y] (그 지도 그림의 픽셀 위치), 표식: 영역 (넓은 땅 이름표) | 수도 (별 표식) | 건물 (그림: 건물 그림, 크기: 지도 px 폭)
 *   인물: 분류: 인물, 위치: "[[지역]]", 하는 일, 시점, 초상: "[[그림]]"
 * 지도는 여러 장을 둘 수 있어요(설정). 지역의 `지도`가 없으면 첫 번째 지도에 올라가요.
 * 인물을 다른 지역으로 옮기면 위치 속성을 고치고, 기록 폴더의 오늘 노트에 한 줄 남겨요.
 */
const { Plugin, ItemView, Modal, Notice, SuggestModal, PluginSettingTab, Setting, TFile, setIcon } = require('obsidian');

const VIEW_TYPE = 'mn-sekaipan';
const STORY_TYPE = 'mn-storybook'; // 펼쳐지는 마을 (입체 그림책)
const STORY_PAGE = '.도구/창/popup/index.html'; // 세계판 창과 같은 페이지 하나를 씀
const STORY_READ = /^(The Archive - 자료\/[^/]+\.마을\.json|\.도구\/창\/popup\/layout\.json|The Archive - 자료\/기호\/배치 목록\.json)$/; // 그림책이 읽을 수 있는 파일
const STORY_WRITE = /^The Archive - 자료\/[^/]+\.마을\.json$/; // 그림책이 쓸 수 있는 파일 (마을 저장본)
const STORY_NOTES = /^(The Main - 지리|The Main - 인물|The Rule - TRPG\/기록)\/.+\.md$/; // 그림책이 읽고 쓰는 노트 (기록 · 인물·장소·기관 노트)
/** 노트 맨 위 「키: 값」 속성만 빠르게 (방금 만든 노트는 옵시디언 속성 캐시가 아직 비어 있어서) */
function quickFm(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const fm = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const k = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!k) continue;
    let v = k[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch (e) {} } else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    fm[k[1].trim()] = v;
  }
  return fm;
}
const DEFAULTS = {
  maps: [
    { name: '4간구', path: 'The Archive - 자료/4간구.jpg' },
    { name: '메러노더 전체', path: 'The Archive - 자료/메러노더.jpg' },
  ],
  logFolder: 'The Rule - TRPG/기록',
  placeFolder: 'The Main - 지리',
};
const KIND = { place: '지역', person: '인물' };
const DROP_RADIUS = 36; // 화면 px. 이 거리 안에 놓으면 그 지역으로 옮겨요.
// 머리글자 말 바탕: 지역·강조 빨강과 겹치지 않게 먹색·갈색 계열만
const FACE_COLORS = ['#2e1010', '#4a231c', '#6b3a2a', '#5c2b3a', '#7a4a35'];

const pad = (n) => String(n).padStart(2, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** "[[이름|별칭]]" 또는 "이름" → "이름" */
function linkpath(v) {
  if (Array.isArray(v)) v = v[0];
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  return (m ? m[1] : s).trim() || null;
}

function coords(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function now() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function faceColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return FACE_COLORS[h % FACE_COLORS.length];
}

/* ==================== 땅 나누기: 종족 땅 칠하기 · 자동 경계 ====================
 * 지도마다 `<지도 그림 이름>.영역.json` 하나에 저장해요.
 *   paint: 칠한 그림(지도의 1/scale 크기, 칸마다 땅 번호, 0은 빈 땅)  territories: 땅 목록  settings: 경계 설정
 * 칠한 그림을 곳마다 크기가 다른 작은 각진 칸(보로노이)으로 묶어서 경계를 만들어요.
 * 그래서 붓으로 대충 칠해도 경계는 각지고 자세하게 나와요. 빈 땅은 주인 없는 구역으로 저절로 나뉘어요.
 */
const LAND_PALETTE = ['#d0645a', '#d6a043', '#86a052', '#9a5a88', '#5f8aa0', '#c96e3a', '#9a6a46'];
const PROV_TONES = [[230, 214, 180], [239, 226, 196], [226, 210, 174], [235, 220, 187]];
const LANDC_RGB = [246, 234, 208];
const HATCH_TINT = [143, 169, 178];
const HATCH_LINE = [95, 116, 130];

function rng32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 부드러운 값 잡음. 평균 0, 대략 표준편차 1 */
function makeNoise(seed, scale) {
  const r = rng32(seed);
  const N = 256;
  const tbl = new Float32Array(N * N);
  for (let i = 0; i < tbl.length; i++) tbl[i] = (r() * 2 - 1) * 2.2;
  return (x, y) => {
    const fx = x / scale;
    const fy = y / scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    let tx = fx - x0;
    let ty = fy - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const i0 = ((x0 % N) + N) % N;
    const j0 = ((y0 % N) + N) % N;
    const i1 = (i0 + 1) % N;
    const j1 = (j0 + 1) % N;
    const a = tbl[j0 * N + i0];
    const b = tbl[j0 * N + i1];
    const c = tbl[j1 * N + i0];
    const d = tbl[j1 * N + i1];
    const top = a + (b - a) * tx;
    return top + (c + (d - c) * tx - top) * ty;
  };
}

/** 점이 다각형 안에 있는지 (지도 px) */
function inPoly([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hexRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 색을 겹쳐 칠하기 (아래 [rgb, a] 위에 rgb를 알파 a로) */
function over(bottom, rgb, a) {
  const [brgb, ba] = bottom;
  const oa = a + ba * (1 - a);
  if (oa <= 0) return [[0, 0, 0], 0];
  return [brgb.map((c, i) => (rgb[i] * a + c * ba * (1 - a)) / oa), oa];
}

/** 체임퍼 거리: is(p)가 참인 칸까지의 대략 거리 */
function chamfer(w, h, is) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) d[p] = is(p) ? 0 : INF;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = d[p];
      if (v === 0) continue;
      if (x > 0 && d[p - 1] + 1 < v) v = d[p - 1] + 1;
      if (y > 0) {
        if (d[p - w] + 1 < v) v = d[p - w] + 1;
        if (x > 0 && d[p - w - 1] + D < v) v = d[p - w - 1] + D;
        if (x < w - 1 && d[p - w + 1] + D < v) v = d[p - w + 1] + D;
      }
      d[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = d[p];
      if (v === 0) continue;
      if (x < w - 1 && d[p + 1] + 1 < v) v = d[p + 1] + 1;
      if (y < h - 1) {
        if (d[p + w] + 1 < v) v = d[p + w] + 1;
        if (x < w - 1 && d[p + w + 1] + D < v) v = d[p + w + 1] + D;
        if (x > 0 && d[p + w - 1] + D < v) v = d[p + w - 1] + D;
      }
      d[p] = v;
    }
  }
  return d;
}

class Lands {
  constructor(w, h, scale) {
    this.w = w;
    this.h = h;
    this.scale = scale;
    this.paint = new Uint8Array(w * h);
    this.terr = []; // { name, kind: '종족' | '빗금', color, lock: 고정 넓이(칠한 칸 수) 또는 null }
    this.settings = { seed: 7, detail: 0.55, irregular: 0.6 };
    this.frame = 0; // 지도 테두리 안쪽 여백(지도 px): 이 밖은 칠하지 않음
    this.clear = []; // [x, y, w, h] (지도 px): 표제·나침반 자리 — 빈 땅 색을 칠하지 않음
    this.cells = null;
    this.owner = null;
    this.area = null;
  }

  static decode(obj) {
    const L = new Lands(obj.w, obj.h, obj.scale || 2);
    L.terr = (obj.territories || []).map((t) => ({
      name: String(t.name),
      kind: t.kind === '빗금' ? '빗금' : '종족',
      color: t.color || LAND_PALETTE[0],
      lock: Number.isFinite(t.lock) ? t.lock : null,
    }));
    Object.assign(L.settings, obj.settings || {});
    L.frame = Number(obj.frame) || 0;
    L.clear = Array.isArray(obj.clear) ? obj.clear : [];
    const r = obj.paint || [];
    let p = 0;
    for (let i = 0; i + 1 < r.length; i += 2) {
      L.paint.fill(r[i], p, p + r[i + 1]);
      p += r[i + 1];
    }
    return L;
  }

  encode() {
    const a = this.paint;
    const runs = [];
    let v = a[0];
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === v) n++;
      else {
        runs.push(v, n);
        v = a[i];
        n = 1;
      }
    }
    runs.push(v, n);
    return {
      version: 1,
      w: this.w,
      h: this.h,
      scale: this.scale,
      frame: this.frame,
      clear: this.clear,
      settings: this.settings,
      territories: this.terr.map((t) => ({ name: t.name, kind: t.kind, color: t.color, ...(t.lock != null ? { lock: t.lock } : {}) })),
      paint: runs,
    };
  }

  /** 칸 만들기 (경계 설정이 바뀔 때만) */
  build() {
    const { w, h } = this;
    const S = this.settings;
    const base = 18 - 12 * clamp(S.detail, 0, 1); // 평균 칸 크기(작업 px)
    const irr = clamp(S.irregular, 0, 1);
    const nSp = makeNoise(S.seed * 31 + 1, 150);
    const fine = Math.max(2.5, base * Math.exp(-1.2 * irr));
    const rnd = rng32(S.seed * 97 + 3);
    const sx = [];
    const sy = [];
    for (let y = fine / 2; y < h; y += fine) {
      for (let x = fine / 2; x < w; x += fine) {
        const px = x + (rnd() - 0.5) * 0.9 * fine;
        const py = y + (rnd() - 0.5) * 0.9 * fine;
        const sp = base * Math.exp(irr * 1.2 * Math.tanh(1.4 * nSp(px, py)));
        if (rnd() < (fine / sp) ** 2) {
          sx.push(px);
          sy.push(py);
        }
      }
    }
    const n = sx.length;
    const SX = Float32Array.from(sx);
    const SY = Float32Array.from(sy);
    // 칸 찾기용 바구니
    const B = Math.max(4, Math.ceil(base * Math.exp(1.2 * irr)));
    const bw = Math.ceil(w / B);
    const bh = Math.ceil(h / B);
    const bStart = new Int32Array(bw * bh + 1);
    for (let i = 0; i < n; i++) bStart[Math.min(bh - 1, (SY[i] / B) | 0) * bw + Math.min(bw - 1, (SX[i] / B) | 0) + 1]++;
    for (let i = 1; i < bStart.length; i++) bStart[i] += bStart[i - 1];
    const fillAt = bStart.slice(0, bw * bh);
    const bSeeds = new Int32Array(n);
    for (let i = 0; i < n; i++) bSeeds[fillAt[Math.min(bh - 1, (SY[i] / B) | 0) * bw + Math.min(bw - 1, (SX[i] / B) | 0)]++] = i;
    const cellOf = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      const by = (y / B) | 0;
      for (let x = 0; x < w; x++) {
        const bx = (x / B) | 0;
        let best = 0;
        let bd = Infinity;
        for (let r = 1; r <= 6; r++) {
          for (let j = by - r; j <= by + r; j++) {
            if (j < 0 || j >= bh) continue;
            for (let i = bx - r; i <= bx + r; i++) {
              if (i < 0 || i >= bw) continue;
              if (r > 1 && Math.abs(j - by) < r && Math.abs(i - bx) < r) continue;
              const b = j * bw + i;
              for (let k = bStart[b]; k < bStart[b + 1]; k++) {
                const s = bSeeds[k];
                const dx = SX[s] - x;
                const dy = SY[s] - y;
                const d = dx * dx + dy * dy;
                if (d < bd) {
                  bd = d;
                  best = s;
                }
              }
            }
          }
          if (bd <= r * B * (r * B)) break;
        }
        cellOf[y * w + x] = best;
      }
    }
    // 칠한 그림을 살짝 비틀어 읽기 (곳마다 굴곡 세기가 다름) — 성긴 격자에서 계산해 메움
    const G = 4;
    const gw = Math.ceil(w / G) + 2;
    const gh = Math.ceil(h / G) + 2;
    const nA = makeNoise(S.seed * 7 + 11, 190);
    const n1x = makeNoise(S.seed + 21, 100);
    const n1y = makeNoise(S.seed + 22, 100);
    const n2x = makeNoise(S.seed + 23, 32);
    const n2y = makeNoise(S.seed + 24, 32);
    const ox = new Float32Array(gw * gh);
    const oy = new Float32Array(gw * gh);
    const ampScale = irr / 0.6;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = i * G;
        const y = j * G;
        const amp = (3 + 13 * (0.5 + 0.5 * Math.tanh(1.2 * nA(x, y)))) * ampScale;
        ox[j * gw + i] = amp * (0.75 * n1x(x, y) + 0.45 * n2x(x, y));
        oy[j * gw + i] = amp * (0.75 * n1y(x, y) + 0.45 * n2y(x, y));
      }
    }
    const warp = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      const gy = y / G;
      const j = gy | 0;
      const fy = gy - j;
      for (let x = 0; x < w; x++) {
        const gx = x / G;
        const i = gx | 0;
        const fx = gx - i;
        const a = j * gw + i;
        const dx = (ox[a] * (1 - fx) + ox[a + 1] * fx) * (1 - fy) + (ox[a + gw] * (1 - fx) + ox[a + gw + 1] * fx) * fy;
        const dy = (oy[a] * (1 - fx) + oy[a + 1] * fx) * (1 - fy) + (oy[a + gw] * (1 - fx) + oy[a + gw + 1] * fx) * fy;
        const wx = clamp(Math.round(x + dx), 0, w - 1);
        const wy = clamp(Math.round(y + dy), 0, h - 1);
        warp[y * w + x] = wy * w + wx;
      }
    }
    // 칸 크기 · 이웃
    const size = new Int32Array(n);
    for (let p = 0; p < w * h; p++) size[cellOf[p]]++;
    const pairs = new Set();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const c = cellOf[p];
        if (x + 1 < w && cellOf[p + 1] !== c) pairs.add(c < cellOf[p + 1] ? c * n + cellOf[p + 1] : cellOf[p + 1] * n + c);
        if (y + 1 < h && cellOf[p + w] !== c) pairs.add(c < cellOf[p + w] ? c * n + cellOf[p + w] : cellOf[p + w] * n + c);
      }
    }
    const nbr = Array.from({ length: n }, () => []);
    for (const key of pairs) {
      const a = Math.floor(key / n);
      const b = key - a * n;
      nbr[a].push(b);
      nbr[b].push(a);
    }
    // 주인 없는 구역: 듬성한 씨앗으로 나눔 (칸 단위)
    const pr = rng32(S.seed * 13 + 9);
    const px = [];
    const py = [];
    for (let t = 0; t < 4000 && px.length < 400; t++) {
      const x = pr() * w;
      const y = pr() * h;
      let ok = true;
      for (let k = 0; k < px.length; k++) {
        if ((px[k] - x) ** 2 + (py[k] - y) ** 2 < 200 * 200) {
          ok = false;
          break;
        }
      }
      if (ok) {
        px.push(x);
        py.push(y);
      }
    }
    const provOf = new Int16Array(n);
    for (let c = 0; c < n; c++) {
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k < px.length; k++) {
        const d = (px[k] - SX[c]) ** 2 + (py[k] - SY[c]) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      provOf[c] = best;
    }
    this.cells = { n, SX, SY, cellOf, warp, size, nbr, provOf };
  }

  /** 칸마다 주인 정하기 (칠할 때마다) */
  assign() {
    const { w, h } = this;
    const C = this.cells;
    const KK = this.terr.length + 1;
    const cnt = new Uint32Array(C.n * KK);
    const { cellOf, warp } = C;
    const paint = this.paint;
    for (let p = 0; p < w * h; p++) {
      const v = paint[warp[p]];
      if (v < KK) cnt[cellOf[p] * KK + v]++;
    }
    const owner = new Uint8Array(C.n);
    for (let c = 0; c < C.n; c++) {
      let best = 0;
      let bv = -1;
      for (let k = 0; k < KK; k++) {
        const v = cnt[c * KK + k];
        if (v > bv) {
          bv = v;
          best = k;
        }
      }
      owner[c] = best;
    }
    // 맞닿은 땅 사이에 낀 빈 칸은 더 많이 걸친 쪽으로 (틈이 생기지 않게)
    for (let c = 0; c < C.n; c++) {
      if (owner[c] !== 0) continue;
      let o1 = 0;
      let o2 = 0;
      for (const nb of C.nbr[c]) {
        const o = owner[nb];
        if (!o) continue;
        if (!o1) o1 = o;
        else if (o !== o1) o2 = o;
      }
      if (o2) owner[c] = cnt[c * KK + o1] >= cnt[c * KK + o2] ? o1 : o2;
    }
    const area = new Float64Array(KK);
    for (let c = 0; c < C.n; c++) area[owner[c]] += C.size[c];
    this.owner = owner;
    this.area = area;
  }

  /** 땅 넓이 (지도 전체 대비 %) */
  percent(k) {
    return this.area ? (this.area[k] / (this.w * this.h)) * 100 : 0;
  }

  paintCount(k) {
    let n = 0;
    for (let p = 0; p < this.paint.length; p++) if (this.paint[p] === k) n++;
    return n;
  }

  /** 넓이 잠금: 칠한 칸 수를 target에 맞춤 (가장자리부터 깎거나, 가까운 빈 땅부터 넓힘) */
  fitArea(k, target) {
    const { w, h, paint } = this;
    const count = this.paintCount(k);
    if (Math.abs(count - target) <= Math.max(20, target * 0.002)) return;
    const shrink = count > target;
    const d = shrink ? chamfer(w, h, (p) => paint[p] !== k) : chamfer(w, h, (p) => paint[p] === k);
    const want = Math.abs(count - target);
    const BINS = 4096;
    const hist = new Uint32Array(BINS);
    const q = (v) => Math.min(BINS - 1, Math.floor(v * 4));
    for (let p = 0; p < paint.length; p++) {
      if (shrink ? paint[p] === k : paint[p] === 0 && d[p] < 1e8) hist[q(d[p])]++;
    }
    let acc = 0;
    let cut = 0;
    while (cut < BINS && acc + hist[cut] <= want) acc += hist[cut++];
    let partial = want - acc; // 경계값에 걸친 칸은 일부만
    for (let p = 0; p < paint.length; p++) {
      const ok = shrink ? paint[p] === k : paint[p] === 0 && d[p] < 1e8;
      if (!ok) continue;
      const b = q(d[p]);
      if (b < cut || (b === cut && partial-- > 0)) paint[p] = shrink ? 0 : k;
    }
  }

  /** 붓 한 번 찍기 (작업 좌표) */
  stamp(cx, cy, r, k, erase, force) {
    const { w, h, paint } = this;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
        const p = y * w + x;
        const v = paint[p];
        if (erase) {
          if (v === k || (force && v !== 0)) paint[p] = 0;
        } else if (v === 0 || v === k || force) paint[p] = k;
      }
    }
  }

  /** 지도 크기 캔버스에 땅 색과 경계를 그림 */
  draw(canvas) {
    const { w, h, scale } = this;
    const C = this.cells;
    const owner = this.owner;
    const { cellOf, SX, SY, provOf, n } = C;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    const D = img.data;
    // 땅마다 색 미리 섞기: 지형을 옅게 덮는 종이색 + 땅 색, 경계 안쪽은 진한 띠
    const wash = [LANDC_RGB, 0.5];
    const fills = [null];
    const bands = [null];
    for (const t of this.terr) {
      if (t.kind === '빗금') {
        const base = over([LANDC_RGB, 0.35], HATCH_TINT, 0.12);
        fills.push(base);
        bands.push(over(base, HATCH_LINE, 0.5)); // 빗금 줄
      } else {
        const rgb = hexRgb(t.color);
        fills.push(over(wash, rgb, 0.2));
        bands.push(over(wash, rgb, 0.6));
      }
    }
    const tones = PROV_TONES.map((c) => [c, 0.55]);
    const rid = (c) => (owner[c] ? owner[c] : -1 - provOf[c]);
    // 비워 둘 자리: 2 = 테두리 밖(아무것도 안 그림), 1 = 표제·나침반(빈 땅 색·가는 경계 안 그림)
    const keep = new Uint8Array(w * h);
    const fr = Math.ceil(this.frame / scale);
    if (fr > 0) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) if (x < fr || y < fr || x >= w - fr || y >= h - fr) keep[y * w + x] = 2;
      }
    }
    const fade = new Float32Array(w * h).fill(1); // 표제·나침반 둘레는 빈 땅 색이 서서히 사라지게
    const FEATHER = 14;
    for (const [rx, ry, rw, rh] of this.clear) {
      const x0 = Math.max(0, Math.floor(rx / scale));
      const y0 = Math.max(0, Math.floor(ry / scale));
      const x1 = Math.min(w, Math.ceil((rx + rw) / scale));
      const y1 = Math.min(h, Math.ceil((ry + rh) / scale));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * w + x;
          if (keep[p]) continue;
          const d = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
          fade[p] = Math.min(fade[p], clamp(1 - d / FEATHER, 0, 1));
          if (d > FEATHER * 0.5) keep[p] = 1;
        }
      }
    }
    const OFF = [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const c = cellOf[p];
        const o = owner[c];
        if (keep[p] === 2) continue;
        if (!o && fade[p] <= 0) continue;
        let col;
        if (!o) col = tones[provOf[c] % tones.length];
        else if (this.terr[o - 1].kind === '빗금') col = (x + y) % 11 < 1.4 ? bands[o] : fills[o];
        else {
          col = fills[o];
          const me = rid(c);
          for (const [dx, dy] of OFF) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            if (rid(cellOf[yy * w + xx]) !== me) {
              col = bands[o];
              break;
            }
          }
        }
        const i = p * 4;
        D[i] = col[0][0];
        D[i + 1] = col[0][1];
        D[i + 2] = col[0][2];
        D[i + 3] = col[1] * 255 * (o ? 1 : fade[p]);
      }
    }
    octx.putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, w * scale, h * scale);
    // 경계선: 맞닿은 두 칸 씨앗의 수직이등분선 위 곧은 마디 (각지고 또렷하게)
    const segs = new Map();
    const add = (ca, cb, ptx, pty) => {
      const ra = rid(ca);
      const rb = rid(cb);
      if (ra === rb) return;
      let a = ca;
      let b = cb;
      if (a > b) {
        a = cb;
        b = ca;
      }
      const key = a * n + b;
      let s = segs.get(key);
      if (!s) {
        const mx = (SX[a] + SX[b]) / 2;
        const my = (SY[a] + SY[b]) / 2;
        let dx = -(SY[b] - SY[a]);
        let dy = SX[b] - SX[a];
        const L = Math.hypot(dx, dy) || 1;
        dx /= L;
        dy /= L;
        const ka = ra > 0 ? this.terr[ra - 1].kind : null;
        const kb = rb > 0 ? this.terr[rb - 1].kind : null;
        let kind = 'minor';
        if ((ka === '종족') || (kb === '종족')) kind = 'major';
        else if (ka === '빗금' || kb === '빗금') kind = 'hatch';
        s = [Infinity, -Infinity, kind, mx, my, dx, dy];
        segs.set(key, s);
      }
      const t = (ptx - s[3]) * s[5] + (pty - s[4]) * s[6];
      if (t < s[0]) s[0] = t;
      if (t > s[1]) s[1] = t;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const c = cellOf[p];
        if (x + 1 < w && cellOf[p + 1] !== c) add(c, cellOf[p + 1], x + 0.5, y);
        if (y + 1 < h && cellOf[p + w] !== c) add(c, cellOf[p + w], x, y + 0.5);
      }
    }
    const pass = (kind, width, color, alpha, dash) => {
      ctx.beginPath();
      for (const s of segs.values()) {
        if (s[2] !== kind) continue;
        const tm = (s[0] + s[1]) / 2;
        const sx = Math.round(s[3] + s[5] * tm);
        const sy = Math.round(s[4] + s[6] * tm);
        const kp = sx >= 0 && sy >= 0 && sx < w && sy < h ? keep[sy * w + sx] : 2;
        if (kp === 2 || (kp === 1 && kind === 'minor')) continue;
        const t0 = s[0] - 0.7;
        const t1 = s[1] + 0.7;
        ctx.moveTo((s[3] + s[5] * t0 + 0.5) * scale, (s[4] + s[6] * t0 + 0.5) * scale);
        ctx.lineTo((s[3] + s[5] * t1 + 0.5) * scale, (s[4] + s[6] * t1 + 0.5) * scale);
      }
      ctx.setLineDash(dash || []);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.stroke();
    };
    pass('minor', 4, '#f6ead0', 0.6);
    pass('minor', 1.6, '#7a5a3a', 0.85);
    pass('hatch', 2, '#4d6f80', 1, [8, 5]);
    pass('major', 6, '#f6ead0', 0.8);
    pass('major', 2.8, '#4a2418', 1);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  /** 새 땅 색: 가장 덜 쓴 색 */
  nextColor() {
    const used = LAND_PALETTE.map((c) => this.terr.filter((t) => t.color === c).length);
    return LAND_PALETTE[used.indexOf(Math.min(...used))];
  }
}

/* ==================== 지형 그리기: 땅·바다·숲·영역을 직접 그리면 둘레 지형은 저절로 ====================
 * 지도마다 `<지도 그림 이름>.지형.json` 하나에 저장해요. 칸은 지도의 1/scale 크기예요.
 *   ground: 땅(1)·바다(0)   cover: 숲(1)   regions: 각진 영역 [{ name, pts: [[x, y] ...] (지도 px) }]
 * 그린 대로 해안 굴곡·작은 섬·바다 깊이·물결선·숲 테두리·나무 머리·영역 띠를 다시 계산해서 그려요.
 * 영역 밑은 늘 땅이에요(바다에 걸쳐 그리면 그만큼 땅이 생겨요). 양식은 4간구 지도에 맞췄어요.
 */
const TER = {
  INK: 'rgba(62,47,34,0.92)',
  LAND: [233, 223, 197],
  SHALLOW: [184, 200, 190],
  MID: [164, 184, 176],
  DEEP: [146, 168, 164],
  RIPPLE: [86, 112, 114],
  FOREST: [164, 158, 102],
  ARCH: 'rgba(104,84,52,0.84)',
  FLINE: 'rgba(88,66,44,0.92)',
  RLINE: '#5c3426',
  RBAND: 'rgba(212,140,122,0.55)',
  RFILL: 'rgba(236,200,184,0.38)',
  RSOLID: 'rgb(226,176,159)',
  WAVE: 'rgba(80,108,112,0.59)',
};

function gaussRand(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** 여러 크기의 부드러운 잡음을 겹친 장 (평균 0, 표준편차 1). cells: 지도 px 단위 크기 */
function fractalField(w, h, scale, cells, power, seed) {
  const out = new Float32Array(w * h);
  const r = rng32(seed);
  for (const cf of cells) {
    const c = cf / scale;
    const gw = Math.ceil(w / c) + 3;
    const gh = Math.ceil(h / c) + 3;
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = gaussRand(r);
    const ox = r() * c;
    const oy = r() * c;
    const amp = Math.pow(cf, power);
    const tx = new Float32Array(w);
    const ix = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = (x + ox) / c;
      const x0 = Math.floor(fx);
      const t = fx - x0;
      ix[x] = x0;
      tx[x] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < h; y++) {
      const fy = (y + oy) / c;
      const y0 = Math.floor(fy);
      let ty = fy - y0;
      ty = ty * ty * (3 - 2 * ty);
      const r0 = y0 * gw;
      const r1 = r0 + gw;
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = ix[x];
        const a = g[r0 + x0];
        const b = g[r0 + x0 + 1];
        const cc = g[r1 + x0];
        const d = g[r1 + x0 + 1];
        const t = tx[x];
        const top = a + (b - a) * t;
        out[o + x] += (top + (cc + (d - cc) * t - top) * ty) * amp;
      }
    }
  }
  let m = 0;
  for (let i = 0; i < out.length; i++) m += out[i];
  m /= out.length;
  let v = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= m;
    v += out[i] * out[i];
  }
  const sd = Math.sqrt(v / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

/** 1차원 제곱 거리 변환 (Felzenszwalb) */
function edt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** 정확한 유클리드 거리: target 이 1인 칸까지 (칸 단위). 읽기가 늘 연속이 되게 뒤집어 가며 두 번 */
function edt(target, w, h) {
  const INF = 1e20;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const t = new Float32Array(w * h); // 뒤집힌 (x 줄마다 y)
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = target[o + x] ? 0 : INF;
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) t[x * h + y] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    const o = x * h;
    for (let y = 0; y < h; y++) f[y] = t[o + y];
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = Math.sqrt(d[y]);
  }
  return out;
}

/** 땅·바다 경계 칸까지 거리 하나로 양쪽 거리 (거리 변환 한 번) */
function edgeDist(m, w, h) {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const v = m[p];
      if ((x > 0 && m[p - 1] !== v) || (x < w - 1 && m[p + 1] !== v) || (y > 0 && m[p - w] !== v) || (y < h - 1 && m[p + w] !== v)) b[p] = 1;
    }
  }
  return edt(b, w, h);
}

/** 4방향으로 이어진 덩어리 번호와 크기 */
function labelParts(mask, w, h) {
  const lab = new Int32Array(w * h);
  const sizes = [0];
  const q = new Int32Array(w * h);
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s]) continue;
    n++;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    lab[s] = n;
    while (head < tail) {
      const p = q[head++];
      const x = p % w;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = n; q[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = n; q[tail++] = p + 1; }
      if (p >= w && mask[p - w] && !lab[p - w]) { lab[p - w] = n; q[tail++] = p - w; }
      if (p < w * h - w && mask[p + w] && !lab[p + w]) { lab[p + w] = n; q[tail++] = p + w; }
    }
    sizes.push(tail);
  }
  return { lab, sizes };
}

/** 상자 흐림 세 번 (가우시안 비슷하게) */
function blurField(src, w, h, r) {
  let a = Float32Array.from(src);
  let b = new Float32Array(w * h);
  const R = Math.max(1, Math.round(r));
  const norm = 1 / (2 * R + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += a[o + clamp(k, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        b[o + x] = acc * norm;
        acc += a[o + Math.min(w - 1, x + R + 1)] - a[o + Math.max(0, x - R)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += b[clamp(k, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        acc += b[Math.min(h - 1, y + R + 1) * w + x] - b[Math.max(0, y - R) * w + x];
      }
    }
  }
  return a;
}

/** 마칭 스퀘어: f = level 등고선 조각들 [x1, y1, x2, y2, ...] (칸 가운데 좌표). keep(x, y): 그 칸을 쓸지 */
function contourSegs(f, w, h, level, keep) {
  const out = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const p = y * w + x;
      const a = f[p] - level;
      const b = f[p + 1] - level;
      const c = f[p + w + 1] - level;
      const d = f[p + w] - level;
      const idx = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      if (keep && !keep(x, y)) continue;
      const T = [x + a / (a - b), y]; // 위
      const R = [x + 1, y + b / (b - c)]; // 오른쪽
      const B = [x + d / (d - c), y + 1]; // 아래
      const L = [x, y + a / (a - d)]; // 왼쪽
      const seg = (u, v) => out.push(u[0], u[1], v[0], v[1]);
      switch (idx) {
        case 1: case 14: seg(L, B); break;
        case 2: case 13: seg(B, R); break;
        case 3: case 12: seg(L, R); break;
        case 4: case 11: seg(T, R); break;
        case 6: case 9: seg(T, B); break;
        case 7: case 8: seg(L, T); break;
        case 5: case 10: {
          const mid = (a + b + c + d) / 4 > 0;
          if ((idx === 5) === mid) { seg(L, T); seg(B, R); } else { seg(T, R); seg(L, B); }
          break;
        }
      }
    }
  }
  return out;
}

function strokeSegs(ctx, segs, s, style, width) {
  ctx.beginPath();
  for (let i = 0; i < segs.length; i += 4) {
    ctx.moveTo((segs[i] + 0.5) * s, (segs[i + 1] + 0.5) * s);
    ctx.lineTo((segs[i + 2] + 0.5) * s, (segs[i + 3] + 0.5) * s);
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function polyPath(ctx, pts, k) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
  ctx.closePath();
}

function hashInt(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** 그린 꼭짓점 사이를 잘게 꺾은 경계. detail 0이면 그린 그대로.
 *  꺾임은 영역 이름·변 번호로 정해져서, 같은 영역을 크게 본 판에서도 큰 모양은 똑같고 더 잘게 들어가요. */
function detailPts(r) {
  const d = clamp(r.detail || 0, 0, 1);
  const pts = r.pts;
  if (!d || pts.length < 3) return pts;
  const rough = 0.12 + 0.2 * d; // 꺾임 세기 (변 길이 대비)
  const minSeg = 9 - 5 * d; // 이보다 짧은 마디는 더 안 쪼갬 (지도 px)
  const base = [...r.name].reduce((h, ch) => hashInt(h, ch.codePointAt(0)), 7);
  const out = [];
  const split = (a, b, seed, depth) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < minSeg || depth > 14) return;
    const h = hashInt(seed, depth) / 4294967296;
    const off = (h * 2 - 1) * rough * L * 0.5;
    const t = 0.5 + ((hashInt(seed, depth + 99) / 4294967296) * 2 - 1) * 0.12;
    const m = [a[0] + dx * t - (dy / L) * off, a[1] + dy * t + (dx / L) * off];
    split(a, m, hashInt(seed, 1), depth + 1);
    out.push(m);
    split(m, b, hashInt(seed, 2), depth + 1);
  };
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    split(pts[i], pts[(i + 1) % pts.length], hashInt(base, i), 0);
  }
  return out;
}

const isTrench = (r) => r && r.type === 'trench';
const isRiver = (r) => r && r.type === 'river';
const isRoad = (r) => r && r.type === 'road';
const isLine = (r) => isTrench(r) || isRiver(r) || isRoad(r); // 점을 이어 긋는 것 (닫지 않음)
/** 선 종류별로 저장할 값 */
const lineFields = (r) => (isTrench(r) ? { type: 'trench', w0: r.w0, w1: r.w1 } : isRiver(r) ? { type: 'river', w0: r.w0, w1: r.w1 } : isRoad(r) ? { type: 'road' } : {});
const isWreck = (r) => r && r.type === 'wreck';
const isPlace = (r) => r && !r.type; // 땅을 만드는 보통 영역

/** 재해 지대 하나: 범위만 알려 주는 아주 옅은 안내선 (지금은 생명체가 잘 사는 땅) */
function drawWreck(ctx, r, seed, lines) {
  const heal = clamp(r.heal || 0, 0, 1);
  if (heal >= 0.98) return;
  const shape = detailPts({ ...r, detail: r.detail || 0.6 });
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.setLineDash([22, 14]);
  ctx.strokeStyle = `rgba(92,70,52,${0.42 * (1 - 0.4 * heal)})`;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/* ---------- 배치: 산 · 언덕 · 강 · 길 (4간구 지도 양식) ---------- */
const MK = {
  INK: 'rgba(92,62,40,0.95)',
  HATCH: 'rgba(92,62,40,0.8)',
  FILL: 'rgb(247,239,219)',
  GLOW: 'rgba(250,244,229,0.6)',
  RIVER: 'rgb(69,109,114)',
  RIVER_EDGE: 'rgba(46,82,86,0.9)',
  ROAD: 'rgba(98,56,36,0.95)',
  ROAD_HALO: 'rgba(247,239,219,0.75)',
};

/** 표식 하나의 씨앗 (자리로 정해져서 다시 그려도 같은 모양) */
function markRnd(m) {
  const h0 = hashInt(hashInt(Math.round(m.x * 10), Math.round(m.y * 10)), m.k === 'hill' ? 7 : 3);
  return (i) => hashInt(h0, i) / 4294967296;
}

/** 산 하나: 오목한 두 변의 뾰족한 봉우리 + 오른쪽 세로 빗금 + 밑동의 밝은 띠 (x, y = 밑 가운데, s = 높이) */
function drawMountain(ctx, m) {
  const rnd = markRnd(m);
  const h = m.s;
  const w = h * (0.84 + 0.16 * rnd(1));
  const x = m.x;
  const y = m.y;
  const px = x + (rnd(2) - 0.4) * 0.14 * w;
  const py = y - h;
  const lx = x - w / 2;
  const rx = x + w / 2;
  const lc = [x - w * 0.16, y - h * 0.34]; // 왼 변 조절점 (안으로 오목)
  const rc = [x + w * 0.15, y - h * 0.32];
  const lw = clamp(h * 0.05, 1.1, 4);
  ctx.save();
  // 밑동의 밝은 띠
  ctx.fillStyle = MK.GLOW;
  ctx.beginPath();
  ctx.ellipse(x + w * 0.05, y - h * 0.03, w * 0.66, Math.max(1.5, h * 0.075), 0, 0, Math.PI * 2);
  ctx.fill();
  // 몸통
  const body = () => {
    ctx.beginPath();
    ctx.moveTo(lx, y);
    ctx.quadraticCurveTo(lc[0], lc[1], px, py);
    ctx.quadraticCurveTo(rc[0], rc[1], rx, y);
  };
  body();
  ctx.closePath();
  ctx.fillStyle = MK.FILL;
  ctx.fill();
  // 오른쪽 빗금: 오른 변에 매달린 세로 획, 바깥으로 갈수록 짧게
  const q = (t) => {
    const u = 1 - t;
    return [u * u * px + 2 * u * t * rc[0] + t * t * rx, u * u * py + 2 * u * t * rc[1] + t * t * y];
  };
  const n = h < 24 ? 3 : h < 44 ? 4 : 5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const t = 0.12 + (0.72 * (i + 0.3 * rnd(10 + i))) / n;
    const [ex, ey] = q(t);
    const sx = ex - lw * 1.1; // 변 바로 안쪽
    const len = h * (0.5 - 0.32 * (i / n)) * (0.85 + 0.3 * rnd(20 + i));
    const ey2 = Math.min(y - lw, ey + len);
    if (ey2 <= ey + lw) continue;
    ctx.moveTo(sx, ey + lw * 0.8);
    ctx.lineTo(sx - len * 0.06, ey2);
  }
  ctx.strokeStyle = MK.HATCH;
  ctx.lineWidth = lw * 0.6;
  ctx.lineCap = 'round';
  ctx.stroke();
  // 먹선 + 오른쪽 밑 짧은 가로 획
  body();
  ctx.moveTo(rx - w * 0.06, y);
  ctx.lineTo(rx + w * 0.16, y);
  ctx.strokeStyle = MK.INK;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 12;
  ctx.stroke();
  ctx.restore();
}

/** 언덕 하나: 낮은 활 모양 먹선 (s = 폭) */
function drawHill(ctx, m) {
  const rnd = markRnd(m);
  const w = m.s * (1.0 + 0.25 * rnd(1));
  const hh = m.s * (0.2 + 0.06 * rnd(2));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(m.x - w / 2, m.y);
  ctx.quadraticCurveTo(m.x + (rnd(3) - 0.5) * w * 0.2, m.y - hh * 2, m.x + w / 2, m.y + hh * 0.15);
  ctx.strokeStyle = MK.INK;
  ctx.lineWidth = clamp(m.s * 0.07, 1.1, 3.5);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/** 스케치 붓: [종류, 이름, 색, 굵기 배율] — Codex 에게 보낼 때 이 색의 뜻을 같이 알려 줌 */
const SKETCH_INKS = [
  ['urban', '시가지', '#e2b98f', 1],
  ['water', '물', '#4f86a6', 1],
  ['park', '공원 · 숲', '#7fa45a', 1],
  ['road', '큰길', '#6b4a30', 0.3],
  ['mark', '중심 · 명소', '#c0443c', 0.7],
  ['erase', '지우개', null, 1],
];

/** 산 기호 그림 묶음: 폴더 이름 → 불러온 그림들 (세계판이 The Archive - 자료/기호/산 에서 채움) */
const STAMPS = {};
const STAMP_DIR = 'The Archive - 자료/기호/산';
const BIG = '큰 산';
const SMALL = '작은 산';

/** 산 하나의 묶음: 놓을 때 정해 둔 것(st), 없으면 자리로 정함 */
function stampSetOf(m) {
  const names = Object.keys(STAMPS).filter((k) => STAMPS[k].length);
  if (!names.length) return null;
  if (m.st && STAMPS[m.st] && STAMPS[m.st].length) return STAMPS[m.st];
  const pick = markRnd(m)(41) < 0.3 ? BIG : SMALL;
  return STAMPS[pick] && STAMPS[pick].length ? STAMPS[pick] : STAMPS[names[0]];
}

/** 그림 기호로 산 하나: 아래 가운데가 밑동, 폭 = 크기의 1.5배 */
function drawStamp(ctx, m, set) {
  const im = set[Math.floor(markRnd(m)(31) * set.length)];
  const tw = m.s * 1.5;
  const th = (im.height * tw) / im.width;
  ctx.drawImage(im, m.x - tw / 2, m.y - th, tw, th);
}

function drawMark(ctx, m) {
  if (m.k === 'hill') return drawHill(ctx, m);
  const set = stampSetOf(m);
  if (set) drawStamp(ctx, m, set);
  else drawMountain(ctx, m);
}

/** 찍은 점들을 지나는 부드러운 선 (캣멀롬). step: 점 사이 간격(지도 px) */
function smoothLine(pts, step) {
  if (pts.length < 2) return pts.map((p) => p.slice());
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

/** 강 하나: 발원지(첫 점, w0)에서 하구(끝 점, w1)로 굵어지는 물길. 잔잔한 굽이 */
function drawRiver(ctx, r, seed) {
  const base = smoothLine(r.pts, 6);
  if (base.length < 2) return;
  const w0 = r.w0 == null ? 3 : r.w0;
  const w1 = r.w1 == null ? 12 : r.w1;
  const len = [0];
  for (let i = 1; i < base.length; i++) len.push(len[i - 1] + Math.hypot(base[i][0] - base[i - 1][0], base[i][1] - base[i - 1][1]));
  const total = len[len.length - 1] || 1;
  const ph1 = (hashInt(seed, 1) / 4294967296) * Math.PI * 2;
  const ph2 = (hashInt(seed, 2) / 4294967296) * Math.PI * 2;
  const L = [];
  const R = [];
  base.forEach((p, i) => {
    const a = base[Math.max(0, i - 1)];
    const b = base[Math.min(base.length - 1, i + 1)];
    let nx = a[1] - b[1];
    let ny = b[0] - a[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const t = len[i] / total;
    const wv = w0 + (w1 - w0) * t;
    const amp = (2 + wv * 1.2) * Math.min(1, t * 8, (1 - t) * 8); // 두 끝은 찍은 자리 그대로
    const o = amp * (Math.sin(len[i] / 37 + ph1) * 0.6 + Math.sin(len[i] / 13 + ph2) * 0.25);
    const cx = p[0] + nx * o;
    const cy = p[1] + ny * o;
    L.push([cx + (nx * wv) / 2, cy + (ny * wv) / 2]);
    R.push([cx - (nx * wv) / 2, cy - (ny * wv) / 2]);
  });
  ctx.save();
  ctx.beginPath();
  L.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  ctx.fillStyle = MK.RIVER;
  ctx.fill();
  ctx.strokeStyle = MK.RIVER_EDGE;
  ctx.lineWidth = 0.9;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(base[0][0], base[0][1], Math.max(0.6, w0 / 2), 0, Math.PI * 2);
  ctx.fillStyle = MK.RIVER;
  ctx.fill();
  ctx.restore();
}

/** 길 하나: 옅은 테두리 위 끊긴 먹선 */
function drawRoad(ctx, r) {
  const pts = smoothLine(r.pts, 8);
  if (pts.length < 2) return;
  const path = () => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  };
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  path();
  ctx.strokeStyle = MK.ROAD_HALO;
  ctx.lineWidth = 7.5;
  ctx.stroke();
  path();
  ctx.setLineDash([16, 9]);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = MK.ROAD;
  ctx.lineWidth = 3.2;
  ctx.stroke();
  ctx.restore();
}

/** 자국(골) 하나 그리기: pts 선을 따라 폭 w0 → w1 로 좁아지는 골 */
function drawTrench(ctx, r, seed) {
  const pts = r.pts;
  if (pts.length < 2) return;
  const w0 = Math.max(0.5, r.w0 || 8);
  const w1 = Math.max(0.3, r.w1 == null ? w0 * 0.15 : r.w1);
  // 고르게 다시 찍기
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  if (total <= 0) return;
  const step = clamp(Math.min(w0, w1 * 4) / 3, 1.5, 6);
  const P = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = i ? 1 : 0; k <= n; k++) P.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, acc + (L * k) / n]);
    acc += L;
  }
  const left = [];
  const right = [];
  const inL = [];
  const inR = [];
  const W = [];
  const N = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 2)];
    const b = P[Math.min(P.length - 1, i + 2)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    const w = w0 + (w1 - w0) * (P[i][2] / total);
    const j1 = ((hashInt(seed, i * 2) / 4294967296) - 0.5) * 0.22 * w;
    const j2 = ((hashInt(seed, i * 2 + 1) / 4294967296) - 0.5) * 0.22 * w;
    left.push([P[i][0] + nx * (w / 2 + j1), P[i][1] + ny * (w / 2 + j1)]);
    right.push([P[i][0] - nx * (w / 2 + j2), P[i][1] - ny * (w / 2 + j2)]);
    inL.push([P[i][0] + nx * w * 0.22, P[i][1] + ny * w * 0.22]);
    inR.push([P[i][0] - nx * w * 0.22, P[i][1] - ny * w * 0.22]);
    W.push(w);
    N.push([nx, ny]);
  }
  const fillBand = (A, B, color) => {
    ctx.beginPath();
    A.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (let i = B.length - 1; i >= 0; i--) ctx.lineTo(B[i][0], B[i][1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  // 둑 빗금 (가장자리에서 바깥으로 짧게)
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(110,90,68,0.72)';
  ctx.beginPath();
  let next = 0;
  for (let i = 0; i < P.length; i++) {
    if (P[i][2] < next) continue;
    const w = W[i];
    next = P[i][2] + Math.max(4, w * 0.55);
    const len = w * 0.32 + 2.5;
    const [nx, ny] = N[i];
    ctx.moveTo(left[i][0], left[i][1]);
    ctx.lineTo(left[i][0] + nx * len, left[i][1] + ny * len);
    ctx.moveTo(right[i][0], right[i][1]);
    ctx.lineTo(right[i][0] - nx * len, right[i][1] - ny * len);
  }
  ctx.lineWidth = clamp(w0 * 0.05, 0.8, 2.2);
  ctx.stroke();
  // 바닥: 바깥은 거무스름한 돌, 가운데 깊은 곳은 검은 유리
  fillBand(left, right, '#5b5046');
  fillBand(inL, inR, '#2d2722');
  // 가장자리 먹선
  ctx.strokeStyle = 'rgba(52,40,30,0.95)';
  ctx.lineWidth = clamp(w0 * 0.06, 0.9, 2.4);
  ctx.lineJoin = 'round';
  for (const E of [left, right]) {
    ctx.beginPath();
    E.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  // 깊은 쪽의 김 (넓은 곳만)
  ctx.strokeStyle = 'rgba(246,242,232,0.85)';
  next = 0;
  ctx.beginPath();
  for (let i = 0; i < P.length; i++) {
    const w = W[i];
    if (w < 10 || P[i][2] < next) continue;
    next = P[i][2] + w * (2.2 + 1.6 * (P[i][2] / total));
    const r = w * 0.18;
    const x = P[i][0] + ((hashInt(seed, i + 777) / 4294967296) - 0.5) * w * 0.3;
    const y = P[i][1];
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - r, y - r, x + r, y - r * 2, x, y - r * 3);
    ctx.bezierCurveTo(x - r, y - r * 4, x + r * 0.6, y - r * 4.6, x + r * 0.2, y - r * 5.4);
  }
  ctx.lineWidth = clamp(w0 * 0.05, 1, 2.6);
  ctx.stroke();
}

class Terrain {
  constructor(w, h, scale) {
    this.w = w;
    this.h = h;
    this.scale = scale;
    this.ground = new Uint8Array(w * h);
    this.cover = new Uint8Array(w * h);
    this.regions = [];
    this.seed = 20261019;
    this.coast = 1;
    this.isles = true;
    this.deco = true;
    this.underlay = '';
    this.title = '';
    this.subtitle = '세 계  전 도'; // 제목판 아래 글 (판이면 지역 지도)
    this.output = ''; // 지도 그림으로 구울 경로 (비면 지금 지도 그림)
    this.inherited = []; // 위 판에서 내려온 선(자국 · 강 · 길) (이 판 좌표로 바꾼 것, 그리기만)
    this.marks = []; // 배치한 산 · 언덕 { k: 'mtn' | 'hill', x, y (밑 가운데), s (크기) }
    this.cache = null; // 잡음 장 (씨앗이 같으면 다시 안 만듦)
  }

  static decode(o) {
    const T = new Terrain(o.w, o.h, o.scale || 2);
    const unrle = (runs, arr) => {
      let p = 0;
      for (let i = 0; i + 1 < (runs || []).length; i += 2) {
        arr.fill(runs[i], p, p + runs[i + 1]);
        p += runs[i + 1];
      }
    };
    unrle(o.ground, T.ground);
    unrle(o.cover, T.cover);
    T.regions = (o.regions || []).map((r) => ({
      name: String(r.name),
      pts: (r.pts || []).map((p) => [Number(p[0]), Number(p[1])]),
      ...(Number(r.detail) > 0 ? { detail: Number(r.detail) } : {}),
      ...(r.type === 'trench' ? { type: 'trench', w0: Number(r.w0) || 8, w1: Number.isFinite(Number(r.w1)) ? Number(r.w1) : 1 } : {}),
      ...(r.type === 'wreck' ? { type: 'wreck', heal: clamp(Number(r.heal) || 0, 0, 1) } : {}),
      ...(r.type === 'river' ? { type: 'river', w0: Number.isFinite(Number(r.w0)) ? Number(r.w0) : 3, w1: Number.isFinite(Number(r.w1)) ? Number(r.w1) : 12 } : {}),
      ...(r.type === 'road' ? { type: 'road' } : {}),
    }));
    T.marks = (o.marks || [])
      .filter((m) => m && (m.k === 'mtn' || m.k === 'hill') && Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y)))
      .map((m) => ({ k: m.k, x: Number(m.x), y: Number(m.y), s: Number(m.s) > 0 ? Number(m.s) : 40, ...(typeof m.st === 'string' && m.st ? { st: m.st } : {}) }));
    if (Number.isFinite(o.seed)) T.seed = o.seed;
    if (Number.isFinite(o.coast)) T.coast = o.coast;
    if (typeof o.isles === 'boolean') T.isles = o.isles;
    if (typeof o.deco === 'boolean') T.deco = o.deco;
    T.underlay = o.underlay || '';
    T.title = o.title || '';
    if (typeof o.subtitle === 'string') T.subtitle = o.subtitle;
    T.output = o.output || '';
    return T;
  }

  encode() {
    const rle = (a) => {
      const runs = [];
      let v = a[0];
      let n = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] === v) n++;
        else {
          runs.push(v, n);
          v = a[i];
          n = 1;
        }
      }
      runs.push(v, n);
      return runs;
    };
    return {
      version: 1, w: this.w, h: this.h, scale: this.scale, seed: this.seed,
      coast: this.coast, isles: this.isles, deco: this.deco, underlay: this.underlay, title: this.title, subtitle: this.subtitle, output: this.output,
      ground: rle(this.ground), cover: rle(this.cover),
      regions: this.regions.map((r) => ({
        name: r.name,
        pts: r.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        ...(r.detail ? { detail: r.detail } : {}),
        ...lineFields(r),
        ...(isWreck(r) ? { type: 'wreck', heal: r.heal || 0 } : {}),
      })),
      marks: this.marks.map((m) => ({ k: m.k, x: Math.round(m.x * 10) / 10, y: Math.round(m.y * 10) / 10, s: Math.round(m.s * 10) / 10, ...(m.st ? { st: m.st } : {}) })),
    };
  }

  /** 붓 한 번 (칸 좌표). layer: 'ground' | 'cover', value 0/1. 바다를 칠하면 숲도 걷어요 */
  stamp(cx, cy, r, layer, value) {
    const { w, h } = this;
    const arr = this[layer];
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(h - 1, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
        const p = y * w + x;
        arr[p] = value;
        if (layer === 'ground' && !value) this.cover[p] = 0;
      }
    }
    return [x0, y0, x1, y1];
  }

  noise() {
    if (this.cache && this.cache.seed === this.seed) return this.cache;
    const { w, h, scale, seed } = this;
    this.cache = {
      seed,
      coast: fractalField(w, h, scale, [160, 80, 40, 20, 10, 5], 0.75, seed + 1), // 큰 굽이는 빼서 그린 모양을 따르게
      isle: fractalField(w, h, scale, [90, 45, 22, 11], 0.6, seed + 2),
      paper: fractalField(w, h, scale, [900, 450, 225], 1.0, seed + 3),
      forest: fractalField(w, h, scale, [300, 150, 75], 1.0, seed + 7),
    };
    return this.cache;
  }

  /** 고른 영역들을 칸 크기로 칠한 마스크 */
  maskOf(pred) {
    const { w, h, scale } = this;
    const m = new Uint8Array(w * h);
    const list = this.regions.filter((r) => pred(r) && r.pts.length >= 3);
    if (!list.length) return m;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    for (const r of list) {
      polyPath(ctx, detailPts(r).map(([x, y]) => [x - scale / 2, y - scale / 2]), 1 / scale);
      ctx.fill();
    }
    const a = ctx.getImageData(0, 0, w, h).data;
    for (let p = 0; p < w * h; p++) m[p] = a[p * 4 + 3] > 100 ? 1 : 0;
    return m;
  }

  /** 영역들을 칸 크기로 칠한 마스크와, 둘레 margin 칸까지 넓힌 마스크 */
  regionMask(margin) {
    const { w, h, scale } = this;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineJoin = 'round';
    const read = () => {
      const a = ctx.getImageData(0, 0, w, h).data;
      const m = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) m[p] = a[p * 4 + 3] > 100 ? 1 : 0;
      return m;
    };
    const paths = this.regions.filter((r) => isPlace(r) && r.pts.length >= 3).map((r) => detailPts(r).map(([x, y]) => [x - scale / 2, y - scale / 2]));
    for (const pts of paths) {
      polyPath(ctx, pts, 1 / scale);
      ctx.fill();
    }
    const m = read();
    ctx.lineWidth = margin * 2;
    for (const pts of paths) {
      polyPath(ctx, pts, 1 / scale);
      ctx.stroke();
    }
    return [m, read()];
  }

  /** 빠른 미리보기용: 칸을 반으로 줄인 사본 (잡음은 따로 기억) */
  lowres() {
    const w2 = Math.ceil(this.w / 2);
    const h2 = Math.ceil(this.h / 2);
    if (!this.low || this.low.w !== w2) this.low = new Terrain(w2, h2, this.scale * 2);
    const L = this.low;
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const p = Math.min(this.h - 1, y * 2) * this.w + Math.min(this.w - 1, x * 2);
        const q = Math.min(this.h - 1, y * 2 + 1) * this.w + Math.min(this.w - 1, x * 2 + 1);
        L.ground[y * w2 + x] = this.ground[p] + this.ground[q] + this.ground[p + 1 < this.w * this.h ? p + 1 : p] + this.ground[q - 1 >= 0 ? q - 1 : q] >= 2 ? 1 : 0;
        L.cover[y * w2 + x] = this.cover[p] || this.cover[q] ? 1 : 0;
      }
    }
    Object.assign(L, { regions: this.regions, inherited: this.inherited, marks: this.marks, seed: this.seed, coast: this.coast, isles: this.isles, deco: this.deco, title: this.title, subtitle: this.subtitle });
    return L;
  }

  /** 지도 크기(W×H) 캔버스에 완성 지도를 그림 */
  /** 산 · 언덕만 따로 (투명한 겹, 지도 크기) */
  renderMarks(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const m of [...(this.marks || [])].sort((a, b) => a.y - b.y)) drawMark(ctx, m);
  }

  /** opts.marks === false 면 산 · 언덕은 빼고 (편집 중에는 따로 된 겹에 그려요) */
  render(canvas, opts = {}) {
    const { w, h, scale: s } = this;
    const N = w * h;
    const W = canvas.width;
    const H = canvas.height;
    const nz = this.noise();
    const rnd = rng32(this.seed + 11);

    // 1) 땅 모양: 그린 땅 + 영역, 해안 굴곡과 작은 섬은 저절로
    const [reg, near] = this.regionMask(6 / s);
    const g = new Uint8Array(N);
    for (let p = 0; p < N; p++) g[p] = this.ground[p] || reg[p] ? 1 : 0;
    const dE = edgeDist(g, w, h); // 경계까지 (칸)
    const amp = (26 / s) * clamp(this.coast, 0, 2);
    const ampK = new Float32Array(N).fill(1);
    {
      const M = Math.ceil(70 / s);
      for (const r of this.regions) {
        if (!isPlace(r) || r.pts.length < 3) continue;
        const x0 = Math.max(0, Math.floor(Math.min(...r.pts.map((q) => q[0])) / s) - M);
        const x1 = Math.min(w - 1, Math.ceil(Math.max(...r.pts.map((q) => q[0])) / s) + M);
        const y0 = Math.max(0, Math.floor(Math.min(...r.pts.map((q) => q[1])) / s) - M);
        const y1 = Math.min(h - 1, Math.ceil(Math.max(...r.pts.map((q) => q[1])) / s) + M);
        const ww = x1 - x0 + 1;
        const hh = y1 - y0 + 1;
        const sub = new Uint8Array(ww * hh);
        for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) sub[y * ww + x] = reg[(y + y0) * w + x + x0];
        const dd = edt(sub, ww, hh);
        for (let y = 0; y < hh; y++) {
          for (let x = 0; x < ww; x++) {
            const k = clamp((dd[y * ww + x] * s - 8) / 50, 0, 1);
            const p = (y + y0) * w + x + x0;
            if (k < ampK[p]) ampK[p] = k;
          }
        }
      }
    }
    const F = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const sdf = g[p] ? dE[p] + 0.5 : -dE[p] - 0.5;
      let v = sdf + amp * ampK[p] * nz.coast[p];
      if (this.isles && ampK[p] > 0.99 && sdf < -20 / s && sdf > -260 / s) {
        const iv = (nz.isle[p] - (2.15 + (-sdf * s) / 160)) * 6;
        if (iv > v) v = iv;
      }
      F[p] = v;
    }
    for (let p = 0; p < N; p++) if (reg[p]) F[p] = Math.max(F[p], 1.5); // 영역 밑은 늘 땅
    // 먼지 같은 섬(300px 미만)과 웅덩이(400px 미만)는 없앰
    {
      const L = new Uint8Array(N);
      for (let p = 0; p < N; p++) L[p] = F[p] > 0 ? 1 : 0;
      const cut = (mask, lim, val) => {
        const { lab, sizes } = labelParts(mask, w, h);
        for (let p = 0; p < N; p++) if (lab[p] && sizes[lab[p]] < lim) F[p] = val;
      };
      cut(L, 300 / (s * s), -1);
      for (let p = 0; p < N; p++) L[p] = F[p] > 0 ? 0 : 1;
      cut(L, 400 / (s * s), 1);
    }
    const land = new Uint8Array(N);
    const sea = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
      land[p] = F[p] > 0 ? 1 : 0;
      sea[p] = land[p] ? 0 : 1;
    }
    this.lastLand = land;
    const dSea = edt(land, w, h); // 바다 칸 → 해안 (칸)
    const dLand = edt(sea, w, h); // 땅 칸 → 해안 (칸)

    // 물결선 기준: 큰 땅만, 매끈하게
    let dBig;
    {
      const { lab, sizes } = labelParts(land, w, h);
      const big = new Float32Array(N);
      const lim = 4000 / (s * s);
      for (let p = 0; p < N; p++) big[p] = lab[p] && sizes[lab[p]] >= lim ? 1 : 0;
      const bs = blurField(big, w, h, 2.5 / s * 1.0);
      const bigS = new Uint8Array(N);
      for (let p = 0; p < N; p++) bigS[p] = bs[p] > 0.5 ? 1 : 0;
      dBig = edt(bigS, w, h);
    }

    // 2) 숲 모양: 그린 숲을 땅 안에서, 테두리는 4간구처럼 몽글몽글
    const forest = new Uint8Array(N);
    let fx0 = w;
    let fy0 = h;
    let fx1 = -1;
    let fy1 = -1;
    const raw = new Uint8Array(N);
    const razed = this.maskOf((r) => isWreck(r) && (r.heal || 0) < 0.5);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (this.cover[p] && land[p] && !near[p] && !razed[p]) {
          raw[p] = 1;
          if (x < fx0) fx0 = x;
          if (x > fx1) fx1 = x;
          if (y < fy0) fy0 = y;
          if (y > fy1) fy1 = y;
        }
      }
    }
    const trees = [];
    let fwin = null;
    if (fx1 >= 0) {
      const M = Math.ceil(30 / s);
      fx0 = Math.max(0, fx0 - M);
      fy0 = Math.max(0, fy0 - M);
      fx1 = Math.min(w - 1, fx1 + M);
      fy1 = Math.min(h - 1, fy1 + M);
      const ww = fx1 - fx0 + 1;
      const hh = fy1 - fy0 + 1;
      const sub = new Uint8Array(ww * hh);
      const subInv = new Uint8Array(ww * hh);
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < ww; x++) {
          const v = raw[(y + fy0) * w + x + fx0];
          sub[y * ww + x] = v;
          subInv[y * ww + x] = v ? 0 : 1;
        }
      }
      const dInside = edt(subInv, ww, hh);
      const core = new Uint8Array(ww * hh);
      for (let i = 0; i < ww * hh; i++) core[i] = dInside[i] > 9 / s ? 1 : 0;
      // 몸통 둘레에 14px 간격으로 반지름 9~12.5px 둥근 혹
      const cv = document.createElement('canvas');
      cv.width = ww;
      cv.height = hh;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#000';
      const SP = 14 / s;
      const grid = new Map();
      const edge = [];
      for (let y = 1; y < hh - 1; y++) {
        for (let x = 1; x < ww - 1; x++) {
          const i = y * ww + x;
          if (core[i] && (!core[i - 1] || !core[i + 1] || !core[i - ww] || !core[i + ww])) edge.push(i);
        }
      }
      for (let k = edge.length - 1; k > 0; k--) {
        const j = Math.floor(rnd() * (k + 1));
        const t = edge[k];
        edge[k] = edge[j];
        edge[j] = t;
      }
      for (const i of edge) {
        const x = i % ww;
        const y = (i - x) / ww;
        const gx = Math.floor(x / SP);
        const gy = Math.floor(y / SP);
        let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dx = -1; dx <= 1 && ok; dx++) {
            for (const [px, py] of grid.get(`${gx + dx},${gy + dy}`) || []) {
              if ((px - x) ** 2 + (py - y) ** 2 < SP * SP) {
                ok = false;
                break;
              }
            }
          }
        }
        if (!ok) continue;
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([x, y]);
        const r = (9 + rnd() * 3.5) / s;
        cx.beginPath();
        cx.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2);
        cx.fill();
      }
      const bumps = cx.getImageData(0, 0, ww, hh).data;
      for (let y = 0; y < hh; y++) {
        for (let x = 0; x < ww; x++) {
          const i = y * ww + x;
          const p = (y + fy0) * w + x + fx0;
          // 물가 쪽은 해안선이 맡으므로 물까지 꽉
          const v = core[i] || bumps[i * 4 + 3] > 127 || (sub[i] && dLand[p] <= 14 / s);
          if (v && land[p]) forest[p] = 1;
        }
      }
      // 나무 머리 자리: 열린 반원 호 (행 15px, 열 21px 엇갈림, 빈자리는 낮은 잡음으로)
      const fInv = new Uint8Array(ww * hh);
      for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) fInv[y * ww + x] = forest[(y + fy0) * w + x + fx0] ? 0 : 1;
      const dF = edt(fInv, ww, hh);
      const RY = 15;
      const RX = 21;
      let row = 0;
      for (let ty = 0; ty < hh * s; ty += RY) {
        const off = row++ % 2 ? RX / 2 : 0;
        for (let tx = off; tx < ww * s; tx += RX) {
          const jx = tx + (rnd() * 2 - 1) * 5;
          const jy = ty + (rnd() * 2 - 1) * 3;
          const ix = Math.floor(jx / s);
          const iy = Math.floor(jy / s);
          if (ix < 0 || iy < 0 || ix >= ww || iy >= hh || dF[iy * ww + ix] <= 6 / s) continue;
          const dens = clamp(nz.forest[(iy + fy0) * w + ix + fx0], 0, 1.2);
          if (rnd() < 0.16 + 0.22 * dens) continue;
          const r = 6.5 + rnd() * 3;
          const a0 = ((182 + rnd() * 18) * Math.PI) / 180;
          const a1 = ((340 + rnd() * 18) * Math.PI) / 180;
          trees.push([fx0 * s + jx, fy0 * s + jy, r, a0, a1]);
        }
      }
      fwin = [fx0, fy0, fx1, fy1];
    }

    // 3) 바탕 색 (칸 크기로) : 땅 종이 · 바다 깊이 · 숲 바탕 · 종이 결 · 가장자리 그늘
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(w, h);
    const D = img.data;
    for (let y = 0; y < h; y++) {
      const vy = (y / h - 0.5) ** 2 * 1.6;
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const pl = nz.paper[p];
        let r;
        let gg;
        let b;
        if (forest[p]) {
          const fn = nz.forest[p];
          r = TER.FOREST[0] + fn * 3;
          gg = TER.FOREST[1] + fn * 3;
          b = TER.FOREST[2] + fn * 2;
        } else if (land[p]) {
          const inl = Math.min(1, (dLand[p] * s) / 900);
          r = TER.LAND[0] - 6 * inl + pl * 3.5;
          gg = TER.LAND[1] - 7 * inl + pl * 3.5;
          b = TER.LAND[2] - 9 * inl + pl * 3.5;
        } else {
          const ds = dSea[p] * s;
          const t1 = Math.min(1, ds / 70);
          const t2 = Math.pow(clamp((ds - 70) / 500, 0, 1), 0.8);
          r = (TER.SHALLOW[0] * (1 - t1) + TER.MID[0] * t1) * (1 - t2) + TER.DEEP[0] * t2 + pl * 1.5;
          gg = (TER.SHALLOW[1] * (1 - t1) + TER.MID[1] * t1) * (1 - t2) + TER.DEEP[1] * t2 + pl * 1.5;
          b = (TER.SHALLOW[2] * (1 - t1) + TER.MID[2] * t1) * (1 - t2) + TER.DEEP[2] * t2 + pl * 1.5;
        }
        const vig = (x / w - 0.5) ** 2 * 1.2 + vy;
        const k = (1 + (rnd() * 2 - 1) * 0.022) * (1 - clamp(vig - 0.15, 0, 1) * 0.25);
        const i = p * 4;
        D[i] = r * k;
        D[i + 1] = gg * k;
        D[i + 2] = b * k;
        D[i + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, W, H);

    // 4) 물결선 두 줄 (큰 땅에서 13px, 30px) + 먼바다 홑 호
    for (const [dist, alpha, wdt] of [[13, 0.42, 1.1], [30, 0.2, 0.9]]) {
      const segs = contourSegs(dBig, w, h, dist / s, (x, y) => sea[y * w + x] && dSea[y * w + x] * s > dist * 0.6);
      strokeSegs(ctx, segs, s, `rgba(${TER.RIPPLE.join(',')},${alpha})`, wdt);
    }
    ctx.strokeStyle = TER.WAVE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const G = 190;
    for (let gy = G / 2; gy < H; gy += G) {
      for (let gx = G / 2; gx < W; gx += G) {
        const x = gx + (rnd() * 2 - 1) * G * 0.4;
        const y = gy + (rnd() * 2 - 1) * G * 0.4;
        const r = 10 + rnd() * 3;
        const skip = rnd() > 0.55;
        const ix = Math.floor(x / s);
        const iy = Math.floor(y / s);
        if (skip || ix < 0 || iy < 0 || ix >= w || iy >= h || dSea[iy * w + ix] * s < 110) continue;
        ctx.moveTo(x + r * Math.cos((200 * Math.PI) / 180), y + r * 0.75 * Math.sin((200 * Math.PI) / 180));
        ctx.ellipse(x, y, r, r * 0.75, 0, (200 * Math.PI) / 180, (340 * Math.PI) / 180);
      }
    }
    ctx.stroke();

    // 5) 숲: 나무 머리 + 땅 쪽 테두리
    if (trees.length) {
      ctx.strokeStyle = TER.ARCH;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [x, y, r, a0, a1] of trees) {
        ctx.moveTo(x + r * Math.cos(a0), y + r * Math.sin(a0));
        ctx.arc(x, y, r, a0, a1);
      }
      ctx.stroke();
    }
    if (fwin) {
      const [x0, y0, x1, y1] = fwin;
      const ww = x1 - x0 + 1;
      const hh = y1 - y0 + 1;
      const ff = new Float32Array(ww * hh);
      for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) ff[y * ww + x] = forest[(y + y0) * w + x + x0];
      const fs = blurField(ff, ww, hh, 1);
      const segs = contourSegs(fs, ww, hh, 0.5, (x, y) => dLand[(y + y0) * w + x + x0] * s > 5);
      for (let i = 0; i < segs.length; i += 2) {
        segs[i] += x0;
        segs[i + 1] += y0;
      }
      strokeSegs(ctx, segs, s, TER.FLINE, 3);
    }

    // 땅 위에만 그리는 것들을 위한 땅 마스크 (필요할 때 한 번만)
    let landCv = null;
    const getLandCv = () => {
      if (landCv) return landCv;
      landCv = document.createElement('canvas');
      landCv.width = w;
      landCv.height = h;
      const lctx = landCv.getContext('2d');
      const li = lctx.createImageData(w, h);
      for (let p = 0; p < N; p++) li.data[p * 4 + 3] = land[p] ? 255 : 0;
      lctx.putImageData(li, 0, 0);
      return landCv;
    };
    const onLand = (pts, pad, draw) => {
      const bx0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[0])) - pad));
      const by0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[1])) - pad));
      const bx1 = Math.min(W, Math.ceil(Math.max(...pts.map((q) => q[0])) + pad));
      const by1 = Math.min(H, Math.ceil(Math.max(...pts.map((q) => q[1])) + pad));
      if (bx1 <= bx0 || by1 <= by0) return;
      const tc = document.createElement('canvas');
      tc.width = bx1 - bx0;
      tc.height = by1 - by0;
      const tctx = tc.getContext('2d');
      tctx.translate(-bx0, -by0);
      draw(tctx);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(getLandCv(), bx0 / s, by0 / s, (bx1 - bx0) / s, (by1 - by0) / s, 0, 0, bx1 - bx0, by1 - by0);
      ctx.drawImage(tc, bx0, by0);
    };

    // 6) 해안선 먹
    strokeSegs(ctx, contourSegs(F, w, h, 0), s, TER.INK, 3.2);

    // 7) 영역: 옅은 속 → (재해 지대) → 안쪽 색띠 + 바깥선
    const places = this.regions
      .filter((r) => isPlace(r) && r.pts.length >= 3)
      .map((r) => {
        const xs = r.pts.map((q) => q[0]);
        const ys = r.pts.map((q) => q[1]);
        const small = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 70;
        return { small, shape: detailPts(r) };
      });
    // 7a) 옅은 속 (작은 영역은 꽉 찬 색)
    for (const p of places) {
      ctx.save();
      polyPath(ctx, p.shape, 1);
      ctx.clip();
      ctx.fillStyle = p.small ? TER.RSOLID : TER.RFILL;
      ctx.fill();
      ctx.restore();
    }
    // 자국(골)들: 위 판에서 내려온 것도 같이
    const lines = [...this.inherited, ...this.regions.filter(isLine)].filter((r) => r.pts.length >= 2);
    // 7a-1) 강: 발원지에서 하구로 굵어지는 물길 (땅 위에만, 영역 속 위 · 경계선 아래, 위 판에서 내려온 것도)
    for (const r of [...this.inherited, ...this.regions].filter(isRiver)) {
      if (r.pts.length < 2) continue;
      const seed = [...r.name].reduce((hh, ch) => hashInt(hh, ch.codePointAt(0)), 31);
      onLand(r.pts, Math.max(r.w0 || 3, r.w1 || 12) * 2 + 30, (c) => drawRiver(c, r, seed));
    }
    // 7b) 재해 지대: 땅의 생김새는 그대로, 겉이 쓸려 나간 자리 (땅 위에만)
    for (const r of this.regions.filter(isWreck)) {
      if (r.pts.length < 3) continue;
      const seed = [...r.name].reduce((hh, ch) => hashInt(hh, ch.codePointAt(0)), 23);
      onLand(detailPts({ ...r, detail: r.detail || 0.6 }), 20, (c) => drawWreck(c, r, seed, lines));
    }
    // 7c) 안쪽 색띠 + 뾰족한 모서리의 바깥선 (재해 지대 위로 경계가 또렷하게)
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 10;
    for (const p of places) {
      ctx.save();
      polyPath(ctx, p.shape, 1);
      ctx.clip();
      if (!p.small) {
        ctx.strokeStyle = TER.RBAND;
        ctx.lineWidth = 32;
        ctx.stroke();
      }
      ctx.strokeStyle = TER.RLINE;
      ctx.lineWidth = p.small ? 4.4 : 6; // 안쪽 절반만 보임 → 2.2px / 3px
      ctx.stroke();
      ctx.restore();
    }
    ctx.lineJoin = 'round';

    // 7-1) 자국(골): 땅 위에만, 영역 위에 (재해 자국이 경계를 가로질러요)
    for (const r of lines.filter(isTrench)) {
      const pad = Math.max(r.w0 || 8, r.w1 || 1) * 1.6 + 12;
      const seed = [...r.name].reduce((hh, ch) => hashInt(hh, ch.codePointAt(0)), 11);
      onLand(r.pts, pad, (c) => drawTrench(c, r, seed));
    }

    // 7-2) 길
    for (const r of [...this.inherited, ...this.regions].filter(isRoad)) if (r.pts.length >= 2) drawRoad(ctx, r);
    // 7-3) 산 · 언덕: 뒤(위)에서 앞(아래)으로
    if (opts.marks !== false) for (const m of [...(this.marks || [])].sort((a, b) => a.y - b.y)) drawMark(ctx, m);

    // 8) 테두리 · 나침반 · 제목판
    if (this.deco) drawDeco(ctx, W, H, this.title, this.subtitle);
  }
}

function drawDeco(ctx, W, H, title, subtitle) {
  const ink = 'rgb(70,50,36)';
  const red = 'rgb(150,70,55)';
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 6;
  ctx.strokeRect(46, 46, W - 92, H - 92);
  ctx.strokeStyle = red;
  ctx.lineWidth = 2;
  ctx.strokeRect(64, 64, W - 128, H - 128);
  // 나침반
  const cx = W - 420;
  const cy = H - 440;
  const r = 250;
  const tri = (pts, fill, line) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (line) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };
  const P = (a, k) => [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)];
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 2) * k - Math.PI / 4;
    tri([P(a, 0.62), P(a - Math.PI / 4, 0.12), [cx, cy]], 'rgb(150,112,82)');
    tri([P(a, 0.62), P(a + Math.PI / 4, 0.12), [cx, cy]], 'rgb(232,216,186)', ink);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = red;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  for (let k = 0; k < 4; k++) {
    const a = (Math.PI / 2) * k - Math.PI / 2;
    tri([P(a, 1), P(a - Math.PI / 4, 0.16), [cx, cy]], 'rgb(96,40,32)');
    tri([P(a, 1), P(a + Math.PI / 4, 0.16), [cx, cy]], 'rgb(240,226,198)', ink);
  }
  ctx.fillStyle = 'rgb(120,40,32)';
  ctx.font = `${Math.round(r * 0.32)}px Batang, "바탕", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('N', cx, cy - r - r * 0.12);
  // 제목판
  const bx0 = 150;
  const by0 = H - 520;
  const bx1 = 1150;
  const by1 = H - 150;
  ctx.fillStyle = 'rgb(238,226,200)';
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 5;
  ctx.strokeRect(bx0 + 2.5, by0 + 2.5, bx1 - bx0 - 5, by1 - by0 - 5);
  ctx.strokeStyle = red;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx0 + 16, by0 + 16, bx1 - bx0 - 32, by1 - by0 - 32);
  ctx.fillStyle = 'rgb(52,36,26)';
  ctx.font = '150px Batang, "바탕", serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title || '', (bx0 + bx1) / 2, by0 + 78);
  ctx.fillStyle = red;
  ctx.font = '46px Batang, "바탕", serif';
  ctx.fillText(subtitle || '', (bx0 + bx1) / 2, by0 + 262);
  ctx.restore();
}

class SekaipanPlugin extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    if (saved.mapPath && !saved.maps) saved.maps = [{ name: '지도', path: saved.mapPath }]; // v0.1 설정 옮기기
    delete saved.mapPath;
    this.settings = Object.assign({}, DEFAULTS, saved);
    this.registerView(VIEW_TYPE, (leaf) => new SekaiView(leaf, this));
    this.registerView(STORY_TYPE, (leaf) => new StoryView(leaf, this));
    this.addRibbonIcon('map', '세계판 열기', () => this.openView());
    this.addRibbonIcon('book-open', '펼쳐지는 마을 열기', () => this.openView(STORY_TYPE));
    this.addCommand({ id: 'open', name: '세계판 열기', callback: () => this.openView() });
    this.addCommand({ id: 'open-storybook', name: '펼쳐지는 마을 열기', callback: () => this.openView(STORY_TYPE) });
    this.addSettingTab(new SekaiSettings(this.app, this));
  }

  async openView(type = VIEW_TYPE) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.reload?.();
  }

  /** 노트의 `지도` 값 → 설정에 있는 지도 이름 (없으면 첫 지도) */
  mapOf(fm) {
    const name = linkpath(fm['지도']);
    const maps = this.settings.maps;
    return (name && maps.find((m) => m.name === name)?.name) || maps[0]?.name || '';
  }

  /** 보관소 전체에서 지역과 인물을 모아요. */
  collect() {
    const { vault, metadataCache } = this.app;
    const places = [];
    const people = [];
    for (const file of vault.getMarkdownFiles()) {
      const fm = metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const base = { file, name: file.basename, aliases: asArray(fm.aliases).map(String), fm };
      if (fm['분류'] === KIND.place) {
        const pl = { ...base, kind: 'place', xy: coords(fm['좌표']), map: this.mapOf(fm), area: fm['표식'] === '영역', capital: fm['표식'] === '수도' };
        // 건물: 그림을 지도 위 제자리에 지도 크기대로 (링크 [[그림]] 또는 보관소 경로)
        if (fm['표식'] === '건물' && fm['그림']) {
          const raw = String(fm['그림']);
          const lp = linkpath(raw);
          const f = lp ? metadataCache.getFirstLinkpathDest(lp, file.path) : null;
          pl.icon = f ? vault.getResourcePath(f) : /[\/]/.test(raw) ? vault.adapter.getResourcePath(raw.replace(/^"|"$/g, '')) : null;
          pl.iconW = Number(fm['크기']) > 0 ? Number(fm['크기']) : 300;
        }
        places.push(pl);
      } else if (fm['분류'] === KIND.person) people.push({ ...base, kind: 'person' });
    }
    const placeByPath = new Map(places.map((p) => [p.file.path, p]));
    for (const p of people) {
      const lp = linkpath(p.fm['위치']);
      const dest = lp ? metadataCache.getFirstLinkpathDest(lp, p.file.path) : null;
      p.place = dest ? placeByPath.get(dest.path) || null : null;
      p.placeLabel = dest ? dest.basename : lp;
      p.doing = p.fm['하는 일'] != null ? String(p.fm['하는 일']) : '';
      p.when = p.fm['시점'] != null ? String(p.fm['시점']) : '';
      const ip = linkpath(p.fm['초상']);
      const img = ip ? metadataCache.getFirstLinkpathDest(ip, p.file.path) : null;
      p.portrait = img ? vault.getResourcePath(img) : null;
      p.xy = (p.place && p.place.xy) || coords(p.fm['좌표']);
      p.map = p.place ? p.place.map : this.mapOf(p.fm);
    }
    return { places, people };
  }

  linkTo(file, sourcePath = '') {
    return `[[${this.app.metadataCache.fileToLinktext(file, sourcePath, true)}]]`;
  }

  async movePerson(person, place) {
    if (person.place === place) return false;
    const from = person.place ? this.linkTo(person.place.file) : person.placeLabel || '어딘가';
    await this.app.fileManager.processFrontMatter(person.file, (fm) => {
      fm['위치'] = this.linkTo(place.file, person.file.path);
    });
    await this.log(`${this.linkTo(person.file)} 이동 · ${from} → ${this.linkTo(place.file)}`);
    new Notice(`${person.name} → ${place.name}`);
    return true;
  }

  async setPlaceXY(place, xy, mapName) {
    await this.app.fileManager.processFrontMatter(place.file, (fm) => {
      if (mapName) fm['지도'] = mapName;
      fm['좌표'] = [Math.round(xy[0]), Math.round(xy[1])];
    });
  }

  async createPlace(name, xy, mapName) {
    const folder = this.settings.placeFolder.replace(/\/+$/, '');
    const safe = name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!safe) return null;
    const path = `${folder ? folder + '/' : ''}${safe}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`이미 있는 노트예요: ${path}`);
      return null;
    }
    await this.ensureFolder(folder);
    const [x, y] = xy.map(Math.round);
    return this.app.vault.create(
      path,
      `---\n분류: ${KIND.place}\n세계: \n상위: \n지도: ${mapName}\n좌표: [${x}, ${y}]\n정리: 뼈대\n공개: 작가\n---\n\n`,
    );
  }

  async ensureFolder(path) {
    if (!path) return;
    let cur = '';
    for (const part of path.split('/')) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur);
    }
  }

  /** 기록 폴더의 오늘 날짜 노트 끝에 한 줄 덧붙여요. */
  async log(line) {
    const { date, time } = now();
    const folder = this.settings.logFolder.replace(/\/+$/, '');
    await this.ensureFolder(folder);
    const path = `${folder ? folder + '/' : ''}${date}.md`;
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      file = await this.app.vault.create(path, `---\n분류: 기록\n날짜: ${date}\n---\n\n# ${date}\n`);
    }
    await this.app.vault.process(file, (text) => {
      const body = text.replace(/\s*$/, '');
      const sep = /\n- [^\n]*$/.test(body) ? '\n' : '\n\n';
      return `${body}${sep}- ${time} ${line}\n`;
    });
  }
}

/** 펼쳐지는 마을: 세계판 창의 그림책 페이지(.도구/창/popup)를 옵시디언 안에 액자로 그대로 띄움.
 *  액자에 주소(src)를 주면 옵시디언이 그 안에서 부르는 그림을 모두 막아서(ERR_BLOCKED_BY_CLIENT), 페이지 글을 읽어 srcdoc 으로 넣고
 *  <base> 로 그림 자리를 알려 줌 (srcdoc 은 옵시디언 창과 같은 출처라 그림을 부를 수 있음).
 *  보관소 읽기·쓰기는 플러그인이 대신 함 (postMessage, 정해 둔 파일만) */
class StoryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return STORY_TYPE;
  }

  getDisplayText() {
    return '펼쳐지는 마을';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mnsk-story');
    const ad = this.app.vault.adapter;
    let html;
    try {
      html = await ad.read(STORY_PAGE);
    } catch (err) {
      root.createDiv({ text: '그림책 페이지를 찾지 못했어요: ' + STORY_PAGE });
      return;
    }
    const base = ad.getResourcePath(STORY_PAGE).split('?')[0].replace(/[^/]*$/, ''); // 페이지가 있는 폴더 (그림은 여기서 상대 주소로)
    const head = `<head><base href="${base}"><script>window.MN_OBS = true;</` + 'script>';
    this.frame = root.createEl('iframe', { cls: 'mnsk-story-frame' });
    this.frame.srcdoc = html.replace(/<head>/i, head);
    this.registerDomEvent(window, 'message', async (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      const m = e.data || {};
      const reply = (msg) => this.frame?.contentWindow?.postMessage(msg, '*');
      const vault = this.app.vault;
      if (m.mn === 'read') {
        let text = null;
        try {
          if ((STORY_READ.test(m.path) || STORY_NOTES.test(m.path)) && (await ad.exists(m.path))) text = await ad.read(m.path);
        } catch (err) {
          console.error('[펼쳐지는 마을] 읽기 실패', m.path, err);
        }
        reply({ mn: 'read', id: m.id, text });
      } else if (m.mn === 'list') {
        // 기록 · 그림 노트 목록 (속성 포함)
        const items = [];
        for (const f of vault.getMarkdownFiles()) {
          if (!STORY_NOTES.test(f.path) || !(m.prefixes || []).some((px) => f.path.startsWith(px))) continue;
          let fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
          if (!fm) { try { fm = quickFm(await vault.cachedRead(f)); } catch (err) { fm = {}; } }
          items.push({ path: f.path, fm: JSON.parse(JSON.stringify(fm || {})) });
        }
        reply({ mn: 'list', id: m.id, items });
      } else if (m.mn === 'note') {
        // 노트 만들기 · 고쳐 쓰기 (정해 둔 폴더의 .md 만, 없는 폴더는 만듦)
        let ok = false;
        if (STORY_NOTES.test(m.path) && typeof m.text === 'string') {
          try {
            const parts = m.path.split('/');
            for (let i = 1; i < parts.length; i++) {
              const dir = parts.slice(0, i).join('/');
              if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
            }
            const f = vault.getAbstractFileByPath(m.path);
            if (f && vault.modify) await vault.modify(f, m.text);
            else if (f) await ad.write(m.path, m.text);
            else await vault.create(m.path, m.text);
            ok = true;
          } catch (err) {
            new Notice('펼쳐지는 마을: 노트를 쓰지 못했어요 — ' + err.message);
          }
        }
        reply({ mn: 'note', id: m.id, ok });
      } else if (m.mn === 'open') {
        if (STORY_NOTES.test(m.path)) this.app.workspace.openLinkText?.(m.path, '', 'tab');
      } else if (m.mn === 'save') {
        if (!STORY_WRITE.test(m.path) || typeof m.text !== 'string') return;
        try {
          await ad.write(m.path, m.text);
        } catch (err) {
          new Notice('펼쳐지는 마을: 저장하지 못했어요 — ' + err.message);
        }
      }
    });
  }

  async onClose() {
    this.frame = null;
  }
}

class SekaiView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.s = 1;
    this.tx = 0;
    this.ty = 0;
    this.minS = 0.05;
    this.W = 0;
    this.H = 0;
    this.fitted = false;
    this.mode = 'view'; // view | stamp
    this.selected = null; // 선택한 노트 경로
    this.moveTarget = null; // 옮길 지역을 기다리는 인물
    this.data = { places: [], people: [] }; // 모든 지도
    this.here = { places: [], people: [] }; // 지금 펼친 지도
    this.mapName = plugin.settings.maps[0]?.name || '';
    this.afterLoad = null; // 지도를 바꾼 뒤 할 일 (찾은 인물에게 날아가기)
    this.hits = [];
    this.cursor = 0;
    // 땅 칠하기
    this.lands = null; // 지금 지도의 Lands
    this.landsPath = null;
    this.brush = { k: 1, tool: 'brush', radius: 70 }; // radius: 지도 px
    this.undo = [];
    this.spaceDown = false;
    // 지형 그리기
    this.terrain = null; // 지금 지도의 Terrain
    this.terrainPath = null;
    this.tool = { kind: 'land', radius: 40, markSize: {} }; // land | sea | forest | unforest | region | zoom | mtn | hill | pick, radius: 지도 px
    this.markSel = -1; // 고르기로 고른 산 · 언덕
    this.tundo = [];
    this.regionSel = -1; // 고르고 있는 영역
    this.draft = null; // 새로 그리는 영역 { name, pts }
    this.terrainDirty = false; // 지도 그림으로 아직 안 구운 바뀜
    this.under = { on: false, alpha: 0.5 }; // 밑그림 겹쳐 보기
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return '세계판';
  }

  getIcon() {
    return 'map';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('mnsk');
    this.stage = root.createDiv({ cls: 'mnsk-stage' });
    this.layer = this.stage.createDiv({ cls: 'mnsk-layer' });
    this.mapImg = this.layer.createEl('img', { cls: 'mnsk-map', attr: { draggable: 'false', alt: '' } });
    this.terrainCanvas = this.layer.createEl('canvas', { cls: 'mnsk-terrain is-hidden' });
    this.markCanvas = this.layer.createEl('canvas', { cls: 'mnsk-terrain mnsk-marks is-hidden' }); // 산 · 언덕 (지형과 따로)
    this.sketchCanvas = this.layer.createEl('canvas', { cls: 'mnsk-terrain mnsk-sketch is-hidden' }); // 스케치 (지도 크기의 절반)
    this.sketch = { ink: 'urban', radius: 60, alpha: 0.8, note: '', busy: false, cands: [], undo: [] };
    this.underImg = this.layer.createEl('img', { cls: 'mnsk-under is-hidden', attr: { draggable: 'false', alt: '' } });
    this.landCanvas = this.layer.createEl('canvas', { cls: 'mnsk-lands' });
    this.previewCanvas = this.layer.createEl('canvas', { cls: 'mnsk-lands-preview' });
    this.regionSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.regionSvg.setAttribute('class', 'mnsk-regions is-hidden');
    this.layer.appendChild(this.regionSvg);
    this.pinLayer = this.layer.createDiv({ cls: 'mnsk-pins' });
    this.brushRing = this.stage.createDiv({ cls: 'mnsk-brush is-hidden' });
    this.msg = root.createDiv({ cls: 'mnsk-msg' });
    this.buildSearch(root);
    this.mapTabs = root.createDiv({ cls: 'mnsk-maps' });
    this.card = root.createDiv({ cls: 'mnsk-card is-hidden' });
    this.paintPanel = root.createDiv({ cls: 'mnsk-paint is-hidden' });
    this.buildBar(root);
    this.banner = root.createDiv({ cls: 'mnsk-banner is-hidden' });
    this.bindStage();

    const soon = () => this.refreshSoon();
    this.registerEvent(this.app.metadataCache.on('changed', soon));
    this.registerEvent(this.app.metadataCache.on('resolved', soon));
    this.registerEvent(this.app.vault.on('rename', soon));
    this.registerEvent(this.app.vault.on('delete', soon));
    this.registerEvent(this.app.vault.on('modify', (f) => this.onFileModified(f)));
    this.registerDomEvent(document, 'keydown', (e) => {
      if (this.app.workspace.getActiveViewOfType(SekaiView) !== this) return;
      if (e.target instanceof HTMLElement && e.target.closest('.modal-container')) return;
      const terrain = this.mode === 'terrain' && this.terrain;
      if (!(e.target instanceof HTMLInputElement) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '+' || e.key === '=') {
          this.zoomCenter(1.4);
          e.preventDefault();
          return;
        }
        if (e.key === '-' || e.key === '_') {
          this.zoomCenter(1 / 1.4);
          e.preventDefault();
          return;
        }
        if (e.key === '0') {
          this.fit();
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (terrain && this.draft) this.cancelDraft();
        else this.cancelModes();
      }
      if ((this.mode !== 'paint' && this.mode !== 'sketch' && !terrain) || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const sketching = this.mode === 'sketch';
      if (e.key === ' ') {
        this.spaceDown = true;
        this.stage.addClass('is-pan-ready');
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (terrain) this.undoTerrain();
        else if (sketching) this.undoSketch();
        else this.undoPaint();
        e.preventDefault();
      } else if (e.key === '[' || e.key === ']') {
        const k = e.key === ']' ? 1.2 : 1 / 1.2;
        if (terrain) this.tool.radius = clamp(this.tool.radius * k, 4, 400);
        else if (sketching) this.sketch.radius = clamp(this.sketch.radius * k, 4, 600);
        else this.brush.radius = clamp(this.brush.radius * k, 8, 400);
        this.renderPaintPanel();
      } else if (terrain && this.draft && e.key === 'Enter') {
        this.finishDraft();
        e.preventDefault();
      } else if (terrain && !this.draft && this.tool.kind === 'pick' && this.markSel >= 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
        this.deleteMark(this.markSel);
        e.preventDefault();
      } else if (terrain && this.draft && e.key === 'Backspace') {
        this.draft.pts.pop();
        this.renderRegionSvg();
        e.preventDefault();
      } else if (!terrain && e.key.toLowerCase() === 'b') this.setTool('brush');
      else if (!terrain && e.key.toLowerCase() === 'e') this.setTool('erase');
    });
    this.registerDomEvent(document, 'keyup', (e) => {
      if (e.key === ' ') {
        this.spaceDown = false;
        this.stage.removeClass('is-pan-ready');
      }
    });
    this.register(() => {
      this.stopAnim();
      clearTimeout(this.timer);
    });
    this.reload();
  }

  onResize() {
    // 사용자가 아직 지도를 움직이지 않았으면 창 크기에 다시 맞춰요.
    if (this.W && (!this.fitted || !this.touched)) this.fit();
  }

  currentMap() {
    const maps = this.plugin.settings.maps;
    return maps.find((m) => m.name === this.mapName) || maps[0] || null;
  }

  reload() {
    const map = this.currentMap();
    this.mapName = map ? map.name : '';
    this.renderMapTabs();
    const file = map ? this.app.vault.getAbstractFileByPath(map.path) : null;
    if (!(file instanceof TFile)) {
      this.W = 0;
      this.mapImg.removeAttribute('src');
      this.showMsg(`지도 그림을 찾지 못했어요: ${map ? map.path : '(지도 없음)'}\n설정 → MN 세계판에서 지도를 고칠 수 있어요.`);
      this.refresh();
      return;
    }
    this.showMsg('');
    this.mapImg.onload = () => {
      if (this.silentSrc && this.mapImg.src === this.silentSrc) {
        this.silentSrc = null; // 구운 지도 그림으로 바꿔 끼운 것뿐 (다른 지도로 바꾼 거면 여기 안 걸림)
        return;
      }
      this.silentSrc = null;
      this.W = this.mapImg.naturalWidth;
      this.H = this.mapImg.naturalHeight;
      this.mapImg.style.width = `${this.W}px`;
      this.mapImg.style.height = `${this.H}px`;
      this.fitted = false;
      this.touched = false;
      if (!this.applyPendingView()) this.fit();
      this.refresh();
      this.loadLands(map);
      this.loadTerrain(map);
      const after = this.afterLoad;
      this.afterLoad = null;
      if (after) after();
    };
    this.mapImg.src = this.app.vault.getResourcePath(file);
  }

  /* ---------- 땅 나누기 ---------- */

  /** 땅 나누기 자료: 지도에 따로 적어 둔 곳(lands)이 있으면 거기, 없으면 지도 그림 이름 옆 */
  landsPathOf(map) {
    if (map.lands) return map.lands;
    return map.path.replace(/\.[^./]+$/, '').replace(/\.지형$/, '') + '.영역.json';
  }

  async loadLands(map) {
    this.lands = null;
    this.undo = [];
    this.landsPath = this.landsPathOf(map);
    this.landCanvas.width = this.landCanvas.height = 0;
    this.landCanvas.style.width = this.landCanvas.style.height = '0';
    const adapter = this.app.vault.adapter;
    let L = null;
    try {
      if (await adapter.exists(this.landsPath)) L = Lands.decode(JSON.parse(await adapter.read(this.landsPath)));
    } catch (err) {
      console.error('[MN 세계판] 영역 데이터를 읽지 못했어요', err);
      new Notice('영역 데이터를 읽지 못했어요: ' + this.landsPath);
    }
    if (!L || map.name !== this.mapName) {
      if (this.mode === 'paint') this.renderPaintPanel();
      return;
    }
    L.scale = this.W / L.w;
    this.lands = L;
    this.recomputeLands(true);
  }

  newLands() {
    const w = Math.ceil(this.W / 2);
    const h = Math.ceil(this.H / 2);
    const L = new Lands(w, h, this.W / w);
    this.lands = L;
    this.recomputeLands(true);
  }

  /** 칸을 (다시) 만들고 주인을 정해 그림. rebuild: 경계 설정이 바뀌었을 때 */
  recomputeLands(rebuild) {
    const L = this.lands;
    if (!L) return;
    this.setBusy(true);
    setTimeout(() => {
      try {
        if (rebuild || !L.cells) L.build();
        L.assign();
        this.drawLands();
      } catch (err) {
        console.error('[MN 세계판] 경계 계산 오류', err);
        new Notice('경계를 계산하다가 문제가 생겼어요.');
      }
      this.setBusy(false);
      if (this.mode === 'paint') this.renderPaintPanel();
      if (!this.card.hasClass('is-hidden')) this.renderCard();
    }, 20);
  }

  drawLands() {
    const L = this.lands;
    const cv = this.landCanvas;
    if (cv.width !== this.W || cv.height !== this.H) {
      cv.width = this.W;
      cv.height = this.H;
    }
    cv.style.width = `${this.W}px`;
    cv.style.height = `${this.H}px`;
    L.draw(cv);
  }

  setBusy(on) {
    this.contentEl.toggleClass('is-busy', on);
    if (this.busyEl) this.busyEl.toggleClass('is-hidden', !on);
  }

  saveLandsSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      if (!this.lands || !this.landsPath) return;
      try {
        await this.app.vault.adapter.write(this.landsPath, JSON.stringify(this.lands.encode()));
        this.savedAt = now().time;
        if (this.mode === 'paint') this.renderPaintPanel();
      } catch (err) {
        console.error('[MN 세계판] 영역 저장 실패', err);
        new Notice('영역을 저장하지 못했어요.');
      }
    }, 700);
  }

  setTool(tool) {
    this.brush.tool = tool;
    this.renderPaintPanel();
  }

  /** 붓질 시작 */
  beginStroke(e) {
    const L = this.lands;
    if (!L || !L.terr.length) {
      new Notice('먼저 오른쪽에서 칠할 땅을 고르거나 추가하세요.');
      return null;
    }
    const k = clamp(this.brush.k, 1, L.terr.length);
    this.undo.push(L.paint.slice());
    if (this.undo.length > 20) this.undo.shift();
    const pv = this.previewCanvas;
    pv.width = L.w;
    pv.height = L.h;
    pv.style.width = `${this.W}px`;
    pv.style.height = `${this.H}px`;
    const ctx = pv.getContext('2d');
    const erase = this.brush.tool === 'erase';
    ctx.fillStyle = erase ? 'rgba(46, 16, 16, 0.35)' : L.terr[k - 1].color;
    const stroke = { k, erase, force: e.altKey, ctx, last: null };
    this.strokeTo(stroke, e);
    return stroke;
  }

  strokeTo(stroke, e) {
    const L = this.lands;
    const [mx, my] = this.toMap(e.clientX, e.clientY);
    const x = mx / L.scale;
    const y = my / L.scale;
    const r = this.brush.radius / L.scale;
    const from = stroke.last || [x, y];
    const dist = Math.hypot(x - from[0], y - from[1]);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 3)));
    for (let i = stroke.last ? 1 : 0; i <= steps; i++) {
      const t = i / steps;
      const cx = from[0] + (x - from[0]) * t;
      const cy = from[1] + (y - from[1]) * t;
      L.stamp(cx, cy, r, stroke.k, stroke.erase, stroke.force);
      stroke.ctx.beginPath();
      stroke.ctx.arc(cx, cy, r, 0, Math.PI * 2);
      stroke.ctx.fill();
    }
    stroke.last = [x, y];
  }

  endStroke(stroke) {
    const L = this.lands;
    const pv = this.previewCanvas;
    pv.getContext('2d').clearRect(0, 0, pv.width, pv.height);
    const t = L.terr[stroke.k - 1];
    if (t && t.lock != null) L.fitArea(stroke.k, t.lock);
    this.recomputeLands(false);
    this.saveLandsSoon();
  }

  undoPaint() {
    const L = this.lands;
    const prev = this.undo.pop();
    if (!L || !prev) {
      new Notice('되돌릴 게 없어요.');
      return;
    }
    L.paint.set(prev);
    this.recomputeLands(false);
    this.saveLandsSoon();
  }

  moveBrushRing(e) {
    const ring = this.brushRing;
    const tb = this.mode === 'terrain' && this.terrain && this.tool.kind !== 'region' && this.tool.kind !== 'zoom' && this.tool.kind !== 'pick';
    if (this.mode === 'sketch' && this.W) {
      const r0 = this.stage.getBoundingClientRect();
      const d0 = this.sketchWidth() * this.s;
      ring.removeClass('is-hidden');
      ring.toggleClass('is-erase', this.sketch.ink === 'erase');
      ring.style.width = ring.style.height = `${d0}px`;
      ring.style.left = `${e.clientX - r0.left - d0 / 2}px`;
      ring.style.top = `${e.clientY - r0.top - d0 / 2}px`;
      return;
    }
    if (!tb && (this.mode !== 'paint' || !this.lands)) {
      ring.addClass('is-hidden');
      return;
    }
    const r = this.stage.getBoundingClientRect();
    const d = (tb ? this.tool.radius : this.brush.radius) * 2 * this.s;
    ring.removeClass('is-hidden');
    ring.toggleClass('is-erase', tb ? this.tool.kind === 'sea' || this.tool.kind === 'unforest' : this.brush.tool === 'erase');
    ring.style.width = ring.style.height = `${d}px`;
    ring.style.left = `${e.clientX - r.left - d / 2}px`;
    ring.style.top = `${e.clientY - r.top - d / 2}px`;
  }

  renderPaintPanel() {
    if (this.mode === 'terrain') {
      this.renderTerrainPanel();
      return;
    }
    if (this.mode === 'sketch') {
      this.renderSketchPanel();
      return;
    }
    const P = this.paintPanel;
    P.empty();
    P.toggleClass('is-hidden', this.mode !== 'paint');
    if (this.mode !== 'paint') return;
    const L = this.lands;
    const head = P.createDiv({ cls: 'mnsk-paint-head' });
    head.createDiv({ cls: 'mnsk-card-kind', text: '편집' });
    head.createDiv({ cls: 'mnsk-paint-title', text: '땅 칠하기' });
    this.busyEl = head.createDiv({ cls: 'mnsk-paint-busy is-hidden', text: '경계 계산 중…' });
    if (this.contentEl.hasClass('is-busy')) this.busyEl.removeClass('is-hidden');
    if (!L) {
      P.createDiv({ cls: 'mnsk-paint-empty', text: '이 지도에는 아직 나눈 땅이 없어요.' });
      const b = P.createEl('button', { cls: 'mnsk-btn is-primary', text: '땅 나누기 시작' });
      b.onclick = () => this.newLands();
      return;
    }
    // 땅 목록
    const sec = (label) => {
      const s = P.createDiv({ cls: 'mnsk-paint-sec' });
      s.createDiv({ cls: 'mnsk-paint-label', text: label });
      return s;
    };
    const list = sec('칠할 땅').createDiv({ cls: 'mnsk-terr-list' });
    L.terr.forEach((t, i) => {
      const k = i + 1;
      const row = list.createDiv({ cls: 'mnsk-terr' });
      row.toggleClass('is-active', this.brush.k === k);
      const sw = row.createDiv({ cls: 'mnsk-terr-sw' });
      sw.style.background = t.color;
      if (t.kind === '빗금') sw.addClass('is-hatch');
      row.createDiv({ cls: 'mnsk-terr-name', text: t.name });
      row.createDiv({ cls: 'mnsk-terr-area', text: `${L.percent(k).toFixed(2)}%` + (t.lock != null ? ' 🔒' : '') });
      row.onclick = () => {
        this.brush.k = k;
        this.renderPaintPanel();
      };
    });
    const add = P.createEl('button', { cls: 'mnsk-btn mnsk-terr-add', text: '+ 땅 추가' });
    add.onclick = () => new LandSuggest(this.app, this).open();
    // 도구
    const tools = sec('도구');
    const seg = tools.createDiv({ cls: 'mnsk-seg mnsk-seg-small' });
    for (const [tool, label] of [['brush', '붓 (B)'], ['erase', '지우개 (E)']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.brush.tool === tool);
      b.onclick = () => this.setTool(tool);
    }
    this.slider(tools, '붓 크기 ([ ])', 8, 400, 1, this.brush.radius, (v) => {
      this.brush.radius = v;
    }, (v) => `${Math.round(v)}`);
    // 넓이
    const cur = L.terr[this.brush.k - 1];
    if (cur) {
      const ar = sec('넓이');
      const line = ar.createDiv({ cls: 'mnsk-paint-area' });
      line.createSpan({ cls: 'mnsk-paint-area-name', text: cur.name });
      line.createSpan({ cls: 'mnsk-paint-area-val', text: `${L.percent(this.brush.k).toFixed(2)}%` });
      const lock = ar.createEl('button', { cls: 'mnsk-btn' + (cur.lock != null ? ' is-on' : ''), text: cur.lock != null ? '🔒 넓이 고정 중 (누르면 풀기)' : '넓이 고정' });
      lock.onclick = () => {
        cur.lock = cur.lock != null ? null : L.paintCount(this.brush.k);
        this.saveLandsSoon();
        this.renderPaintPanel();
      };
      if (cur.lock != null) ar.createDiv({ cls: 'mnsk-paint-hint', text: '고정한 넓이를 지키며 모양만 바뀌어요.' });
    }
    // 경계
    const bd = sec('경계');
    const S = L.settings;
    this.slider(bd, '자글자글함', 0, 1, 0.05, S.detail, null, (v) => `${Math.round(v * 100)}`, (v) => {
      S.detail = v;
      this.recomputeLands(true);
      this.saveLandsSoon();
    });
    this.slider(bd, '불규칙함', 0, 1, 0.05, S.irregular, null, (v) => `${Math.round(v * 100)}`, (v) => {
      S.irregular = v;
      this.recomputeLands(true);
      this.saveLandsSoon();
    });
    // 아래
    const foot = P.createDiv({ cls: 'mnsk-paint-foot' });
    const un = foot.createEl('button', { cls: 'mnsk-btn', text: '되돌리기 (Ctrl+Z)' });
    un.disabled = !this.undo.length;
    un.onclick = () => this.undoPaint();
    foot.createDiv({ cls: 'mnsk-paint-saved', text: this.savedAt ? `${this.savedAt} 저장됨` : '자동 저장' });
    P.createDiv({ cls: 'mnsk-paint-hint', text: '끌어서 칠하기 · 오른쪽 버튼이나 스페이스 누르고 끌면 지도 이동 · Alt 누르고 칠하면 다른 땅도 덮어써요' });
  }

  /** 이름 · 값 · 슬라이더 한 줄. onInput: 움직이는 동안, onChange: 놓았을 때 */
  slider(parent, label, min, max, step, value, onInput, fmt, onChange) {
    const row = parent.createDiv({ cls: 'mnsk-slider' });
    const top = row.createDiv({ cls: 'mnsk-slider-top' });
    top.createSpan({ text: label });
    const val = top.createSpan({ cls: 'mnsk-slider-val', text: fmt(value) });
    const input = row.createEl('input', { type: 'range', attr: { min, max, step } });
    input.value = String(value);
    input.oninput = () => {
      val.setText(fmt(Number(input.value)));
      if (onInput) onInput(Number(input.value));
    };
    if (onChange) input.onchange = () => onChange(Number(input.value));
  }

  /** 땅 추가 (지역 노트 이름 또는 빗금 구역) */
  addTerritory(name, kind) {
    const L = this.lands;
    if (!L) return;
    if (L.terr.length >= 250) {
      new Notice('땅은 250개까지 만들 수 있어요.');
      return;
    }
    if (L.terr.some((t) => t.name === name)) {
      new Notice('이미 있는 땅이에요.');
      return;
    }
    L.terr.push({ name, kind, color: kind === '빗금' ? '#5f8aa0' : L.nextColor(), lock: null });
    this.brush.k = L.terr.length;
    this.recomputeLands(false);
    this.saveLandsSoon();
  }

  territoryOf(place) {
    const L = this.lands;
    if (!L || !place) return 0;
    return L.terr.findIndex((t) => t.name === place.name) + 1;
  }

  switchMap(name, after) {
    if (this.mode === 'sketch' && name !== this.mapName) this.setMode('view'); // 스케치는 판마다 따로: 판을 바꾸면 스케치에서 나옴
    if (name === this.mapName && this.W) {
      if (after) after();
      return;
    }
    this.flushTerrainSave();
    this.mapName = name;
    this.afterLoad = after || null;
    this.moveTarget = null;
    this.selected = null; // 다른 지도의 카드가 남지 않게
    this.renderCard();
    this.hideBanner();
    this.reload();
  }

  renderMapTabs() {
    const maps = this.plugin.settings.maps;
    this.mapTabs.empty();
    this.mapTabs.toggleClass('is-hidden', maps.length < 2);
    const cur = this.currentMap();
    // 지금 판까지의 길: 맨 위 지도 → … → 지금 판
    const chain = [];
    for (let m = cur, guard = 0; m && guard < 20; m = m.parent ? maps.find((x) => x.name === m.parent) : null, guard++) chain.unshift(m);
    const root = chain[0];
    for (const m of maps.filter((x) => !x.parent)) {
      const b = this.mapTabs.createEl('button', { text: m.name });
      b.toggleClass('is-active', root && m.name === root.name);
      b.toggleClass('is-path', root && m.name === root.name && chain.length > 1);
      b.onclick = () => (cur && cur.parent === m.name ? this.exitToParent(m.name) : this.switchMap(m.name));
    }
    for (const m of chain.slice(1)) {
      this.mapTabs.createSpan({ cls: 'mnsk-maps-sep', text: '›' });
      const b = this.mapTabs.createEl('button', { text: m.name });
      b.toggleClass('is-active', m.name === this.mapName);
      b.onclick = () => (cur && cur.parent === m.name ? this.exitToParent(m.name) : this.switchMap(m.name));
    }
  }

  /** 이 자리의 영역과, 그 영역의 판 (없으면 map: null) */
  regionAt(xy) {
    const T = this.terrain;
    const cur = this.currentMap();
    if (!T || !cur) return null;
    for (let i = T.regions.length - 1; i >= 0; i--) {
      const r = T.regions[i];
      if (!isPlace(r) || r.pts.length < 3 || r.name === cur.region || !inPoly(xy, r.pts)) continue;
      const map = this.plugin.settings.maps.find((m) => m.parent === cur.name && m.region === r.name) || null;
      return { region: r, map };
    }
    return null;
  }

  /** 이 판에 있는 지역 표식(노트)의 판 (없으면 null) */
  placeMapOf(pl) {
    const cur = this.currentMap();
    return cur && pl ? this.plugin.settings.maps.find((m) => m.parent === cur.name && m.place === pl.name) || null : null;
  }

  /** 지역 표식 둘레의 3:2 창 (지도 폭의 6%, 수도·도시 하나를 크게 볼 만큼) */
  placeWindowOf(xy) {
    const ww = this.W * 0.06;
    const wh = ww / 1.5;
    return [xy[0] - ww / 2, xy[1] - wh / 2, ww, wh];
  }

  /** 지역 표식에서 새 판 만들기 */
  createPlaceMap(pl) {
    if (!pl || !pl.xy || !this.terrain) return;
    this.select(null);
    this.createChildMap({ name: pl.name, pts: [] }, { place: pl.name, window: this.placeWindowOf(pl.xy), subtitle: pl.capital ? '수 도  지 도' : '지 역  지 도' });
  }

  /** 영역 둘레에 여유를 둔 3:2 창 (지도 px). 아래 판은 이 창을 그대로 키운 것 */
  childWindowOf(r) {
    const xs = r.pts.map((p) => p[0]);
    const ys = r.pts.map((p) => p[1]);
    let x0 = Math.min(...xs);
    let y0 = Math.min(...ys);
    let ww = Math.max(...xs) - x0;
    let wh = Math.max(...ys) - y0;
    const mg = Math.max(ww, wh) * 0.35;
    x0 -= mg;
    y0 -= mg;
    ww += mg * 2;
    wh += mg * 2;
    if (ww / wh > 1.5) {
      const nh = ww / 1.5;
      y0 -= (nh - wh) / 2;
      wh = nh;
    } else {
      const nw = wh * 1.5;
      x0 -= (nw - ww) / 2;
      ww = nw;
    }
    return [x0, y0, ww, wh];
  }

  /** 영역의 판으로 들어가기: 위 판을 그 창까지 확대해 들어간 뒤, 같은 자리에 아래 판을 겹쳐 바꿈 */
  async enterChild(map, region) {
    if (this.transitioning) return;
    const win = map.window || (region && region.pts.length >= 3 ? this.childWindowOf(region) : null);
    if (!win || !this.W) {
      this.switchMap(map.name);
      return;
    }
    this.transitioning = true;
    const v = this.viewForRect(win);
    if (v) await this.animateView(v, 620);
    this.snapshotCover();
    this.pendingView = { kind: 'in', win, from: { s: this.s, tx: this.tx, ty: this.ty } };
    this.switchMap(map.name);
    setTimeout(() => {
      this.transitioning = false; // 그림을 못 불러온 경우에도 풀림
    }, 4000);
  }

  /** 위 판으로 나가기: 아래 판 그림을 위 판의 제자리에 붙인 채 작아지며 사라짐 */
  exitToParent(name) {
    const cur = this.currentMap();
    if (this.transitioning) return;
    if (!cur || cur.parent !== name || !cur.window || !this.W) {
      this.switchMap(name);
      return;
    }
    this.transitioning = true;
    this.snapshotCover();
    this.pendingView = { kind: 'out', win: cur.window, childW: this.W, src: this.mapImg.src, from: { s: this.s, tx: this.tx, ty: this.ty } };
    this.switchMap(name);
    setTimeout(() => {
      this.transitioning = false;
    }, 4000);
  }

  /** 새 판 그림이 막 불러와졌을 때: 이어지는 자리에 놓고 덮개를 걷음. 처리했으면 true */
  applyPendingView() {
    const pv = this.pendingView;
    this.pendingView = null;
    if (!pv || !pv.win) return false;
    const [x0, y0, ww, wh] = pv.win;
    if (pv.kind === 'in') {
      const k = this.W / ww; // 위 판 1px = 이 판 k px
      this.s = pv.from.s / k;
      this.tx = pv.from.tx + x0 * pv.from.s;
      this.ty = pv.from.ty + y0 * pv.from.s;
      const fit = this.viewForRect([0, 0, this.W, this.H]);
      if (fit) this.minS = Math.min(this.minS || fit.s, fit.s * 0.6);
      this.fitted = true;
      this.touched = false;
      this.apply();
      this.dropCover(true);
      this.transitioning = false;
      return true;
    }
    // 나가기: 아래 판이 있던 자리 그대로에서 시작해 전체로 물러남
    const k = pv.childW / ww;
    this.s = pv.from.s * k;
    this.tx = pv.from.tx - x0 * this.s;
    this.ty = pv.from.ty - y0 * this.s;
    this.apply();
    this.dropCover(false);
    const ghost = this.layer.createEl('img', { cls: 'mnsk-ghost', attr: { src: pv.src, draggable: 'false', alt: '' } });
    ghost.style.left = `${x0}px`;
    ghost.style.top = `${y0}px`;
    ghost.style.width = `${ww}px`;
    ghost.style.height = `${wh}px`;
    this.layer.insertBefore(ghost, this.pinLayer);
    setTimeout(() => ghost.addClass('is-out'), 30);
    const fit = this.viewForRect([0, 0, this.W, this.H]);
    this.animateView(fit, 650).then(() => {
      ghost.remove();
      this.fitted = true;
      this.touched = false;
      this.transitioning = false;
    });
    return true;
  }

  /** 영역(또는 지역 표식)에서 새 판 만들기: 부모 지형(해안·숲·영역)을 그 자리만큼 크게 옮겨 와서 시작.
   *  opts.place: 지역 표식 이름 (r 은 { name, pts: [] }), opts.window: 창, opts.subtitle: 제목판 작은 글 */
  async createChildMap(r, opts = {}) {
    const P = this.currentMap();
    const T = this.terrain;
    if (!P || !T || !r || this.baking) return;
    const maps = this.plugin.settings.maps;
    const have = maps.find((m) => m.parent === P.name && (opts.place ? m.place === opts.place : m.region === r.name));
    if (have) {
      this.enterChild(have, opts.place ? null : r);
      return;
    }
    if (maps.some((m) => m.name === r.name)) {
      new Notice(`「${r.name}」이라는 지도가 이미 있어요.`);
      return;
    }
    this.baking = true;
    this.setBusy(true);
    new Notice(`「${r.name}」 판을 만드는 중이에요…`);
    await new Promise((res) => setTimeout(res, 40));
    try {
      // 1) 창: 영역 둘레에 여유를 두고 3:2로
      const [x0, y0, ww, wh] = opts.window || this.childWindowOf(r);
      const CW = 6000;
      const CH = 4000;
      const k = CW / ww; // 부모 1px = 새 판 k px
      // 2) 부모가 그려 보이는 그대로의 땅(해안 굴곡 포함)과 숲을 옮겨 옴
      if (!T.lastLand) {
        const tmp = document.createElement('canvas');
        tmp.width = this.W;
        tmp.height = this.H;
        T.render(tmp);
      }
      const C = new Terrain(CW / 2, CH / 2, 2);
      const pick = (arr, px, py) => {
        const gx = clamp(px / T.scale - 0.5, 0, T.w - 1.001);
        const gy = clamp(py / T.scale - 0.5, 0, T.h - 1.001);
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const p = iy * T.w + ix;
        const a = arr[p];
        const b = arr[p + 1];
        const c = arr[p + T.w];
        const d = arr[p + T.w + 1];
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      };
      for (let cy = 0; cy < C.h; cy++) {
        for (let cx = 0; cx < C.w; cx++) {
          const px = x0 + ((cx + 0.5) * 2) / k;
          const py = y0 + ((cy + 0.5) * 2) / k;
          const p = cy * C.w + cx;
          C.ground[p] = pick(T.lastLand, px, py) >= 0.5 ? 1 : 0;
          C.cover[p] = C.ground[p] && pick(T.cover, px, py) >= 0.5 ? 1 : 0;
        }
      }
      // 3) 창 안에 걸친 영역들 (이 영역 포함, 창을 통째로 품은 영역도)
      const corners = [[x0, y0], [x0 + ww, y0], [x0, y0 + wh], [x0 + ww, y0 + wh]];
      C.regions = T.regions
        .filter((q) => isPlace(q) && (q.pts.some(([x, y]) => x >= x0 && x <= x0 + ww && y >= y0 && y <= y0 + wh) || corners.some((c) => inPoly(c, q.pts))))
        .map((q) => ({ name: q.name, pts: q.pts.map(([x, y]) => [(x - x0) * k, (y - y0) * k]), ...(q.detail ? { detail: q.detail } : {}) }));
      C.title = r.name;
      C.subtitle = opts.subtitle || '지 역  지 도';
      C.seed = (T.seed + [...r.name].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7)) >>> 0;
      C.coast = T.coast;
      C.isles = T.isles;
      C.deco = true;
      const dir = P.path.includes('/') ? P.path.replace(/\/[^/]*$/, '/') : '';
      C.output = `${dir}${r.name}.jpg`;
      const ad = this.app.vault.adapter;
      const toBuf = async (cv) => (await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92))).arrayBuffer();
      // 4) 밑그림: 부모 밑그림(없으면 부모 지도 그림)의 같은 자리를 키워서
      const srcPath = T.underlay || P.path;
      const srcFile = this.app.vault.getAbstractFileByPath(srcPath);
      if (srcFile instanceof TFile) {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = this.app.vault.getResourcePath(srcFile);
        });
        const f = img.naturalWidth / this.W;
        const ul = document.createElement('canvas');
        ul.width = CW;
        ul.height = CH;
        const uctx = ul.getContext('2d');
        uctx.fillStyle = '#e9dfc5';
        uctx.fillRect(0, 0, CW, CH);
        uctx.imageSmoothingQuality = 'high';
        uctx.drawImage(img, x0 * f, y0 * f, ww * f, wh * f, 0, 0, CW, CH);
        C.underlay = `${dir}${r.name}.밑그림.jpg`;
        await ad.writeBinary(C.underlay, await toBuf(ul));
      }
      // 5) 지도 그림 굽고 지형 저장
      const out = document.createElement('canvas');
      out.width = CW;
      out.height = CH;
      C.render(out);
      await ad.writeBinary(C.output, await toBuf(out));
      await ad.write(`${dir}${r.name}.지형.json`, JSON.stringify(C.encode()));
      // 6) 지도 목록에 넣고 들어가기
      const rnd = (v) => Math.round(v * 100) / 100;
      maps.push({ name: r.name, path: C.output, parent: P.name, ...(opts.place ? { place: opts.place } : { region: r.name }), window: [rnd(x0), rnd(y0), rnd(ww), rnd(wh)] });
      await this.plugin.saveSettings();
      new Notice(`「${r.name}」 판을 만들었어요. 지형 그리기로 바로 그릴 수 있어요.`);
      this.baking = false;
      this.setBusy(false);
      this.enterChild(maps[maps.length - 1], opts.place ? null : r);
    } catch (err) {
      console.error('[MN 세계판] 판 만들기 실패', err);
      new Notice('판을 만들지 못했어요.');
      this.baking = false;
      this.setBusy(false);
    }
  }

  refreshSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 120);
  }

  refresh() {
    this.data = this.plugin.collect();
    const onMap = (it) => it.map === this.mapName;
    this.here = { places: this.data.places.filter(onMap), people: this.data.people.filter(onMap) };
    this.renderPins();
    this.renderCard();
    this.renderInfo();
    if (this.searchInput.value) this.renderResults();
  }

  /* ---------- 지형 그리기 ---------- */

  terrainPathOf(map) {
    if (map.terrain) return map.terrain;
    return map.path.replace(/\.[^./]+$/, '').replace(/\.지형$/, '') + '.지형.json';
  }

  async loadTerrain(map) {
    this.terrain = null;
    this.tundo = [];
    this.regionSel = -1;
    this.draft = null;
    this.terrainShown = false;
    this.terrainDirty = false;
    this.terrainPath = this.terrainPathOf(map);
    let T = null;
    try {
      const ad = this.app.vault.adapter;
      if (await ad.exists(this.terrainPath)) T = Terrain.decode(JSON.parse(await ad.read(this.terrainPath)));
    } catch (err) {
      console.error('[MN 세계판] 지형 데이터를 읽지 못했어요', err);
      new Notice('지형 데이터를 읽지 못했어요: ' + this.terrainPath);
    }
    if (T) T.inherited = await this.inheritedLines(map, T.w * T.scale);
    if (map.name !== this.mapName) return;
    if (T) {
      T.scale = this.W / T.w;
      T.mapName = map.name;
    }
    this.terrain = T;
    this.setUnderlay();
    this.showTerrainLayer();
    if (this.mode === 'terrain') this.renderPaintPanel();
  }

  /** 지형 데이터 파일이 밖에서 바뀌면 다시 불러옴 (세계판이 쓴 것은 빼고) */
  onFileModified(f) {
    if (!f || !this.terrainPath || f.path !== this.terrainPath) return;
    if (Date.now() - (this.tSelfWrite || 0) < 3000) return;
    const map = this.currentMap();
    if (!map) return;
    this.loadTerrain(map).then(() => new Notice('지형 데이터가 밖에서 바뀌어서 다시 불러왔어요.'));
  }

  /** 위 판들에서 그은 자국을 이 판 좌표로 (이 판의 창 · 크기로 바꿔서). childW: 이 판 폭(지도 px) */
  async inheritedLines(map, childW) {
    const maps = this.plugin.settings.maps;
    const parent = map.parent ? maps.find((m) => m.name === map.parent) : null;
    if (!parent || !map.window) return [];
    let P = null;
    try {
      const path = this.terrainPathOf(parent);
      if (await this.app.vault.adapter.exists(path)) P = Terrain.decode(JSON.parse(await this.app.vault.adapter.read(path)));
    } catch (err) {
      console.error('[MN 세계판] 위 판 지형을 읽지 못했어요', err);
    }
    if (!P) return [];
    const up = await this.inheritedLines(parent, P.w * P.scale);
    const [x0, y0, ww] = map.window;
    const k = childW / ww;
    return [...up, ...P.regions.filter(isLine)].map((r) => ({
      name: r.name,
      type: r.type,
      pts: r.pts.map(([x, y]) => [(x - x0) * k, (y - y0) * k]),
      ...(isRoad(r) ? {} : { w0: (r.w0 || (isRiver(r) ? 3 : 8)) * k, w1: (r.w1 == null ? (isRiver(r) ? 12 : 1) : r.w1) * k }),
    }));
  }

  /** 지형 그림이 없는 지도: 지금 지도 그림을 밑그림으로 깔고 온통 땅에서 시작 */
  newTerrain() {
    const map = this.currentMap();
    if (!map || !this.W) return;
    const w = Math.ceil(this.W / 2);
    const h = Math.ceil(this.H / 2);
    const T = new Terrain(w, h, this.W / w);
    T.ground.fill(1);
    T.title = map.name;
    T.underlay = map.path;
    T.output = map.path.replace(/\.[^./]+$/, '').replace(/\.지형$/, '') + '.지형.jpg';
    T.mapName = map.name;
    this.terrain = T;
    this.under.on = true;
    this.terrainDirty = true;
    this.setUnderlay();
    this.showTerrainLayer();
    this.saveTerrainSoon();
    this.renderPaintPanel();
  }

  setUnderlay() {
    const T = this.terrain;
    const f = T && T.underlay ? this.app.vault.getAbstractFileByPath(T.underlay) : null;
    if (f instanceof TFile) {
      this.underImg.src = this.app.vault.getResourcePath(f);
      this.underImg.style.width = `${this.W}px`;
      this.underImg.style.height = `${this.H}px`;
    } else this.underImg.removeAttribute('src');
    this.updateUnderlay();
  }

  updateUnderlay() {
    const on = this.mode === 'terrain' && !!this.terrain && this.under.on && this.underImg.hasAttribute('src');
    this.underImg.toggleClass('is-hidden', !on);
    this.underImg.style.opacity = String(this.under.alpha);
  }

  showTerrainLayer() {
    const on = this.mode === 'terrain' && !!this.terrain;
    this.terrainCanvas.toggleClass('is-hidden', !on);
    this.markCanvas.toggleClass('is-hidden', !on);
    if (on) this.loadStamps();
    if (on && !this.terrainShown) this.renderTerrain(false);
    else if (on) this.renderMarks();
    this.updateUnderlay();
    this.renderRegionSvg();
  }

  /** 지형을 다시 그림. fast: 칸을 반으로 줄인 빠른 그림 (손을 떼고 잠시 있으면 제대로 다시 그림) */
  renderTerrain(fast) {
    const T = this.terrain;
    if (!T || !this.W) return;
    const cv = this.terrainCanvas;
    if (cv.width !== this.W || cv.height !== this.H) {
      cv.width = this.W;
      cv.height = this.H;
    }
    cv.style.width = `${this.W}px`;
    cv.style.height = `${this.H}px`;
    clearTimeout(this.tRenderTimer);
    this.setBusy(true);
    this.tRenderTimer = setTimeout(async () => {
      if ((await this.terrainWorker()) && !this.twBroken) {
        this.sendTerrainJob(false); // 화면이 굳지 않으니 대충 그린 그림 없이 바로 제대로 (붓 자국은 미리보기에 남아 있음)
        return;
      }
      try {
        (fast ? T.lowres() : T).render(cv, { marks: false });
        this.renderMarks();
        this.terrainShown = true;
        this.terrainFull = !fast;
      } catch (err) {
        console.error('[MN 세계판] 지형 그리기 오류', err);
        new Notice('지형을 그리다가 문제가 생겼어요.');
      }
      const pv = this.previewCanvas;
      pv.getContext('2d').clearRect(0, 0, pv.width, pv.height);
      this.setBusy(false);
      if (fast) this.tRenderTimer = setTimeout(() => this.renderTerrain(false), 1500);
    }, 30);
  }

  /** 지형 그리기 일꾼: 이 플러그인의 main.js 를 그대로 일꾼 안에서 돌려 OffscreenCanvas 에 그려요. 못 쓰면 null */
  async terrainWorker() {
    if (this.twReady) return this.twReady;
    this.twReady = (async () => {
      try {
        if (typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') return null;
        const dir = (this.plugin.manifest && this.plugin.manifest.dir) || '.obsidian/plugins/mn-sekaipan';
        const src = await this.app.vault.adapter.read(`${dir}/main.js`);
        const head = [
          'const document = { createElement: () => new OffscreenCanvas(1, 1) };',
          'const module = { exports: {} };',
          'const require = () => new Proxy({}, { get: () => class {} });',
          '',
        ].join('\n');
        const tail = [
          '',
          'const noiseCache = new Map();',
          'self.onmessage = (ev) => {',
          '  const q = ev.data;',
          '  try {',
          '    const T = new Terrain(q.w, q.h, q.scale);',
          '    Object.assign(T, q.fields);',
          '    T.ground = q.ground;',
          '    T.cover = q.cover;',
          '    const R = q.fast ? T.lowres() : T;',
          "    const key = R.w + 'x' + R.h + ':' + R.scale + ':' + R.seed;",
          '    R.cache = noiseCache.get(key) || null;',
          '    const cv = new OffscreenCanvas(q.W, q.H);',
          '    R.render(cv, { marks: false });',
          '    if (R.cache) {',
          '      noiseCache.set(key, R.cache);',
          '      if (noiseCache.size > 6) noiseCache.delete(noiseCache.keys().next().value);',
          '    }',
          '    const bmp = cv.transferToImageBitmap();',
          '    self.postMessage({ id: q.id, bmp }, [bmp]);',
          '  } catch (err) {',
          '    self.postMessage({ id: q.id, error: String((err && err.stack) || err) });',
          '  }',
          '};',
        ].join('\n');
        const url = URL.createObjectURL(new Blob([head, src, tail], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = (ev) => this.onTerrainJob(ev.data);
        w.onerror = (ev) => {
          console.error('[MN 세계판] 지형 일꾼 오류', ev.message);
          this.twBroken = true;
          this.twBusy = null;
          this.renderTerrain(false);
        };
        this.register(() => {
          w.terminate();
          URL.revokeObjectURL(url);
        });
        return w;
      } catch (err) {
        console.error('[MN 세계판] 지형 일꾼을 만들지 못했어요', err);
        return null;
      }
    })();
    return this.twReady;
  }

  /** 지금 지형을 일꾼에게 보내 그리게 함 (그리는 중이면 끝난 뒤 가장 마지막 것만) */
  async sendTerrainJob(fast) {
    const w = await this.terrainWorker();
    const T = this.terrain;
    if (!w || !T || !this.W) return;
    if (this.twBusy) {
      this.twWant = { fast: this.twWant ? this.twWant.fast && fast : fast };
      return;
    }
    const id = (this.twSeq = (this.twSeq || 0) + 1);
    this.twBusy = { id, fast, T };
    const ground = T.ground.slice();
    const cover = T.cover.slice();
    const fields = {
      regions: T.regions,
      inherited: T.inherited || [],
      marks: [],
      seed: T.seed,
      coast: T.coast,
      isles: T.isles,
      deco: T.deco,
      title: T.title,
      subtitle: T.subtitle,
    };
    w.postMessage({ id, w: T.w, h: T.h, scale: T.scale, W: this.W, H: this.H, fast, ground, cover, fields }, [ground.buffer, cover.buffer]);
  }

  onTerrainJob(d) {
    const job = this.twBusy;
    this.twBusy = null;
    if (d.error) {
      console.error('[MN 세계판] 지형 일꾼이 그리다 멈췄어요', d.error);
      this.twBroken = true; // 이후로는 화면에서 그려요
      this.renderTerrain(!!(job && job.fast));
      return;
    }
    const current = job && job.T === this.terrain && job.id === d.id;
    if (current && d.bmp) {
      const cv = this.terrainCanvas;
      if (cv.width !== this.W || cv.height !== this.H) {
        cv.width = this.W;
        cv.height = this.H;
      }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(d.bmp, 0, 0);
      this.renderMarks();
      this.terrainShown = true;
      this.terrainFull = !job.fast;
      if (!this.tsnap && !this.markStroking) {
        const pv = this.previewCanvas;
        pv.getContext('2d').clearRect(0, 0, pv.width, pv.height);
      }
    }
    if (d.bmp) d.bmp.close();
    if (this.twWant) {
      const f = this.twWant.fast;
      this.twWant = null;
      this.sendTerrainJob(f);
      return;
    }
    this.setBusy(false);
    if (current && job.fast) {
      clearTimeout(this.tRenderTimer);
      this.tRenderTimer = setTimeout(() => this.renderTerrain(false), 600);
    }
  }

  /** 산 기호 그림 불러오기 (폴더마다 한 묶음). Obsidian 은 폴더를 읽고, 없으면 목록.json */
  loadStamps() {
    if (this.stampsReady) return this.stampsReady;
    this.stampsReady = (async () => {
      const ad = this.app.vault.adapter;
      let sets = {};
      try {
        if (typeof ad.list === 'function') {
          const top = await ad.list(STAMP_DIR);
          for (const f of top.folders || []) {
            const ls = await ad.list(f);
            sets[f.split('/').pop()] = (ls.files || []).filter((p) => /\.png$/i.test(p)).sort();
          }
        } else if (await ad.exists(`${STAMP_DIR}/목록.json`)) {
          const idx = JSON.parse(await ad.read(`${STAMP_DIR}/목록.json`));
          for (const k in idx) sets[k] = idx[k].map((n) => `${STAMP_DIR}/${k}/${n}`);
        }
      } catch (err) {
        console.error('[MN 세계판] 산 기호를 읽지 못했어요', err);
        sets = {};
      }
      const load = (p) =>
        new Promise((res) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => res(null);
          im.src = ad.getResourcePath(p);
        });
      for (const k in sets) {
        const ims = (await Promise.all(sets[k].map(load))).filter(Boolean);
        if (ims.length) STAMPS[k] = ims;
      }
      this.stampsDone = true;
      if (this.terrainShown) this.renderMarks();
      return Object.keys(STAMPS).length;
    })();
    return this.stampsReady;
  }

  /** 산 · 언덕 겹만 다시 (빠름) */
  renderMarks() {
    const T = this.terrain;
    const cv = this.markCanvas;
    if (!T || !this.W || !cv) return;
    if (!this.stampsDone && T.marks.some((m) => m.k === 'mtn')) {
      this.loadStamps().then(() => this.renderMarks());
      return;
    }
    if (cv.width !== this.W || cv.height !== this.H) {
      cv.width = this.W;
      cv.height = this.H;
    }
    cv.style.width = `${this.W}px`;
    cv.style.height = `${this.H}px`;
    T.renderMarks(cv);
  }

  /** 산 · 언덕만 바뀌었을 때: 지형은 그대로 두고 겹만 다시 그림 */
  marksChanged() {
    this.terrainDirty = true;
    this.renderMarks();
    this.clearPreview();
    this.saveTerrainSoon();
    this.renderPaintPanel();
    this.renderRegionSvg();
  }

  terrainChanged() {
    this.terrainDirty = true;
    this.renderTerrain(true);
    this.saveTerrainSoon();
    this.renderPaintPanel();
    this.renderRegionSvg();
  }

  /** 기다리던 지형 저장을 바로 (지도를 바꾸기 전에) */
  flushTerrainSave() {
    if (!this.tSaveTimer) return;
    clearTimeout(this.tSaveTimer);
    this.tSaveTimer = null;
    const T = this.terrain;
    const path = this.terrainPath;
    const map = T && T.mapName ? this.plugin.settings.maps.find((m) => m.name === T.mapName) : null;
    if (!T || !path || !map || path !== this.terrainPathOf(map)) return;
    this.tSelfWrite = Date.now();
    this.app.vault.adapter.write(path, JSON.stringify(T.encode())).catch((err) => {
      console.error('[MN 세계판] 지형 저장 실패', err);
      new Notice('지형을 저장하지 못했어요.');
    });
  }

  saveTerrainSoon() {
    clearTimeout(this.tSaveTimer);
    this.tSaveTimer = setTimeout(async () => {
      const T = this.terrain;
      const map = T && T.mapName ? this.plugin.settings.maps.find((m) => m.name === T.mapName) : null;
      if (!T || !this.terrainPath || !map || this.terrainPath !== this.terrainPathOf(map)) return;
      try {
        this.tSelfWrite = Date.now();
        await this.app.vault.adapter.write(this.terrainPath, JSON.stringify(this.terrain.encode()));
        this.tSelfWrite = Date.now();
        this.tSavedAt = now().time;
        if (this.mode === 'terrain') this.renderPaintPanel();
      } catch (err) {
        console.error('[MN 세계판] 지형 저장 실패', err);
        new Notice('지형을 저장하지 못했어요.');
      }
    }, 800);
  }

  /** 완성 지도를 그림 파일로 구워서 지도 그림으로 씀 */
  async bakeTerrain() {
    const T = this.terrain;
    const map = T && T.mapName ? this.plugin.settings.maps.find((m) => m.name === T.mapName) : null;
    if (!T || !map || this.baking) return;
    if (map.name !== this.mapName || this.terrainPath !== this.terrainPathOf(map)) return; // 지도를 바꾸는 중에는 굽지 않음
    this.baking = true;
    clearTimeout(this.tRenderTimer);
    this.setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    if (T.marks && T.marks.length) await this.loadStamps();
    const out = T.output || map.path;
    try {
      const cv = document.createElement('canvas');
      cv.width = this.W;
      cv.height = this.H;
      T.render(cv);
      if (!this.terrainFull || !this.terrainShown) {
        // 화면의 지형 겹도 같은 그림으로 (산 · 언덕은 따로 된 겹에 있으니 빼고 다시)
        const tc = this.terrainCanvas;
        if (tc.width !== this.W || tc.height !== this.H) {
          tc.width = this.W;
          tc.height = this.H;
        }
        T.render(tc, { marks: false });
        this.renderMarks();
        this.terrainShown = true;
        this.terrainFull = true;
      }
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
      await this.app.vault.adapter.writeBinary(out, await blob.arrayBuffer());
      this.terrainDirty = false;
      if (map.path !== out) {
        map.path = out;
        await this.plugin.saveSettings();
        new Notice(`이 지도의 그림을 ${out} 로 바꿨어요.`);
      }
      const url = this.app.vault.adapter.getResourcePath(out);
      const src = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
      this.mapImg.src = src;
      this.silentSrc = this.mapImg.src; // 브라우저가 고친 꼴 그대로 기억
      this.tBakedAt = now().time;
    } catch (err) {
      console.error('[MN 세계판] 지도 그림 저장 실패', err);
      new Notice('지도 그림을 저장하지 못했어요.');
    }
    this.baking = false;
    this.setBusy(false);
    if (this.mode === 'terrain') this.renderPaintPanel();
  }

  setTerrainTool(kind) {
    if (this.draft && kind !== 'region') this.cancelDraft();
    this.tool.kind = kind;
    if (kind !== 'pick') this.markSel = -1;
    this.contentEl.toggleClass('is-zoomtool', kind === 'zoom');
    this.renderPaintPanel();
    this.renderRegionSvg();
    if (kind === 'region' || kind === 'zoom' || kind === 'pick') this.brushRing.addClass('is-hidden');
  }

  /* ---------- 배치: 산 · 언덕 찍기, 고르기 ---------- */

  markSizeOf(kind) {
    return this.tool.markSize[kind] || Math.round(this.W * (kind === 'hill' ? 0.007 : 0.009));
  }

  /** 미리보기 판을 비우고 (붓질과 같은 판) */
  clearPreview() {
    const T = this.terrain;
    const pv = this.previewCanvas;
    if (pv.width !== T.w || pv.height !== T.h) {
      pv.width = T.w;
      pv.height = T.h;
    }
    pv.style.width = `${this.W}px`;
    pv.style.height = `${this.H}px`;
    const ctx = pv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pv.width, pv.height);
  }

  previewMark(m) {
    const ctx = this.previewCanvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1 / this.terrain.scale, 0, 0, 1 / this.terrain.scale, 0, 0);
    drawMark(ctx, m);
    ctx.restore();
  }

  /** 산 · 언덕 찍기 시작 (Alt 를 누르고 있으면 지우기) */
  beginMarkStroke(e) {
    const T = this.terrain;
    clearTimeout(this.tRenderTimer);
    this.clearPreview();
    const st = { kind: this.tool.kind, erase: e.altKey, before: T.marks.map((m) => ({ ...m })), last: null, changed: false };
    this.markStroking = true;
    this.markStrokeTo(st, e);
    return st;
  }

  markStrokeTo(st, e) {
    const T = this.terrain;
    const xy = this.toMap(e.clientX, e.clientY);
    const size = this.markSizeOf(st.kind);
    if (st.erase) {
      const r = Math.max(this.tool.radius, size * 0.6);
      const n0 = T.marks.length;
      T.marks = T.marks.filter((m) => Math.hypot(m.x - xy[0], m.y - (m.k === 'hill' ? m.s * 0.1 : m.s * 0.4) - xy[1]) > r);
      if (T.marks.length !== n0) {
        st.changed = true;
        this.renderMarks();
      }
      return;
    }
    // 크기는 들쭉날쭉 (작은 게 많고 가끔 크게), 산은 크게 뽑히면 주로 큰 산 · 작으면 주로 작은 산
    const add = (x, y, f) => {
      const m = { k: st.kind, x, y, s: size * f };
      if (st.kind === 'mtn') m.st = f > 1.12 ? (Math.random() < 0.85 ? BIG : SMALL) : Math.random() < 0.15 ? BIG : SMALL;
      T.marks.push(m);
      this.previewMark(m);
      st.changed = true;
    };
    const jitter = (one) => (st.kind === 'hill' ? 0.75 + 0.5 * Math.random() : one ? 0.8 + 0.5 * Math.random() : 0.6 + 0.95 * Math.random() ** 1.6);
    if (!st.last) {
      add(xy[0], xy[1], jitter(true));
      st.last = xy;
      return;
    }
    // 끌면 그 길을 따라 줄지어 (붓 크기만큼 옆으로 흩어지게)
    const [lx, ly] = st.last;
    const d = Math.hypot(xy[0] - lx, xy[1] - ly);
    const gap = Math.max(4, size * (st.kind === 'hill' ? 1.1 : 0.5));
    if (d < gap) return;
    const nx = -(xy[1] - ly) / d;
    const ny = (xy[0] - lx) / d;
    const spread = this.tool.radius;
    const per = 1 + Math.floor(spread / (size * 1.2));
    const steps = Math.floor(d / gap);
    for (let i = 1; i <= steps; i++) {
      const t = (i * gap) / d;
      const bx = lx + (xy[0] - lx) * t;
      const by = ly + (xy[1] - ly) * t;
      for (let j = 0; j < per; j++) {
        const o = (Math.random() * 2 - 1) * spread;
        const along = (Math.random() - 0.5) * gap;
        add(bx + nx * o + ((xy[0] - lx) / d) * along, by + ny * o + ((xy[1] - ly) / d) * along, jitter(false));
      }
    }
    st.last = [lx + ((xy[0] - lx) * steps * gap) / d, ly + ((xy[1] - ly) * steps * gap) / d];
  }

  endMarkStroke(st) {
    this.markStroking = false;
    if (!st.changed) {
      this.clearPreview();
      return;
    }
    this.pushTundo({ type: 'marks', marks: st.before });
    this.marksChanged();
  }

  /** 이 자리에 있는 산 · 언덕 (앞에 있는 것 먼저). 없으면 -1 */
  markAt(xy) {
    const T = this.terrain;
    if (!T) return -1;
    const pad = 6 / this.s;
    let best = -1;
    T.marks.forEach((m, i) => {
      const hill = m.k === 'hill';
      const hw = (hill ? m.s * 0.65 : stampSetOf(m) ? m.s * 0.7 : m.s * 0.45) + pad;
      const top = m.y - (hill ? m.s * 0.35 : m.s) - pad;
      const bot = m.y + (hill ? m.s * 0.12 : m.s * 0.08) + pad;
      if (xy[0] >= m.x - hw && xy[0] <= m.x + hw && xy[1] >= top && xy[1] <= bot && (best < 0 || m.y >= T.marks[best].y)) best = i;
    });
    return best;
  }

  deleteMark(i) {
    const T = this.terrain;
    if (!T || !T.marks[i]) return;
    this.pushTundo({ type: 'marks', marks: T.marks.map((m) => ({ ...m })) });
    T.marks.splice(i, 1);
    this.markSel = -1;
    this.marksChanged();
  }

  /** 붓질 시작 (땅 · 바다 · 숲 · 숲 걷기) */
  beginTerrainStroke(e) {
    const T = this.terrain;
    clearTimeout(this.tRenderTimer);
    this.tsnap = { ground: T.ground.slice(), cover: T.cover.slice(), bb: [Infinity, Infinity, -1, -1] };
    const pv = this.previewCanvas;
    if (pv.width !== T.w || pv.height !== T.h) {
      pv.width = T.w;
      pv.height = T.h;
    }
    pv.style.width = `${this.W}px`;
    pv.style.height = `${this.H}px`;
    const ctx = pv.getContext('2d');
    ctx.clearRect(0, 0, pv.width, pv.height);
    ctx.fillStyle = { land: '#f0e4c6', sea: '#8fb0ae', forest: '#8d8850', unforest: '#f0e4c6' }[this.tool.kind];
    const stroke = { kind: this.tool.kind, ctx, last: null };
    this.terrainStrokeTo(stroke, e);
    return stroke;
  }

  terrainStrokeTo(stroke, e) {
    const T = this.terrain;
    const [mx, my] = this.toMap(e.clientX, e.clientY);
    const x = mx / T.scale - 0.5;
    const y = my / T.scale - 0.5;
    const r = this.tool.radius / T.scale;
    const from = stroke.last || [x, y];
    const dist = Math.hypot(x - from[0], y - from[1]);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 3)));
    const [layer, val] = { land: ['ground', 1], sea: ['ground', 0], forest: ['cover', 1], unforest: ['cover', 0] }[stroke.kind];
    const bb = this.tsnap.bb;
    for (let i = stroke.last ? 1 : 0; i <= steps; i++) {
      const t = i / steps;
      const cx = from[0] + (x - from[0]) * t;
      const cy = from[1] + (y - from[1]) * t;
      const [x0, y0, x1, y1] = T.stamp(cx, cy, r, layer, val);
      bb[0] = Math.min(bb[0], x0);
      bb[1] = Math.min(bb[1], y0);
      bb[2] = Math.max(bb[2], x1);
      bb[3] = Math.max(bb[3], y1);
      stroke.ctx.beginPath();
      stroke.ctx.arc(cx + 0.5, cy + 0.5, r, 0, Math.PI * 2);
      stroke.ctx.fill();
    }
    stroke.last = [x, y];
  }

  endTerrainStroke() {
    const T = this.terrain;
    const S = this.tsnap;
    this.tsnap = null;
    if (!T || !S) return;
    const [x0, y0, x1, y1] = S.bb;
    if (x1 < x0) return;
    const ww = x1 - x0 + 1;
    const crop = (arr) => {
      const out = new Uint8Array(ww * (y1 - y0 + 1));
      for (let y = y0; y <= y1; y++) out.set(arr.subarray(y * T.w + x0, y * T.w + x1 + 1), (y - y0) * ww);
      return out;
    };
    this.pushTundo({ type: 'paint', bb: S.bb, ground: crop(S.ground), cover: crop(S.cover) });
    this.terrainChanged();
  }

  pushTundo(entry) {
    this.tundo.push(entry);
    if (this.tundo.length > 40) this.tundo.shift();
  }

  undoTerrain() {
    const T = this.terrain;
    const u = this.tundo.pop();
    if (!T || !u) {
      new Notice('되돌릴 게 없어요.');
      return;
    }
    if (u.type === 'paint') {
      const [x0, y0, x1, y1] = u.bb;
      const ww = x1 - x0 + 1;
      for (let y = y0; y <= y1; y++) {
        T.ground.set(u.ground.subarray((y - y0) * ww, (y - y0 + 1) * ww), y * T.w + x0);
        T.cover.set(u.cover.subarray((y - y0) * ww, (y - y0 + 1) * ww), y * T.w + x0);
      }
    } else if (u.type === 'regions') {
      T.regions = u.regions;
      if (this.regionSel >= T.regions.length) this.regionSel = T.regions.length - 1;
    } else if (u.type === 'marks') {
      T.marks = u.marks;
      this.markSel = -1;
      this.marksChanged();
      return;
    } else if (u.type === 'settings') Object.assign(T, u.settings);
    this.terrainChanged();
  }

  snapshotRegions() {
    return this.terrain.regions.map((r) => ({ name: r.name, pts: r.pts.map((p) => p.slice()), ...(r.detail ? { detail: r.detail } : {}), ...lineFields(r), ...(isWreck(r) ? { type: 'wreck', heal: r.heal || 0 } : {}) }));
  }

  startRegionDraft() {
    new NameModal(this.app, '새 영역 이름', '', (name) => {
      this.draft = { name, pts: [] };
      this.tool.kind = 'region';
      this.regionSel = -1;
      this.showBanner(`「${name}」 꼭짓점을 차례로 찍으세요 · 첫 점을 다시 누르거나 Enter · 두 번 눌러 닫기 · Backspace 한 점 빼기 · Esc 그만`);
      this.renderPaintPanel();
      this.renderRegionSvg();
    }).open();
  }

  startWreckDraft() {
    new NameModal(this.app, '새 재해 지대 이름 (예: 라타이츠 재해 지대)', '', (name) => {
      this.draft = { name, pts: [], type: 'wreck' };
      this.tool.kind = 'region';
      this.regionSel = -1;
      this.showBanner(`「${name}」 둘레를 차례로 찍으세요 · 첫 점을 다시 누르거나 Enter · 두 번 눌러 닫기 · Backspace 한 점 빼기 · Esc 그만`);
      this.renderPaintPanel();
      this.renderRegionSvg();
    }).open();
  }

  startTrenchDraft() {
    this.startLineDraft('trench');
  }

  /** 점을 이어 긋는 선 시작: trench(자국) · river(강) · road(길) */
  startLineDraft(type) {
    const n = (this.terrain?.regions || []).filter((r) => r.type === type).length + 1;
    const ask = { trench: ['새 자국 이름 (예: 포격 자국)', ''], river: ['새 강 이름', ''], road: ['새 길 이름', `길 ${n}`] }[type];
    const how = {
      trench: '시작점(가장 넓은 쪽)부터 차례로 찍으세요',
      river: '발원지(가는 쪽)부터 하구 쪽으로 차례로 찍으세요',
      road: '한쪽 끝부터 차례로 찍으세요',
    }[type];
    new NameModal(this.app, ask[0], ask[1], (name) => {
      this.draft = { name, pts: [], type };
      this.tool.kind = 'region';
      this.regionSel = -1;
      this.markSel = -1;
      this.showBanner(`「${name}」 ${how} · Enter 또는 두 번 눌러 끝내기 · Backspace 한 점 빼기 · Esc 그만`);
      this.renderPaintPanel();
      this.renderRegionSvg();
    }).open();
  }

  addDraftPoint(xy) {
    const d = this.draft;
    if (!isLine(d) && d.pts.length >= 3) {
      const [fx, fy] = d.pts[0];
      if (Math.hypot(xy[0] - fx, xy[1] - fy) * this.s < 12) {
        this.finishDraft();
        return;
      }
    }
    const last = d.pts[d.pts.length - 1];
    if (last && Math.hypot(xy[0] - last[0], xy[1] - last[1]) * this.s < 4) return; // 두 번 누르기로 생긴 겹친 점
    d.pts.push(xy);
    this.renderRegionSvg();
  }

  finishDraft() {
    const d = this.draft;
    if (!d) return;
    if (d.pts.length < (isLine(d) ? 2 : 3)) {
      new Notice(isLine(d) ? '점이 두 개 이상 있어야 해요.' : '꼭짓점이 세 개 이상 있어야 해요.');
      return;
    }
    this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
    if (isTrench(d)) {
      const w0 = Math.round(Math.max(4, this.W * 0.004));
      this.terrain.regions.push({ name: d.name, pts: d.pts, type: 'trench', w0, w1: Math.max(1, Math.round(w0 * 0.15)) });
    } else if (isRiver(d)) this.terrain.regions.push({ name: d.name, pts: d.pts, type: 'river', w0: 3, w1: Math.round(this.W * 0.002 * 2) / 2 });
    else if (isRoad(d)) this.terrain.regions.push({ name: d.name, pts: d.pts, type: 'road' });
    else if (isWreck(d)) this.terrain.regions.push({ name: d.name, pts: d.pts, type: 'wreck', heal: 0, detail: 0.6 });
    else this.terrain.regions.push({ name: d.name, pts: d.pts });
    this.regionSel = this.terrain.regions.length - 1;
    this.draft = null;
    this.hideBanner();
    this.terrainChanged();
  }

  cancelDraft() {
    if (!this.draft) return;
    this.draft = null;
    this.hideBanner();
    this.renderRegionSvg();
    this.renderPaintPanel();
  }

  /** Shift+누르기: 고른 영역의 가장 가까운 변에 꼭짓점 넣기 */
  insertVertex(xy) {
    const r = this.terrain.regions[this.regionSel];
    if (!r) return;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < r.pts.length - (isLine(r) ? 1 : 0); i++) {
      const [ax, ay] = r.pts[i];
      const [bx, by] = r.pts[(i + 1) % r.pts.length];
      const dx = bx - ax;
      const dy = by - ay;
      const t = clamp(((xy[0] - ax) * dx + (xy[1] - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      const d = Math.hypot(ax + dx * t - xy[0], ay + dy * t - xy[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
    r.pts.splice(best + 1, 0, xy);
    this.terrainChanged();
  }

  deleteVertex(j) {
    const r = this.terrain.regions[this.regionSel];
    if (!r) return;
    if (r.pts.length <= (isLine(r) ? 2 : 3)) {
      new Notice(isLine(r) ? '점이 두 개보다 적어질 수는 없어요.' : '꼭짓점이 세 개보다 적어질 수는 없어요.');
      return;
    }
    this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
    r.pts.splice(j, 1);
    this.terrainChanged();
  }

  renameRegion() {
    const r = this.terrain?.regions[this.regionSel];
    if (!r) return;
    new NameModal(this.app, '영역 이름 바꾸기', r.name, (name) => {
      this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
      r.name = name;
      this.saveTerrainSoon();
      this.renderPaintPanel();
    }).open();
  }

  deleteRegion() {
    const T = this.terrain;
    if (!T || !T.regions[this.regionSel]) return;
    this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
    T.regions.splice(this.regionSel, 1);
    this.regionSel = -1;
    this.terrainChanged();
  }

  /** 영역 고치기 손잡이 (꼭짓점) */
  renderRegionSvg() {
    const svg = this.regionSvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const T = this.terrain;
    const pickOn = this.mode === 'terrain' && !!T && this.tool.kind === 'pick' && !!this.W;
    const on = (this.mode === 'terrain' && !!T && this.tool.kind === 'region' && !!this.W) || pickOn;
    svg.classList.toggle('is-hidden', !on);
    if (!on) return;
    svg.setAttribute('width', String(this.W));
    svg.setAttribute('height', String(this.H));
    svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    svg.style.width = `${this.W}px`;
    svg.style.height = `${this.H}px`;
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, cls) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, String(attrs[k]));
      e.setAttribute('class', cls);
      svg.appendChild(e);
      return e;
    };
    const pts = (a) => a.map((p) => `${p[0]},${p[1]}`).join(' ');
    if (pickOn) {
      const m = T.marks[this.markSel];
      if (m) {
        const hill = m.k === 'hill';
        const hw = hill ? m.s * 0.65 : stampSetOf(m) ? m.s * 0.75 : m.s * 0.5;
        const top = m.y - (hill ? m.s * 0.35 : m.s);
        el('rect', { x: m.x - hw, y: top, width: hw * 2, height: m.y - top + (hill ? m.s * 0.12 : m.s * 0.1) }, 'mnsk-mk-sel');
      }
      return;
    }
    for (const r of T.inherited || []) el('polyline', { points: pts(r.pts) }, 'mnsk-rt-up');
    T.regions.forEach((r, i) => el(isLine(r) ? 'polyline' : 'polygon', { points: pts(r.pts), 'data-r': i }, 'mnsk-rg' + (isLine(r) ? ' is-line' + (isRiver(r) ? ' is-river' : isRoad(r) ? ' is-road' : '') : isWreck(r) ? ' is-wreck' : '') + (i === this.regionSel ? ' is-sel' : '')));
    const sel = T.regions[this.regionSel];
    if (sel && !this.draft) sel.pts.forEach((p, j) => el('circle', { cx: p[0], cy: p[1], 'data-v': j }, 'mnsk-rv'));
    if (this.draft) {
      const d = this.draft;
      if (d.pts.length > 1) el('polyline', { points: pts(d.pts) }, 'mnsk-rd');
      d.pts.forEach((p, j) => el('circle', { cx: p[0], cy: p[1] }, 'mnsk-rv' + (j === 0 ? ' is-first' : '')));
    }
  }

  renderTerrainPanel() {
    const P = this.paintPanel;
    P.empty();
    P.removeClass('is-hidden');
    const T = this.terrain;
    const head = P.createDiv({ cls: 'mnsk-paint-head' });
    head.createDiv({ cls: 'mnsk-card-kind', text: '편집' });
    head.createDiv({ cls: 'mnsk-paint-title', text: '지형 그리기' });
    this.busyEl = head.createDiv({ cls: 'mnsk-paint-busy is-hidden', text: '지형 그리는 중…' });
    if (this.contentEl.hasClass('is-busy')) this.busyEl.removeClass('is-hidden');
    if (!T) {
      P.createDiv({ cls: 'mnsk-paint-empty', text: '이 지도에는 아직 지형 그림이 없어요. 지금 지도 그림을 밑그림으로 깔고 시작해요.' });
      const b = P.createEl('button', { cls: 'mnsk-btn is-primary', text: '지형 그림 시작' });
      b.onclick = () => this.newTerrain();
      return;
    }
    const sec = (label) => {
      const s = P.createDiv({ cls: 'mnsk-paint-sec' });
      s.createDiv({ cls: 'mnsk-paint-label', text: label });
      return s;
    };
    // 보기: 휠 없이도 확대·축소
    const vz = sec('보기 · 확대 축소 (+ - 0 글쇠도 돼요)');
    const zr = vz.createDiv({ cls: 'mnsk-zoomrow' });
    const zbtn = (text, fn, title) => {
      const b = zr.createEl('button', { cls: 'mnsk-btn', text, attr: { 'aria-label': title } });
      b.onclick = fn;
    };
    zbtn('－', () => this.zoomCenter(1 / 1.5), '작게');
    this.zoomSlider = zr.createEl('input', { type: 'range', attr: { min: 0, max: 1, step: 0.005 } });
    this.zoomSlider.value = String(this.zoomT());
    this.zoomSlider.oninput = () => this.zoomToT(Number(this.zoomSlider.value));
    zbtn('＋', () => this.zoomCenter(1.5), '크게');
    zbtn('전체', () => this.fit(), '전체 보기');
    // 도구
    const tools = sec('도구');
    const grid = tools.createDiv({ cls: 'mnsk-tools' });
    for (const [kind, label] of [['land', '땅'], ['sea', '바다'], ['forest', '숲'], ['unforest', '숲 걷기'], ['region', '영역 · 선'], ['zoom', '돋보기'], ['mtn', '산'], ['hill', '언덕'], ['pick', '고르기']]) {
      const b = grid.createEl('button', { text: label, cls: 'mnsk-tool' });
      b.toggleClass('is-active', this.tool.kind === kind);
      b.onclick = () => this.setTerrainTool(kind);
    }
    if (this.tool.kind === 'zoom') {
      tools.createDiv({ cls: 'mnsk-paint-hint', text: '누르면 크게 · Alt(또는 Shift)+누르면 작게 · 끌면 지도 이동' });
    } else if (this.tool.kind === 'mtn' || this.tool.kind === 'hill') {
      const kind = this.tool.kind;
      const nm = kind === 'hill' ? '언덕' : '산';
      this.slider(tools, `${nm} 크기 (놓을 때마다 들쭉날쭉)`, 8, kind === 'hill' ? 200 : 300, 1, this.markSizeOf(kind), (v) => {
        this.tool.markSize[kind] = v;
      }, (v) => `${Math.round(v)}`);
      this.slider(tools, '퍼짐 · 지우개 크기 ([ ])', 4, 400, 1, this.tool.radius, (v) => {
        this.tool.radius = v;
      }, (v) => `${Math.round(v)}`);
      tools.createDiv({ cls: 'mnsk-paint-hint', text: `누르면 ${nm} 하나 · 끌면 그 길을 따라 줄지어 (퍼짐만큼 옆으로 흩어져요) · Alt+끌면 지우기 · 놓은 걸 옮기려면 「고르기」` });
    } else if (this.tool.kind === 'pick') {
      const m = T.marks[this.markSel];
      if (m) {
        this.slider(tools, `고른 ${m.k === 'hill' ? '언덕' : '산'} 크기`, 8, m.k === 'hill' ? 200 : 300, 1, m.s, null, (v) => `${Math.round(v)}`, (v) => {
          this.pushTundo({ type: 'marks', marks: T.marks.map((q) => ({ ...q })) });
          m.s = v;
          this.marksChanged();
        });
        const rb2 = tools.createDiv({ cls: 'mnsk-row-btns' });
        rb2.createEl('button', { cls: 'mnsk-btn', text: '고른 것 지우기' }).onclick = () => this.deleteMark(this.markSel);
      }
      tools.createDiv({ cls: 'mnsk-paint-hint', text: `산 · 언덕 ${T.marks.length}개 · 눌러서 고르기 · 끌어서 옮기기 · Delete로 지우기 · Alt+누르면 바로 지우기 · 빈 곳을 끌면 지도 이동 · 강 · 길 · 영역은 「영역 · 선」에서 꼭짓점을 끌어요` });
    } else if (this.tool.kind !== 'region') {
      this.slider(tools, '붓 크기 ([ ])', 4, 400, 1, this.tool.radius, (v) => {
        this.tool.radius = v;
      }, (v) => `${Math.round(v)}`);
    }
    // 영역
    const rs = sec('영역 · 선 (강 · 길 · 자국) · 점을 찍어서');
    const list = rs.createDiv({ cls: 'mnsk-terr-list' });
    T.regions.forEach((r, i) => {
      const row = list.createDiv({ cls: 'mnsk-terr' });
      row.toggleClass('is-active', i === this.regionSel && this.tool.kind === 'region');
      row.createDiv({ cls: 'mnsk-terr-sw ' + (isRiver(r) ? 'is-river' : isRoad(r) ? 'is-road' : isLine(r) ? 'is-trench' : isWreck(r) ? 'is-wreck' : 'is-region') });
      row.createDiv({ cls: 'mnsk-terr-name', text: r.name });
      row.createDiv({ cls: 'mnsk-terr-area', text: isLine(r) ? `${isRiver(r) ? '강' : isRoad(r) ? '길' : '자국'} · 점 ${r.pts.length}` : isWreck(r) ? `재해 지대 · 아묾 ${Math.round((r.heal || 0) * 100)}` : `꼭짓점 ${r.pts.length}` });
      row.onclick = () => {
        this.cancelDraft();
        this.regionSel = i;
        this.tool.kind = 'region';
        this.renderPaintPanel();
        this.renderRegionSvg();
      };
    });
    const rb = rs.createDiv({ cls: 'mnsk-row-btns' });
    const addB = rb.createEl('button', { cls: 'mnsk-btn', text: this.draft ? `「${this.draft.name}」 그리는 중` : '+ 새 영역' });
    addB.disabled = !!this.draft;
    addB.onclick = () => this.startRegionDraft();
    if (!this.draft) rb.createEl('button', { cls: 'mnsk-btn', text: '+ 새 강' }).onclick = () => this.startLineDraft('river');
    if (!this.draft) rb.createEl('button', { cls: 'mnsk-btn', text: '+ 새 길' }).onclick = () => this.startLineDraft('road');
    if (!this.draft) rb.createEl('button', { cls: 'mnsk-btn', text: '+ 새 자국' }).onclick = () => this.startTrenchDraft();
    if (!this.draft) rb.createEl('button', { cls: 'mnsk-btn', text: '+ 새 재해 지대' }).onclick = () => this.startWreckDraft();
    if (T.regions[this.regionSel] && !this.draft) {
      const sr = T.regions[this.regionSel];
      const cur = this.currentMap();
      const child = this.plugin.settings.maps.find((m) => cur && m.parent === cur.name && m.region === sr.name);
      if (isPlace(sr) && (!cur || sr.name !== cur.region)) {
        const pb = rb.createEl('button', { cls: 'mnsk-btn is-primary', text: child ? '판 열기' : '판 만들기' });
        pb.onclick = () => (child ? this.enterChild(child, sr) : this.createChildMap(sr));
      }
      rb.createEl('button', { cls: 'mnsk-btn', text: '이름' }).onclick = () => this.renameRegion();
      rb.createEl('button', { cls: 'mnsk-btn', text: '지우기' }).onclick = () => this.deleteRegion();
    }
    const selR = !this.draft ? T.regions[this.regionSel] : null;
    if (selR && isWreck(selR)) {
      this.slider(rs, `「${selR.name}」 아문 정도`, 0, 1, 0.05, selR.heal || 0, null, (v) => (v === 0 ? '막 생김' : v === 1 ? '다 아묾' : `${Math.round(v * 100)}`), (v) => {
        this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
        selR.heal = v;
        this.terrainChanged();
      });
      this.slider(rs, `「${selR.name}」 경계 자세히`, 0, 1, 0.05, selR.detail || 0.6, null, (v) => (v === 0 ? '그린 그대로' : `${Math.round(v * 100)}`), (v) => {
        this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
        selR.detail = Math.max(0.001, v);
        this.terrainChanged();
      });
    } else if (selR && isRiver(selR)) {
      const setW = (key) => (v) => {
        this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
        selR[key] = v;
        this.terrainChanged();
      };
      this.slider(rs, `「${selR.name}」 발원지 폭`, 0.5, 60, 0.5, selR.w0 == null ? 3 : selR.w0, null, (v) => `${v}`, setW('w0'));
      this.slider(rs, `「${selR.name}」 하구 폭`, 1, 200, 0.5, selR.w1 == null ? 12 : selR.w1, null, (v) => `${v}`, setW('w1'));
    } else if (selR && isTrench(selR)) {
      const setW = (key) => (v) => {
        this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
        selR[key] = v;
        this.terrainChanged();
      };
      this.slider(rs, `「${selR.name}」 시작 폭`, 1, 400, 1, selR.w0 || 8, null, (v) => `${Math.round(v)}`, setW('w0'));
      this.slider(rs, `「${selR.name}」 끝 폭`, 0.5, 200, 0.5, selR.w1 == null ? 1 : selR.w1, null, (v) => `${v}`, setW('w1'));
    } else if (selR) {
      this.slider(rs, `「${selR.name}」 경계 자세히`, 0, 1, 0.05, selR.detail || 0, null, (v) => (v === 0 ? '그린 그대로' : `${Math.round(v * 100)}`), (v) => {
        this.pushTundo({ type: 'regions', regions: this.snapshotRegions() });
        if (v > 0) selR.detail = v;
        else delete selR.detail;
        this.terrainChanged();
      });
    }
    if (T.inherited && T.inherited.length) {
      rs.createDiv({ cls: 'mnsk-paint-hint', text: `위 판에서 내려온 선(자국 · 강 · 길) ${T.inherited.length}개가 같이 그려져요 (점선). 고치려면 위 판에서 고쳐요.` });
    }
    if (this.tool.kind === 'region') {
      rs.createDiv({ cls: 'mnsk-paint-hint', text: '꼭짓점 끌어 옮기기 · Shift+누르기 꼭짓점 넣기 · Alt+누르기 꼭짓점 빼기 · 영역 밑은 늘 땅이 돼요 · 경계 자세히는 꼭짓점 사이를 잘게 꺾어요(큰 모양은 그대로) · 자국은 첫 점이 가장 넓고 끝으로 갈수록 좁아져요(땅 위에만 그려짐)' });
    }
    // 둘레 지형
    const nat = sec('둘레 지형 (그림 따라 저절로)');
    this.slider(nat, '해안 굴곡', 0, 2, 0.05, T.coast, null, (v) => (v === 0 ? '그린 그대로' : `${Math.round(v * 100)}`), (v) => {
      this.pushTundo({ type: 'settings', settings: { coast: T.coast } });
      T.coast = v;
      this.terrainChanged();
    });
    const isl = nat.createEl('button', { cls: 'mnsk-btn' + (T.isles ? ' is-on' : ''), text: T.isles ? '해안 작은 섬 넣는 중 (누르면 끄기)' : '해안 작은 섬 넣기' });
    isl.onclick = () => {
      this.pushTundo({ type: 'settings', settings: { isles: T.isles } });
      T.isles = !T.isles;
      this.terrainChanged();
    };
    // 밑그림
    if (T.underlay) {
      const un = sec('밑그림');
      const ub = un.createEl('button', { cls: 'mnsk-btn' + (this.under.on ? ' is-on' : ''), text: this.under.on ? '원본 그림 보는 중 (누르면 끄기)' : '원본 그림 위에 겹쳐 보기' });
      ub.onclick = () => {
        this.under.on = !this.under.on;
        this.updateUnderlay();
        this.renderPaintPanel();
      };
      if (this.under.on) {
        this.slider(un, '진하기', 0.1, 1, 0.05, this.under.alpha, (v) => {
          this.under.alpha = v;
          this.updateUnderlay();
        }, (v) => `${Math.round(v * 100)}`);
      }
    }
    // 아래
    const foot = P.createDiv({ cls: 'mnsk-paint-foot' });
    const undo = foot.createEl('button', { cls: 'mnsk-btn', text: '되돌리기' });
    undo.disabled = !this.tundo.length;
    undo.onclick = () => this.undoTerrain();
    const bake = foot.createEl('button', { cls: 'mnsk-btn' + (this.terrainDirty ? ' is-primary' : ''), text: '지도 그림 저장' });
    bake.onclick = () => this.bakeTerrain();
    foot.createDiv({ cls: 'mnsk-paint-saved', text: this.terrainDirty ? '그림 저장 전' : this.tBakedAt ? `${this.tBakedAt} 그림 저장됨` : '자동 저장' });
    P.createDiv({ cls: 'mnsk-paint-hint', text: '끌어서 칠하기 · 오른쪽 버튼이나 스페이스 누르고 끌면 지도 이동 · 손을 떼면 해안선 · 물결 · 숲 테두리가 다시 그려져요 · 다 그리면 「지도 그림 저장」(나갈 때도 저절로)' });
  }

  /* ---------- 스케치: 대충 잡고 Codex 로 그리기 ---------- */

  sketchPathOf(map) {
    const dir = map.path.includes('/') ? map.path.replace(/\/[^/]*$/, '/') : '';
    return map.sketch || `${dir}${map.name}.스케치.png`;
  }

  sketchWidth() {
    const ink = SKETCH_INKS.find((k) => k[0] === this.sketch.ink) || SKETCH_INKS[0];
    return this.sketch.radius * 2 * ink[3];
  }

  /** 스케치 모드로: 판 크기의 절반 캔버스를 깔고, 저장된 스케치가 있으면 불러옴 */
  async enterSketch() {
    const map = this.currentMap();
    const cv = this.sketchCanvas;
    if (!map || !this.W) return;
    const w = Math.round(this.W / 2);
    const h = Math.round(this.H / 2);
    if (this.sketchFor !== map.name || cv.width !== w) {
      cv.width = w;
      cv.height = h;
      this.sketch.undo = [];
      this.sketchFor = map.name;
      this.sketch.cands = [];
      const ad = this.app.vault.adapter;
      const p = this.sketchPathOf(map);
      try {
        if (await ad.exists(p)) {
          const im = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = ad.getResourcePath(p);
          });
          cv.getContext('2d').drawImage(im, 0, 0, w, h);
        }
      } catch (err) {
        console.error('[MN 세계판] 스케치를 불러오지 못했어요', err);
      }
    }
    cv.style.width = `${this.W}px`;
    cv.style.height = `${this.H}px`;
    cv.style.opacity = String(this.sketch.alpha);
    cv.removeClass('is-hidden');
    this.sketchPrev = document.createElement('canvas');
    this.sketchPrev.width = w;
    this.sketchPrev.height = h;
    this.sketchPrev.getContext('2d').drawImage(cv, 0, 0);
    this.renderPaintPanel();
  }

  leaveSketch() {
    this.sketchCanvas.addClass('is-hidden');
    this.saveSketchNow();
  }

  beginSketchStroke(e) {
    const [x, y] = this.toMap(e.clientX, e.clientY);
    const st = { last: [x / 2, y / 2], bb: [x / 2, y / 2, x / 2, y / 2] };
    this.sketchSeg(st, x / 2, y / 2);
    return st;
  }

  sketchStrokeTo(st, e) {
    const [x, y] = this.toMap(e.clientX, e.clientY);
    this.sketchSeg(st, x / 2, y / 2);
  }

  /** 붓 한 토막 (캔버스 = 지도의 절반 크기) */
  sketchSeg(st, x, y) {
    const ctx = this.sketchCanvas.getContext('2d');
    const ink = SKETCH_INKS.find((k) => k[0] === this.sketch.ink) || SKETCH_INKS[0];
    const lw = Math.max(1, this.sketchWidth() / 2);
    ctx.save();
    ctx.globalCompositeOperation = ink[0] === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ink[2] || '#000';
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(st.last[0], st.last[1]);
    ctx.lineTo(x + 0.01, y);
    ctx.stroke();
    ctx.restore();
    st.last = [x, y];
    const r = lw / 2 + 2;
    st.bb = [Math.min(st.bb[0], x - r), Math.min(st.bb[1], y - r), Math.max(st.bb[2], x + r), Math.max(st.bb[3], y + r)];
  }

  endSketchStroke(st) {
    const cv = this.sketchCanvas;
    const x0 = Math.max(0, Math.floor(st.bb[0]));
    const y0 = Math.max(0, Math.floor(st.bb[1]));
    const x1 = Math.min(cv.width, Math.ceil(st.bb[2]));
    const y1 = Math.min(cv.height, Math.ceil(st.bb[3]));
    if (x1 > x0 && y1 > y0 && this.sketchPrev) {
      const before = this.sketchPrev.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
      this.sketch.undo.push({ x: x0, y: y0, data: before });
      if (this.sketch.undo.length > 40) this.sketch.undo.shift();
      this.sketchPrev.getContext('2d').clearRect(x0, y0, x1 - x0, y1 - y0);
      this.sketchPrev.getContext('2d').drawImage(cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    this.saveSketchSoon();
    this.renderPaintPanel();
  }

  undoSketch() {
    const u = this.sketch.undo.pop();
    if (!u) {
      new Notice('되돌릴 게 없어요.');
      return;
    }
    this.sketchCanvas.getContext('2d').putImageData(u.data, u.x, u.y);
    this.sketchPrev.getContext('2d').putImageData(u.data, u.x, u.y);
    this.saveSketchSoon();
    this.renderPaintPanel();
  }

  clearSketch() {
    const cv = this.sketchCanvas;
    const all = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    this.sketch.undo.push({ x: 0, y: 0, data: all });
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    this.sketchPrev.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    this.saveSketchSoon();
    this.renderPaintPanel();
  }

  saveSketchSoon() {
    clearTimeout(this.sketchTimer);
    this.sketchTimer = setTimeout(() => this.saveSketchNow(), 900);
  }

  async saveSketchNow() {
    if (!this.sketchTimer) return;
    clearTimeout(this.sketchTimer);
    this.sketchTimer = null;
    const map = this.plugin.settings.maps.find((m) => m.name === this.sketchFor);
    if (!map) return;
    try {
      const blob = await new Promise((r) => this.sketchCanvas.toBlob(r, 'image/png'));
      await this.app.vault.adapter.writeBinary(this.sketchPathOf(map), await blob.arrayBuffer());
    } catch (err) {
      console.error('[MN 세계판] 스케치를 저장하지 못했어요', err);
    }
  }

  /** Codex 에게 보낼 그림: 양피지 위의 스케치 (1536 폭) */
  async sketchForCodex() {
    const cv = this.sketchCanvas;
    const w = 1536;
    const h = Math.round((1536 * cv.height) / cv.width);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#e9dec4';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(cv, 0, 0, w, h);
    return new Promise((r) => out.toBlob(r, 'image/png'));
  }

  async runCodexSketch() {
    const map = this.currentMap();
    if (!map || this.sketch.busy) return;
    if (!/^https?:/.test(location.protocol)) {
      new Notice('Codex로 그리기는 아직 세계판 창(브라우저)에서만 돼요.');
      return;
    }
    this.sketch.busy = true;
    this.sketch.started = Date.now();
    this.renderPaintPanel();
    const tick = setInterval(() => this.renderPaintPanel(), 5000);
    try {
      await this.saveSketchNow();
      const blob = await this.sketchForCodex();
      const q = new URLSearchParams({ map: map.name, w: String(this.W), h: String(this.H), note: this.sketch.note || '' });
      const res = await fetch(`/codex?${q.toString()}`, { method: 'POST', body: blob });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'Codex 오류');
      this.sketch.cands.unshift(j.path);
      new Notice('Codex가 그림을 그렸어요. 아래 후보에서 확인하세요.');
    } catch (err) {
      console.error('[MN 세계판] Codex로 그리기 실패', err);
      new Notice(`Codex로 그리지 못했어요: ${err.message || err}`);
    }
    clearInterval(tick);
    this.sketch.busy = false;
    this.renderPaintPanel();
  }

  /** 후보를 이 판의 바탕 그림으로 (지형 · 땅 자료 위치는 그대로 붙잡아 둠) */
  async useSketchCandidate(path) {
    const map = this.currentMap();
    if (!map) return;
    if (this.terrain) {
      new Notice('이 판은 지형 그리기 그림이 있어서, 바탕을 바꾸면 지형 그리기를 나갈 때 다시 덮여요. 지형이 없는 판에서 써 주세요.');
      return;
    }
    if (!map.terrain) map.terrain = this.terrainPathOf(map);
    if (!map.lands) map.lands = this.landsPathOf(map);
    if (!map.sketch) map.sketch = this.sketchPathOf(map);
    map.path = path;
    await this.plugin.saveSettings();
    new Notice(`「${map.name}」 바탕을 바꿨어요: ${path.split('/').pop()}`);
    this.afterLoad = () => this.setMode('sketch');
    this.reload(); // 같은 판이라도 그림을 다시 불러옴
  }

  renderSketchPanel() {
    const P = this.paintPanel;
    P.empty();
    P.removeClass('is-hidden');
    const head = P.createDiv({ cls: 'mnsk-paint-head' });
    head.createDiv({ cls: 'mnsk-card-kind', text: '편집' });
    head.createDiv({ cls: 'mnsk-paint-title', text: '스케치' });
    const sec = (label) => {
      const d = P.createDiv({ cls: 'mnsk-paint-sec' });
      d.createDiv({ cls: 'mnsk-paint-label', text: label });
      return d;
    };
    const tools = sec('붓 (색마다 뜻이 있어요)');
    const grid = tools.createDiv({ cls: 'mnsk-tools' });
    for (const [kind, label, color] of SKETCH_INKS) {
      const b = grid.createEl('button', { cls: 'mnsk-tool mnsk-sk-ink' });
      const sw = b.createSpan({ cls: 'mnsk-sk-sw' + (color ? '' : ' is-erase') });
      if (color) sw.style.background = color;
      b.createSpan({ text: label });
      b.toggleClass('is-active', this.sketch.ink === kind);
      b.onclick = () => {
        this.sketch.ink = kind;
        this.renderPaintPanel();
      };
    }
    this.slider(tools, '붓 크기 ([ ])', 4, 600, 1, this.sketch.radius, (v) => {
      this.sketch.radius = v;
    }, (v) => `${Math.round(v)}`);
    this.slider(tools, '스케치 진하기 (밑의 지도가 비치게)', 0.2, 1, 0.05, this.sketch.alpha, (v) => {
      this.sketch.alpha = v;
      this.sketchCanvas.style.opacity = String(v);
    }, (v) => `${Math.round(v * 100)}`);
    const rb = tools.createDiv({ cls: 'mnsk-row-btns' });
    const ub = rb.createEl('button', { cls: 'mnsk-btn', text: '되돌리기' });
    ub.disabled = !this.sketch.undo.length;
    ub.onclick = () => this.undoSketch();
    rb.createEl('button', { cls: 'mnsk-btn', text: '모두 지우기' }).onclick = () => this.clearSketch();
    tools.createDiv({ cls: 'mnsk-paint-hint', text: '끌어서 칠하기 · 오른쪽 버튼이나 스페이스+끌기로 지도 이동 · Ctrl+Z 되돌리기 · 칠한 건 저절로 저장돼요' });

    const cx = sec('Codex로 그리기');
    const ta = cx.createEl('textarea', { cls: 'mnsk-sk-note', attr: { rows: 3, placeholder: '덧붙일 설명 (없어도 돼요). 예: 가운데 빨간 곳은 큰 광장과 궁전, 북쪽 초록은 숲 공원' } });
    ta.value = this.sketch.note || '';
    ta.oninput = () => {
      this.sketch.note = ta.value;
    };
    const go = cx.createEl('button', { cls: 'mnsk-btn is-primary', text: this.sketch.busy ? `그리는 중… ${Math.round((Date.now() - (this.sketch.started || Date.now())) / 1000)}초 (1~2분 걸려요)` : '이 스케치로 그리기' });
    go.disabled = this.sketch.busy;
    go.onclick = () => this.runCodexSketch();
    cx.createDiv({ cls: 'mnsk-paint-hint', text: '스케치 자리 · 크기 · 모양대로, 세계판 양식(바랜 옛 지도 색, 갈색 먹선)으로 자세한 지도를 그려 후보로 남겨요. 판 크기에 맞춰 저장돼요.' });

    if (this.sketch.cands.length) {
      const cs = sec('후보 (위가 가장 최근)');
      const ad = this.app.vault.adapter;
      for (const p of this.sketch.cands) {
        const row = cs.createDiv({ cls: 'mnsk-sk-cand' });
        row.createEl('img', { attr: { src: ad.getResourcePath(p), alt: '' } });
        const r2 = row.createDiv({ cls: 'mnsk-row-btns' });
        r2.createDiv({ cls: 'mnsk-paint-hint', text: p.split('/').pop() });
        const use = r2.createEl('button', { cls: 'mnsk-btn', text: this.currentMap()?.path === p ? '지금 바탕' : '바탕으로 쓰기' });
        use.disabled = this.currentMap()?.path === p;
        use.onclick = () => this.useSketchCandidate(p);
      }
    }
  }

  /* ---------- 지도 움직이기 ---------- */

  fit() {
    const v = this.viewForRect([0, 0, this.W, this.H]);
    if (!v) return;
    this.minS = Math.min(this.minS || v.s, v.s * 0.6);
    this.s = v.s;
    this.tx = v.tx;
    this.ty = v.ty;
    this.fitted = true;
    this.apply();
  }

  /** 지도 위 사각형(지도 px)이 화면에 꽉 차는 배율·위치.
   *  위아래는 검색창·조작부에 가리지 않게 72px씩, 편집 중에는 오른쪽 판 자리도 비워요. */
  viewForRect([x0, y0, ww, wh]) {
    const r = this.stage.getBoundingClientRect();
    if (!ww || !wh || !r.width || !r.height) return null;
    const right = (this.mode === 'paint' || this.mode === 'terrain' || this.mode === 'sketch') && r.width > 760 ? 330 : 0;
    const s = Math.min((r.width - right - 56) / ww, (r.height - 144) / wh);
    return { s, tx: (r.width - right - ww * s) / 2 - x0 * s, ty: (r.height - wh * s) / 2 - y0 * s };
  }

  stopAnim() {
    cancelAnimationFrame(this.anim);
    this.animToken = (this.animToken || 0) + 1;
  }

  /** 화면 가운데 지점을 따라 부드럽게 옮기며 확대·축소 (배율은 로그로 고르게) */
  animateView(to, ms = 560) {
    this.stopAnim();
    const r = this.stage.getBoundingClientRect();
    const right = (this.mode === 'paint' || this.mode === 'terrain' || this.mode === 'sketch') && r.width > 760 ? 330 : 0;
    const cx = (r.width - right) / 2;
    const cy = r.height / 2;
    const a = { s: this.s, px: (cx - this.tx) / this.s, py: (cy - this.ty) / this.s };
    const b = { s: to.s, px: (cx - to.tx) / to.s, py: (cy - to.ty) / to.s };
    const t0 = performance.now();
    this.touched = true;
    const token = (this.animToken = (this.animToken || 0) + 1);
    // 창이 가려져 있으면 requestAnimationFrame 이 멈추므로, 늦어도 타이머로 한 걸음씩
    const next = (fn) => {
      let done = false;
      const run = () => {
        if (done || token !== this.animToken) return;
        done = true;
        fn(performance.now());
      };
      this.anim = requestAnimationFrame(run);
      setTimeout(run, 50);
    };
    return new Promise((res) => {
      const step = (t) => {
        const e = ease(Math.min(1, (t - t0) / ms));
        const sc = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e);
        this.s = sc;
        this.tx = cx - (a.px + (b.px - a.px) * e) * sc;
        this.ty = cy - (a.py + (b.py - a.py) * e) * sc;
        this.apply();
        if (e < 1) next(step);
        else res();
      };
      next(step);
    });
  }

  /** 지금 화면(지도 그림 · 지형 그림)을 그대로 떠서 판 위에 덮어 둠. 새 판이 나오면 서서히 걷음 */
  snapshotCover() {
    this.dropCover();
    const cover = this.stage.createDiv({ cls: 'mnsk-fade' });
    const inner = cover.createDiv({ cls: 'mnsk-fade-inner' });
    inner.style.transform = this.layer.style.transform;
    const img = inner.createEl('img', { attr: { src: this.mapImg.src, draggable: 'false', alt: '' } });
    img.style.width = `${this.W}px`;
    img.style.height = `${this.H}px`;
    if (!this.terrainCanvas.hasClass('is-hidden') && this.terrainCanvas.width) {
      const cv = inner.createEl('canvas');
      cv.width = this.terrainCanvas.width;
      cv.height = this.terrainCanvas.height;
      cv.style.width = `${this.W}px`;
      cv.style.height = `${this.H}px`;
      cv.getContext('2d').drawImage(this.terrainCanvas, 0, 0);
      if (this.markCanvas.width === cv.width) cv.getContext('2d').drawImage(this.markCanvas, 0, 0);
    }
    this.cover = cover;
  }

  dropCover(fade) {
    const c = this.cover;
    if (!c) return;
    this.cover = null;
    if (!fade) {
      c.remove();
      return;
    }
    setTimeout(() => c.addClass('is-out'), 30);
    setTimeout(() => c.remove(), 460);
  }

  apply() {
    this.layer.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    if (this.zoomLabel) this.zoomLabel.setText(`${Math.round(this.s * 100)}%`);
    if (this.zoomSlider && document.activeElement !== this.zoomSlider) this.zoomSlider.value = String(this.zoomT());
    this.layer.style.setProperty('--inv', String(1 / this.s));
    this.contentEl.toggleClass('is-far', this.s < this.minS * 1.4);
  }

  zoomAt(mx, my, k) {
    this.touched = true;
    const s2 = clamp(this.s * k, this.minS, 4);
    const f = s2 / this.s;
    this.tx = mx - (mx - this.tx) * f;
    this.ty = my - (my - this.ty) * f;
    this.s = s2;
    this.apply();
  }

  zoomCenter(k) {
    const r = this.stage.getBoundingClientRect();
    const right = (this.mode === 'paint' || this.mode === 'terrain' || this.mode === 'sketch') && r.width > 760 ? 330 : 0;
    this.zoomAt((r.width - right) / 2, r.height / 2, k);
  }

  /** 배율 ↔ 막대 값 (0~1, 로그 눈금) */
  zoomT() {
    const lo = Math.log(this.minS);
    return clamp((Math.log(this.s) - lo) / (Math.log(4) - lo), 0, 1);
  }

  zoomToT(t) {
    const s2 = Math.exp(Math.log(this.minS) + (Math.log(4) - Math.log(this.minS)) * t);
    this.zoomCenter(s2 / this.s);
  }

  /** 화면 좌표 → 지도 픽셀 좌표 */
  toMap(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    return [(clientX - r.left - this.tx) / this.s, (clientY - r.top - this.ty) / this.s];
  }

  /** 지도 픽셀 좌표 → 화면 좌표 */
  toScreen(xy) {
    const r = this.stage.getBoundingClientRect();
    return [r.left + this.tx + xy[0] * this.s, r.top + this.ty + xy[1] * this.s];
  }

  flyTo(xy) {
    this.stopAnim();
    this.touched = true;
    const r = this.stage.getBoundingClientRect();
    const cx = this.card.hasClass('is-hidden') ? r.width / 2 : (r.width - 330) / 2;
    const s0 = this.s;
    const s1 = clamp(Math.max(this.s, this.minS * 3.4), this.minS, 1);
    const p0 = [this.tx + xy[0] * s0, this.ty + xy[1] * s0];
    const p1 = [cx, r.height / 2];
    const t0 = performance.now();
    const step = (t) => {
      const e = ease(Math.min(1, (t - t0) / 480));
      this.s = s0 + (s1 - s0) * e;
      this.tx = p0[0] + (p1[0] - p0[0]) * e - xy[0] * this.s;
      this.ty = p0[1] + (p1[1] - p0[1]) * e - xy[1] * this.s;
      this.apply();
      if (e < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  bindStage() {
    const st = this.stage;
    this.registerDomEvent(
      st,
      'wheel',
      (e) => {
        e.preventDefault();
        this.stopAnim();
        const r = st.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    this.registerDomEvent(st, 'dblclick', (e) => {
      if (this.mode === 'terrain' && this.draft) {
        this.finishDraft();
        return;
      }
      if (this.mode === 'terrain' && this.tool.kind !== 'region') return; // 붓·돋보기는 두 번 누르기로 확대하지 않음
      if (e.target.closest('.mnsk-place, .mnsk-token')) return;
      const r = st.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8);
    });
    let drag = null;
    let stroke = null;
    let tstroke = null; // 지형 붓질
    let vdrag = null; // 영역 꼭짓점 끌기
    let mstroke = null; // 산 · 언덕 찍기
    let sstroke = null; // 스케치 붓질
    let mdrag = null; // 고른 산 · 언덕 옮기기
    this.registerDomEvent(st, 'contextmenu', (e) => {
      if (this.mode === 'paint' || this.mode === 'terrain' || this.mode === 'sketch') e.preventDefault();
    });
    this.registerDomEvent(st, 'pointerleave', () => this.brushRing.addClass('is-hidden'));
    this.registerDomEvent(st, 'pointerdown', (e) => {
      if (e.target.closest('.mnsk-place, .mnsk-token')) return;
      if (this.mode === 'sketch' && e.button === 0 && !this.spaceDown && this.W) {
        sstroke = this.beginSketchStroke(e);
        try {
          st.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 시험용 가짜 누르기 */
        }
        return;
      }
      const terrain = this.mode === 'terrain' && this.terrain;
      if (terrain && e.button === 0 && !this.spaceDown && (this.tool.kind === 'mtn' || this.tool.kind === 'hill')) {
        mstroke = this.beginMarkStroke(e);
        st.setPointerCapture(e.pointerId);
        return;
      }
      if (terrain && e.button === 0 && !this.spaceDown && this.tool.kind === 'pick') {
        const xy = this.toMap(e.clientX, e.clientY);
        const i = this.markAt(xy);
        if (i >= 0) {
          if (e.altKey) this.deleteMark(i);
          else {
            const m = this.terrain.marks[i];
            this.markSel = i;
            mdrag = { i, dx: m.x - xy[0], dy: m.y - xy[1], before: this.terrain.marks.map((q) => ({ ...q })), moved: false };
            st.setPointerCapture(e.pointerId);
            this.renderPaintPanel();
            this.renderRegionSvg();
          }
          return;
        }
        if (this.markSel >= 0) {
          this.markSel = -1;
          this.renderPaintPanel();
          this.renderRegionSvg();
        }
      }
      if (terrain && e.button === 0 && !this.spaceDown && this.tool.kind !== 'zoom' && this.tool.kind !== 'pick') {
        if (this.tool.kind !== 'region') {
          tstroke = this.beginTerrainStroke(e);
          st.setPointerCapture(e.pointerId);
          return;
        }
        const v = e.target.closest('.mnsk-rv');
        if (v && !this.draft && v.dataset.v != null) {
          const j = Number(v.dataset.v);
          if (e.altKey) this.deleteVertex(j);
          else {
            vdrag = { j, before: this.snapshotRegions(), moved: false };
            st.setPointerCapture(e.pointerId);
          }
          return;
        }
        if (this.draft) {
          this.addDraftPoint(this.toMap(e.clientX, e.clientY));
          return;
        }
        if (e.shiftKey && this.regionSel >= 0) {
          this.insertVertex(this.toMap(e.clientX, e.clientY));
          return;
        }
        const rg = e.target.closest('.mnsk-rg');
        if (rg) {
          this.regionSel = Number(rg.dataset.r);
          this.renderPaintPanel();
          this.renderRegionSvg();
          return;
        }
      }
      const painting = (this.mode === 'paint' && this.lands) || terrain || this.mode === 'sketch';
      if (this.mode === 'paint' && this.lands && e.button === 0 && !this.spaceDown) {
        stroke = this.beginStroke(e);
        if (stroke) st.setPointerCapture(e.pointerId);
        return;
      }
      // 칠하는 중에는 오른쪽·가운데 버튼(또는 스페이스+왼쪽)으로 지도를 옮겨요
      if (e.button !== 0 && !(painting && (e.button === 1 || e.button === 2))) return;
      this.stopAnim();
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      st.setPointerCapture(e.pointerId);
    });
    this.registerDomEvent(st, 'pointermove', (e) => {
      this.moveBrushRing(e);
      if (this.mode === 'view' && !drag && this.terrain && this.W) {
        const hit = this.regionAt(this.toMap(e.clientX, e.clientY));
        st.toggleClass('is-enterable', !!(hit && hit.map));
        st.title = hit ? (hit.map ? `${hit.region.name} · 눌러서 들어가기` : `${hit.region.name} · 판 없음`) : '';
      }
      if (tstroke) {
        this.terrainStrokeTo(tstroke, e);
        return;
      }
      if (mstroke) {
        this.markStrokeTo(mstroke, e);
        return;
      }
      if (sstroke) {
        this.sketchStrokeTo(sstroke, e);
        return;
      }
      if (mdrag) {
        const m = this.terrain.marks[mdrag.i];
        const xy = this.toMap(e.clientX, e.clientY);
        if (m) {
          m.x = xy[0] + mdrag.dx;
          m.y = xy[1] + mdrag.dy;
          if (!mdrag.moved) {
            mdrag.moved = true;
            const keep = this.terrain.marks;
            this.terrain.marks = keep.filter((q) => q !== m);
            this.renderMarks();
            this.terrain.marks = keep;
          }
          this.clearPreview();
          this.previewMark(m);
          this.renderRegionSvg();
        }
        return;
      }
      if (vdrag) {
        const r = this.terrain.regions[this.regionSel];
        if (r) {
          r.pts[vdrag.j] = this.toMap(e.clientX, e.clientY);
          vdrag.moved = true;
          this.renderRegionSvg();
        }
        return;
      }
      if (stroke) {
        this.strokeTo(stroke, e);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.touched = true;
      st.addClass('is-panning');
      this.tx = drag.tx + dx;
      this.ty = drag.ty + dy;
      this.apply();
    });
    const end = (e) => {
      if (tstroke) {
        tstroke = null;
        this.endTerrainStroke();
        return;
      }
      if (mstroke) {
        const m = mstroke;
        mstroke = null;
        this.endMarkStroke(m);
        return;
      }
      if (sstroke) {
        const k = sstroke;
        sstroke = null;
        this.endSketchStroke(k);
        return;
      }
      if (mdrag) {
        const d = mdrag;
        mdrag = null;
        if (d.moved) {
          this.pushTundo({ type: 'marks', marks: d.before });
          this.marksChanged();
        }
        return;
      }
      if (vdrag) {
        const v = vdrag;
        vdrag = null;
        if (v.moved) {
          this.pushTundo({ type: 'regions', regions: v.before });
          this.terrainChanged();
        }
        return;
      }
      if (stroke) {
        const s = stroke;
        stroke = null;
        this.endStroke(s);
        return;
      }
      if (!drag) return;
      const click = !drag.moved;
      drag = null;
      st.removeClass('is-panning');
      if (click && e.type === 'pointerup' && this.mode === 'terrain' && this.tool.kind === 'zoom' && e.button === 0) {
        const r = st.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.altKey || e.shiftKey ? 1 / 1.8 : 1.8);
        return;
      }
      if (click && e.type === 'pointerup' && this.mode !== 'paint' && this.mode !== 'terrain') this.onMapClick(e);
    };
    this.registerDomEvent(st, 'pointerup', end);
    this.registerDomEvent(st, 'pointercancel', end);
  }

  onMapClick(e) {
    if (this.moveTarget) {
      new Notice('지역 표식을 눌러 주세요. 그만두려면 Esc.');
      return;
    }
    if (this.mode === 'stamp') {
      if (!this.W) return;
      const xy = this.toMap(e.clientX, e.clientY);
      if (xy[0] < 0 || xy[1] < 0 || xy[0] > this.W || xy[1] > this.H) return;
      new PlaceSuggest(this.app, this.plugin, this, xy).open();
      return;
    }
    if (this.mode === 'view' && this.W) {
      const hit = this.regionAt(this.toMap(e.clientX, e.clientY));
      if (hit && hit.map) {
        this.enterChild(hit.map, hit.region);
        return;
      }
      if (hit) new Notice(`「${hit.region.name}」 판은 아직 없어요. 지형 그리기 → 영역에서 고르고 「판 만들기」를 누르세요.`);
    }
    this.select(null);
  }

  cancelModes() {
    this.moveTarget = null;
    if (this.mode === 'stamp' || this.mode === 'paint' || this.mode === 'terrain' || this.mode === 'sketch') this.setMode('view');
    else this.hideBanner();
  }

  setMode(mode) {
    const prev = this.mode;
    this.mode = mode;
    this.moveTarget = null;
    this.contentEl.toggleClass('is-stamp', mode === 'stamp');
    this.contentEl.toggleClass('is-paint', mode === 'paint');
    this.contentEl.toggleClass('is-terrain', mode === 'terrain');
    this.contentEl.toggleClass('is-sketch', mode === 'sketch');
    if (mode === 'sketch') this.enterSketch();
    else if (prev === 'sketch') this.leaveSketch();
    this.contentEl.toggleClass('is-zoomtool', mode === 'terrain' && this.tool.kind === 'zoom');
    if (prev === 'terrain' && mode !== 'terrain') {
      this.draft = null;
      if (this.terrainDirty) this.bakeTerrain(); // 나가면서 지도 그림으로 굽기
    }
    for (const b of this.modeButtons) b.el.toggleClass('is-active', b.mode === mode);
    if (mode === 'stamp') this.showBanner('지도를 누르면 그 자리에 지역을 만들거나 옮겨요 · 지역 표식은 끌어서 옮겨요 · Esc로 끝');
    else this.hideBanner();
    if (mode === 'paint' || mode === 'terrain' || mode === 'sketch') this.select(null);
    if (mode !== 'paint' && mode !== 'terrain' && mode !== 'sketch') this.brushRing.addClass('is-hidden');
    this.renderPaintPanel();
    this.showTerrainLayer();
    if (this.W && !this.touched) this.fit(); // 판이 생기거나 없어지면 지도를 다시 맞춤
  }

  /* ---------- 표식 ---------- */

  renderPins() {
    this.pinLayer.empty();
    if (!this.W) return;
    const { places, people } = this.here;
    for (const pl of places) {
      if (!pl.xy) continue;
      const inner = this.marker(pl.xy);
      if (pl.icon) {
        // 건물 그림: 지도와 같이 커지고 작아지게 (밑동 = 좌표)
        const im = inner.parentElement.createEl('img', { cls: 'mnsk-bicon', attr: { src: pl.icon, draggable: 'false', alt: '' } });
        im.style.width = `${pl.iconW}px`;
        im.dataset.path = pl.file.path;
        this.bindMarker(im, pl);
      }
      const el = inner.createDiv({ cls: 'mnsk-place' + (pl.area ? ' is-area' : pl.capital ? ' is-capital' : pl.icon ? ' is-building' : '') + (this.placeMapOf(pl) ? ' has-map' : '') });
      el.createDiv({ cls: 'mnsk-place-dot' });
      el.createDiv({ cls: 'mnsk-place-name', text: pl.name });
      this.bindMarker(el, pl);
    }
    const groups = new Map();
    for (const p of people) {
      if (!p.xy) continue;
      const key = p.xy.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      this.marker(group[0].xy).createDiv({ cls: 'mnsk-stem' + (group[0].place?.area ? ' is-area' : '') });
      group.forEach((p, i) => {
        const el = this.marker(p.xy).createDiv({ cls: 'mnsk-token' });
        el.style.left = `${(i - (group.length - 1) / 2) * 58}px`;
        el.style.top = '-62px';
        if (p.doing) el.createDiv({ cls: 'mnsk-token-doing', text: p.doing });
        this.fillFace(el.createDiv({ cls: 'mnsk-token-face' }), p);
        el.createDiv({ cls: 'mnsk-token-name', text: p.name });
        this.bindMarker(el, p);
      });
    }
    this.markSelection();
  }

  marker(xy) {
    const m = this.pinLayer.createDiv({ cls: 'mnsk-m' });
    m.style.left = `${xy[0]}px`;
    m.style.top = `${xy[1]}px`;
    return m.createDiv({ cls: 'mnsk-m-in' });
  }

  fillFace(el, person) {
    el.empty();
    if (person.portrait) {
      el.createEl('img', { attr: { src: person.portrait, alt: '', draggable: 'false' } });
    } else {
      el.addClass('is-initial');
      el.style.background = faceColor(person.name);
      el.setText(Array.from(person.name)[0] || '?');
    }
  }

  bindMarker(el, item) {
    el.dataset.path = item.file.path;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.stopAnim();
      const canDrag = item.kind === 'person' || this.mode === 'stamp';
      const start = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!canDrag || (!start.moved && Math.hypot(dx, dy) < 4)) return;
        start.moved = true;
        el.addClass('is-dragging');
        el.closest('.mnsk-m')?.addClass('is-top');
        el.style.translate = `${dx}px ${dy}px`;
        if (item.kind === 'person') this.markDrop(this.placeNear(ev.clientX, ev.clientY));
      };
      const up = async (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeClass('is-dragging');
        el.style.translate = '';
        this.markDrop(null);
        if (!start.moved) {
          if (ev.type === 'pointerup') this.onMarkerClick(item);
          return;
        }
        if (ev.type !== 'pointerup') return;
        if (item.kind === 'person') {
          const target = this.placeNear(ev.clientX, ev.clientY);
          if (target) await this.plugin.movePerson(item, target);
          else new Notice('지역 표식 위에 놓아야 옮겨져요.');
          this.renderPins();
        } else {
          await this.plugin.setPlaceXY(item, this.toMap(ev.clientX, ev.clientY));
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  onMarkerClick(item) {
    if (this.moveTarget) {
      if (item.kind === 'place') {
        const person = this.moveTarget;
        this.moveTarget = null;
        this.hideBanner();
        this.plugin.movePerson(person, item);
      }
      return;
    }
    const pm = item.kind === 'place' && this.mode === 'view' ? this.placeMapOf(item) : null;
    if (pm) {
      this.select(null);
      this.enterChild(pm, null);
      return;
    }
    this.select(item);
  }

  placeNear(clientX, clientY) {
    let best = null;
    let bestD = DROP_RADIUS;
    for (const pl of this.here.places) {
      if (!pl.xy) continue;
      const [sx, sy] = this.toScreen(pl.xy);
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) {
        best = pl;
        bestD = d;
      }
    }
    return best;
  }

  markDrop(place) {
    for (const el of this.pinLayer.querySelectorAll('.mnsk-place')) {
      el.toggleClass('is-drop', !!place && el.dataset.path === place.file.path);
    }
  }

  /* ---------- 선택과 카드 ---------- */

  select(item) {
    this.selected = item ? item.file.path : null;
    this.markSelection();
    this.renderCard();
  }

  findSelected() {
    if (!this.selected) return null;
    return [...this.data.people, ...this.data.places].find((it) => it.file.path === this.selected) || null;
  }

  markSelection() {
    for (const el of this.pinLayer.querySelectorAll('.mnsk-place, .mnsk-token')) {
      const on = el.dataset.path === this.selected;
      el.toggleClass('is-selected', on);
      el.closest('.mnsk-m')?.toggleClass('is-top', on);
    }
  }

  peopleAt(place) {
    return this.data.people.filter((p) => p.place === place);
  }

  renderCard() {
    const c = this.card;
    c.empty();
    const it = this.findSelected();
    c.toggleClass('is-hidden', !it);
    if (!it) return;
    const person = it.kind === 'person';
    const head = c.createDiv({ cls: 'mnsk-card-head' });
    if (person) this.fillFace(head.createDiv({ cls: 'mnsk-card-face' }), it);
    else head.createDiv({ cls: 'mnsk-card-placeicon' });
    const title = head.createDiv({ cls: 'mnsk-card-title' });
    title.createDiv({ cls: 'mnsk-card-kind', text: person ? '인물' : '지역' });
    title.createDiv({ cls: 'mnsk-card-name', text: it.name });
    const close = head.createEl('button', { cls: 'mnsk-card-close clickable-icon', attr: { 'aria-label': '닫기' } });
    setIcon(close, 'x');
    close.onclick = () => this.select(null);

    const rows = c.createEl('dl', { cls: 'mnsk-card-rows' });
    const row = (label) => {
      const d = rows.createDiv();
      d.createEl('dt', { text: label });
      return d.createEl('dd');
    };
    if (person) {
      const loc = row('위치');
      if (it.place) {
        const a = loc.createEl('a', { cls: 'mnsk-link', text: it.place.name });
        a.onclick = () => {
          this.select(it.place);
          if (it.place.xy) this.flyTo(it.place.xy);
        };
        if (!it.place.xy) loc.createSpan({ cls: 'mnsk-dim', text: ' (지도에 없음)' });
      } else {
        loc.setText(it.placeLabel ? `${it.placeLabel}` : '정해지지 않음');
        if (it.placeLabel) loc.createSpan({ cls: 'mnsk-dim', text: ' (지역 노트 없음)' });
      }
      const doing = row('하는 일');
      doing.addClass('is-doing');
      doing.setText(it.doing || '—');
      row('시점').setText(it.when || '—');
    } else {
      const here = this.peopleAt(it);
      const dd = row('여기 있는 인물');
      if (!here.length) dd.setText('없음');
      for (const p of here) {
        const chip = dd.createEl('a', { cls: 'mnsk-chip', text: p.name });
        chip.onclick = () => this.select(p);
      }
      const tk = this.territoryOf(it);
      if (tk) row('넓이').setText(`지도의 ${this.lands.percent(tk).toFixed(2)}%`);
      row('지도').setText(it.map || '—');
      row('좌표').setText(it.xy ? `${Math.round(it.xy[0])}, ${Math.round(it.xy[1])}` : '지도에 없음');
    }

    const actions = c.createDiv({ cls: 'mnsk-card-actions' });
    const open = actions.createEl('button', { cls: 'mnsk-btn is-primary', text: '노트 열기' });
    open.onclick = () => this.app.workspace.getLeaf('split', 'vertical').openFile(it.file);
    if (!person && it.xy && it.map === this.mapName) {
      const pm = this.placeMapOf(it);
      if (pm) actions.createEl('button', { cls: 'mnsk-btn', text: '판으로 들어가기' }).onclick = () => this.enterChild(pm, null);
      else if (this.terrain) actions.createEl('button', { cls: 'mnsk-btn', text: '판 만들기' }).onclick = () => this.createPlaceMap(it);
    }
    if (person) {
      const mv = actions.createEl('button', { cls: 'mnsk-btn', text: '위치 옮기기' });
      mv.onclick = () => {
        if (this.mode === 'stamp') this.setMode('view');
        this.moveTarget = it;
        this.showBanner(`${it.name}을(를) 옮길 지역 표식을 누르세요 · Esc 취소`);
      };
    }
  }

  /* ---------- 검색 ---------- */

  buildSearch(root) {
    const box = root.createDiv({ cls: 'mnsk-search' });
    const field = box.createDiv({ cls: 'mnsk-search-field' });
    setIcon(field.createSpan({ cls: 'mnsk-search-icon' }), 'search');
    this.searchInput = field.createEl('input', {
      type: 'text',
      attr: { placeholder: '인물·지역 찾기', spellcheck: 'false' },
    });
    this.results = box.createDiv({ cls: 'mnsk-results' });
    this.registerDomEvent(this.searchInput, 'input', () => {
      this.cursor = 0;
      this.renderResults();
    });
    this.registerDomEvent(this.searchInput, 'keydown', (e) => {
      if (e.key === 'ArrowDown') this.cursor = Math.min(this.cursor + 1, this.hits.length - 1);
      else if (e.key === 'ArrowUp') this.cursor = Math.max(this.cursor - 1, 0);
      else if (e.key === 'Enter') {
        if (this.hits[this.cursor]) this.pick(this.hits[this.cursor]);
      } else if (e.key === 'Escape') this.searchInput.value = '';
      else return;
      e.preventDefault();
      e.stopPropagation();
      this.renderResults();
    });
  }

  renderResults() {
    const q = this.searchInput.value.trim().toLowerCase();
    this.results.empty();
    this.hits = [];
    if (!q) return;
    this.hits = [...this.data.people, ...this.data.places]
      .filter((it) => [it.name, ...it.aliases].some((n) => n.toLowerCase().includes(q)))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'ko') : a.kind === 'person' ? -1 : 1))
      .slice(0, 8);
    if (!this.hits.length) {
      this.results.createDiv({ cls: 'mnsk-result is-empty', text: '찾는 이름이 없어요' });
      return;
    }
    this.hits.forEach((it, i) => {
      const row = this.results.createDiv({ cls: 'mnsk-result' });
      row.toggleClass('is-active', i === this.cursor);
      if (it.kind === 'person') this.fillFace(row.createDiv({ cls: 'mnsk-result-face' }), it);
      else row.createDiv({ cls: 'mnsk-result-place' });
      const text = row.createDiv({ cls: 'mnsk-result-text' });
      text.createDiv({ cls: 'mnsk-result-name', text: it.name });
      const other = it.map !== this.mapName && this.plugin.settings.maps.length > 1 ? it.map : '';
      const sub =
        it.kind === 'person'
          ? [it.placeLabel || '위치 없음', it.doing, other].filter(Boolean).join(' · ')
          : ['지역', `인물 ${this.peopleAt(it).length}명`, other].filter(Boolean).join(' · ');
      text.createDiv({ cls: 'mnsk-result-sub', text: sub });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(it);
      });
    });
  }

  pick(it) {
    this.searchInput.value = '';
    this.renderResults();
    this.searchInput.blur();
    if (!it.xy) {
      this.select(it);
      new Notice(`${it.name}은(는) 아직 지도에 없어요.`);
      return;
    }
    // 다른 지도에 있으면 그 지도를 펼친 뒤 날아가요.
    const path = it.file.path;
    this.switchMap(it.map, () => {
      this.select(this.findByPath(path) || it);
      this.flyTo(it.xy);
    });
  }

  findByPath(path) {
    return [...this.data.people, ...this.data.places].find((x) => x.file.path === path) || null;
  }

  /* ---------- 아래 막대 ---------- */

  buildBar(root) {
    const bar = root.createDiv({ cls: 'mnsk-bar' });
    const seg = bar.createDiv({ cls: 'mnsk-seg' });
    this.modeButtons = [
      { mode: 'view', label: '보기' },
      { mode: 'stamp', label: '지역 찍기' },
      { mode: 'paint', label: '땅 칠하기' },
      { mode: 'terrain', label: '지형 그리기' },
      { mode: 'sketch', label: '스케치' },
    ].map((b) => {
      const el = seg.createEl('button', { text: b.label });
      el.onclick = () => this.setMode(b.mode);
      return { ...b, el };
    });
    this.modeButtons[0].el.addClass('is-active');
    this.info = bar.createDiv({ cls: 'mnsk-info' });

    const zoom = root.createDiv({ cls: 'mnsk-zoom' });
    const zb = (icon, label, fn) => {
      const b = zoom.createEl('button', { attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.onclick = fn;
    };
    zb('minus', '작게 (- 글쇠)', () => this.zoomCenter(1 / 1.5));
    this.zoomLabel = zoom.createDiv({ cls: 'mnsk-zoom-val', text: '' });
    zb('plus', '크게 (+ 글쇠)', () => this.zoomCenter(1.5));
    zb('maximize', '전체 보기 (0 글쇠)', () => this.fit());
  }

  renderInfo() {
    const { places, people } = this.here;
    const off = people.filter((p) => !p.xy).length;
    this.info.setText(`지역 ${places.filter((p) => p.xy).length} · 인물 ${people.length - off}${off ? ` · 지도 밖 ${off}` : ''}`);
  }

  showBanner(text) {
    this.banner.setText(text);
    this.banner.removeClass('is-hidden');
  }

  hideBanner() {
    this.banner.addClass('is-hidden');
  }

  showMsg(text) {
    this.msg.setText(text);
    this.msg.toggleClass('is-hidden', !text);
  }
}

class PlaceSuggest extends SuggestModal {
  constructor(app, plugin, view, xy) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.xy = xy;
    this.setPlaceholder('지역 이름 · 새로 만들거나 있는 지역을 이 자리로 옮겨요');
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    // 지금 지도의 지역, 그리고 아직 어느 지도에도 안 놓인 지역만
    const places = this.view.data.places.filter((p) => p.map === this.view.mapName || !p.xy);
    const list = places
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => (a.xy ? 1 : 0) - (b.xy ? 1 : 0) || a.name.localeCompare(b.name, 'ko'));
    if (q && !places.some((p) => p.name.toLowerCase() === q)) list.unshift({ create: query.trim() });
    return list.slice(0, 12);
  }

  renderSuggestion(it, el) {
    if (it.create) {
      el.createDiv({ text: `새 지역 만들기: ${it.create}` });
      return;
    }
    el.createDiv({ text: it.name });
    el.createEl('small', { text: it.xy ? '이미 지도에 있어요 → 이 자리로 옮겨요' : '지도에 아직 없어요 → 여기에 놓아요' });
  }

  async onChooseSuggestion(it) {
    if (it.create) await this.plugin.createPlace(it.create, this.xy, this.view.mapName);
    else await this.plugin.setPlaceXY(it, this.xy, this.view.mapName);
  }
}

class LandSuggest extends SuggestModal {
  constructor(app, view) {
    super(app);
    this.view = view;
    this.setPlaceholder('칠할 땅 · 이 지도의 지역 노트를 고르거나 빗금 구역을 추가해요');
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase();
    const have = new Set((this.view.lands?.terr || []).map((t) => t.name));
    const list = this.view.here.places
      .filter((p) => !have.has(p.name) && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.area) - Number(a.area) || a.name.localeCompare(b.name, 'ko'))
      .map((p) => ({ name: p.name, kind: '종족' }));
    let j = 1;
    while (have.has(`빗금 ${j}`)) j++;
    list.push({ name: `빗금 ${j}`, kind: '빗금', hatch: true });
    return list.slice(0, 20);
  }

  renderSuggestion(it, el) {
    el.createDiv({ text: it.name });
    el.createEl('small', { text: it.hatch ? '빗금 구역 (뜻을 정하기 전 표시용)' : '종족 땅' });
  }

  onChooseSuggestion(it) {
    this.view.addTerritory(it.name, it.kind);
  }
}

class NameModal extends Modal {
  constructor(app, title, value, onSubmit) {
    super(app);
    this.title = title;
    this.value = value;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'mnsk-name-input' });
    input.value = this.value || '';
    input.style.width = '100%';
    const ok = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ok();
      }
    });
    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const b = row.createEl('button', { text: '확인', cls: 'mod-cta' });
    b.onclick = ok;
    setTimeout(() => input.focus(), 20);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SekaiSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const c = this.containerEl;
    c.empty();
    const text = (name, desc, key) =>
      new Setting(c)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (v) => {
            this.plugin.settings[key] = v.trim();
            await this.plugin.saveSettings();
          }),
        );
    new Setting(c)
      .setName('지도')
      .setDesc('한 줄에 하나씩 "이름 | 그림 경로". 지역 노트의 `지도` 값이 이 이름과 같아야 해요. 맨 위가 기본 지도예요.')
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.style.width = '100%';
        t.setValue(this.plugin.settings.maps.map((m) => `${m.name} | ${m.path}`).join('\n')).onChange(async (v) => {
          const maps = v
            .split('\n')
            .map((line) => line.split('|').map((s) => s.trim()))
            .filter(([name, path]) => name && path)
            .map(([name, path]) => ({ name, path }));
          if (!maps.length) return;
          this.plugin.settings.maps = maps;
          await this.plugin.saveSettings();
        });
      });
    text('기록 폴더', '인물을 옮기면 이 폴더의 오늘 날짜 노트에 한 줄 남겨요', 'logFolder');
    text('새 지역 폴더', '지역 찍기로 새로 만든 지역 노트가 들어가는 곳', 'placeFolder');
  }
}

module.exports = SekaipanPlugin;
