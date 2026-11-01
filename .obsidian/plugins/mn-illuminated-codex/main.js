"use strict";

const {
  Component,
  FuzzySuggestModal,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  TFile,
  normalizePath,
  parseYaml,
  stringifyYaml,
} = require("obsidian");

const BLOCK_LANGUAGE = "mn-codex";
const THEMES = new Set(["parchment", "frost", "ember", "forest", "ink", "moon", "redline", "resonance", "mely"]);
const IMAGE_POSITIONS = new Set(["left", "right"]);
const IMAGE_FOCUS = new Set(["top", "center", "bottom"]);
const IMAGE_FITS = new Set(["contain", "cover", "bleed"]);
const MELY_SHOWCASE_LAYOUTS = new Set([
  "ribbon-slash",
  "tidal-crescent",
  "horn-slash",
  "portrait-echo",
  "black-tide",
]);
const LAYOUT_MODES = new Set(["flow", "book", ...MELY_SHOWCASE_LAYOUTS]);
const PAGE_BREAK_PATTERN = /<!--\s*mn-page-break\s*-->/gi;

// 캐릭터 전용 지면(layout_variant)을 인물마다 다르게: 지면 색 = [색상 돌림(도, oklch 의 h 는 단위 없는 수), 채도 배수].
// 은회(리냐 지면 그대로)는 돌리지 않음. 실험실 추가 2026-10-28
const VARIANT_TINTS = Object.freeze({ 먹: [0, 0], 쪽빛: [20, 1.6], 청록: [-65, 1.4], 녹: [-110, 1.2], 자주: [60, 1.4], 적갈: [140, 1.4], 황토: [180, 1.3] });
const VARIANT_TINT_NAMES = Object.freeze(["은회", ...Object.keys(VARIANT_TINTS)]);
const VARIANT_TOKEN = /(\.[\w-]*variant-silver-knight)(?![\w-])/gu;
// 능력 등급 한 단 안의 열 칸: M0 Ⅰ부터, Ⅹ 다음은 다음 단 Ⅰ (작가와 정함 2026-10-30)
const GRADE_STEPS = Object.freeze(["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"]);
// 큰 축과 세부 스테이터스 (작가가 고름 2026-11-01, 큰 축은 무력 · 민첩 · 플라즈마 · 내구도 · 감각 다섯). 「큰 축: 등급」은 오각형에, 「큰 축 > 세부: 등급」은 큰 축을 누르면 그 축의 세부 다각형으로
const RECORD_AXES = Object.freeze({
  "전투 등급": [
    ["무력", ["완력", "각력", "악력"]],
    ["민첩", ["순발력", "속도", "반응", "몸놀림"]],
    ["플라즈마", ["출력", "운용", "강화", "방출", "지속"]],
    ["내구도", ["맷집", "지구력", "회복력"]],
    ["감각", ["동체시력", "기척", "간파"]],
  ],
});
// 「M2 Ⅶ」 · 「M2 VII」 · 「M2 7」 → { tier: 2, step: 7 }
const RECORD_LATIN = Object.freeze(["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]);
const parseRecordGrade = (value) => {
  const match = String(value || "").replace(/\s+/gu, "").match(/^M(\d+)[-·]?(.+)$/iu);
  if (!match) return null;
  const mark = match[2].toUpperCase();
  let step = GRADE_STEPS.indexOf(mark);
  if (step < 0) step = RECORD_LATIN.indexOf(mark);
  if (step < 0 && /^\d+$/u.test(mark)) step = Number(mark) - 1;
  return step >= 0 && step < 10 ? { tier: Number(match[1]), step: step + 1 } : null;
};
const recordGradeText = (grade) => `M${grade.tier} ${GRADE_STEPS[grade.step - 1]}`;
const RECORD_KINDS = Object.freeze(["패시브", "액티브"]);
// 내성주 평균 수준: 등급을 적은 것만, M0 Ⅰ부터 센 칸 수의 평균을 반올림 (작가 2026-11-01)
const recordResistMean = (resists) => {
  const graded = resists.filter((resist) => resist.grade);
  if (!graded.length) return { graded, mean: null };
  const index = Math.round(graded.reduce((sum, resist) => sum + resist.grade.tier * 10 + resist.grade.step - 1, 0) / graded.length);
  return { graded, mean: { tier: Math.floor(index / 10), step: (index % 10) + 1 } };
};

/** 괄호 · 따옴표 밖의 구분자로만 나눔 (선택자 목록 · 선언 목록) */
const splitTopLevel = (text, separator) => {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
};

/** 지면 색 덧층: styles.css 의 캐릭터 전용 지면 규칙(variant-silver-knight)을 같은 자리에 「.mn-sk-tint」를 붙여 그대로 베끼고
 *  색 값만 oklch(from 색 …)로 돌림. 베낀 규칙은 모두 한 칸씩 무거워져서 원래 규칙끼리의 앞뒤 · 무게는 그대로.
 *  색을 고르지 않은 지면(리냐)은 이 덧층을 쓰지 않음 */
const buildVariantTintCss = (css, assetUrl) => {
  const source = String(css || "").replace(/\/\*[\s\S]*?\*\//gu, "");
  const roots = [".mn-codex--variant-silver-knight", ".mn-mely-showcase--variant-silver-knight", ".mn-codex-host--variant-silver-knight"]
    .map((selector) => `${selector}.mn-sk-tint`).join(",");
  const tint = (value) => value
    .replace(/url\([^)]*\)|"[^"]*"|'[^']*'|#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)/gu, (match) => (/^(url|"|')/u.test(match)
      ? match
      : `oklch(from ${match} l calc(c * var(--sk-c, 1)) calc(h + var(--sk-h, 0)))`))
    .replace(/url\((["']?)assets\/([^"')]+)\1\)/gu, (match, quote, name) => `url("${assetUrl(name)}")`);
  const walk = (text) => {
    let out = "";
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open < 0) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      index = close;
      if (/^@(media|supports|container)\b/u.test(prelude)) {
        const inner = walk(body);
        if (inner) out += `${prelude}{\n${inner}}\n`;
        continue;
      }
      if (prelude.startsWith("@")) continue;
      let selector = "";
      let declarations = splitTopLevel(body, ";").map((item) => item.trim()).filter(Boolean);
      if (prelude === ":root") {
        selector = roots;
        declarations = declarations.filter((item) => item.startsWith("--mn-sk-"));
      } else if (prelude.includes("variant-silver-knight")) {
        selector = splitTopLevel(prelude, ",").map((item) => item.trim())
          .filter((item) => item.includes("variant-silver-knight"))
          .map((item) => item.replace(VARIANT_TOKEN, "$1.mn-sk-tint")).join(",");
      }
      if (!selector || !declarations.length) continue;
      out += `${selector}{${declarations.map(tint).join(";")}}\n`;
    }
    return out;
  };
  return walk(source);
};

// 물감 방울로 그림이 드러나는 효과 — 「특징」(개요 장의 쪽 그림)에만. 작가 요청 2026-10-29: 「툭… 투툭… 툭 불규칙하게 물감 떨어지듯 시작해서
// 천천히 번지면서 드러나게」. 그림 위에 같은 크기 캔버스를 잠깐 얹어 그래픽 카드(WebGL)로 그리고, 다 번지면 캔버스를 떼고 원래 그림을 보여 줌
// (CSS 가림막을 움직이면 매 프레임 화면을 새로 그려 렉이 생겨서). 방울마다: 떨어지는 순간 작게 퍼지고(툭) 둘레에 작은 튄 방울 →
// 천천히 번짐(갓 번진 자리는 색이 먼저, 마르면서 선이 또렷해짐 · 가장자리에 고인 물감 테) → 끝무렵 서로 이어져 다 채움. WebGL을 못 쓰면 그냥 그림이 보임
const INK_NOISE_SIZE = 256;
let inkNoiseData = null;
// 이어 붙여도 이음매가 없는 잡음 세 겹: r = 방울 둘레의 큰 굴곡 · g = 잔 굴곡 · b = 종이 결(가장자리만)
const inkNoise = () => {
  if (inkNoiseData) return inkNoiseData;
  const size = INK_NOISE_SIZE;
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const layer = (octaves) => {
    const acc = new Float32Array(size * size);
    for (const [cells, amp] of octaves) {
      const grid = new Float32Array(cells * cells).map(() => rand());
      const span = size / cells;
      for (let y = 0; y < size; y += 1) {
        const gy = y / span;
        const y0 = Math.floor(gy);
        const fy = gy - y0;
        const sy = fy * fy * (3 - 2 * fy);
        const r0 = (y0 % cells) * cells;
        const r1 = ((y0 + 1) % cells) * cells;
        for (let x = 0; x < size; x += 1) {
          const gx = x / span;
          const x0 = Math.floor(gx);
          const fx = gx - x0;
          const sx = fx * fx * (3 - 2 * fx);
          const c0 = x0 % cells;
          const c1 = (x0 + 1) % cells;
          const top = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
          const bottom = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
          acc[y * size + x] += (top + (bottom - top) * sy) * amp;
        }
      }
    }
    let min = Infinity;
    let max = -Infinity;
    for (const value of acc) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return acc.map((value) => (value - min) / (max - min || 1));
  };
  const channels = [layer([[3, 1], [6, 0.4]]), layer([[12, 1], [24, 0.5]]), layer([[64, 1], [128, 0.6]])];
  inkNoiseData = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    for (let c = 0; c < 3; c += 1) inkNoiseData[i * 3 + c] = Math.round(channels[c][i] * 255);
  }
  return inkNoiseData;
};
const INK_MAX_DROPS = 16;
const INK_VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
// 방울 반지름 = 떨어질 때 퍼짐(크기 w 까지 0.1초) + 천천히 번짐(w × 2.4 × 지난 초^0.62) + 끝무렵 다 같이 더 번짐(uFlood). main.js 의 inkRadius 와 같은 식
const INK_FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uImg;
uniform sampler2D uSoft;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uDone;
uniform float uAspect;
uniform float uFlood;
uniform vec4 uDrops[${INK_MAX_DROPS}];
uniform float uWind;
uniform vec2 uDir;
uniform vec2 uSpan;
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float detail = texture2D(uNoise, p * 0.6 + 0.37).g - 0.5;
  float D = 10.0;
  float age = 9.0;
  if (uWind > 0.5) {
    // 바람 결: 바람 방향으로 길게 늘어진 결을 따라 걷히듯 드러남 (결은 바람과 수직으로만 촘촘해서 앞자락 뒤에 구멍이 남지 않음)
    vec2 q = vec2(dot(p, uDir), dot(p, vec2(-uDir.y, uDir.x)));
    float streak = texture2D(uNoise, vec2(q.x * 0.15, q.y * 1.1) + vec2(0.11, 0.37)).r * 0.75
      + texture2D(uNoise, vec2(q.x * 0.12, q.y * 2.6) + vec2(0.53, 0.19)).g * 0.25 - 0.5;
    D = q.x + streak * 0.3 + detail * 0.008 - mix(uSpan.x, uSpan.y, 1.0 - pow(1.0 - uDone, 1.8));
  }
  for (int i = 0; i < ${INK_MAX_DROPS}; i++) {
    vec4 d = uDrops[i];
    float a = uTime - d.z;
    if (a <= 0.0) continue;
    vec2 v = p - vec2(d.x * uAspect, d.y);
    float len = length(v);
    vec2 ring = v / max(len, 0.0001);
    float lobe = texture2D(uNoise, ring * 0.3 + vec2(0.17 + float(i) * 0.137, 0.53)).r * 0.6
      + texture2D(uNoise, ring * 0.75 + vec2(0.41, 0.09 + float(i) * 0.211)).r * 0.4 - 0.5;
    float r = d.w * (1.0 - exp(-a / 0.045)) + d.w * 2.4 * pow(a, 0.62);
    float di = len - r * (1.0 + lobe * 0.5) + detail * 0.012 * min(1.0, r * 4.0) - uFlood;
    if (di < D) { D = di; age = a; }
  }
  float s = -D + (texture2D(uNoise, p + 0.61).b - 0.5) * 0.004;
  float cover = smoothstep(0.0, mix(0.008, 0.045, uWind), s);
  float fade = 1.0 - smoothstep(0.8, 1.0, uDone);
  float rim = smoothstep(0.0, 0.005, s) * (1.0 - smoothstep(0.007, 0.018, s)) * fade;
  float wet = max(1.0 - smoothstep(0.0, mix(0.07, 0.16, uWind), s), exp(-age / 0.55)) * fade;
  vec4 c = mix(texture2D(uImg, vUv), texture2D(uSoft, vUv), wet);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 col = mix(vec3(lum), c.rgb, 1.0 + 0.1 * wet + 0.2 * rim) * (1.0 - 0.05 * wet) * (1.0 - 0.18 * rim);
  float alpha = cover * (1.0 - 0.06 * wet) * c.a;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}`;
const inkRadius = (size, age) => (age <= 0 ? 0 : size * (1 - Math.exp(-age / 0.045)) + size * 2.4 * Math.pow(age, 0.62));

class InkRevealer {
  constructor(doc) {
    this.doc = doc;
    this.surfaces = new Map();
    this.running = new Set();
    this.broken = false;
  }

  makeSurface() {
    const canvas = this.doc.createElement("canvas");
    canvas.className = "mn-ink-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader");
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, INK_VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, INK_FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "program");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = (unit, wrap) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return tex;
    };
    texture(1, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, INK_NOISE_SIZE, INK_NOISE_SIZE, 0, gl.RGB, gl.UNSIGNED_BYTE, inkNoise());
    const soft = texture(2, gl.CLAMP_TO_EDGE);
    const image = texture(0, gl.CLAMP_TO_EDGE);
    const loc = {};
    for (const name of ["uImg", "uSoft", "uNoise", "uTime", "uDone", "uAspect", "uFlood", "uDrops", "uWind", "uDir", "uSpan"]) loc[name] = gl.getUniformLocation(program, name);
    gl.uniform1i(loc.uImg, 0);
    gl.uniform1i(loc.uNoise, 1);
    gl.uniform1i(loc.uSoft, 2);
    const surface = { canvas, gl, loc, image, soft, key: "", lost: false };
    canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); surface.lost = true; });
    return surface;
  }

  /** 그림마다 캔버스 하나를 그 그림 바로 뒤에 붙박이로 둠 — 다 번지면 떼지 않고 투명하게 지우기만 함.
   *  번지던 캔버스를 문서에서 떼면 그래픽 카드가 0.2초 붙잡혀 넘김 첫머리 · 날던 꽃잎이 멈칫해서. 그림 데이터도 크기가 그대로면 다시 안 올림 */
  surfaceFor(img) {
    let surface = this.surfaces.get(img);
    if (surface && (surface.lost || surface.gl.isContextLost())) {
      surface.canvas.remove();
      this.surfaces.delete(img);
      surface = null;
    }
    if (!surface) {
      if (this.surfaces.size >= 4) return null;
      try {
        surface = this.makeSurface();
      } catch (error) {
        console.warn("[mn-codex] 물감 번짐을 못 써서 그림을 바로 보여 줘요", error);
        surface = null;
      }
      if (!surface) return null;
      this.surfaces.set(img, surface);
    }
    if (surface.canvas.previousElementSibling !== img) img.after(surface.canvas);
    return surface;
  }

  clearSurface(surface) {
    if (surface.lost) return;
    surface.gl.clearColor(0, 0, 0, 0);
    surface.gl.clear(surface.gl.COLOR_BUFFER_BIT);
    // 쉬는 동안엔 그림자 필터도 걷음(투명한 캔버스에 그림자를 매번 다시 씌우지 않게)
    surface.canvas.style.filter = "none";
  }

  /** 방울 자리 · 떨어지는 때 · 크기 (그림마다 늘 같게). 첫 방울은 눈길 가는 자리(object-position) 가까이, 나머지는 서로 떨어진 아무 데나.
   *  떨어지는 간격은 짧게 · 길게를 섞어 「툭… 투툭… 툭」. 큰 방울 둘레엔 작은 튄 방울 */
  planDrops(img, aspect, px, py) {
    let hash = 2166136261;
    for (const code of String(img.currentSrc || img.src)) hash = Math.imul(hash ^ code.codePointAt(0), 16777619) >>> 0;
    const rand = () => (hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0) / 4294967296;
    const mains = [[Math.min(aspect - 0.08, Math.max(0.08, px * aspect + (rand() - 0.5) * 0.12)), Math.min(0.9, Math.max(0.1, py + 0.04 + (rand() - 0.5) * 0.1))]];
    for (let tries = 0; mains.length < 6 && tries < 200; tries += 1) {
      const x = 0.07 + rand() * (aspect - 0.14);
      const y = 0.08 + rand() * 0.84;
      if (mains.every(([ox, oy]) => Math.hypot(x - ox, y - oy) > 0.3)) mains.push([x, y]);
    }
    const drops = [];
    let land = 0;
    let longGap = rand() < 0.5;
    mains.forEach(([x, y], index) => {
      if (index) {
        land += longGap ? 0.3 + rand() * 0.18 : 0.1 + rand() * 0.08;
        longGap = rand() < (longGap ? 0.35 : 0.7);
      }
      const size = 0.055 + rand() * 0.03;
      drops.push([x / aspect, y, land, size]);
      const splashes = rand() < 0.35 ? 1 : 2;
      for (let k = 0; k < splashes && drops.length < INK_MAX_DROPS; k += 1) {
        const angle = rand() * Math.PI * 2;
        const dist = size + 0.025 + rand() * 0.06;
        drops.push([(x + Math.cos(angle) * dist) / aspect, y + Math.sin(angle) * dist, land + 0.012 + rand() * 0.03, 0.009 + rand() * 0.009]);
      }
    });
    return drops.slice(0, INK_MAX_DROPS);
  }

  /** 그림을 바로 숨기고, delay 뒤에 방울이 떨어져 번지며 나타나게 함. 다른 쪽으로 넘기면 finishAll 로 바로 다 보이게.
   *  준비(그림 데이터 · 그래픽 카드)는 종이가 움직이기 시작한 다음 틈에 해 둠 — 첫 방울이 늦게 떨어지지 않게 */
  play(img, { delay = 0, mode = "drops", duration = 1500 } = {}) {
    if (!img || this.broken) return null;
    const view = this.doc.defaultView || window;
    if (typeof view.createImageBitmap !== "function") return null;
    const run = { done: false };
    let timer = 0;
    let frame = 0;
    let surface = null;
    const finish = () => {
      if (run.done) return;
      run.done = true;
      view.clearTimeout(timer);
      if (frame) view.cancelAnimationFrame(frame);
      img.classList.remove("mn-ink-hide");
      if (surface) this.clearSurface(surface);
      surface = null;
      this.running.delete(run);
    };
    run.finish = finish;
    this.running.add(run);
    img.classList.add("mn-ink-hide");
    const startAt = view.performance.now() + delay;
    // 준비(크기 재기 · 그림 자르기 · 그래픽 카드에 올리기)는 종이가 움직이기 시작한 다음 틈에 — 넘기는 순간에 하면 첫 화면이 0.2초쯤 늦어짐
    const prepare = async () => {
      try {
        if (!img.complete || !img.naturalWidth) await img.decode();
        const cs = view.getComputedStyle(img);
        // 그림은 안쪽 여백(padding) · 테두리 안쪽에만 그려짐(은빛 기사 초상은 사방 20px) → 캔버스도 그 안쪽 크기로 그림.
        // 여백까지 꽉 채우면 번지는 동안 그림이 커 보이다 끝나고 진짜 그림으로 바뀔 때 줄어듦
        const inset = (side) => (parseFloat(cs.getPropertyValue(`padding-${side}`)) || 0) + (parseFloat(cs.getPropertyValue(`border-${side}-width`)) || 0);
        const w = img.offsetWidth - inset("left") - inset("right");
        const h = img.offsetHeight - inset("top") - inset("bottom");
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (run.done || !img.isConnected || w < 1 || h < 1 || !nw || !nh) return finish();
        // 보이는 만큼만 화면 크기로 잘라 둠(object-fit: cover · object-position 그대로) → 캔버스와 그림이 한 점 한 점 맞음
        const [px, py] = String(cs.objectPosition || "50% 50%").split(/\s+/).map((part) => (/%$/.test(part) ? parseFloat(part) / 100 : 0.5));
        const cover = cs.objectFit === "cover";
        const scale = cover ? Math.max(w / nw, h / nh) : 1;
        const sx = cover ? Math.max(0, ((nw * scale - w) * px) / scale) : 0;
        const sy = cover ? Math.max(0, ((nh * scale - h) * py) / scale) : 0;
        const sw = cover ? Math.min(nw - sx, w / scale) : nw;
        const sh = cover ? Math.min(nh - sy, h / scale) : nh;
        // 꽉 채우기(cover)가 아니면(contain 등) 그림 비율 그대로 그리고, 캔버스에도 같은 object-fit · position 을 줘서 같은 자리에 놓임
        const fit = cover ? 1 : Math.min(w / nw, h / nh);
        const dw = cover ? w : nw * fit;
        const dh = cover ? h : nh * fit;
        const rect = img.getBoundingClientRect();
        const density = Math.min(2, view.devicePixelRatio || 1) * Math.max(1, rect.width / img.offsetWidth);
        const cw = Math.max(1, Math.min(2048, Math.round(dw * density)));
        const ch = Math.max(1, Math.min(2048, Math.round(dh * density)));
        const crop = [Math.round(sx), Math.round(sy), Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh))];
        const key = `${img.currentSrc || img.src}|${cw}x${ch}|${crop.join(",")}`;
        const owned = this.surfaces.get(img);
        let bitmap = null;
        let blurred = null;
        if (!owned || owned.key !== key) {
          bitmap = await view.createImageBitmap(img, ...crop, { resizeWidth: cw, resizeHeight: ch, resizeQuality: "high", premultiplyAlpha: "none" });
          // 갓 번진 자리에 쓸 흐린 그림(1/6 크기를 늘려 씀) — 색이 먼저 번지고 선은 마르면서 또렷해지게
          blurred = await view.createImageBitmap(img, ...crop,
            { resizeWidth: Math.max(1, Math.round(cw / 6)), resizeHeight: Math.max(1, Math.round(ch / 6)), resizeQuality: "medium", premultiplyAlpha: "none" });
        }
        const drop = () => { if (bitmap) bitmap.close(); if (blurred) blurred.close(); };
        if (run.done || !img.isConnected) { drop(); return finish(); }
        surface = this.surfaceFor(img);
        if (!surface) { drop(); return finish(); }
        const { canvas, gl, loc } = surface;
        if (surface.key !== key) {
          if (!bitmap) { surface.key = ""; return finish(); }
          if (canvas.width !== cw) canvas.width = cw;
          if (canvas.height !== ch) canvas.height = ch;
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, surface.image);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, surface.soft);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, blurred);
          surface.key = key;
        }
        drop();
        canvas.style.cssText = "";
        canvas.style.left = `${img.offsetLeft}px`;
        canvas.style.top = `${img.offsetTop}px`;
        // 상자는 그림과 똑같이(여백 · 테두리 포함) 두고 캔버스 그림만 안쪽에 — 기울임 · 확대 기준점도 그대로 맞음
        canvas.style.boxSizing = "border-box";
        canvas.style.width = `${img.offsetWidth}px`;
        canvas.style.height = `${img.offsetHeight}px`;
        for (const name of ["padding", "border-width", "border-style", "border-color", "transform", "transform-origin", "filter", "z-index", "border-radius", "mix-blend-mode",
          "mask-image", "-webkit-mask-image"]) {
          canvas.style.setProperty(name, cs.getPropertyValue(name));
        }
        canvas.style.objectFit = cover ? "fill" : "contain";
        canvas.style.objectPosition = cover ? "50% 50%" : cs.objectPosition;
        const aspect = dw / dh;
        // 바람 결(첫 쪽 꽃잎과 함께): 방울 없이 왼쪽 위에서 오른쪽 아래로 걷힘
        const wind = mode === "wind";
        const drops = wind ? [] : this.planDrops(img, aspect, px, py);
        const packed = new Float32Array(INK_MAX_DROPS * 4).fill(0);
        for (let i = 0; i < INK_MAX_DROPS; i += 1) packed[i * 4 + 2] = 99;
        drops.forEach((drop, i) => packed.set(drop, i * 4));
        // 끝나는 때: 마지막 방울이 떨어지고 1.9초 뒤. 마지막 1초 동안 모든 방울이 함께 더 번져(uFlood) 남은 빈 곳까지 다 채움 —
        // 그때 가장 늦게 닿는 자리를 미리 재 둠(굴곡이 가장 오목한 쪽 기준)
        const lastLand = Math.max(0, ...drops.map((drop) => drop[2]));
        const end = wind ? duration / 1000 : lastLand + 1.9;
        let gap = 0;
        for (let gy = 0; gy <= (wind ? -1 : 40); gy += 1) {
          for (let gx = 0; gx <= 40; gx += 1) {
            const x = (gx / 40) * aspect;
            const y = gy / 40;
            let nearest = Infinity;
            for (const [dx, dy, land, size] of drops) nearest = Math.min(nearest, Math.hypot(x - dx * aspect, y - dy) - inkRadius(size, end - land) * 0.75);
            gap = Math.max(gap, nearest);
          }
        }
        const floodTo = Math.max(0, gap) + 0.07 + 0.006 + 0.05;
        gl.viewport(0, 0, cw, ch);
        gl.uniform1f(loc.uAspect, aspect);
        gl.uniform4fv(loc.uDrops, packed);
        const dir = [0.92, 0.39];
        const along = [[0, 0], [aspect, 0], [0, 1], [aspect, 1]].map(([x, y]) => x * dir[0] + y * dir[1]);
        gl.uniform1f(loc.uWind, wind ? 1 : 0);
        gl.uniform2f(loc.uDir, dir[0], dir[1]);
        gl.uniform2f(loc.uSpan, Math.min(...along) - 0.2, Math.max(...along) + 0.15 + 0.01 + 0.16 + 0.05 + 0.05);
        const wait = startAt - view.performance.now();
        if (wait > 1) await new Promise((resolve) => { timer = view.setTimeout(resolve, wait); });
        if (run.done || !img.isConnected) return finish();
        const start = view.performance.now();
        const draw = () => {
          frame = 0;
          if (run.done) return;
          if (surface.lost) return finish();
          const time = Math.min(end, (view.performance.now() - start) / 1000);
          const f = Math.min(1, Math.max(0, (time - (end - 1)) / 1));
          gl.uniform1f(loc.uTime, time);
          gl.uniform1f(loc.uDone, time / end);
          gl.uniform1f(loc.uFlood, wind ? 0 : floodTo * f * f * (3 - 2 * f));
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          if (time >= end) return finish();
          frame = view.requestAnimationFrame(draw);
        };
        draw();
      } catch (error) {
        finish();
      }
    };
    frame = view.requestAnimationFrame(() => {
      frame = 0;
      timer = view.setTimeout(prepare, 0);
    });
    return run;
  }

  finishAll() {
    for (const run of [...this.running]) run.finish();
  }

  destroy() {
    this.finishAll();
    for (const surface of this.surfaces.values()) {
      surface.canvas.remove();
      surface.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.surfaces.clear();
  }
}

/**
 * Small, bounded pool for short-lived DOM objects. The reset callback owns
 * lifecycle cleanup so callers cannot accidentally return dirty nodes.
 */
class BoundedObjectPool {
  constructor(factory, reset, maxSize = 1) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = Math.max(0, Math.floor(maxSize));
    this.items = [];
    this.stats = { created: 0, reused: 0, released: 0, discarded: 0 };
  }

  acquire() {
    if (this.items.length) {
      this.stats.reused += 1;
      return this.items.pop();
    }
    this.stats.created += 1;
    return this.factory();
  }

  release(item) {
    if (!item) return;
    this.reset(item);
    this.stats.released += 1;
    if (this.items.length < this.maxSize) {
      this.items.push(item);
    } else {
      this.stats.discarded += 1;
    }
  }

  clear() {
    this.items.length = 0;
  }
}

/**
 * Reuses the animation stage and its compositor-only paper sheets. Page
 * snapshots remain per-transition because their contents are document data;
 * pooling those would retain entire pages and trade allocations for a leak.
 */
class BookFlipDomPool {
  constructor(ownerDocument, maxSheets = 16) {
    this.ownerDocument = ownerDocument;
    this.activeStages = new Set();
    this.stagePool = new BoundedObjectPool(
      () => {
        const stage = this.ownerDocument.createElement("div");
        stage.className = "mn-codex__flip-stage";
        return stage;
      },
      (stage) => {
        stage.remove();
        stage.replaceChildren();
        stage.className = "mn-codex__flip-stage";
        stage.removeAttribute("style");
        stage.removeAttribute("aria-hidden");
      },
      1,
    );
    this.sheetPool = new BoundedObjectPool(
      () => {
        const sheet = this.ownerDocument.createElement("div");
        sheet.className = "mn-codex__flip-sheet";
        const front = this.ownerDocument.createElement("div");
        front.className = "mn-codex__flip-face mn-codex__flip-face--front";
        const back = this.ownerDocument.createElement("div");
        back.className = "mn-codex__flip-face mn-codex__flip-face--back";
        sheet.append(front, back);
        return sheet;
      },
      (sheet) => {
        sheet.remove();
        sheet.className = "mn-codex__flip-sheet";
        sheet.style.removeProperty("--mn-flip-delay");
        sheet.style.removeProperty("--mn-flip-z");
        sheet.style.removeProperty("--mn-flip-offset");
      },
      maxSheets,
    );
  }

  acquire(sheetCount) {
    const stage = this.stagePool.acquire();
    stage.setAttribute("aria-hidden", "true");
    stage._mnFlipSheets = [];
    const count = Math.max(0, Math.min(this.sheetPool.maxSize, Math.floor(sheetCount)));
    for (let index = 0; index < count; index += 1) {
      const sheet = this.sheetPool.acquire();
      stage._mnFlipSheets.push(sheet);
    }
    this.activeStages.add(stage);
    return stage;
  }

  appendSheets(stage, configure) {
    (stage?._mnFlipSheets || []).forEach((sheet, index) => {
      configure(sheet, index);
      stage.appendChild(sheet);
    });
  }

  release(stage) {
    if (!stage || !this.activeStages.has(stage)) return;
    this.activeStages.delete(stage);
    const sheets = stage._mnFlipSheets || [];
    stage._mnFlipSheets = [];
    sheets.forEach((sheet) => this.sheetPool.release(sheet));
    this.stagePool.release(stage);
  }

  releaseAll() {
    Array.from(this.activeStages).forEach((stage) => this.release(stage));
  }

  snapshot() {
    return {
      stages: { ...this.stagePool.stats },
      sheets: { ...this.sheetPool.stats },
    };
  }

  dispose() {
    this.releaseAll();
    this.stagePool.clear();
    this.sheetPool.clear();
  }
}

const KIND_ALIASES = {
  spread: "spread",
  layout: "spread",
  profile: "profile",
  portrait: "profile",
  creature: "creature",
  bestiary: "creature",
  infobox: "infobox",
  skills: "skills",
  techniques: "skills",
  quote: "quote",
  divider: "divider",
  spoiler: "spoiler",
};

const SNIPPETS = {
  mely: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: flow # 내용 길이에 맞춰 지면이 늘어납니다",
    "eyebrow: MELY / AERIAL ARCHIVE 01",
    "title: \"{{noteTitle}}\"",
    "subtitle: OBSERVATION RECORD · ACTIVE",
    "image: \"\" # 비워두면 문서의 첫 이미지를 자동 사용",
    "image_alt: Mely 인물 기록 이미지",
    "image_position: left",
    "image_focus: center",
    "image_fit: bleed",
    "plate_label: FILE 01 / WING INDEX",
    "caption: VISUAL IDENTIFICATION · VERIFIED",
    "folio_left: 01",
    "folio_right: MELY",
    "image_note: |",
    "  복식, 날개형 장비, 움직임처럼 현장에서 식별할 특징을 기록합니다.",
    "content: |",
    "  인물의 핵심 설정을 **간결한 문장**으로 정리합니다. [[Mely 관련 기록]]을 연결할 수 있습니다.",
    "  ",
    "  두 번째 문단에는 임무, 현재 상태, 관측자의 판단을 기록합니다.",
    "```",
  ].join("\n"),

  melyBook: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: book",
    "auto_paginate: true",
    "eyebrow: MELY / AERIAL ARCHIVE 01",
    "title: \"{{noteTitle}}\"",
    "subtitle: OBSERVATION RECORD · ACTIVE",
    "image: \"\" # 비워두면 문서의 첫 이미지를 자동 사용",
    "image_alt: Mely 인물 기록 이미지",
    "image_position: left",
    "image_focus: center",
    "image_fit: bleed",
    "plate_label: FILE 01 / WING INDEX",
    "caption: VISUAL IDENTIFICATION · VERIFIED",
    "folio_left: 01",
    "folio_right: 02",
    "image_note: |",
    "  복식, 날개형 장비, 움직임처럼 현장에서 식별할 특징을 기록합니다.",
    "content: |",
    "  첫 장의 본문입니다. 내용이 지면을 넘으면 문단 단위로 다음 장에 자동 배치됩니다.",
    "  ",
    "  원하는 위치에서 강제로 넘기려면 아래 주석을 한 줄로 넣으세요.",
    "  ",
    "  <!-- mn-page-break -->",
    "  ",
    "  이 문단은 새 지면에서 시작합니다.",
    "```",
  ].join("\n"),

  melyRibbonSlash: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: ribbon-slash",
    "visual_mode: live # 모든 요소가 실제 텍스트와 이미지로 렌더링됩니다",
    "deck: auto # 소개 책장을 자동 생성하며, 바로 다음 Mely book 블록이 있으면 그것을 사용합니다",
    "eyebrow: MELY / AERIAL ARCHIVE 01",
    "title: \"{{noteTitle}}\"",
    "subtitle: OBSERVATION RECORD · ACTIVE",
    "image: \"plugin:mely-sample-ribbon.png\" # 원하는 볼트 이미지 경로로 교체 가능",
    "book_image: \"\" # NEXT에서 열리는 소개 책장 전용 이미지",
    "book_title: \"{{noteTitle}}\" # NEXT 소개 책장 전용 제목",
    "book_eyebrow: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_subtitle: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_illustration: \"\" # 본문 속 작은 용/문양 삽화",
    "book_illustration_position: right # left 또는 right",
    "book_illustration_size: medium # small, medium, large, wide",
    "book_illustration_style: ink # ink 또는 plain",
    "book_page_style: archive # archive 또는 parchment",
    "book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장",
    "book_sections: [] # 장 제목과 하위 페이지를 계층형으로 작성",
    "book_pages: [] # 페이지별 작성 시 이 배열에 원하는 만큼 추가",
    "book_content: \"\" # book_pages가 비어 있을 때 쓰는 자동 넘김 본문",
    "image_alt: 인물 관측 이미지",
    "image_focus: center",
    "image_fit: contain",
    "plate_label: RIBBON SLASH DOSSIER —",
    "caption: VISUAL IDENTIFICATION · VERIFIED",
    "facts:",
    "  CLASSIFICATION: VISUAL IDENTIFICATION · VERIFIED",
    "  STATUS: ACTIVE",
    "  ORIGIN: OBSERVER UNKNOWN",
    "  SECURITY: LV. 01 / LIMITED ACCESS",
    "content: |",
    "  인물의 핵심 설정을<br>**간결한 문장**으로 정리합니다.<br>[[Mely 관련 기록]]을<br>연결할 수 있습니다.",
    "  ",
    "  두 번째 문단에는 임무,<br>현재 상태, 관측자의 판단을<br>기록합니다.",
    "```",
  ].join("\n"),

  melyTidalCrescent: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: tidal-crescent",
    "visual_mode: live # 모든 요소가 실제 텍스트와 이미지로 렌더링됩니다",
    "deck: auto # 소개 책장을 자동 생성하며, 바로 다음 Mely book 블록이 있으면 그것을 사용합니다",
    "eyebrow: MELY / CURRENT ARCHIVE 02",
    "title: \"{{noteTitle}}\"",
    "subtitle: TIDAL OBSERVATION · ACTIVE",
    "image: \"plugin:mely-sample-aquatic.png\" # 원하는 볼트 이미지 경로로 교체 가능",
    "book_image: \"\" # NEXT에서 열리는 소개 책장 전용 이미지",
    "book_title: \"{{noteTitle}}\" # NEXT 소개 책장 전용 제목",
    "book_eyebrow: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_subtitle: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_illustration: \"\" # 본문 속 작은 용/문양 삽화",
    "book_illustration_position: right # left 또는 right",
    "book_illustration_size: medium # small, medium, large, wide",
    "book_illustration_style: ink # ink 또는 plain",
    "book_page_style: archive # archive 또는 parchment",
    "book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장",
    "book_sections: [] # 장 제목과 하위 페이지를 계층형으로 작성",
    "book_pages: [] # 페이지별 작성 시 이 배열에 원하는 만큼 추가",
    "book_content: \"\" # book_pages가 비어 있을 때 쓰는 자동 넘김 본문",
    "image_alt: 수류 관측 이미지",
    "image_focus: center",
    "image_fit: contain",
    "plate_label: FILE 02 / TIDAL CRESCENT",
    "caption: CURRENT SIGNAL · VERIFIED",
    "facts:",
    "  분류: 수류 관측 대상",
    "  상태: ACTIVE",
    "  기록: FILE 02",
    "content: |",
    "  흐름, 능력, 인상과 현재 상태를 기록합니다. [[관련 기록]]을 연결할 수 있습니다.",
    "  ",
    "  긴 본문도 지면 높이에 맞춰 계속 이어집니다.",
    "```",
  ].join("\n"),

  melyHornSlash: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: horn-slash",
    "visual_mode: live # 모든 요소가 실제 텍스트와 이미지로 렌더링됩니다",
    "deck: auto # 소개 책장을 자동 생성하며, 바로 다음 Mely book 블록이 있으면 그것을 사용합니다",
    "eyebrow: MELY / AERIAL ARCHIVE 03",
    "title: \"{{noteTitle}}\"",
    "subtitle: HORN TRACE · OBSERVATION RECORD",
    "image: \"plugin:mely-sample-horn.png\" # 원하는 볼트 이미지 경로로 교체 가능",
    "book_image: \"\" # NEXT에서 열리는 소개 책장 전용 이미지",
    "book_title: \"{{noteTitle}}\" # NEXT 소개 책장 전용 제목",
    "book_eyebrow: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_subtitle: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_illustration: \"\" # 본문 속 작은 용/문양 삽화",
    "book_illustration_position: right # left 또는 right",
    "book_illustration_size: medium # small, medium, large, wide",
    "book_illustration_style: ink # ink 또는 plain",
    "book_page_style: archive # archive 또는 parchment",
    "book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장",
    "book_sections: [] # 장 제목과 하위 페이지를 계층형으로 작성",
    "book_pages: [] # 페이지별 작성 시 이 배열에 원하는 만큼 추가",
    "book_content: \"\" # book_pages가 비어 있을 때 쓰는 자동 넘김 본문",
    "image_alt: 인물 식별 이미지",
    "image_focus: center",
    "image_fit: contain",
    "plate_label: FILE 03 / HORN SLASH",
    "caption: VISUAL IDENTIFICATION · VERIFIED",
    "facts:",
    "  분류: Mely 관측 대상",
    "  상태: ACTIVE",
    "  보안: LIMITED ACCESS",
    "content: |",
    "  외형의 특징과 핵심 설정을 적습니다. 이미지의 뿔과 장식은 검은 절개선을 가로질러 표시됩니다.",
    "  ",
    "  추가 문단은 정보 패널을 아래로 확장합니다.",
    "```",
  ].join("\n"),

  melyPortraitEcho: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: portrait-echo",
    "visual_mode: live # 모든 요소가 실제 텍스트와 이미지로 렌더링됩니다",
    "deck: auto # 소개 책장을 자동 생성하며, 바로 다음 Mely book 블록이 있으면 그것을 사용합니다",
    "eyebrow: MELY / PORTRAIT ARCHIVE 04",
    "title: \"{{noteTitle}}\"",
    "subtitle: PORTRAIT ECHO · ACTIVE",
    "image: \"plugin:mely-sample-horn.png\" # 원하는 볼트 이미지 경로로 교체 가능",
    "book_image: \"\" # NEXT에서 열리는 소개 책장 전용 이미지",
    "book_title: \"{{noteTitle}}\" # NEXT 소개 책장 전용 제목",
    "book_eyebrow: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_subtitle: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_illustration: \"\" # 본문 속 작은 용/문양 삽화",
    "book_illustration_position: right # left 또는 right",
    "book_illustration_size: medium # small, medium, large, wide",
    "book_illustration_style: ink # ink 또는 plain",
    "book_page_style: archive # archive 또는 parchment",
    "book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장",
    "book_sections: [] # 장 제목과 하위 페이지를 계층형으로 작성",
    "book_pages: [] # 페이지별 작성 시 이 배열에 원하는 만큼 추가",
    "book_content: \"\" # book_pages가 비어 있을 때 쓰는 자동 넘김 본문",
    "image_alt: 인물 초상 기록",
    "image_focus: center",
    "image_fit: contain",
    "plate_label: FILE 04 / PORTRAIT ECHO",
    "caption: ECHO PARALLAX · VERIFIED",
    "facts:",
    "  분류: 초상 관측 기록",
    "  상태: ACTIVE",
    "  기록: FILE 04",
    "content: |",
    "  인물의 표정, 행동 원리, 관측자의 판단을 적습니다. **강조 문장**도 사용할 수 있습니다.",
    "  ",
    "  내용이 많아져도 하단 기록지가 유동적으로 늘어납니다.",
    "```",
  ].join("\n"),

  melyBlackTide: [
    "```mn-codex",
    "type: spread",
    "theme: mely",
    "layout_mode: black-tide",
    "visual_mode: live # 모든 요소가 실제 텍스트와 이미지로 렌더링됩니다",
    "deck: auto # 소개 책장을 자동 생성하며, 바로 다음 Mely book 블록이 있으면 그것을 사용합니다",
    "eyebrow: MELY / BLACK TIDE ARCHIVE 05",
    "title: \"{{noteTitle}}\"",
    "subtitle: SUBMERSION RECORD · ACTIVE",
    "image: \"plugin:mely-sample-aquatic.png\" # 원하는 볼트 이미지 경로로 교체 가능",
    "book_image: \"\" # NEXT에서 열리는 소개 책장 전용 이미지",
    "book_title: \"{{noteTitle}}\" # NEXT 소개 책장 전용 제목",
    "book_eyebrow: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_subtitle: \"\" # 비우면 NEXT 책장에서는 숨김",
    "book_illustration: \"\" # 본문 속 작은 용/문양 삽화",
    "book_illustration_position: right # left 또는 right",
    "book_illustration_size: medium # small, medium, large, wide",
    "book_illustration_style: ink # ink 또는 plain",
    "book_page_style: archive # archive 또는 parchment",
    "book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장",
    "book_sections: [] # 장 제목과 하위 페이지를 계층형으로 작성",
    "book_pages: [] # 페이지별 작성 시 이 배열에 원하는 만큼 추가",
    "book_content: \"\" # book_pages가 비어 있을 때 쓰는 자동 넘김 본문",
    "image_alt: 침수 관측 이미지",
    "image_focus: center",
    "image_fit: contain",
    "detail_focus:",
    "  - 50% 18% # 얼굴/상단",
    "  - 50% 50% # 상체/중앙",
    "  - 50% 82% # 의상/하단",
    "detail_scale: [2.05, 2.05, 2.05]",
    "visual_data_text_size: 1cqi # 우측 VISUAL DATA 기록지의 본문 글자 크기",
    "plate_label: FILE 05 / BLACK TIDE",
    "caption: SUBMERSION SIGNAL · VERIFIED",
    "facts:",
    "  분류: 침수 관측 대상",
    "  상태: ACTIVE",
    "  수심: UNKNOWN",
    "content: |",
    "  대상의 생태, 능력, 위험성과 현장 기록을 적습니다. [[관련 문서]]를 연결할 수 있습니다.",
    "  ",
    "  본문이 길면 흰 기록지가 아래로 확장됩니다.",
    "```",
  ].join("\n"),

  redline: [
    "```mn-codex",
    "type: spread",
    "theme: redline",
    "eyebrow: MN // RESTRICTED FILE 01",
    "title: \"{{noteTitle}}\"",
    "subtitle: SUBJECT / ACTIVE RECORD",
    "image: \"\" # 비워두면 문서의 첫 이미지를 자동 사용",
    "image_alt: 인물 기록 이미지",
    "image_position: left",
    "image_focus: center",
    "image_fit: cover",
    "plate_label: FILE 01",
    "caption: VISUAL RECORD / 01",
    "folio_left: 01",
    "folio_right: MN",
    "image_note: |",
    "  관찰 포인트, 복식이나 전투 습관을 짧고 강하게 적습니다.",
    "content: |",
    "  핵심 설정을 **짧은 문단**으로 정리합니다. [[내부 링크]]와 강조를 사용할 수 있습니다.",
    "  ",
    "  두 번째 문단에는 갈등, 행동 원리, 현재 상태를 기록합니다.",
    "```",
  ].join("\n"),

  resonance: [
    "```mn-codex",
    "type: spread",
    "theme: resonance",
    "eyebrow: MN RESONANCE ARCHIVE / 01",
    "title: \"{{noteTitle}}\"",
    "subtitle: SIGNAL PROFILE · ACTIVE",
    "image: \"\" # 비워두면 문서의 첫 이미지를 자동 사용",
    "image_alt: 공명 기록 이미지",
    "image_position: left",
    "image_focus: center",
    "image_fit: cover",
    "plate_label: SIGNAL 01",
    "caption: RESONATOR VISUAL / VERIFIED",
    "folio_left: 01",
    "folio_right: MN",
    "image_note: |",
    "  파형, 움직임, 감각적 특징처럼 인물을 식별하는 신호를 적습니다.",
    "content: |",
    "  인물 또는 현상의 핵심 정보를 절제된 문장으로 정리합니다. **중요 신호**와 [[관련 기록]]을 연결할 수 있습니다.",
    "  ",
    "  두 번째 문단에는 현재 상태와 관측자의 해석을 기록합니다.",
    "```",
  ].join("\n"),

  spread: [
    "```mn-codex",
    "type: spread",
    "theme: parchment",
    "eyebrow: MN ARCHIVE · CODEX",
    "title: \"{{noteTitle}}\"",
    "subtitle: 설정 기록",
    "image: \"\" # 비워두면 문서에 첨부된 첫 이미지를 자동 사용",
    "image_alt: 루시아 설정화",
    "image_position: left",
    "image_focus: center",
    "image_fit: contain",
    "plate_label: PLATE 01",
    "caption: 설정화",
    "folio_left: 12",
    "folio_right: 13",
    "image_note: |",
    "  삽화에서 눈여겨볼 특징이나 복식, 장비에 대한 짧은 주석을 적습니다.",
    "content: |",
    "  이 문서의 핵심 설정을 설명합니다. **강조**, [[내부 링크]], 인용을 그대로 쓸 수 있습니다.",
    "  ",
    "  두 번째 문단에는 실루엣, 재질, 습관처럼 그림을 읽는 단서를 적어 보세요.",
    "```",
  ].join("\n"),

  profile: [
    "```mn-codex",
    "type: profile",
    "theme: frost",
    "eyebrow: MN · PERSONNEL FILE",
    "title: \"{{noteTitle}}\"",
    "subtitle: 인물 기록",
    "badge: 인물",
    "image: \"\" # 비워두면 문서에 첨부된 첫 이미지를 자동 사용",
    "image_alt: 루시아 전신",
    "image_focus: top",
    "quote: 인물을 대표하는 대사나 문장을 적습니다.",
    "facts:",
    "  소속: 미정",
    "  분류: 미정",
    "  시대: 미정",
    "  역할: 미정",
    "  상태: 미정",
    "content: |",
    "  인물의 첫인상과 핵심 갈등을 적습니다. 관련 문서는 [[MN-Node/Character/Main/Mely]]처럼 연결할 수 있습니다.",
    "```",
  ].join("\n"),

  creature: [
    "```mn-codex",
    "type: creature",
    "theme: forest",
    "eyebrow: FIELD BESTIARY · 017",
    "title: \"{{noteTitle}}\"",
    "subtitle: 생물 관찰 기록",
    "badge: 관찰 등급 B",
    "image: \"\" # 비워두면 문서에 첨부된 첫 이미지를 자동 사용",
    "image_alt: 서리깃 와이번 관찰화",
    "image_position: right",
    "facts:",
    "  서식지: 북부 빙곡",
    "  활동기: 초겨울",
    "  위험도: 중간",
    "  먹이: 유리비늘어",
    "traits:",
    "  - 냉기 내성",
    "  - 군집 비행",
    "  - 빛 반사 깃털",
    "content: |",
    "  날개막보다 깃털이 먼저 빛을 받아, 눈보라 속에서는 실제 크기보다 크게 보인다.",
    "```",
  ].join("\n"),

  infobox: [
    "```mn-codex",
    "type: infobox",
    "theme: ink",
    "eyebrow: QUICK REFERENCE",
    "title: \"{{noteTitle}}\"",
    "subtitle: 핵심 정보",
    "badge: MN-Node",
    "image: \"\" # 비워두면 문서에 첨부된 첫 이미지를 자동 사용",
    "image_alt: Mely 문장",
    "facts:",
    "  창설: 원년",
    "  거점: 북부 관측소",
    "  지휘: [[지휘관 문서]]",
    "  문서: MN-Node/Character/Main/Mely",
    "content: |",
    "  짧은 정의나 문서 사용 규칙을 적습니다.",
    "```",
  ].join("\n"),

  skills: [
    "```mn-codex",
    "type: skills",
    "theme: ember",
    "eyebrow: TECHNIQUE PLATE",
    "title: 기술 및 전투 습관",
    "columns: 2",
    "skills:",
    "  - name: 빙면 도약",
    "    icon: ◇",
    "    rank: 기동",
    "    description: 얇은 얼음의 파동을 읽고 무너지기 직전의 면을 발판으로 삼는다.",
    "  - name: 백색 잔향",
    "    icon: ✦",
    "    rank: 감지",
    "    description: 눈에 남은 미세한 진동으로 지나간 존재의 방향을 추적한다.",
    "```",
  ].join("\n"),

  quote: [
    "```mn-codex",
    "type: quote",
    "theme: moon",
    "quote: 눈은 모든 발자국을 기억하지만, 봄은 아무것도 증언하지 않는다.",
    "attribution: 루시아 글라시에르 · 북부 관측일지",
    "```",
  ].join("\n"),

  divider: [
    "```mn-codex",
    "type: divider",
    "theme: frost",
    "eyebrow: CHAPTER II",
    "title: 북부에서 발견된 것들",
    "subtitle: 흔적 · 생물 · 미확인 현상",
    "```",
  ].join("\n"),

  spoiler: [
    "> [!mn-spoiler]- 작가 전용 · 진실 보기",
    "> 이 안에는 반전, 생사 여부, 폐기 전 설정처럼 기본적으로 접어 둘 내용을 적습니다.",
    ">",
    "> - 관련 비밀: [[스포일러 문서]]",
    "> - 공개 시점: 3막 이후",
  ].join("\n"),
};

/*
 * Single source of truth for every insertable template.
 * Keep commandId and key stable: existing hotkeys and Markdown layouts depend on them.
 * Reordering this array changes only the user-facing catalogue number.
 */
const TEMPLATE_CATALOG = Object.freeze([
  { key: "melyRibbonSlash", commandId: "insert-mely-ribbon-slash", title: "Mely 리본 슬래시" },
  { key: "melyTidalCrescent", commandId: "insert-mely-tidal-crescent", title: "Mely 타이달 크레센트" },
  { key: "melyHornSlash", commandId: "insert-mely-horn-slash", title: "Mely 혼 슬래시" },
  { key: "melyPortraitEcho", commandId: "insert-mely-portrait-echo", title: "Mely 포트레이트 에코" },
  { key: "melyBlackTide", commandId: "insert-mely-black-tide", title: "Mely 블랙 타이드" },
  { key: "mely", commandId: "insert-mely", title: "Mely 에디토리얼 아카이브" },
  { key: "melyBook", commandId: "insert-mely-book", title: "Mely 넘기는 설정집" },
  { key: "redline", commandId: "insert-redline", title: "Redline 스타일 아카이브" },
  { key: "resonance", commandId: "insert-resonance", title: "Resonance 공명 아카이브" },
  { key: "spread", commandId: "insert-spread", title: "양피지 좌우 펼침" },
  { key: "profile", commandId: "insert-profile", title: "인물 프로필" },
  { key: "creature", commandId: "insert-creature", title: "생물 도감" },
  { key: "infobox", commandId: "insert-infobox", title: "인포박스" },
  { key: "skills", commandId: "insert-skills", title: "기술 카드 묶음" },
  { key: "quote", commandId: "insert-quote", title: "장식 인용문" },
  { key: "divider", commandId: "insert-divider", title: "장식 구분선" },
  { key: "spoiler", commandId: "insert-spoiler", title: "접이식 스포일러" },
].map((template, index) => {
  const number = String(index + 1).padStart(2, "0");
  const snippet = SNIPPETS[template.key];
  if (typeof snippet !== "string" || !snippet.trim()) {
    throw new Error(`템플릿 카탈로그에 연결된 양식이 없습니다: ${template.key}`);
  }
  return Object.freeze({
    ...template,
    order: index + 1,
    number,
    label: `${number} · ${template.title}`,
    commandName: `${number} · ${template.title} 삽입`,
    snippet,
  });
}));

const validateTemplateCatalog = (catalog) => {
  const keys = new Set();
  const commandIds = new Set();
  catalog.forEach((template, index) => {
    if (template.order !== index + 1 || template.number !== String(index + 1).padStart(2, "0")) {
      throw new Error(`템플릿 순서가 연속적이지 않습니다: ${template.key}`);
    }
    if (keys.has(template.key)) throw new Error(`중복 템플릿 키: ${template.key}`);
    if (commandIds.has(template.commandId)) throw new Error(`중복 템플릿 명령 ID: ${template.commandId}`);
    keys.add(template.key);
    commandIds.add(template.commandId);
  });
};

validateTemplateCatalog(TEMPLATE_CATALOG);

class LayoutPickerModal extends FuzzySuggestModal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.setPlaceholder("넣을 도감 레이아웃을 고르세요…");
  }

  getItems() {
    return TEMPLATE_CATALOG;
  }

  getItemText(item) {
    return item.label;
  }

  onChooseItem(item) {
    this.plugin.insertSnippet(
      this.view.editor,
      item.label,
      item.snippet,
      this.view.file ? this.view.file.basename : "제목"
    );
  }
}

/**
 * 지면 글 고치기 (실험실 추가 2026-10-27): 코드블록 YAML 을 직접 만지지 않고 칸에 써서 고침.
 * 표지(이름 · 부제 · 표지 글 · 정보칸) · 그림(전신 · 책장 · 창 셋) · 책장(장 / 쪽)을 고치고 저장하면
 * 노트의 mn-codex 블록을 새 YAML 로 바꿔 씀. 여기 없는 키(배치 · 색 · 초점 등)는 그대로 둠.
 */
/** 그림 초점 잡기: 그림에서 보일 자리를 누르거나 끌어 초점(가로% 세로%)을, 밀대로 확대를 정함. 옆 창에 실제로 잘릴 모양. 실험실 추가 2026-10-28 */
class FocusPickerModal extends Modal {
  constructor(app, src, focus, scale, aspect, onApply) {
    super(app);
    const m = String(focus || "").match(/(-?[\d.]+)%\s+(-?[\d.]+)%/u);
    this.src = src;
    this.x = m ? Number(m[1]) : 50;
    this.y = m ? Number(m[2]) : 30;
    this.scale = Number(scale) > 0 ? Number(scale) : 1;
    this.aspect = aspect || 1.6;
    this.onApply = onApply;
  }

  onOpen() {
    this.modalEl.addClass("mn-focus-picker");
    this.titleEl.setText("그림 초점 잡기");
    const el = this.contentEl;
    el.empty();
    el.createDiv({ cls: "mn-focus-picker__hint", text: "보이게 할 자리(얼굴 등)를 누르거나 끌어요. 확대는 아래 밀대로." });
    const body = el.createDiv({ cls: "mn-focus-picker__body" });
    const stage = body.createDiv({ cls: "mn-focus-picker__stage" });
    const img = stage.createEl("img", { attr: { src: this.src, alt: "", draggable: "false" } });
    const mark = stage.createDiv({ cls: "mn-focus-picker__mark" });
    const side = body.createDiv({ cls: "mn-focus-picker__side" });
    side.createDiv({ cls: "mn-focus-picker__label", text: "보이는 모양" });
    const preview = side.createDiv({ cls: "mn-focus-picker__preview" });
    preview.style.aspectRatio = String(this.aspect);
    const shot = preview.createEl("img", { attr: { src: this.src, alt: "" } });
    const value = side.createDiv({ cls: "mn-focus-picker__value" });
    const scaleRow = side.createDiv({ cls: "mn-focus-picker__scale" });
    scaleRow.createSpan({ text: "확대" });
    const slider = scaleRow.createEl("input", { attr: { type: "range", min: "1", max: "3", step: "0.05" } });
    slider.value = String(this.scale);
    const scaleText = scaleRow.createSpan({ cls: "mn-focus-picker__scale-value" });
    const update = () => {
      const focus = `${Math.round(this.x)}% ${Math.round(this.y)}%`;
      mark.style.left = `${this.x}%`;
      mark.style.top = `${this.y}%`;
      shot.style.objectPosition = focus;
      shot.style.transformOrigin = focus;
      shot.style.transform = this.scale > 1 ? `scale(${this.scale})` : "";
      value.setText(`초점 ${focus}`);
      scaleText.setText(`${this.scale.toFixed(2)}×`);
    };
    const pick = (event) => {
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
      this.y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
      update();
    };
    let dragging = false;
    stage.addEventListener("pointerdown", (event) => { dragging = true; stage.setPointerCapture?.(event.pointerId); pick(event); });
    stage.addEventListener("pointermove", (event) => { if (dragging) pick(event); });
    stage.addEventListener("pointerup", () => { dragging = false; });
    slider.addEventListener("input", () => { this.scale = Number(slider.value) || 1; update(); });
    const bar = el.createDiv({ cls: "mn-codex-editor__bar" });
    bar.createEl("button", { text: "닫기", attr: { type: "button" } }).addEventListener("click", () => this.close());
    const apply = bar.createEl("button", { cls: "mod-cta", text: "적용", attr: { type: "button" } });
    apply.addEventListener("click", () => {
      this.onApply(`${Math.round(this.x)}% ${Math.round(this.y)}%`, Math.round(this.scale * 100) / 100);
      this.close();
    });
    update();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 인물 도감의 「인물 거르기」 창: 왼쪽에 거리(소속 · 종족 · 위치), 오른쪽에 그 거리의 이름 찾기 + 고르기(인원 수와 함께).
 *  고르면 뒤의 도감이 바로 바뀜. 실험실 추가 2026-10-29 */
class RosterFilterModal extends Modal {
  constructor(app, facets, picked, countFor, onChange) {
    super(app);
    this.facets = facets.filter((facet) => facet.values.length);
    this.picked = picked;
    this.countFor = countFor;
    this.onChange = onChange;
    this.tab = this.facets[0] ? this.facets[0].key : "";
    this.query = "";
  }

  onOpen() {
    this.modalEl.addClass("mn-roster-filter");
    this.titleEl.setText("인물 거르기");
    const el = this.contentEl;
    el.empty();
    if (!this.facets.length) {
      el.createDiv({ cls: "mn-roster-filter__none", text: "거를 소속 · 종족 · 위치가 아직 없어요." });
      return;
    }
    const body = el.createDiv({ cls: "mn-roster-filter__body" });
    const tabs = body.createDiv({ cls: "mn-roster-filter__tabs" });
    const side = body.createDiv({ cls: "mn-roster-filter__side" });
    const search = side.createEl("input", { cls: "mn-roster-filter__search", attr: { type: "search" } });
    const list = side.createDiv({ cls: "mn-roster-filter__list" });
    const chosen = el.createDiv({ cls: "mn-roster-filter__chosen" });
    const foot = el.createDiv({ cls: "mn-roster-filter__foot" });
    const total = foot.createDiv({ cls: "mn-roster-filter__total" });
    const clear = foot.createEl("button", { text: "다 풀기", attr: { type: "button" } });
    const close = foot.createEl("button", { cls: "mod-cta", text: "닫기", attr: { type: "button" } });
    const changed = () => {
      this.onChange();
      draw();
    };
    const draw = () => {
      const facet = this.facets.find((item) => item.key === this.tab) || this.facets[0];
      const set = this.picked[facet.key];
      tabs.empty();
      this.facets.forEach((item) => {
        const n = this.picked[item.key].size;
        const tab = tabs.createEl("button", { cls: `mn-roster-filter__tab${item.key === facet.key ? " is-on" : ""}`, attr: { type: "button" } });
        tab.createSpan({ text: item.label });
        tab.createSpan({ cls: "mn-roster-filter__tab-count", text: n ? `${n} / ${item.values.length}` : String(item.values.length) });
        tab.addEventListener("click", () => {
          this.tab = item.key;
          this.query = "";
          search.value = "";
          draw();
          search.focus();
        });
      });
      search.setAttr("placeholder", `${facet.label} 이름 찾기 (${facet.values.length}개)`);
      const scroll = list.scrollTop;
      list.empty();
      const words = this.query.toLowerCase().split(/\s+/u).filter(Boolean);
      const rows = facet.values.filter((value) => words.every((word) => value.toLowerCase().includes(word)));
      if (!rows.length) list.createDiv({ cls: "mn-roster-filter__none", text: `「${this.query}」에 맞는 ${facet.label}이 없어요.` });
      rows.forEach((value) => {
        const row = list.createEl("label", { cls: `mn-roster-filter__row${set.has(value) ? " is-on" : ""}` });
        const box = row.createEl("input", { attr: { type: "checkbox" } });
        box.checked = set.has(value);
        row.createSpan({ cls: "mn-roster-filter__name", text: value });
        row.createSpan({ cls: "mn-roster-filter__count", text: `${facet.counts.get(value)}명` });
        box.addEventListener("change", () => {
          if (box.checked) set.add(value);
          else set.delete(value);
          changed();
        });
      });
      list.scrollTop = scroll;
      chosen.empty();
      const tags = this.facets.flatMap((item) => [...this.picked[item.key]].map((value) => ({ item, value })));
      chosen.toggleClass("is-empty", !tags.length);
      tags.forEach(({ item, value }) => {
        const tag = chosen.createEl("button", { cls: "mn-roster-filter__tag", text: `${item.label} · ${value} ✕`, attr: { type: "button" } });
        tag.addEventListener("click", () => {
          this.picked[item.key].delete(value);
          changed();
        });
      });
      total.setText(`${this.countFor()}명이 맞아요`);
    };
    search.addEventListener("input", () => {
      this.query = search.value;
      draw();
    });
    clear.addEventListener("click", () => {
      this.facets.forEach((item) => this.picked[item.key].clear());
      changed();
    });
    close.addEventListener("click", () => this.close());
    draw();
    search.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 내성주 관리 패널 (작가 2026-11-01: 많아서 기록표 안이 아니라 별도 패널에서 관리). 노트 속성이 바뀌면 다시 그림 */
class ResistPanelModal extends Modal {
  constructor(app, plugin, sourcePath, options, name) {
    super(app);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.options = options || {};
    this.name = name;
  }

  onOpen() {
    this.modalEl.addClass("mn-resist-modal");
    this.titleEl.setText(`${this.name} · 내성주`);
    const draw = () => this.plugin.recordResistManager(this.contentEl, this.sourcePath, this.options);
    draw();
    const cache = this.app && this.app.metadataCache;
    if (cache && typeof cache.on === "function") {
      let timer = 0;
      this.changedRef = cache.on("changed", (file) => {
        if (!file || file.path !== this.sourcePath) return;
        clearTimeout(timer);
        timer = setTimeout(draw, 120);
      });
    }
  }

  onClose() {
    if (this.changedRef && this.app.metadataCache && typeof this.app.metadataCache.offref === "function") this.app.metadataCache.offref(this.changedRef);
    this.contentEl.empty();
  }
}

class CodexEditModal extends Modal {
  constructor(app, data, onSave, onExport) {
    super(app);
    this.data = JSON.parse(JSON.stringify(data || {}));
    this.onSave = onSave;
    this.onExport = onExport;
  }

  onOpen() {
    this.modalEl.addClass("mn-codex-editor");
    this.titleEl.setText("지면 글 고치기");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  field(parent, label, value, onInput, opts = {}) {
    const row = parent.createDiv({ cls: "mn-codex-editor__field" + (opts.area ? " is-area" : "") });
    row.createEl("label", { text: label });
    const input = row.createEl(opts.area ? "textarea" : "input", { attr: opts.area ? { rows: String(opts.rows || 4) } : { type: "text" } });
    input.value = value == null ? "" : String(value);
    if (opts.placeholder) input.setAttr("placeholder", opts.placeholder);
    input.addEventListener("input", () => onInput(input.value));
    if (opts.pick) {
      const pick = row.createEl("button", { cls: "mn-codex-editor__pick", text: "고르기", attr: { type: "button" } });
      pick.addEventListener("click", () => new VaultImagePickerModal(this.app, (file) => { input.value = file.path; onInput(file.path); }).open());
    }
    return input;
  }

  /** 그림 칸의 값(보관소 경로 · [[이름]])을 화면에 띄울 주소로 */
  imageUrl(value) {
    const raw = String(value || "").trim().replace(/^!?\[\[|\]\]$/gu, "").split("|")[0].trim();
    if (!raw) return "";
    const vault = this.app && this.app.vault;
    const file = (vault && vault.getAbstractFileByPath(raw)) || (this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest(raw, ""));
    return file && vault ? vault.getResourcePath(file) : "";
  }

  /** 초점 칸 옆 「눌러서 잡기」: 그림을 띄워 초점 · 확대를 잡고 칸에 넣음 */
  focusButton(focusInput, getImage, getScale, setScale, aspect) {
    const row = focusInput.parentElement;
    const btn = row.createEl("button", { cls: "mn-codex-editor__pick", text: "눌러서 잡기", attr: { type: "button" } });
    btn.addEventListener("click", () => {
      const src = this.imageUrl(getImage());
      if (!src) { new Notice("먼저 그림을 골라 주세요."); return; }
      new FocusPickerModal(this.app, src, focusInput.value, getScale(), aspect, (focus, scale) => {
        focusInput.value = focus;
        focusInput.dispatchEvent(new Event("input"));
        setScale(scale);
      }).open();
    });
  }

  tools(parent, list, index, rerender, label) {
    const bar = parent.createDiv({ cls: "mn-codex-editor__tools" });
    const btn = (text, title, act, disabled) => {
      const b = bar.createEl("button", { text, attr: { type: "button", title } });
      if (disabled) b.disabled = true;
      b.addEventListener("click", () => { act(); rerender(); });
    };
    btn("↑", "위로", () => list.splice(index - 1, 0, list.splice(index, 1)[0]), index === 0);
    btn("↓", "아래로", () => list.splice(index + 1, 0, list.splice(index, 1)[0]), index === list.length - 1);
    btn(`${label} 지우기`, `이 ${label} 지우기`, () => list.splice(index, 1));
  }

  render() {
    const d = this.data;
    const el = this.contentEl;
    const keepScroll = el.scrollTop;
    el.empty();
    const rerender = () => this.render();

    const cover = el.createEl("details", { cls: "mn-codex-editor__group", attr: { open: "" } });
    cover.createEl("summary", { text: "표지" });
    this.field(cover, "이름", d.title, (v) => { d.title = v; });
    this.field(cover, "부제 (이름 아래 띠)", d.subtitle, (v) => { d.subtitle = v; });
    this.field(cover, "표지 글 (오른쪽 아래)", d.content, (v) => { d.content = v; }, { area: true, rows: 4 });
    const factsText = d.facts && typeof d.facts === "object" && !Array.isArray(d.facts)
      ? Object.entries(d.facts).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
    this.field(cover, "정보칸 (왼쪽 위, 한 줄에 「이름: 값」)", factsText, (v) => {
      const facts = {};
      v.split("\n").forEach((line) => {
        const m = line.match(/^\s*([^:：]+)[:：]\s*(.*)$/);
        if (m && m[1].trim()) facts[m[1].trim()] = m[2].trim();
      });
      d.facts = facts;
    }, { area: true, rows: 3 });

    const pics = el.createEl("details", { cls: "mn-codex-editor__group" });
    pics.createEl("summary", { text: "그림" });
    this.field(pics, "표지 전신 (바탕을 뗀 투명 그림)", d.image, (v) => { d.image = v; }, { pick: true });
    this.field(pics, "책장 그림", d.book_image, (v) => { d.book_image = v; }, { pick: true });
    const details = Array.isArray(d.detail_images) ? d.detail_images : [];
    ["창 1", "창 2", "창 3"].forEach((label, i) => {
      this.field(pics, `왼쪽 ${label}`, details[i], (v) => {
        const list = Array.isArray(d.detail_images) ? d.detail_images : [];
        list[i] = v;
        d.detail_images = list;
      }, { pick: true });
      const focusList = () => (Array.isArray(d.detail_focus) ? d.detail_focus : (d.detail_focus = []));
      const scaleList = () => (Array.isArray(d.detail_scale) ? d.detail_scale : (d.detail_scale = []));
      const focus = this.field(pics, `　${label} 초점`, focusList()[i], (v) => { focusList()[i] = v; }, { placeholder: "50% 30%" });
      this.focusButton(focus, () => (Array.isArray(d.detail_images) ? d.detail_images[i] : ""), () => scaleList()[i], (scale) => { scaleList()[i] = scale; }, 1.6);
    });

    if (String(d.layout_variant || "").trim()) this.lookFields(el, d, rerender);

    const book = el.createEl("details", { cls: "mn-codex-editor__group", attr: { open: "" } });
    book.createEl("summary", { text: "책장 (넘기는 쪽)" });
    if (!Array.isArray(d.book_sections)) d.book_sections = [];
    d.book_sections.forEach((section, si) => {
      const card = book.createDiv({ cls: "mn-codex-editor__section" });
      const head = card.createDiv({ cls: "mn-codex-editor__head" });
      head.createSpan({ text: `${String(si + 1).padStart(2, "0")} 장` });
      this.tools(head, d.book_sections, si, rerender, "장");
      this.field(card, "장 제목", section.title, (v) => { section.title = v; });
      this.field(card, "작은 영문 머리", section.subtitle, (v) => { section.subtitle = v; });
      this.field(card, "틀 (개요 · 능력 · 관계 · 여담 · 기본)", section.template, (v) => { section.template = v.trim(); }, { placeholder: "비우면 장 제목으로 고름" });
      const tpl = String(section.template || "").trim();
      const isPersonal = tpl ? /^(여담|personal)$/iu.test(tpl) : /여담|취향|사적|비하인드/u.test(String(section.title || ""));
      if (isPersonal) this.personalFields(card, section);
      else this.field(card, "글", section.content, (v) => { section.content = v; }, { area: true, rows: 6 });
      const isRelation = tpl ? /^(관계|relation)$/iu.test(tpl) : /관계|인연/u.test(String(section.title || ""));
      const isAbility = tpl ? /^(능력|ability)$/iu.test(tpl) : /능력|기술|전투|스킬/u.test(String(section.title || ""));
      this.pageArtFields(card, section, "장 그림");
      if (!Array.isArray(section.pages)) section.pages = [];
      section.pages.forEach((page, pi) => {
        const pc = card.createDiv({ cls: "mn-codex-editor__page" });
        const ph = pc.createDiv({ cls: "mn-codex-editor__head" });
        ph.createSpan({ text: `쪽 ${pi + 1}` });
        this.tools(ph, section.pages, pi, rerender, "쪽");
        this.field(pc, "쪽 제목", page.title, (v) => { page.title = v; });
        if (isAbility) {
          this.field(pc, "능력 그림", page.visual, (v) => { page.visual = v; }, { pick: true, placeholder: "왼쪽 쪽 전체에 배경으로 깔림 · 비우면 그림 없이" });
          const focus = this.field(pc, "그림 초점 (가로% 세로%)", page.visual_focus, (v) => { page.visual_focus = v; }, { placeholder: "50% 30%" });
          const scale = this.field(pc, "그림 확대 (1 = 그대로)", page.visual_scale, (v) => { page.visual_scale = v; }, { placeholder: "1" });
          // 능력 쪽은 왼쪽 쪽 전체(세로로 긴 판)에 깔리니 미리보기도 그 비율로
          this.focusButton(focus, () => page.visual, () => page.visual_scale, (v) => { page.visual_scale = v; scale.value = String(v); }, 0.6);
        }
        if (!isAbility && !isRelation) this.pageArtFields(pc, page, "쪽 그림");
        if (isRelation) {
          this.field(pc, "관계 한 줄 (두 사람 사이에 뜸)", page.relation, (v) => { page.relation = v; });
          this.field(pc, "그 사람 그림", page.portrait, (v) => { page.portrait = v; }, { pick: true, placeholder: "비우면 그 이름 인물 노트의 「초상」, 없으면 첫 글자" });
        }
        this.field(pc, "글", page.content, (v) => { page.content = v; }, { area: true, rows: 5 });
      });
      const add = card.createEl("button", { cls: "mn-codex-editor__add", text: "＋ 쪽", attr: { type: "button" } });
      add.addEventListener("click", () => { section.pages.push({ title: "새 쪽", content: "" }); rerender(); });
    });
    const addSection = book.createEl("button", { cls: "mn-codex-editor__add", text: "＋ 장", attr: { type: "button" } });
    addSection.addEventListener("click", () => { d.book_sections.push({ title: "새 장", subtitle: "", content: "", pages: [] }); rerender(); });

    const bar = el.createDiv({ cls: "mn-codex-editor__bar" });
    if (typeof this.onExport === "function") {
      const exportButton = bar.createEl("button", { cls: "mn-codex-editor__export", text: "책을 그림으로 내보내기", attr: { type: "button", title: "표지와 책장 펼침을 한 장씩 그림(PNG)으로 — The Archive - 자료/책 내보내기/노트 이름/" } });
      exportButton.addEventListener("click", () => { this.close(); this.onExport(); });
    }
    const cancel = bar.createEl("button", { text: "닫기", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const save = bar.createEl("button", { cls: "mod-cta", text: "저장", attr: { type: "button" } });
    save.addEventListener("click", async () => {
      save.disabled = true;
      const ok = await this.onSave(this.clean(d));
      save.disabled = false;
      if (ok) this.close();
    });
    el.scrollTop = keepScroll;
  }

  /** 지면 (캐릭터 전용 지면일 때만): 색 · 바탕 무늬 · 문장 · 쪽 아래 글자. 비우면 그 지면 그대로 */
  lookFields(el, d, rerender) {
    const group = el.createEl("details", { cls: "mn-codex-editor__group" });
    group.createEl("summary", { text: "지면 (색 · 무늬 · 문장)" });
    const chips = (label, options, current, onPick) => {
      const row = group.createDiv({ cls: "mn-codex-editor__field" });
      row.createEl("label", { text: label });
      const box = row.createDiv({ cls: "mn-codex-editor__swatches" });
      for (const option of options) {
        const chip = box.createEl("button", { cls: "mn-codex-editor__swatch", attr: { type: "button" } });
        if (option.color) chip.createEl("i").style.background = option.color;
        chip.appendText(option.text);
        if (option.value === current) chip.addClass("is-on");
        chip.addEventListener("click", () => { onPick(option.value); rerender(); });
      }
    };
    const swatch = (name) => {
      const tint = VARIANT_TINTS[name];
      return tint ? `oklch(from #4e6382 l calc(c * ${tint[1]}) calc(h + ${tint[0]}))` : "#4e6382";
    };
    chips("지면 색", VARIANT_TINT_NAMES.map((name) => ({ value: name, text: name === "은회" ? "은회 (그대로)" : name, color: swatch(name) })),
      VARIANT_TINTS[String(d.page_tint || "").trim()] ? String(d.page_tint).trim() : "은회",
      (value) => { if (value === "은회") delete d.page_tint; else d.page_tint = value; });
    chips("바탕 무늬", [{ value: "검", text: "떠 있는 검" }, { value: "없음", text: "없음 (민무늬)" }],
      /^(없음|민무늬|none|plain)$/iu.test(String(d.page_pattern || "").trim()) ? "없음" : "검",
      (value) => { if (value === "검") delete d.page_pattern; else d.page_pattern = value; });
    chips("책 효과 (시안)", [{ value: "모두", text: "모두" }, { value: "넘김", text: "책장 넘김만" }, { value: "장 효과", text: "장마다 효과만" }, { value: "없음", text: "없음" }],
      ["넘김", "장 효과", "없음"].includes(String(d.book_effects || "").trim()) ? String(d.book_effects).trim() : String(d.book_effects || "").trim() === "빛줄기" ? "장 효과" : "모두",
      (value) => { if (value === "모두") delete d.book_effects; else d.book_effects = value; });
    this.field(group, "문장 (표지 왼쪽 위 · 개요 그림 메달)", d.page_emblem, (v) => { d.page_emblem = v; },
      { pick: true, placeholder: "비우면 케이숑 메달 · 「없음」이면 안 보임 · 세력 심볼 그림을 골라도 돼요" });
    this.field(group, "쪽 아래 글자", d.archive_label, (v) => { d.archive_label = v; },
      { placeholder: String(d.eyebrow || "").trim() || `${String(d.title || "이름").trim()} / ARCHIVE` });
  }

  /** 장 · 쪽 그림 칸: 그림 · 초점(눌러서 잡기) · 확대. 그림을 달면 그 장 · 쪽은 새 펼침 왼쪽 석판 쪽에서 시작하고 그 쪽 전체 바닥에 은은하게 깔림 */
  pageArtFields(parent, target, label) {
    this.field(parent, label, target.visual, (v) => { target.visual = v; }, { pick: true, placeholder: "달면 새 펼침 왼쪽 석판 쪽에서 시작해 글 뒤에 은은하게 깔려요 · 바탕까지 그린 세로 그림이 어울려요" });
    const focus = this.field(parent, "　그림 초점", target.visual_focus, (v) => { target.visual_focus = v; }, { placeholder: "50% 40%" });
    const scale = this.field(parent, "　그림 확대 (1 = 그대로)", target.visual_scale, (v) => { target.visual_scale = v; }, { placeholder: "1" });
    this.focusButton(focus, () => target.visual, () => target.visual_scale, (v) => { target.visual_scale = v; scale.value = String(v); }, 0.78);
  }

  /** 여담 장: 글을 칸으로 나눠 고침 — 좋아하는 것 · 싫어하는 것 · 취미 · 한마디(한 줄씩), 여담(한 줄에 하나), 그 밖의 글.
   *  저장하면 「이름 : 값」 줄 + 「- 여담」 목록 + 그 밖의 글로 다시 묶음(세 칸은 비어도 남겨서 지면에 「—」로 보임) */
  personalFields(card, section) {
    const BASE = ["좋아하는 것", "싫어하는 것", "취미"];
    const QUOTES = ["한마디", "좌우명"];
    const KV = /^\s*([^:：\n]{1,12}?)\s*[:：]\s*(.*)$/u;
    const state = { values: {}, trivia: [], rest: [] };
    String(section.content || "").split(/\r?\n/u).forEach((line) => {
      const item = line.match(/^\s*[-*+]\s+(.*)$/u);
      const kv = line.match(KV);
      if (item) state.trivia.push(item[1]);
      else if (kv && (BASE.includes(kv[1].trim()) || QUOTES.includes(kv[1].trim()))) state.values[kv[1].trim()] = kv[2].trim();
      else state.rest.push(line);
    });
    const quoteKey = QUOTES.find((key) => state.values[key] !== undefined) || "한마디";
    const compose = () => {
      const lines = BASE.map((key) => `${key} : ${state.values[key] || ""}`.trimEnd());
      if (String(state.values[quoteKey] || "").trim()) lines.push(`${quoteKey} : ${state.values[quoteKey].trim()}`);
      const parts = [lines.join("\n")];
      const trivia = state.trivia.map((t) => t.trim()).filter(Boolean);
      if (trivia.length) parts.push(trivia.map((t) => `- ${t}`).join("\n"));
      const rest = state.rest.join("\n").trim();
      if (rest) parts.push(rest);
      section.content = parts.join("\n\n") + "\n";
    };
    BASE.forEach((key) => this.field(card, `${key} (쉼표로 여럿)`, state.values[key], (v) => { state.values[key] = v; compose(); }));
    this.field(card, `${quoteKey} (비우면 안 보임)`, state.values[quoteKey], (v) => { state.values[quoteKey] = v; compose(); });
    this.field(card, "여담 (한 줄에 하나)", state.trivia.join("\n"), (v) => { state.trivia = v.split(/\r?\n/u); compose(); }, { area: true, rows: 4 });
    this.field(card, "그 밖의 글", state.rest.join("\n").trim(), (v) => { state.rest = v.split(/\r?\n/u); compose(); }, { area: true, rows: 2 });
  }

  /** 빈 칸은 키째 빼서 YAML 을 짧게 */
  clean(d) {
    const out = { ...d };
    for (const k of ["title", "subtitle", "content", "image", "book_image"]) if (out[k] === "") delete out[k];
    for (const k of ["page_tint", "page_pattern", "page_emblem", "archive_label", "book_effects"]) if (!String(out[k] || "").trim()) delete out[k];
    if (Array.isArray(out.detail_images)) {
      const list = out.detail_images.map((v) => (v == null ? "" : String(v).trim()));
      if (list.every((v) => !v)) delete out.detail_images;
      else out.detail_images = list;
    }
    if (out.facts && !Object.keys(out.facts).length) delete out.facts;
    // 왼쪽 창 초점 · 확대: 빈 자리는 기본값으로 채우고, 전부 기본값이면 키째 뺌
    for (const key of ["detail_focus", "detail_scale"]) {
      if (!Array.isArray(out[key])) continue;
      const list = Array.from(out[key], (v) => (v == null ? "" : v));
      const isDefault = (v) => String(v).trim() === "" || (key === "detail_scale" && Number(v) === 1);
      if (list.every(isDefault)) delete out[key];
      else out[key] = key === "detail_scale" ? list.map((v) => Number(v) || 1) : list.map((v) => String(v).trim() || "50% 30%");
    }
    out.book_sections = (out.book_sections || []).map((s) => {
      const sec = { ...s };
      if (!sec.subtitle) delete sec.subtitle;
      if (!sec.template) delete sec.template;
      for (const k of ["visual", "visual_focus"]) if (!String(sec[k] || "").trim()) delete sec[k];
      if (sec.visual_scale !== undefined) {
        const scale = Number(sec.visual_scale);
        if (!sec.visual || !Number.isFinite(scale) || scale === 1 || String(sec.visual_scale).trim() === "") delete sec.visual_scale;
        else sec.visual_scale = scale;
      }
      sec.pages = (sec.pages || []).filter((p) => p && (p.title || p.content)).map((p) => {
        const page = { ...p };
        for (const k of ["relation", "portrait", "visual", "visual_focus"]) if (!String(page[k] || "").trim()) delete page[k];
        if (page.visual_scale !== undefined) {
          const scale = Number(page.visual_scale);
          if (!page.visual || !Number.isFinite(scale) || scale === 1 || String(page.visual_scale).trim() === "") delete page.visual_scale;
          else page.visual_scale = scale;
        }
        return page;
      });
      if (!sec.pages.length) delete sec.pages;
      return sec;
    });
    return out;
  }
}

class VaultImagePickerModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("지면에 배치할 이미지를 검색하세요…");
  }

  getItems() {
    const imagePattern = /^(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
    return this.app.vault.getFiles()
      .filter((file) => imagePattern.test(file.extension || ""))
      .sort((a, b) => {
        const aPreferred = /^Dummy\/SD\//i.test(a.path) ? 0 : 1;
        const bPreferred = /^Dummy\/SD\//i.test(b.path) ? 0 : 1;
        return aPreferred - bPreferred || a.path.localeCompare(b.path, "ko");
      });
  }

  getItemText(file) {
    return file.path;
  }

  renderSuggestion(file, el) {
    el.addClass("mn-codex__image-suggestion");
    el.createEl("img", {
      cls: "mn-codex__image-suggestion-thumb",
      attr: {
        src: this.app.vault.getResourcePath(file),
        alt: "",
        loading: "lazy",
      },
    });
    const copy = el.createDiv({ cls: "mn-codex__image-suggestion-copy" });
    copy.createDiv({ cls: "mn-codex__image-suggestion-name", text: file.basename });
    copy.createDiv({ cls: "mn-codex__image-suggestion-path", text: file.path });
  }

  onChooseItem(file) {
    if (typeof this.onChoose === "function") this.onChoose(file);
  }
}

module.exports = class MnIlluminatedCodexPlugin extends Plugin {
  async onload() {
    this.persistedData = await this.loadData() || {};
    this.pageImageLayouts = this.persistedData.pageImageLayouts || {};
    this.installAssetCssVariables();

    this.registerMarkdownCodeBlockProcessor(
      BLOCK_LANGUAGE,
      async (source, el, ctx) => {
        const child = new MarkdownRenderChild(el);
        ctx.addChild(child);
        el.addClass("mn-codex-host");

        let data;
        try {
          data = parseYaml(source);
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("블록의 최상위 값은 YAML 객체여야 합니다.");
          }
        } catch (error) {
          this.renderError(el, "문법을 읽지 못했습니다.", error);
          return;
        }

        try {
          if (this.asText(data.layout_variant).trim()) this.fitCodexPane(ctx.sourcePath);
          await this.renderCodex(data, el, ctx.sourcePath, child);
          this.registerMelyDeckCandidate(data, el, ctx.sourcePath, child);
          this.addEditButton(el, data, ctx);
        } catch (error) {
          el.empty();
          this.renderError(el, "레이아웃을 그리지 못했습니다.", error);
        }
      }
    );

    // 인물 도감: ```mn-roster 블록 = 「분류: 인물」 노트를 카드로 (소속으로 거르기 · 시험 노트 숨기기 · 누르면 그 인물로). 실험실 추가 2026-10-28
    this.registerMarkdownCodeBlockProcessor("mn-roster", async (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      let options = {};
      try {
        options = parseYaml(source) || {};
      } catch (error) {
        options = {};
      }
      const state = { group: "", hideTest: Boolean(options.hide_test), view: /^(표|table)$/u.test(String(options.view || "").trim()) ? "table" : "card", sort: null,
        picked: { groups: new Set(), races: new Set(), places: new Set() }, query: "", more: 0 };
      const draw = async () => {
        el.empty();
        await this.renderRoster(options, el, ctx.sourcePath, state);
      };
      await draw();
      // 인물 노트 속성이 바뀌면 다시 그림
      const cache = this.app && this.app.metadataCache;
      if (cache && typeof cache.on === "function") {
        let timer = 0;
        child.registerEvent(cache.on("changed", (file) => {
          const front = cache.getFileCache(file)?.frontmatter;
          if (!front || this.asText(front["분류"]).trim() !== "인물") return;
          clearTimeout(timer);
          timer = setTimeout(draw, 400);
        }));
      }
    });

    // 인물 기록표: ```mn-record 블록 = 이 노트 속성(맨 위 칸)을 한눈에 — 수치 · 항목 · 빈 칸. 값은 속성에만 두고 여기선 읽기만 함.
    // 속성을 고치면 바로 다시 그림. 실험실 추가 2026-10-29
    this.registerMarkdownCodeBlockProcessor("mn-record", async (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      // 블록 안엔 속성에 아직 없는 값의 초안(투력 기록 · 전투 등급 · 의지 · 실현 등급)을 적을 수 있음 → 「미리보기」로 보임
      let options = {};
      try {
        options = parseYaml(source) || {};
      } catch (error) {
        options = {};
      }
      const draw = async () => {
        el.empty();
        await this.renderRecord(el, ctx.sourcePath, options);
      };
      await draw();
      const cache = this.app && this.app.metadataCache;
      if (cache && typeof cache.on === "function") {
        let timer = 0;
        child.registerEvent(cache.on("changed", (file) => {
          if (!file || file.path !== ctx.sourcePath) return;
          clearTimeout(timer);
          timer = setTimeout(draw, 300);
        }));
      }
    });

    TEMPLATE_CATALOG.forEach((template) => {
      this.addSnippetCommand(
        template.commandId,
        template.commandName,
        template.snippet
      );
    });

    this.addCommand({
      id: "open-layout-picker",
      name: "레이아웃 선택기 열기",
      callback: () => this.openLayoutPicker(),
    });
    this.addCommand({
      id: "show-version",
      name: "버전 확인",
      callback: () => new Notice(`${this.manifest.name} v${this.manifest.version}`),
    });
    this.addRibbonIcon("book-open", "도감 레이아웃 삽입", () => this.openLayoutPicker());
    this.addCommand({
      id: "export-book-images",
      name: "지금 노트의 인물 책을 그림으로 내보내기",
      callback: () => {
        const leaf = this.app.workspace && this.app.workspace.activeLeaf;
        const container = leaf && leaf.view && leaf.view.containerEl;
        const host = container && Array.from(container.querySelectorAll(".mn-codex-host")).find((el) => typeof el._mnExportBook === "function");
        if (host) host._mnExportBook();
        else new Notice("지금 노트에서 인물 책(지면 블록)을 찾지 못했어요. 읽기 화면에서 해 주세요.");
      },
    });
  }

  /** 지면 오른쪽 위 「글 고치기」 단추 (마우스를 올리면 보임). 표지 다음 책장에도 같은 단추를 달아 줌 */
  addEditButton(host, data, ctx) {
    if (typeof Modal !== "function" || typeof stringifyYaml !== "function") return;
    const exportBook = () => this.exportBookImages(host, ctx.sourcePath);
    const open = () => new CodexEditModal(this.app, data, (next) => this.saveCodexBlock(host, ctx, next), exportBook).open();
    host._mnOpenEditor = open;
    host._mnExportBook = exportBook;
    const make = (parent) => {
      if (!parent || parent.querySelector(":scope > .mn-codex-edit-button")) return;
      const button = parent.createEl("button", {
        cls: "mn-codex-edit-button",
        text: "✎ 글 고치기",
        attr: { type: "button", title: "이 지면의 글 · 그림 · 책장을 칸에 써서 고쳐요" },
      });
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
    };
    make(host);
    // 책장은 NEXT 를 처음 누를 때 생기므로, 생기면 거기에도
    const watch = new MutationObserver(() => make(host._mnMelyInlineBook));
    if (host.parentElement) watch.observe(host.parentElement, { childList: true });
    if (typeof this.register === "function") this.register(() => watch.disconnect());
  }

  /** 책을 그림으로 내보내기: 표지와 책장 펼침을 차례로 띄워 화면 그대로 찍어 PNG 로 저장 (데스크톱 옵시디언 · Electron 화면 찍기).
   *  저장 자리: The Archive - 자료/책 내보내기/<노트 이름>/ 00 표지.png · 01.png … (같은 이름은 덮어씀). 실험실 추가 2026-10-28 */
  async exportBookImages(host, sourcePath) {
    let contents = null;
    for (const name of ["@electron/remote", "electron"]) {
      try {
        const loaded = require(name);
        const remote = name === "electron" ? loaded && loaded.remote : loaded;
        if (remote && typeof remote.getCurrentWebContents === "function") {
          contents = remote.getCurrentWebContents();
          break;
        }
      } catch (error) {
        // 다음 방법으로
      }
    }
    if (!contents || typeof contents.capturePage !== "function") {
      new Notice("책 내보내기는 데스크톱 옵시디언에서만 돼요 (화면 찍기 기능을 찾지 못했어요).");
      return;
    }
    const vault = this.app.vault;
    const base = this.asText(sourcePath).split("/").pop().replace(/\.md$/u, "") || "책";
    const root = "The Archive - 자료/책 내보내기";
    const folder = normalizePath(`${root}/${base}`);
    for (const part of [root, folder]) {
      if (!vault.getAbstractFileByPath(part)) {
        try {
          await vault.createFolder(part);
        } catch (error) {
          // 이미 있음
        }
      }
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const doc = host.ownerDocument;
    const view = doc.defaultView || window;
    const shown = (el) => Boolean(el && el.getClientRects().length && el.getBoundingClientRect().width > 20);
    let count = 0;
    const capture = async (el, name) => {
      el.scrollIntoView({ block: "start" });
      await wait(400);
      const rect = el.getBoundingClientRect();
      const zoom = typeof contents.getZoomFactor === "function" ? Number(contents.getZoomFactor()) || 1 : 1;
      const top = Math.max(0, rect.top);
      const bottom = Math.min(view.innerHeight, rect.bottom);
      if (bottom - top < 20 || rect.width < 20) return;
      const image = await contents.capturePage({
        x: Math.round(Math.max(0, rect.left) * zoom),
        y: Math.round(top * zoom),
        width: Math.round(rect.width * zoom),
        height: Math.round((bottom - top) * zoom),
      });
      const png = image.toPNG();
      const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
      const path = normalizePath(`${folder}/${name}.png`);
      const existing = vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await vault.modifyBinary(existing, buffer);
      else await vault.createBinary(path, buffer);
      count += 1;
    };
    doc.body.classList.add("mn-codex-exporting");
    const progress = new Notice("책을 그림으로 내보내는 중… (끝날 때까지 창을 그대로 두세요)", 0);
    try {
      // 표지: 책장이 열려 있으면 「00 표지」로 돌아가서 찍음
      let book = host._mnMelyInlineBook;
      const coverTag = book && book.querySelector(".mn-codex__page-tag--cover");
      if (coverTag && shown(book)) {
        coverTag.click();
        await wait(1000);
      }
      const cover = host.querySelector(":scope > .mn-codex");
      if (shown(cover)) await capture(cover, "00 표지");
      // 책장: 표지 NEXT 로 열고 펼침(좁은 지면은 한 쪽)마다 찍음
      const next = host.querySelector(".mn-mely-pager__button--next");
      if (next && shown(next)) next.click();
      for (let i = 0; i < 40 && !(book = host._mnMelyInlineBook); i += 1) await wait(150);
      const bookRoot = book && book.querySelector(":scope > .mn-codex");
      let controller = null;
      for (let i = 0; i < 80 && !(controller = bookRoot && bookRoot._mnBookController); i += 1) await wait(150);
      if (controller && shown(bookRoot)) {
        const total = controller.totalSteps();
        for (let step = 0; step < total; step += 1) {
          controller.activate(step);
          await wait(1000);
          await capture(bookRoot, String(step + 1).padStart(2, "0"));
        }
      }
      new Notice(count ? `책을 그림 ${count}장으로 내보냈어요: ${folder}` : "찍을 지면을 찾지 못했어요. 노트를 읽기 화면으로 열고 다시 해 주세요.");
    } catch (error) {
      new Notice(`책을 내보내지 못했어요: ${error && error.message ? error.message : error}`);
    } finally {
      progress.hide();
      doc.body.classList.remove("mn-codex-exporting");
    }
  }

  /** 고친 데이터를 노트의 mn-codex 블록에 YAML 로 다시 씀 (블록 자리를 못 찾으면 쓰지 않음) */
  async saveCodexBlock(host, ctx, nextData) {
    const info = ctx && typeof ctx.getSectionInfo === "function" ? ctx.getSectionInfo(host) : null;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(ctx.sourcePath || ""));
    if (!info || !(file instanceof TFile)) {
      new Notice("노트에서 이 지면 블록 자리를 찾지 못했어요. 노트를 읽기 화면으로 다시 열고 해 보세요.");
      return false;
    }
    const yaml = String(stringifyYaml(nextData)).replace(/\s+$/, "");
    let written = false;
    await this.app.vault.process(file, (text) => {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const lines = text.split(/\r?\n/);
      const open = lines[info.lineStart] || "";
      const fence = (open.match(/^\s*(`{3,}|~{3,})\s*mn-codex\b/) || [])[1];
      if (!fence || !new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[info.lineEnd] || "")) return text;
      lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, `${fence}mn-codex`, ...yaml.split("\n"), fence);
      written = true;
      return lines.join(eol);
    });
    new Notice(written ? "지면 글을 저장했어요." : "블록 자리가 바뀌어 저장하지 않았어요. 다시 열어 주세요.");
    // 관계 장의 사람들은 노트 속성 「관계」에도 [[이름]]으로 (세계판 · 그래프 · 역링크에서도 보이게). 실험실 추가 2026-10-28
    if (written) {
      try {
        await this.syncRelationProperty(ctx.sourcePath, nextData);
      } catch (error) {
        console.warn("MN Codex: 속성 「관계」에 남기지 못했어요", error);
      }
    }
    return written;
  }

  createRenderScope(parentComponent) {
    if (typeof Component !== "function" || typeof parentComponent?.addChild !== "function") {
      return { component: parentComponent, dispose: () => {} };
    }
    const scope = new Component();
    parentComponent.addChild(scope);
    let disposed = false;
    return {
      component: scope,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (typeof parentComponent.removeChild === "function") {
          parentComponent.removeChild(scope);
        } else if (typeof scope.unload === "function") {
          scope.unload();
        }
      },
    };
  }

  createBookFlipDomPool(ownerDocument) {
    return new BookFlipDomPool(ownerDocument, 16);
  }

  installAssetCssVariables() {
    if (typeof document === "undefined" || !document.head) return;
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (!adapter || typeof adapter.getResourcePath !== "function") return;

    const assetUrl = (name) => this.pluginAssetUrl(name);

    const style = document.createElement("style");
    style.id = "mn-codex-runtime-assets";
    style.textContent = `body {
      --mn-mely-reference-spread: url("${assetUrl("mely-reference-spread.webp")}");
      --mn-mely-ornament-vine: url("${assetUrl("mely-ornament-vine.webp")}");
      --mn-mely-wing-etching: url("${assetUrl("mely-wing-etching.webp")}");
      --mn-mely-ribbon-slash-chrome: url("${assetUrl("mely-ribbon-slash-chrome.png")}");
      --mn-mely-tidal-crescent-chrome: url("${assetUrl("mely-tidal-crescent-chrome.png")}");
      --mn-mely-horn-slash-chrome: url("${assetUrl("mely-horn-slash-chrome.png")}");
      --mn-mely-horn-slash-foreground: url("${assetUrl("mely-horn-slash-foreground.png")}");
      --mn-mely-portrait-echo-chrome: url("${assetUrl("mely-portrait-echo-chrome.png")}");
      --mn-mely-black-tide-chrome: url("${assetUrl("mely-black-tide-chrome.png")}");
      --mn-onal-black-tide-foreground: url("${assetUrl("onal-black-tide-foreground-v2.png")}");
      --mn-onal-silver-knight-chrome: url("${assetUrl("onal-silver-knight-chrome.jpg")}");
      --mn-onal-silver-knight-chrome-plain: url("${assetUrl("onal-silver-knight-chrome-plain.jpg")}");
      --mn-onal-keishon-medal: url("${assetUrl("onal-keishon-medal.png")}");
    }`;
    document.head.appendChild(style);
    if (typeof this.register === "function") this.register(() => style.remove());
  }

  pluginAssetUrl(name) {
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
    const vaultPath = normalizePath(`${pluginDir}/assets/${name}`);
    const resource = String(adapter.getResourcePath(vaultPath));
    const separator = resource.includes("?") ? "&" : "?";
    return `${resource}${separator}mn-codex=${encodeURIComponent(this.manifest.version)}`
      .replace(/"/g, "%22");
  }

  /** 캐릭터 전용 지면을 인물마다: 지면 색(page_tint) · 바탕 무늬(page_pattern) · 문장(page_emblem) · 쪽 아래 글자(archive_label).
   *  아무것도 안 적으면 그 지면 그대로(리냐). 표지 장면 · 책장 뿌리 · 책장 바깥 틀에 같이 걺. 실험실 추가 2026-10-28 */
  applyVariantLook(el, data, sourcePath) {
    if (!el || !data || !this.asText(data.layout_variant).trim()) return;
    const tint = VARIANT_TINTS[this.asText(data.page_tint).trim()];
    if (tint) {
      el.classList.add("mn-sk-tint");
      el.style.setProperty("--sk-h", String(tint[0]));
      el.style.setProperty("--sk-c", String(tint[1]));
      this.ensureVariantTintLayer();
    }
    if (/^(없음|민무늬|none|plain)$/iu.test(this.asText(data.page_pattern).trim())) el.classList.add("mn-sk-plain");
    // 책 효과(시안): 비우면 모두, 「넘김」 · 「빛줄기」만, 「없음」
    const effects = this.asText(data.book_effects).trim();
    el.classList.toggle("mn-sk-fx-turn", !effects || /모두|넘김|turn/u.test(effects));
    el.classList.toggle("mn-sk-fx-sheen", !effects || /모두|빛줄기|장|sheen/u.test(effects));
    const emblem = this.asText(data.page_emblem).trim();
    if (/^(없음|none)$/iu.test(emblem)) el.style.setProperty("--mn-onal-keishon-medal", "none");
    else if (emblem) {
      const src = this.resolveImage(emblem, sourcePath);
      if (src) el.style.setProperty("--mn-onal-keishon-medal", `url("${String(src).replace(/"/g, "%22")}")`);
    }
    const label = this.asText(data.archive_label).trim() || this.asText(data.eyebrow).trim()
      || `${this.asText(data._mnCharacterName || data.title).trim()} / ARCHIVE`;
    el.style.setProperty("--mn-sk-folio", JSON.stringify(label.toUpperCase()));
  }

  ensureVariantTintLayer() {
    if (this._mnTintLayer || typeof document === "undefined" || !document.head) return;
    this._mnTintLayer = (async () => {
      const dir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
      const css = await this.app.vault.adapter.read(normalizePath(`${dir}/styles.css`));
      const style = document.createElement("style");
      style.id = "mn-codex-sk-tint";
      style.textContent = buildVariantTintCss(css, (name) => this.pluginAssetUrl(name));
      document.head.appendChild(style);
      if (typeof this.register === "function") this.register(() => style.remove());
    })().catch((error) => console.warn("MN Codex: 지면 색 덧층을 만들지 못했어요", error));
  }

  addSnippetCommand(id, name, snippet) {
    this.addCommand({
      id,
      name,
      editorCallback: (editor, view) => this.insertSnippet(
        editor,
        name,
        snippet,
        view && view.file ? view.file.basename : "제목"
      ),
    });
  }

  openLayoutPicker() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("먼저 Markdown 문서를 열어 주세요.");
      return;
    }
    new LayoutPickerModal(this.app, this, view).open();
  }

  insertSnippet(editor, name, snippet, noteTitle = "제목") {
    const safeTitle = String(noteTitle)
      .replace(/\\/g, "\\\\")
      .replace(/\"/g, "\\\"");
    const titledSnippet = snippet.split("{{noteTitle}}").join(safeTitle);
    const selection = editor.getSelection().trim();
    const prepared = selection
      ? this.applySelection(titledSnippet, selection)
      : titledSnippet;
    const cursor = editor.getCursor();
    const needsLeadingBreak = cursor.ch > 0 || editor.getLine(cursor.line).trim().length > 0;
    editor.replaceSelection(`${needsLeadingBreak ? "\n\n" : ""}${prepared}\n`);
    new Notice(`${name}: 양식을 넣었습니다.`);
  }

  applySelection(snippet, selection) {
    if (snippet.startsWith("> [!mn-spoiler]")) {
      const quoted = selection
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return ["> [!mn-spoiler]- 작가 전용 · 진실 보기", quoted].join("\n");
    }

    const indented = selection
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return snippet.replace(
      /content: \|\n(?:  .*\n?)*/,
      `content: |\n${indented}\n`
    );
  }

  async renderCodex(data, host, sourcePath, component) {
    data._mnSourcePath = this.asText(sourcePath);
    const kindInput = this.asText(data.type, "spread").toLowerCase();
    const kind = KIND_ALIASES[kindInput];
    if (!kind) {
      throw new Error(`지원하지 않는 type입니다: ${kindInput}`);
    }

    const defaultTheme = kind === "spread" ? "parchment" : "frost";
    const themeInput = this.asText(data.theme, defaultTheme).toLowerCase();
    const theme = THEMES.has(themeInput) ? themeInput : defaultTheme;
    const root = host.createDiv({
      cls: `mn-codex mn-codex--${kind} mn-codex--theme-${theme}`,
    });
    root.setAttr("data-mn-kind", kind);
    // layout_variant 를 처음부터 뿌리에 (본문을 그릴 때 그 지면 전용 정리를 할 수 있게). 실험실 추가 2026-10-27
    const variant = this.asText(data.layout_variant).trim().toLowerCase();
    if (/^[a-z0-9-]{1,40}$/u.test(variant)) {
      root.addClass(`mn-codex--variant-${variant}`);
      host.classList.add("mn-codex-host--has-variant");
    }
    if (kind === "spread") this.markCodexView(host, component);
    this.applyVariantLook(root, data, sourcePath);
    const brand = this.asText(data.brand || data.archive_brand).trim().toUpperCase();
    if (brand) root.setAttr("data-mn-brand", brand);

    switch (kind) {
      case "spread":
        await this.renderSpread(data, root, sourcePath, component);
        break;
      case "profile":
        await this.renderProfile(data, root, sourcePath, component);
        break;
      case "creature":
        await this.renderCreature(data, root, sourcePath, component);
        break;
      case "infobox":
        await this.renderInfobox(data, root, sourcePath, component);
        break;
      case "skills":
        await this.renderSkills(data, root, sourcePath, component);
        break;
      case "quote":
        this.renderQuote(data, root);
        break;
      case "divider":
        this.renderDivider(data, root);
        break;
      case "spoiler":
        await this.renderSpoiler(data, root, sourcePath, component);
        break;
      default:
        throw new Error(`렌더러가 없습니다: ${kind}`);
    }
  }

  registerMelyDeckCandidate(data, host, sourcePath, component) {
    const kind = KIND_ALIASES[this.asText(data.type, "spread").toLowerCase()];
    const theme = this.asText(data.theme, kind === "spread" ? "parchment" : "frost").toLowerCase();
    const layoutMode = this.asText(data.layout_mode, "flow").toLowerCase();
    if (kind !== "spread" || theme !== "mely") return;

    const isBook = layoutMode === "book";
    const isShowcase = MELY_SHOWCASE_LAYOUTS.has(layoutMode);
    const deckMode = this.asText(data.deck).trim().toLowerCase();
    const connectsToBook = data.deck === true || deckMode === "auto" || deckMode === "book";
    if (!isBook && !isShowcase) return;

    host.setAttr("data-mn-mely-sequence-role", isBook ? "book" : (connectsToBook ? "cover" : "boundary"));
    host.setAttr("data-mn-source-path", this.asText(sourcePath));
    host.setAttr("data-mn-sequence-title", this.asText(data.title, "Mely 기록"));
    host._mnMelyDeckData = data;
    host._mnMelyDeckComponent = component;
    if (isShowcase && connectsToBook) {
      this.prepareMelyCoverControls(host, this.asText(sourcePath));
      if (typeof component?.register === "function") {
        component.register(() => {
          const root = host.querySelector(":scope > .mn-codex");
          root?._mnMelyCoverNextObserver?.disconnect();
          if (root) root._mnMelyCoverNextObserver = null;
        });
      }
    }

    const refresh = () => this.refreshMelyBookSequence(host, this.asText(sourcePath));
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(refresh));
    } else {
      setTimeout(refresh, 0);
    }
  }

  findMelyDeckContainer(host) {
    return host.closest(".markdown-preview-sizer")
      || host.closest(".markdown-source-view")
      || host.closest(".markdown-reading-view")
      || host.parentElement;
  }

  collectMelySequenceMembers(container, sourcePath) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(".mn-codex-host[data-mn-mely-sequence-role]"))
      .filter((member) => member.getAttribute("data-mn-source-path") === sourcePath)
      .sort((left, right) => {
        if (left === right) return 0;
        return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
  }

  getMelySequenceState(cover, book) {
    if (!this.melySequenceState) this.melySequenceState = new WeakMap();
    let state = this.melySequenceState.get(cover);
    if (!state || state.book !== book) {
      state = { book, page: "cover" };
      this.melySequenceState.set(cover, state);
    }
    return state;
  }

  refreshMelyBookSequence(host, sourcePath) {
    if (!host || !host.isConnected) return;
    const container = this.findMelyDeckContainer(host);
    const members = this.collectMelySequenceMembers(container, sourcePath);
    if (!members.length) return;

    const pairs = [];
    for (let index = 0; index < members.length; index += 1) {
      const cover = members[index];
      if (cover.getAttribute("data-mn-mely-sequence-role") !== "cover") continue;
      for (let nextIndex = index + 1; nextIndex < members.length; nextIndex += 1) {
        const candidate = members[nextIndex];
        const role = candidate.getAttribute("data-mn-mely-sequence-role");
        if (role === "cover" || role === "boundary") break;
        if (role === "book") {
          pairs.push({ cover, book: candidate });
          break;
        }
      }
    }

    const pairedCovers = new Set(pairs.map((pair) => pair.cover));
    const pairedBooks = new Set(pairs.map((pair) => pair.book));

    for (const member of members) {
      const role = member.getAttribute("data-mn-mely-sequence-role");
      const root = member.querySelector(":scope > .mn-codex");
      if (role === "cover" && !pairedCovers.has(member)) {
        member.hidden = false;
        member.classList.remove("mn-codex-host--sequence-page", "is-active");
        this.prepareMelyCoverControls(member, sourcePath);
      } else if (role === "boundary") {
        member.hidden = false;
        member.classList.remove("mn-codex-host--sequence-page", "is-active");
      } else if (role === "book" && !pairedBooks.has(member)) {
        member.hidden = false;
        member.classList.remove("mn-codex-host--sequence-page", "is-active");
        if (root) {
          root._mnBookBeforeFirst = null;
          root._mnBookStatusOffset = 0;
          root._mnBookController?.setBeforeFirst(null);
          root._mnBookController?.setStatusOffset(0);
        }
      }
    }

    for (const pair of pairs) this.connectMelyCoverToBook(pair.cover, pair.book);
  }

  prepareMelyCoverControls(cover, sourcePath) {
    const root = cover?.querySelector(":scope > .mn-codex");
    if (!root) return;
    root.classList.add("mn-codex--mely-sequence-cover");
    root.setAttr("tabindex", "0");
    let controls = root.querySelector(":scope > .mn-mely-sequence-pager");
    if (!controls) controls = this.createMelySequenceControls(root);
    const previous = controls.querySelector(".mn-mely-pager__button--previous");
    const next = controls.querySelector(".mn-mely-pager__button--next");
    const counter = controls.querySelector(".mn-mely-pager__counter");
    const title = controls.querySelector(".mn-mely-pager__title");
    if (previous) previous.disabled = true;
    if (counter && !counter.textContent) counter.setText("01 / --");
    if (title && !title.textContent) title.setText("CHARACTER FILE");
    this.linkMelyChapterStrip(cover, sourcePath);
    // 렉 줄이기: 표지를 보는 동안 쉬는 틈에 책장을 화면 밖에서 미리 만들어 둠 → NEXT 를 누르면 바로 열림
    // (처음 넘길 때 책장 전체를 그 자리에서 만드느라 0.4초쯤 멈칫했음). 캐릭터 전용 지면만. 실험실 추가 2026-10-28
    const deckData = cover._mnMelyDeckData;
    if (deckData && this.asText(deckData.layout_variant).trim() && !cover._mnPrebuildQueued) {
      cover._mnPrebuildQueued = true;
      const view = cover.ownerDocument.defaultView || window;
      const idle = typeof view.requestIdleCallback === "function"
        ? (fn) => view.requestIdleCallback(fn, { timeout: 1200 })
        : (fn) => setTimeout(fn, 300);
      const prebuild = () => {
        if (!cover.isConnected || cover._mnMelyInlineBook || cover._mnMelyInlineBookPending) return;
        this.createMelyInlineBook(cover, sourcePath, { prebuild: true })
          .catch((error) => console.warn("MN Codex: 책장 미리 만들기 실패", error));
      };
      // 표지가 먼저 그려지게 0.35초 뒤 쉬는 틈에. 그 전에 마우스가 NEXT 에 올라가면 바로
      setTimeout(() => idle(prebuild), 350);
      if (next) next.addEventListener("pointerenter", prebuild, { once: true });
    }
    if (next) {
      next.disabled = false;
      next.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await this.openMelyBookFromCover(cover, sourcePath);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          next.setAttr("aria-label", `Mely book error: ${message}`);
          console.error("MN Illuminated Codex: failed to open Mely book", error);
        }
      };
    }
  }

  async openMelyBookFromCover(cover, sourcePath) {
    const container = this.findMelyDeckContainer(cover);
    const members = this.collectMelySequenceMembers(container, sourcePath);
    const coverIndex = members.indexOf(cover);
    if (coverIndex >= 0) {
      for (let index = coverIndex + 1; index < members.length; index += 1) {
        const candidate = members[index];
        const role = candidate.getAttribute("data-mn-mely-sequence-role");
        if (role === "cover" || role === "boundary") break;
        if (role === "book") {
          this.connectMelyCoverToBook(cover, candidate);
          this.activateMelyBookSequence(cover, candidate, "book");
          return candidate;
        }
      }
    }

    const inlineBook = await this.createMelyInlineBook(cover, sourcePath);
    if (!inlineBook) return null;
    this.connectMelyCoverToBook(cover, inlineBook);
    this.activateMelyBookSequence(cover, inlineBook, "book");
    return inlineBook;
  }

  /** 표지 다음 책장. 만드는 중이면 그걸 기다려 씀(미리 만들기와 NEXT 가 겹쳐도 한 번만 만듦) */
  async createMelyInlineBook(cover, sourcePath, options = {}) {
    if (cover?._mnMelyInlineBookPending) return cover._mnMelyInlineBookPending;
    if (cover?._mnMelyInlineBook?.isConnected) return cover._mnMelyInlineBook;
    const pending = this.buildMelyInlineBook(cover, sourcePath, Boolean(options.prebuild));
    if (cover) cover._mnMelyInlineBookPending = pending;
    try {
      return await pending;
    } finally {
      if (cover && cover._mnMelyInlineBookPending === pending) cover._mnMelyInlineBookPending = null;
    }
  }

  async buildMelyInlineBook(cover, sourcePath, prebuild) {
    const sourceData = cover?._mnMelyDeckData;
    const component = cover?._mnMelyDeckComponent;
    if (!cover?.parentElement || !sourceData || !component) return null;

    const data = {
      ...sourceData,
      layout_mode: "book",
      deck: false,
      auto_paginate: this.asBoolean(sourceData.auto_paginate, true),
      title: sourceData.book_title || sourceData.title,
      _mnCharacterName: sourceData.title, // 관계 틀에서 「나」 이름으로 씀 (책 제목은 이명일 수 있음)
      eyebrow: Object.prototype.hasOwnProperty.call(sourceData, "book_eyebrow")
        ? sourceData.book_eyebrow
        : sourceData.eyebrow,
      subtitle: Object.prototype.hasOwnProperty.call(sourceData, "book_subtitle")
        ? sourceData.book_subtitle
        : sourceData.subtitle,
      badge: Object.prototype.hasOwnProperty.call(sourceData, "book_badge")
        ? sourceData.book_badge
        : sourceData.badge,
      image: Object.prototype.hasOwnProperty.call(sourceData, "book_image")
        ? sourceData.book_image
        : "",
      image_alt: sourceData.book_image_alt || `${this.asText(sourceData.title, "Mely 기록")} 소개 이미지`,
      image_position: this.asText(sourceData.book_image_position || sourceData.image_position, "left"),
      image_focus: this.asText(sourceData.book_image_focus, "center"),
      image_fit: this.asText(sourceData.book_image_fit, "contain"),
      plate_label: this.asText(sourceData.book_plate_label || sourceData.plate_label, "FILE 01 / WING INDEX"),
      image_note: sourceData.book_image_note || sourceData.image_note || sourceData.caption || "",
      book_illustration: sourceData.book_illustration || "",
      book_illustration_alt: sourceData.book_illustration_alt || "",
      book_illustration_caption: sourceData.book_illustration_caption || "",
      book_illustration_position: sourceData.book_illustration_position || "right",
      book_illustration_size: sourceData.book_illustration_size || "medium",
      book_illustration_style: sourceData.book_illustration_style || "ink",
      book_page_style: sourceData.book_page_style || "archive",
      book_page_mode: sourceData.book_page_mode || "leaf",
      book_sections: Array.isArray(sourceData.book_sections) ? sourceData.book_sections : [],
      book_pages: Array.isArray(sourceData.book_pages) ? sourceData.book_pages : [],
      content: sourceData.book_content || sourceData.content || "",
      folio_left: sourceData.folio_left || "01",
      folio_right: sourceData.folio_right || "02",
    };
    delete data.pages;

    const book = cover.ownerDocument.createElement("div");
    book.className = "mn-codex-host mn-codex-host--inline-book";
    book.setAttr("data-mn-mely-sequence-role", "book");
    book.setAttr("data-mn-source-path", this.asText(sourcePath));
    book.setAttr("data-mn-sequence-title", this.asText(data.title, "Mely 기록"));
    // 지면 이름표는 쪽을 나누기 전에 (나중에 붙이면 나누는 동안 다른 지면용 오른쪽 여백 · 높이 규칙으로 좁게 나뉘었음). 2026-10-28
    const earlyVariant = this.asText(sourceData.layout_variant).trim().toLowerCase();
    if (/^[a-z0-9-]{1,40}$/u.test(earlyVariant)) book.classList.add(`mn-codex-host--variant-${earlyVariant}`);
    // 미리 만들기: 표지와 같은 폭으로 화면 밖에서 그려 쪽을 나누고, 다 되면 숨겨 둠 (NEXT 를 누르면 바로 보임)
    if (prebuild) {
      book.classList.add("mn-codex-host--prebuilding");
      book.style.cssText = `position:fixed;left:-30000px;top:0;width:${Math.round(cover.getBoundingClientRect().width)}px;visibility:hidden;pointer-events:none;`;
    }
    cover.insertAdjacentElement("afterend", book);
    cover._mnMelyInlineBook = book;

    try {
      await this.renderCodex(data, book, sourcePath, component);
      // layout_variant · brand 를 책장에도 (표지만 캐릭터 전용이고 책장이 MELY 로 남지 않게). 실험실 추가 2026-10-27
      const bookRoot = book.querySelector(":scope > .mn-codex");
      const variant = this.asText(sourceData.layout_variant).trim().toLowerCase();
      if (bookRoot && /^[a-z0-9-]{1,40}$/u.test(variant)) {
        bookRoot.classList.add(`mn-codex--variant-${variant}`);
        book.classList.add(`mn-codex-host--variant-${variant}`);
        this.applyVariantLook(bookRoot, sourceData, sourcePath);
        this.applyVariantLook(book, sourceData, sourcePath);
      }
      const brand = this.asText(sourceData.brand || sourceData.archive_brand).trim().toUpperCase();
      if (bookRoot && brand) bookRoot.setAttr("data-mn-brand", brand);
      if (prebuild) {
        book.style.cssText = "";
        book.classList.remove("mn-codex-host--prebuilding");
        if (!book.classList.contains("is-active")) this.parkMelyBook(cover, book, true);
      }
    } catch (error) {
      cover._mnMelyInlineBook = null;
      book.remove();
      cover.hidden = false;
      throw error;
    }

    if (typeof component.register === "function") {
      component.register(() => {
        if (cover._mnMelyInlineBook === book) cover._mnMelyInlineBook = null;
        book.remove();
      });
    }
    return book;
  }

  connectMelyCoverToBook(cover, book) {
    const state = this.getMelySequenceState(cover, book);
    const coverRoot = cover.querySelector(":scope > .mn-codex");
    const bookRoot = book.querySelector(":scope > .mn-codex");
    if (!coverRoot || !bookRoot) return;

    cover.classList.add("mn-codex-host--sequence-page");
    book.classList.add("mn-codex-host--sequence-page");
    coverRoot.classList.add("mn-codex--mely-sequence-cover");
    coverRoot.setAttr("tabindex", "0");

    const showCover = () => this.activateMelyBookSequence(cover, book, "cover");
    bookRoot._mnBookBeforeFirst = showCover;
    bookRoot._mnBookStatusOffset = 1;
    bookRoot._mnBookController?.setBeforeFirst(showCover);
    bookRoot._mnBookController?.setStatusOffset(1);

    let controls = coverRoot.querySelector(":scope > .mn-mely-sequence-pager");
    if (!controls) controls = this.createMelySequenceControls(coverRoot);
    const previous = controls.querySelector(".mn-mely-pager__button--previous");
    const next = controls.querySelector(".mn-mely-pager__button--next");
    const counter = controls.querySelector(".mn-mely-pager__counter");
    const title = controls.querySelector(".mn-mely-pager__title");
    const bookSteps = bookRoot._mnBookController?.totalSteps() || 1;
    if (previous) previous.disabled = true;
    if (next) {
      next.disabled = false;
      next.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.activateMelyBookSequence(cover, book, "book");
      };
    }
    if (counter) counter.setText(`01 / ${String(bookSteps + 1).padStart(2, "0")}`);
    this.linkMelyChapterStrip(cover, book.getAttribute("data-mn-source-path") || "");
    if (title) title.setText(book.getAttribute("data-mn-sequence-title") || "CHARACTER FILE");
    coverRoot.onkeydown = (event) => {
      if (event.target && event.target.closest && event.target.closest("a, button, input, textarea, select")) return;
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        this.activateMelyBookSequence(cover, book, "book");
      }
    };

    const showingBook = state.page === "book";
    cover.hidden = showingBook;
    if (showingBook) {
      this.parkMelyBook(cover, book, false);
      book.hidden = false;
    } else {
      this.parkMelyBook(cover, book, true);
    }
    cover.classList.toggle("is-active", !showingBook);
    book.classList.toggle("is-active", showingBook);
  }

  /** 렉 줄이기: 표지를 보는 동안 책장은 숨기지 않고 표지 바로 밑에 거의 투명하게(0.4%) 깔아 둠 — 브라우저가 미리 그려 둬서
   *  NEXT 를 누른 순간 큰 그림을 그리느라 멈칫하지 않음 (눈에 안 보이고 누를 수도 없음). 실험실 추가 2026-10-28 */
  parkMelyBook(cover, book, parked) {
    if (!cover || !book) return;
    if (parked) {
      if (book.parentElement) book.parentElement.classList.add("mn-codex-park-parent");
      book.classList.add("mn-codex-host--parked");
      book.style.top = `${cover.offsetTop}px`;
      book.hidden = false;
    } else if (book.classList.contains("mn-codex-host--parked")) {
      book.classList.remove("mn-codex-host--parked");
      book.style.top = "";
    }
  }

  /** 표지 아래 띠를 책장 아래 장 띠와 같은 칸으로: 「00 표지 · 01 개요 · 02 능력 …」(책장 장 제목 그대로), 누르면 책장의 그 장으로.
   *  책장은 처음 넘길 때 만들어지니 표지에 실린 장 목록(book_sections)으로 그림. 캐릭터 전용 지면만. 실험실 추가 2026-10-27 */
  linkMelyChapterStrip(cover, sourcePath) {
    const data = cover?._mnMelyDeckData;
    const root = cover?.querySelector(":scope > .mn-codex");
    const nav = root?.querySelector(".mn-mely-showcase__navigation");
    if (!data || !nav || nav.classList.contains("mn-mely-showcase__navigation--chapters")) return;
    if (!this.asText(data.layout_variant).trim()) return;
    const plain = (text) => this.asText(text).replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/gu, (_m, target, alias) => alias || target).trim();
    const titles = (Array.isArray(data.book_sections) ? data.book_sections : [])
      .filter((section) => section && typeof section === "object" && section.tag !== false && section.page_tag !== false)
      .map((section) => plain(section.title))
      .filter(Boolean);
    if (!titles.length) return;
    nav.textContent = "";
    nav.classList.add("mn-mely-showcase__navigation--chapters");
    nav.setAttr("aria-label", "장 바로가기");
    nav.style.setProperty("--mn-strip-count", String(Math.max(5, titles.length + 1)));
    // 칸이 5개보다 많으면 바탕 그림의 칸 구분선(5칸 기준)과 어긋나서 구분선을 따로 그림(styles.css 「장이 많은 띠」)
    nav.setAttr("data-mn-strip-many", titles.length + 1 > 5 ? "true" : null);
    const cell = (index, label, onClick) => {
      const button = nav.createEl("button", {
        cls: "mn-mely-showcase__chapter",
        attr: { type: "button", title: onClick ? `${label} 장으로` : label },
      });
      button.createSpan({ cls: "mn-mely-showcase__chapter-index", text: index });
      button.createSpan({ cls: "mn-mely-showcase__chapter-label", text: label });
      if (!onClick) {
        button.classList.add("is-active");
        button.setAttr("aria-current", "page");
        return;
      }
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const book = await this.openMelyBookFromCover(cover, sourcePath);
          // 책장은 폭이 바뀌면 다시 그려지니, 누를 때 지금 있는 장 단추를 찾아 누름
          const tag = book && book.querySelectorAll(":scope > .mn-codex > .mn-codex__page-tags > .mn-codex__page-tag:not(.mn-codex__page-tag--cover)")[onClick.at];
          if (tag) tag.click();
        } catch (error) {
          console.error("MN Illuminated Codex: failed to open chapter from cover", error);
        }
      });
    };
    cell("00", "표지", null);
    titles.forEach((title, at) => cell(String(at + 1).padStart(2, "0"), title, { at }));
  }

  createMelySequenceControls(root) {
    const controls = root.createDiv({ cls: "mn-mely-pager mn-mely-sequence-pager" });
    const previous = controls.createEl("button", {
      cls: "mn-mely-pager__button mn-mely-pager__button--previous",
      attr: { type: "button", "aria-label": "표지 이전" },
    });
    previous.createSpan({ text: "PREV" });
    previous.disabled = true;
    const status = controls.createDiv({ cls: "mn-mely-pager__status" });
    status.createSpan({ cls: "mn-mely-pager__counter" });
    status.createSpan({ cls: "mn-mely-pager__title" });
    const next = controls.createEl("button", {
      cls: "mn-mely-pager__button mn-mely-pager__button--next",
      attr: { type: "button", "aria-label": "캐릭터 소개 페이지 열기" },
    });
    next.createSpan({ text: "NEXT" });

    return controls;
  }

  activateMelyBookSequence(cover, book, page) {
    if (!cover?.isConnected || !book?.isConnected) return;
    const state = this.getMelySequenceState(cover, book);
    state.page = page === "book" ? "book" : "cover";
    const showingBook = state.page === "book";
    cover.hidden = showingBook;
    if (showingBook) {
      this.parkMelyBook(cover, book, false);
      book.hidden = false;
    } else {
      this.parkMelyBook(cover, book, true);
    }
    cover.classList.toggle("is-active", !showingBook);
    book.classList.toggle("is-active", showingBook);

    const targetRoot = (showingBook ? book : cover).querySelector(":scope > .mn-codex");
    if (showingBook) {
      targetRoot?._mnBookController?.activate(0);
      targetRoot?.classList.remove("mn-codex--sequence-enter-forward");
      void targetRoot?.offsetWidth;
      targetRoot?.classList.add("mn-codex--sequence-enter-forward");
    } else {
      targetRoot?.classList.remove("mn-codex--sequence-enter-backward");
      void targetRoot?.offsetWidth;
      targetRoot?.classList.add("mn-codex--sequence-enter-backward");
    }
    targetRoot?.focus({ preventScroll: true });
  }

  async renderSpread(data, root, sourcePath, component) {
    const layoutInput = this.asText(data.layout_mode, "flow").toLowerCase();
    const layoutMode = LAYOUT_MODES.has(layoutInput) ? layoutInput : "flow";
    root.addClass(`mn-codex--layout-${layoutMode}`);
    root.setAttr("data-mn-layout", layoutMode);

    if (MELY_SHOWCASE_LAYOUTS.has(layoutMode)) {
      await this.renderMelyShowcase(data, root, sourcePath, component, layoutMode);
      return;
    }

    if (layoutMode === "book") {
      await this.renderPaginatedSpread(data, root, sourcePath, component);
      return;
    }

    await this.renderFlowSpread(data, root, sourcePath, component);
  }

  async renderFlowSpread(data, root, sourcePath, component) {
    const positionInput = this.asText(data.image_position, "left").toLowerCase();
    const position = IMAGE_POSITIONS.has(positionInput) ? positionInput : "left";
    root.addClass(`mn-codex--image-${position}`);
    const book = root.createDiv({ cls: "mn-codex__book" });
    book.setAttr("aria-label", this.asText(data.title, "펼친 설정집"));
    const leftPage = book.createEl("section", {
      cls: "mn-codex__page mn-codex__page--left",
    });
    const leftFrame = leftPage.createDiv({ cls: "mn-codex__page-frame" });
    const gutter = book.createDiv({ cls: "mn-codex__gutter" });
    gutter.setAttr("aria-hidden", "true");
    const rightPage = book.createEl("section", {
      cls: "mn-codex__page mn-codex__page--right",
    });
    const rightFrame = rightPage.createDiv({ cls: "mn-codex__page-frame" });

    const imageFrame = position === "left" ? leftFrame : rightFrame;
    const copyFrame = position === "left" ? rightFrame : leftFrame;
    imageFrame.addClass("mn-codex__page-frame--image");
    copyFrame.addClass("mn-codex__page-frame--copy");

    await this.createFigure(data, imageFrame, sourcePath, component, "book");
    if (data.image_note) {
      const note = imageFrame.createDiv({ cls: "mn-codex__image-note" });
      await this.renderMarkdown(data.image_note, note, sourcePath, component);
    }

    const copy = copyFrame.createDiv({ cls: "mn-codex__copy" });
    this.createHeading(data, copy);
    if (data.content) {
      const body = copy.createDiv({ cls: "mn-codex__prose" });
      await this.renderMarkdown(data.content, body, sourcePath, component);
    }

    this.createFolio(leftFrame, data.folio_left, "left");
    this.createFolio(rightFrame, data.folio_right, "right");
  }

  async renderMelyShowcase(data, root, sourcePath, component, layoutMode) {
    root.addClass("mn-codex--mely-showcase");
    const pages = this.normalizeShowcasePages(data);
    if (pages.length > 1) {
      await this.renderMelyShowcasePager(pages, root, sourcePath, component, layoutMode);
      return;
    }
    await this.renderMelyShowcasePage(pages[0], root, sourcePath, component, layoutMode);
  }

  normalizeShowcasePages(data) {
    const base = { ...data };
    delete base.pages;
    const extras = Array.isArray(data.pages)
      ? data.pages.filter((page) => page && typeof page === "object" && !Array.isArray(page))
      : [];
    return [base, ...extras.map((page) => ({ ...base, ...page }))];
  }

  async renderMelyShowcasePager(pages, root, sourcePath, component, layoutMode) {
    root.addClass("mn-codex--mely-paged");
    root.setAttr("tabindex", "0");

    const stage = root.createDiv({
      cls: "mn-mely-pager__stage",
      attr: { "aria-live": "polite", "aria-atomic": "true" },
    });
    const controls = root.createDiv({ cls: "mn-mely-pager" });
    const previous = controls.createEl("button", {
      cls: "mn-mely-pager__button mn-mely-pager__button--previous",
      attr: { type: "button", "aria-label": "이전 캐릭터 기록" },
    });
    previous.createSpan({ text: "PREV" });
    const status = controls.createDiv({ cls: "mn-mely-pager__status" });
    const counter = status.createSpan({ cls: "mn-mely-pager__counter" });
    const pageTitle = status.createSpan({ cls: "mn-mely-pager__title" });
    const next = controls.createEl("button", {
      cls: "mn-mely-pager__button mn-mely-pager__button--next",
      attr: { type: "button", "aria-label": "다음 캐릭터 기록" },
    });
    next.createSpan({ text: "NEXT" });

    let pageIndex = 0;
    let busy = false;
    const updateControls = () => {
      previous.disabled = busy || pageIndex === 0;
      next.disabled = busy || pageIndex >= pages.length - 1;
      counter.setText(`${String(pageIndex + 1).padStart(2, "0")} / ${String(pages.length).padStart(2, "0")}`);
      pageTitle.setText(this.asText(pages[pageIndex].title, `PAGE ${pageIndex + 1}`));
      root.setAttr("aria-label", `${pageTitle.textContent} · ${pageIndex + 1}/${pages.length}`);
    };

    const activate = async (nextIndex) => {
      const bounded = Math.max(0, Math.min(nextIndex, pages.length - 1));
      if (busy || (bounded === pageIndex && stage.childElementCount)) return;
      const direction = bounded >= pageIndex ? "forward" : "backward";
      pageIndex = bounded;
      busy = true;
      updateControls();
      stage.setAttr("data-direction", direction);
      stage.empty();
      await this.renderMelyShowcasePage(pages[pageIndex], stage, sourcePath, component, layoutMode);
      const rendered = stage.querySelector(".mn-mely-showcase");
      if (rendered) rendered.classList.add("mn-mely-showcase--page-enter");
      busy = false;
      updateControls();
    };

    component.registerDomEvent(previous, "click", () => activate(pageIndex - 1));
    component.registerDomEvent(next, "click", () => activate(pageIndex + 1));
    component.registerDomEvent(root, "keydown", (event) => {
      if (event.target && event.target.closest && event.target.closest("a, button, input, textarea, select")) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        activate(pageIndex - 1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        activate(pageIndex + 1);
      }
    });

    updateControls();
    await activate(0);
  }

  async renderMelyShowcasePage(data, root, sourcePath, component, layoutMode) {
    const scene = root.createEl("section", {
      cls: `mn-mely-showcase mn-mely-showcase--${layoutMode}`,
    });
    const showcaseTitle = this.asText(data.title, "Mely 관측 기록").trim();
    const eyebrowText = this.asText(data.eyebrow).trim();
    const inferredBrand = eyebrowText.split(/\s*(?:\/|·|\||—)\s*/u)[0].trim();
    // 캐릭터 전용 지면은 brand 를 안 적으면 다른 인물 이름(MELY)을 빌리지 않고 비워 둠. 실험실 추가 2026-10-28
    const showcaseBrand = this.asText(data.brand || data.archive_brand, inferredBrand || (this.asText(data.layout_variant).trim() ? "" : "MELY"))
      .trim()
      .toUpperCase();
    const brandPrefix = showcaseBrand ? `${showcaseBrand} / ` : "";
    scene.setAttr("data-mn-brand", showcaseBrand);
    const visualDataTextSize = this.asText(data.visual_data_text_size).trim();
    if (/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|cqi|%)$/iu.test(visualDataTextSize)) {
      scene.style.setProperty("--mn-visual-data-text-size", visualDataTextSize);
    }
    scene.setAttr("aria-label", showcaseTitle);
    // layout_variant: 같은 배치(layout_mode) 위에 캐릭터 전용 바탕 · 색을 입힘 (예: silver-knight = 리냐). 실험실 추가 2026-10-27
    const layoutVariant = this.asText(data.layout_variant).trim().toLowerCase();
    if (/^[a-z0-9-]{1,40}$/u.test(layoutVariant)) {
      scene.addClass(`mn-mely-showcase--variant-${layoutVariant}`);
      this.applyVariantLook(scene, data, sourcePath);
      const codexRoot = typeof scene.closest === "function" ? scene.closest(".mn-codex") : null;
      if (codexRoot) {
        codexRoot.classList.add(`mn-codex--variant-${layoutVariant}`);
        this.applyVariantLook(codexRoot, data, sourcePath);
      }
    }
    if (layoutMode === "ribbon-slash" && showcaseTitle && !/\s/u.test(showcaseTitle)) {
      scene.addClass("mn-mely-showcase--single-title");
      const titleLength = Array.from(showcaseTitle).length;
      scene.addClass(`mn-mely-showcase--single-title-${titleLength <= 3 ? "short" : titleLength <= 5 ? "medium" : "long"}`);
    }

    const decoration = scene.createDiv({ cls: "mn-mely-showcase__decoration" });
    for (let index = 0; index < 4; index += 1) {
      decoration.createSpan({ cls: `mn-mely-showcase__shape mn-mely-showcase__shape--${index + 1}` });
    }
    if (layoutMode === "ribbon-slash") {
      const wordmark = scene.createDiv({ cls: "mn-mely-showcase__ghost", attr: { "aria-hidden": "true" } });
      const wordmarkSrc = this.resolveImage("plugin:mely-ribbon-wordmark-v4.png", sourcePath);
      if (wordmarkSrc) {
        wordmark.createEl("img", {
          cls: "mn-mely-showcase__ghost-image",
          attr: { src: wordmarkSrc, alt: "", draggable: "false" },
        });
      }
      const brandSubtitleSrc = this.resolveImage("plugin:mely-ribbon-subtitle-v2.png", sourcePath);
      if (brandSubtitleSrc) {
        scene.createEl("img", {
          cls: "mn-mely-showcase__brand-subtitle",
          attr: { src: brandSubtitleSrc, alt: "", "aria-hidden": "true", draggable: "false" },
        });
      }
    } else {
      if (showcaseBrand) scene.createDiv({ cls: "mn-mely-showcase__ghost", text: showcaseBrand });
    }

    const indexRail = scene.createDiv({ cls: "mn-mely-showcase__index" });
    indexRail.createSpan({ text: this.asText(data.plate_label, `${brandPrefix}ARCHIVE`) });
    indexRail.createSpan({ text: "OBSERVATION RECORD" });

    const utility = scene.createDiv({ cls: "mn-mely-showcase__utility" });
    utility.createSpan({ cls: "mn-mely-showcase__utility-kicker", text: `${brandPrefix}SUBJECT DATA` });
    utility.createSpan({ cls: "mn-mely-showcase__barcode", attr: { "aria-hidden": "true" } });
    utility.createSpan({ cls: "mn-mely-showcase__utility-code", text: this.asText(data.caption, "VISUAL IDENTIFICATION · VERIFIED") });

    const folio = scene.createDiv({ cls: "mn-mely-showcase__folio" });
    folio.createSpan({ text: this.asText(data.folio_left, this.extractArchiveNumber(data.plate_label)) });
    folio.createEl("small", { text: "/ FILE" });

    const visual = scene.createDiv({ cls: "mn-mely-showcase__visual" });
    const primary = visual.createEl("figure", { cls: "mn-mely-showcase__primary" });
    const primaryArt = primary.createDiv({ cls: "mn-mely-showcase__primary-art" });
    this.decorateShowcaseArt(primaryArt, data);
    const imageRef = this.asText(data.image);
    const src = this.resolveImage(imageRef, sourcePath);
    if (src) {
      this.createShowcaseImage(src, data, primaryArt, component, "mn-mely-showcase__primary-image");
    } else {
      scene.addClass("mn-mely-showcase--image-missing");
      this.createImagePlaceholder(primaryArt, imageRef);
    }
    if (data.caption) {
      primary.createEl("figcaption", { text: this.asText(data.caption) });
    }

    const details = visual.createDiv({ cls: "mn-mely-showcase__details" });
    const detailCount = layoutMode === "portrait-echo" ? 4 : 3;
    for (let index = 0; index < detailCount; index += 1) {
      const detail = details.createDiv({
        cls: `mn-mely-showcase__detail mn-mely-showcase__detail--${index + 1}`,
      });
      const detailImageRef = this.listValue(data.detail_images, index);
      const detailSrc = detailImageRef ? this.resolveImage(this.asText(detailImageRef), sourcePath) : src;
      if (detailSrc) {
        const detailImage = this.createShowcaseImage(detailSrc, data, detail, component, "mn-mely-showcase__detail-image");
        this.decorateShowcaseDetail(detailImage, data, index, layoutMode);
      }
      detail.createSpan({ text: String(index + 1).padStart(2, "0") });
    }

    const identity = scene.createDiv({ cls: "mn-mely-showcase__identity" });
    this.createHeading(data, identity);

    const dossier = scene.createEl("article", { cls: "mn-mely-showcase__dossier" });
    const dossierLabel = dossier.createDiv({ cls: "mn-mely-showcase__dossier-label" });
    dossierLabel.createSpan({ text: "VISUAL DATA" });
    dossierLabel.createSpan({ text: "VERIFIED / ACTIVE" });
    if (data.content) {
      const prose = dossier.createDiv({ cls: "mn-mely-showcase__prose mn-codex__prose" });
      await this.renderMarkdown(data.content, prose, sourcePath, component);
    }

    const metadata = scene.createDiv({ cls: "mn-mely-showcase__metadata" });
    await this.createFacts(data.facts, metadata, sourcePath, component);

    const navigation = scene.createEl("nav", {
      cls: "mn-mely-showcase__navigation",
      attr: { "aria-label": `${showcaseBrand} archive sections` },
    });
    ["OVERVIEW", "RECORD", "ANALYSIS", "LOGS", "ARCHIVE", "DATA MAP", "SETTINGS"].forEach((label, index) => {
      const item = navigation.createSpan({ cls: index === 0 ? "is-active" : "" });
      item.createSpan({ text: String(index + 1).padStart(2, "0") });
      item.createSpan({ text: label });
    });
  }

  extractArchiveNumber(value) {
    const match = this.asText(value).match(/\b(\d{1,3})\b/);
    return match ? match[1].padStart(2, "0") : "01";
  }

  decorateShowcaseArt(parent, data) {
    const focusInput = this.asText(data.image_focus, "center").toLowerCase();
    const focus = IMAGE_FOCUS.has(focusInput) ? focusInput : "center";
    const fitInput = this.asText(data.image_fit, "contain").toLowerCase();
    const fit = IMAGE_FITS.has(fitInput) ? fitInput : "contain";
    parent.addClass(`mn-mely-showcase__primary-art--focus-${focus}`);
    parent.addClass(`mn-mely-showcase__primary-art--fit-${fit}`);
  }

  listValue(value, index) {
    if (Array.isArray(value)) return value[index];
    return value;
  }

  normalizeDetailFocus(value, fallback) {
    const raw = this.asText(value, fallback).trim().toLowerCase();
    const keyword = {
      top: "50% 12%",
      center: "50% 50%",
      bottom: "50% 88%",
    }[raw];
    if (keyword) return keyword;
    const match = raw.match(/^(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/);
    if (!match) return fallback;
    const x = Math.max(0, Math.min(Number(match[1]), 100));
    const y = Math.max(0, Math.min(Number(match[2]), 100));
    return `${x}% ${y}%`;
  }

  decorateShowcaseDetail(image, data, index, layoutMode) {
    const blackTideFocus = ["50% 18%", "50% 50%", "50% 82%"]; 
    const configuredFocus = this.listValue(data.detail_focus, index);
    const fallbackFocus = layoutMode === "black-tide" ? blackTideFocus[index] : "50% 50%";
    const focus = this.normalizeDetailFocus(configuredFocus, fallbackFocus);
    const configuredScale = Number(this.listValue(data.detail_scale, index));
    const fallbackScale = layoutMode === "black-tide" ? 2.05 : NaN;
    const scale = Number.isFinite(configuredScale)
      ? Math.max(1, Math.min(configuredScale, 4))
      : fallbackScale;

    if (configuredFocus !== undefined || layoutMode === "black-tide") {
      image.style.objectPosition = focus;
      image.style.transformOrigin = focus;
    }
    if (Number.isFinite(scale)) {
      image.style.transform = `scale(${scale})`;
    }
  }

  createShowcaseImage(src, data, parent, component, className) {
    const img = parent.createEl("img", {
      cls: className,
      attr: {
        alt: this.asText(data.image_alt, data.title || "Mely 관측 이미지"),
        loading: "lazy",
        src,
      },
    });
    component.registerDomEvent(img, "error", () => img.remove());
    return img;
  }

  /** 캐릭터 전용 지면(전체 화면 노트의 표지 · 책장)은 노트 칸에 맞는 폭으로: 폭 = min(칸 폭, 칸 높이 × 표지 비율 1.5).
   *  지면 높이가 폭에 비례해서, 왼쪽 패널을 닫으면 지면이 화면 높이를 넘어 아래가 잘렸고 여닫을 때마다 크기 · 쪽 나누기가 달라졌음.
   *  이제 칸 높이가 그대로면 패널을 여닫아도 지면 크기가 같아 다시 그리지 않음. 폭은 --mn-fit-w 로 (mn-codex-fullpage.css). 2026-10-29 */
  fitCodexPane(sourcePath) {
    if (typeof ResizeObserver === "undefined") return;
    this.fitPanes = this.fitPanes || new WeakMap();
    const leaves = this.app.workspace.getLeavesOfType("markdown").filter((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === sourcePath);
    for (const leaf of leaves) {
      const pane = leaf.view.contentEl;
      if (!pane) continue;
      if (this.fitPanes.has(pane)) { this.fitPanes.get(pane)(); continue; }
      const update = () => {
        const w = pane.clientWidth, h = pane.clientHeight;
        if (!w || !h) return;
        // 아래 26px 는 옵시디언 상태 표시줄 자리(지면 아래 장 띠를 덮지 않게).
        // 칸이 아주 낮으면(창을 낮게 줄임) 900px 아래로는 줄이지 않음 — 한 쪽 보기 판(760px 이하)으로 넘어가지 않게
        const fit = Math.round(Math.min(w, Math.max((h - 26) * 1.5, Math.min(w, 900))));
        if (pane.style.getPropertyValue("--mn-fit-w") !== `${fit}px`) pane.style.setProperty("--mn-fit-w", `${fit}px`);
      };
      update();
      let frame = 0;
      const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); });
      observer.observe(pane);
      this.fitPanes.set(pane, update);
      this.register(() => { observer.disconnect(); pane.style.removeProperty("--mn-fit-w"); });
    }
  }

  async renderPaginatedSpread(data, root, sourcePath, component) {
    const positionInput = this.asText(data.image_position, "left").toLowerCase();
    const position = IMAGE_POSITIONS.has(positionInput) ? positionInput : "left";
    root.addClass(`mn-codex--image-${position}`);
    root.setAttr("tabindex", "0");

    let disposed = false;
    let building = false;
    let rebuildQueued = false;
    let controlsCleanup = () => {};
    let renderScopeCleanup = () => {};

    const build = async () => {
      if (disposed) return;
      if (building) {
        rebuildQueued = true;
        return;
      }
      building = true;
      rebuildQueued = false;
      // 다시 그릴 때(폭이 바뀜 등): 보던 쪽을 기억했다가 그 쪽으로 돌아가고, 첫 장 도착 효과는 다시 틀지 않고,
      // 그리는 동안 높이를 붙잡아 화면이 비거나 출렁이지 않게. (왼쪽 패널을 여닫으면 첫 장으로 돌아가 효과가 다시 나왔음) 2026-10-29
      const previous = root._mnBookController;
      const anchor = previous && previous.anchor ? previous.anchor() : null;
      if (anchor) root.style.minHeight = `${root.offsetHeight}px`;
      root._mnBookQuietStart = Boolean(anchor);
      controlsCleanup();
      renderScopeCleanup();
      root.empty();
      const renderScope = this.createRenderScope(component);
      renderScopeCleanup = renderScope.dispose;
      try {
        const controller = await this.buildPaginatedSpread(data, root, sourcePath, renderScope.component, position);
        if (disposed) {
          controller.cleanup();
          renderScope.dispose();
          return;
        }
        root._mnBookController = controller;
        controlsCleanup = controller.cleanup;
        controller.setBeforeFirst(root._mnBookBeforeFirst || null);
        controller.setStatusOffset(root._mnBookStatusOffset || 0);
        if (anchor && controller.restore) controller.restore(anchor);
      } catch (error) {
        renderScopeCleanup();
        renderScopeCleanup = () => {};
        throw error;
      } finally {
        building = false;
        root._mnBookQuietStart = false;
        root.style.minHeight = "";
      }
      if (rebuildQueued && !disposed) {
        await build();
      }
    };

    await build();

    let lastWidth = Math.round(root.getBoundingClientRect ? root.getBoundingClientRect().width : 0);
    let resizeTimer = 0;
    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) => {
        const width = Math.round(entries[0] && entries[0].contentRect
          ? entries[0].contentRect.width
          : 0);
        if (!width) return;
        if (!lastWidth) {
          lastWidth = width;
          return;
        }
        if (Math.abs(width - lastWidth) < 24) return;
        lastWidth = width;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => build(), 120);
      });
      observer.observe(root);
    }

    if (typeof component.register === "function") {
      component.register(() => {
        disposed = true;
        clearTimeout(resizeTimer);
        controlsCleanup();
        renderScopeCleanup();
        root._mnBookController = null;
        if (observer) observer.disconnect();
      });
    }
  }

  normalizeBookPages(data) {
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const normalizePageMode = (value, fallback = "leaf") => {
      const input = this.asText(value, fallback).trim().toLowerCase();
      return ["spread", "full", "double", "wide", "전체"].includes(input) ? "spread" : "leaf";
    };
    const defaultPageMode = normalizePageMode(data.book_page_mode, "leaf");
    const normalizePage = (entry, index, meta = {}) => {
      const page = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : { content: entry };
      const fallbackTitle = meta.fallbackTitle || (index === 0
        ? this.asText(data.title, "CHARACTER FILE")
        : `${this.asText(data.title, "CHARACTER FILE")} · ${String(index + 1).padStart(2, "0")}`);
      const illustration = hasOwn(page, "illustration")
        ? page.illustration
        : hasOwn(page, "book_illustration")
          ? page.book_illustration
          : index === 0
            ? data.book_illustration
            : "";
      const tagValue = hasOwn(page, "tag")
        ? page.tag
        : hasOwn(page, "page_tag")
          ? page.page_tag
          : meta.kind === "section"
            ? true
            : false;
      const rawPageImages = hasOwn(page, "page_images")
        ? page.page_images
        : hasOwn(page, "placed_images")
          ? page.placed_images
          : [];
      const persistedKey = `${this.asText(data._mnSourcePath)}::${meta.kind || "page"}::${Number.isInteger(meta.sectionIndex) ? meta.sectionIndex : -1}::${Number.isInteger(meta.entryIndex) ? meta.entryIndex : -1}`;
      const persistedImages = Array.isArray(this.pageImageLayouts?.[persistedKey])
        ? this.pageImageLayouts[persistedKey]
        : null;

      return {
        ...data,
        title: this.asText(page.title, fallbackTitle),
        eyebrow: hasOwn(page, "eyebrow") ? page.eyebrow : data.eyebrow,
        subtitle: hasOwn(page, "subtitle")
          ? page.subtitle
          : meta.inheritSubtitle
            ? data.subtitle
            : "",
        badge: hasOwn(page, "badge") ? page.badge : "",
        book_illustration: illustration,
        book_illustration_alt: page.illustration_alt || page.book_illustration_alt || "",
        book_illustration_caption: page.illustration_caption || page.book_illustration_caption || "",
        book_illustration_position: page.illustration_position || page.book_illustration_position || data.book_illustration_position || "right",
        book_illustration_size: page.illustration_size || page.book_illustration_size || data.book_illustration_size || "medium",
        book_illustration_style: page.illustration_style || page.book_illustration_style || data.book_illustration_style || "ink",
        stickers: hasOwn(page, "stickers")
          ? page.stickers
          : hasOwn(page, "book_stickers")
            ? page.book_stickers
            : index === 0
              ? data.book_stickers || []
              : [],
        page_images: persistedImages || (Array.isArray(rawPageImages)
          ? rawPageImages
          : rawPageImages
            ? [rawPageImages]
            : []),
        _mnBookPersistKey: persistedKey,
        page_mode: normalizePageMode(
          hasOwn(page, "page_mode") ? page.page_mode : hasOwn(page, "book_page_mode") ? page.book_page_mode : defaultPageMode,
          defaultPageMode,
        ),
        page_tag: tagValue,
        page_id: this.asText(page.page_id || page.id || page.slug).trim(),
        text_tone: this.asText(page.text_tone || page.text_color).trim().toLowerCase(),
        text_effect: this.asText(page.text_effect).trim().toLowerCase(),
        content: hasOwn(page, "content") ? page.content : "",
        _mnBookPageKind: meta.kind || "page",
        _mnBookSectionIndex: Number.isInteger(meta.sectionIndex) ? meta.sectionIndex : -1,
        _mnBookSectionTitle: meta.sectionTitle || "",
        _mnBookEntryIndex: Number.isInteger(meta.entryIndex) ? meta.entryIndex : -1,
        // 장마다 고르는 틀(개요 · 능력 · 관계)과 관계 쪽에만 쓰는 칸. 실험실 추가 2026-10-27
        _mnBookTemplate: meta.template || "",
        relation: hasOwn(page, "relation") ? this.asText(page.relation) : "",
        portrait: hasOwn(page, "portrait") ? this.asText(page.portrait) : "",
        visual: hasOwn(page, "visual") ? this.asText(page.visual) : "",
        visual_focus: hasOwn(page, "visual_focus") ? this.asText(page.visual_focus) : "",
        visual_scale: hasOwn(page, "visual_scale") ? Number(page.visual_scale) || 1 : 1,
      };
    };

    const rawSections = Array.isArray(data.book_sections) ? data.book_sections : [];
    if (rawSections.length) {
      const normalized = [];
      rawSections
        .filter((entry) => entry !== undefined && entry !== null)
        .forEach((entry, sectionIndex) => {
          const section = entry && typeof entry === "object" && !Array.isArray(entry)
            ? entry
            : { title: entry };
          const sectionTitle = this.asText(section.title, `SECTION ${String(sectionIndex + 1).padStart(2, "0")}`);
          const template = this.bookTemplateOf(section, data);
          normalized.push(normalizePage(section, normalized.length, {
            kind: "section",
            sectionIndex,
            sectionTitle,
            entryIndex: -1,
            fallbackTitle: sectionTitle,
            inheritSubtitle: sectionIndex === 0,
            template,
          }));

          const entries = Array.isArray(section.pages) ? section.pages : [];
          if (template === "relation") {
            // 관계 틀: 사람마다 쪽을 만들지 않고, 장 첫 쪽(관계도)에서 눌러 그 사람 글을 불러옴
            normalized[normalized.length - 1]._mnRelationPeople = entries
              .filter((page) => page !== undefined && page !== null)
              .map((page, entryIndex) => normalizePage(page, normalized.length, {
                kind: "entry",
                sectionIndex,
                sectionTitle,
                entryIndex,
                fallbackTitle: `${sectionTitle} ${String(entryIndex + 1).padStart(2, "0")}`,
                inheritSubtitle: false,
                template,
              }));
            return;
          }
          entries
            .filter((page) => page !== undefined && page !== null)
            .forEach((page, entryIndex) => {
              normalized.push(normalizePage(page, normalized.length, {
                kind: "entry",
                sectionIndex,
                sectionTitle,
                entryIndex,
                fallbackTitle: `${sectionTitle} ${String(entryIndex + 1).padStart(2, "0")}`,
                inheritSubtitle: false,
                template,
              }));
            });
        });
      return normalized;
    }

    const rawPages = Array.isArray(data.book_pages) ? data.book_pages : [];
    return rawPages
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry, index) => normalizePage(entry, index, {
        kind: "page",
        inheritSubtitle: index === 0,
      }));
  }

  async buildPaginatedSpread(data, root, sourcePath, component, position) {
    const hasImage = Boolean(this.asText(data.image).trim());
    const configuredPages = this.normalizeBookPages(data);
    const hasConfiguredPages = configuredPages.length > 0;
    const hasBookSections = configuredPages.some((page) => page._mnBookPageKind === "section");
    const bookPageMode = this.asText(data.book_page_mode, "leaf").toLowerCase() === "spread" ? "spread" : "leaf";
    const hasMixedPageModes = configuredPages.some((page) => page.page_mode !== bookPageMode);
    const pageStyleInput = this.asText(data.book_page_style, "archive").toLowerCase();
    const pageStyle = pageStyleInput === "parchment" ? "parchment" : "archive";
    root.classList.toggle("mn-codex--book-has-image", hasImage);
    root.classList.toggle("mn-codex--book-text-only", !hasImage);
    root.classList.toggle("mn-codex--book-pages-leaf", bookPageMode === "leaf");
    root.classList.toggle("mn-codex--book-pages-spread", bookPageMode === "spread");
    root.classList.toggle("mn-codex--book-pages-mixed", hasMixedPageModes);
    root.classList.toggle("mn-codex--book-page-archive", pageStyle === "archive");
    root.classList.toggle("mn-codex--book-page-parchment", pageStyle === "parchment");
    root.classList.toggle("mn-codex--book-structured", hasConfiguredPages);
    root.classList.toggle("mn-codex--book-has-sections", hasBookSections);
    const reader = root.createDiv({ cls: "mn-codex__reader" });
    reader.setAttr("aria-label", this.asText(data.title, "넘기는 설정집"));
    // 한 쪽 보기 판: 캐릭터 전용 지면이 좁으면(760px 이하, 옵시디언에 옆 막대를 연 창 등) 쪽 나누기부터 한 쪽 크기로 하고,
    // 리더를 두 배 폭 크기 기준(컨테이너)으로 잡아 한 쪽 안의 글자 · 여백 비율을 넓은 화면의 한 쪽과 같게. 실험실 추가 2026-10-28
    const singleEdition = Boolean(this.asText(data.layout_variant).trim()) && root.getBoundingClientRect().width <= 760;
    root.classList.toggle("mn-codex--single-edition", singleEdition);
    if (singleEdition) reader.classList.add("mn-codex__reader--single", "mn-codex__reader--flowing");
    const track = reader.createDiv({ cls: "mn-codex__book-track" });
    const spreads = [];
    const contentPageQueue = [];
    const sectionDestinations = [];
    const pageDestinations = [];
    const placedPageImages = [];

    const createSpread = (continuation = false) => {
      const book = track.createDiv({
        cls: `mn-codex__book mn-codex__book--turn${continuation ? " mn-codex__book--continuation" : ""}`,
      });
      const leftPage = book.createEl("section", {
        cls: "mn-codex__page mn-codex__page--left",
      });
      const leftFrame = leftPage.createDiv({ cls: "mn-codex__page-frame" });
      const gutter = book.createDiv({ cls: "mn-codex__gutter" });
      gutter.setAttr("aria-hidden", "true");
      const rightPage = book.createEl("section", {
        cls: "mn-codex__page mn-codex__page--right",
      });
      const rightFrame = rightPage.createDiv({ cls: "mn-codex__page-frame" });
      const spread = { book, leftPage, leftFrame, rightPage, rightFrame };
      spreads.push(spread);
      return spread;
    };

    const first = createSpread(false);
    const imageFrame = hasImage
      ? (position === "left" ? first.leftFrame : first.rightFrame)
      : null;
    const copyFrame = hasImage
      ? (position === "left" ? first.rightFrame : first.leftFrame)
      : first.leftFrame;
    const secondCopyFrame = hasImage ? null : first.rightFrame;
    if (imageFrame) imageFrame.addClass("mn-codex__page-frame--image");
    copyFrame.addClass("mn-codex__page-frame--copy");
    if (secondCopyFrame) secondCopyFrame.addClass("mn-codex__page-frame--copy");

    if (imageFrame) {
      await this.createFigure(data, imageFrame, sourcePath, component, "book");
      if (data.image_note) {
        const note = imageFrame.createDiv({ cls: "mn-codex__image-note" });
        await this.renderMarkdown(data.image_note, note, sourcePath, component);
      }
    }

    const prepareBookHeading = (pageData, parent, pageIndex) => {
      const heading = this.createHeading(pageData, parent);
      heading.addClass("mn-codex__heading--book-page");
      heading.setAttr("data-mn-book-page-index", String(pageIndex));
      if (pageData._mnBookPageKind) {
        heading.addClass(`mn-codex__heading--book-${pageData._mnBookPageKind}`);
      }
      if (pageData._mnBookSectionIndex >= 0) {
        heading.setAttr("data-mn-book-section-index", String(pageData._mnBookSectionIndex));
        heading.setAttr("data-mn-book-section-title", this.asText(pageData._mnBookSectionTitle));
      }
      return heading;
    };

    const firstPageData = hasConfiguredPages ? configuredPages[0] : data;
    const firstCopy = copyFrame.createDiv({ cls: "mn-codex__copy" });
    const firstBody = firstCopy.createDiv({ cls: "mn-codex__prose mn-codex__prose--page" });
    let firstHeading = null;
    if (hasConfiguredPages) {
      firstHeading = prepareBookHeading(firstPageData, firstBody, 0);
    } else {
      this.createHeading(firstPageData, firstCopy);
    }
    this.createBookIllustration(firstPageData, firstBody, sourcePath, component);
    await this.renderMarkdownWithPageBreaks(firstPageData.content, firstBody, sourcePath, component);
    if (firstHeading) await this.shapeBookTemplate(firstPageData, firstHeading, data, sourcePath, configuredPages, component);
    if (firstHeading) this.preparePageArt(firstPageData, firstHeading, data, sourcePath);
    if (hasConfiguredPages) {
      for (let pageIndex = 1; pageIndex < configuredPages.length; pageIndex += 1) {
        const pageData = configuredPages[pageIndex];
        const entryBreak = firstBody.createDiv({ cls: "mn-codex__page-break-marker mn-codex__book-entry-break" });
        entryBreak.setAttr("data-mn-book-next-page-index", String(pageIndex));
        entryBreak.setAttr("data-mn-book-next-page-mode", pageData.page_mode || bookPageMode);
        // 관계도는 왼쪽(관계도) | 오른쪽(고른 사람 글)이 한 펼침이어야 해서 새 펼침의 왼쪽 쪽에서 시작
        if ((pageData._mnBookTemplate === "relation" || pageData._mnBookTemplate === "personal") && pageData._mnBookPageKind === "section") entryBreak.setAttr("data-mn-next-spread", "true");
        // 능력 하위 쪽(전용 지면)은 그림 띠가 두 쪽 위를 가로질러서 역시 새 펼침의 왼쪽 쪽에서 시작
        if (pageData._mnBookTemplate === "ability" && pageData._mnBookPageKind === "entry" && this.asText(data.layout_variant).trim()) entryBreak.setAttr("data-mn-next-spread", "true");
        // 쪽 그림을 단 장 · 쪽도 새 펼침의 왼쪽 석판 쪽에서 시작 (오른쪽 종이 쪽에 놓이면 그림이 안 보여서). 실험실 추가 2026-10-28
        if (this.hasPageArt(pageData, data)) entryBreak.setAttr("data-mn-next-spread", "true");
        const heading = prepareBookHeading(pageData, firstBody, pageIndex);
        this.createBookIllustration(pageData, firstBody, sourcePath, component);
        await this.renderMarkdownWithPageBreaks(pageData.content, firstBody, sourcePath, component);
        await this.shapeBookTemplate(pageData, heading, data, sourcePath, configuredPages, component);
        this.preparePageArt(pageData, heading, data, sourcePath);
      }
    }
    this.enhanceBookText(firstBody);
    this.createFolio(first.leftFrame, data.folio_left || "01", "left");
    this.createFolio(first.rightFrame, data.folio_right || "02", "right");

    const firstCopySide = hasImage ? (position === "left" ? "right" : "left") : "left";
    const contentPages = [{ body: firstBody, frame: copyFrame, spread: first, side: firstCopySide }];
    if (secondCopyFrame) {
      const secondCopy = secondCopyFrame.createDiv({ cls: "mn-codex__copy mn-codex__copy--continuation" });
      const secondContinuation = secondCopy.createDiv({
        cls: "mn-codex__continuation",
        text: `${this.asText(data.title, "CHARACTER FILE")} / CONTINUED`,
      });
      secondContinuation.hidden = true;
      const secondBody = secondCopy.createDiv({ cls: "mn-codex__prose mn-codex__prose--page" });
      const secondPage = {
        body: secondBody,
        frame: secondCopyFrame,
        spread: first,
        side: "right",
        continuation: secondContinuation,
      };
      contentPages.push(secondPage);
      contentPageQueue.push(secondPage);
    }
    let continuationFolio = 3;

    const applyConfiguredPageMode = (page, pageIndex) => {
      if (!page || !hasConfiguredPages) return;
      const configuredPage = configuredPages[pageIndex];
      const mode = this.asText(configuredPage?.page_mode, bookPageMode) === "spread" ? "spread" : "leaf";
      page.configuredPageIndex = pageIndex;
      page.frame.setAttr("data-mn-book-owner-page-index", String(pageIndex));
      page.frame.setAttr("data-mn-book-page-mode", mode);
      page.frame.classList.remove("mn-codex__page-frame--mode-leaf", "mn-codex__page-frame--mode-spread");
      page.frame.addClass(`mn-codex__page-frame--mode-${mode}`);
      // 쪽 자체에도 표시 (펼침 쪽 규칙이 예전엔 :has() 로 찾아서 느렸음). 2026-10-28
      const modePage = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
      if (modePage) modePage.classList.toggle("mn-codex__page--mode-spread", mode === "spread");
      if (mode === "spread") page.spread.book.addClass("mn-codex__book--logical-spread");
    };
    applyConfiguredPageMode(contentPages[0], 0);

    const addContinuationSpread = () => {
      const spread = createSpread(true);
      for (const side of ["left", "right"]) {
        const frame = side === "left" ? spread.leftFrame : spread.rightFrame;
        frame.addClass("mn-codex__page-frame--copy");
        const copy = frame.createDiv({ cls: "mn-codex__copy mn-codex__copy--continuation" });
        const continuation = copy.createDiv({
          cls: "mn-codex__continuation",
          text: `${this.asText(data.title, "설정 기록")} / CONTINUED`,
        });
        const body = copy.createDiv({ cls: "mn-codex__prose mn-codex__prose--page" });
        continuation.hidden = hasConfiguredPages;
        const page = { body, frame, spread, side, continuation };
        contentPages.push(page);
        contentPageQueue.push(page);
        this.createFolio(frame, String(continuationFolio).padStart(2, "0"), side);
        continuationFolio += 1;
      }
    };

    await this.waitForLayout();
    const sourceNodes = Array.from(firstBody.childNodes);
    for (const node of sourceNodes) node.remove();

    let currentPage = contentPages[0];
    let currentHasContent = false;
    let usedContentPageCount = 1;
    let activeConfiguredPageIndex = hasConfiguredPages ? 0 : -1;
    const autoPaginate = this.asBoolean(data.auto_paginate, true);

    const nextPage = () => {
      if (!contentPageQueue.length) addContinuationSpread();
      const page = contentPageQueue.shift();
      if (page.continuation && !hasConfiguredPages) page.continuation.hidden = false;
      usedContentPageCount = Math.max(usedContentPageCount, contentPages.indexOf(page) + 1);
      return page;
    };

    const nextSpreadPage = () => {
      const currentSpread = currentPage.spread;
      let page = nextPage();
      while (page.spread === currentSpread) page = nextPage();
      return page;
    };

    const nextOverflowPage = () => {
      const pageData = configuredPages[activeConfiguredPageIndex];
      const pageMode = this.asText(pageData?.page_mode, bookPageMode);
      const page = pageMode === "spread" ? nextSpreadPage() : nextPage();
      applyConfiguredPageMode(page, activeConfiguredPageIndex);
      if (hasConfiguredPages && page.continuation) {
        const section = this.asText(pageData?._mnBookSectionTitle);
        const title = this.asText(pageData?.title, this.asText(data.title, "설정 기록"));
        page.continuation.setText(`${section && section !== title ? `${section} / ` : ""}${title} · CONTINUED`);
        page.continuation.hidden = false;
      }
      return page;
    };

    const isFlowHeading = (element) => element
      && /^H[1-6]$/.test(element.tagName)
      && !element.classList.contains("mn-codex__title");

    const appendFlowNode = (sourceNode) => {
      let remainder = sourceNode;
      let guard = 0;
      while (remainder && guard < 100) {
        guard += 1;
        currentPage.body.appendChild(remainder);
        if (!autoPaginate || !this.isPageOverflowing(currentPage.body)) {
          currentHasContent = true;
          return;
        }
        // 관계도는 다음 쪽으로 밀기 전에 남은 자리에 맞춰 작게 해 봄 (다음 쪽은 고른 사람 글 자리라서). 실험실 추가 2026-10-27
        // 폭은 그대로 두고 높이만 줄여 봄 — 쪽에 놓인 뒤 관계도가 남은 높이까지 다시 늘리고 반지름 · 동그라미 크기를 잡음(shapeRelation layout),
        // 그래서 여기선 아주 작게(1/4)까지 줄여서라도 관계 장 첫 쪽에 붙여 둠. 2026-10-28
        if (remainder.nodeType === 1 && remainder.classList.contains("mn-codex__orbit")) {
          const naturalHeight = remainder.offsetHeight;
          for (const scale of [0.9, 0.8, 0.7, 0.6, 0.5, 0.44, 0.38, 0.32, 0.25]) {
            remainder.style.aspectRatio = "auto";
            remainder.style.height = `${Math.round(naturalHeight * scale)}px`;
            if (!this.isPageOverflowing(currentPage.body)) {
              currentHasContent = true;
              return;
            }
          }
          remainder.style.aspectRatio = "";
          remainder.style.height = "";
        }

        remainder.remove();
        const split = this.splitFlowNodeToFit(remainder, currentPage.body);
        if (split) {
          currentPage.body.appendChild(split.head);
          currentHasContent = true;
          remainder = split.tail;
          currentPage = nextOverflowPage();
          currentHasContent = false;
          continue;
        }

        const trailingHeading = currentPage.body.lastElementChild;
        if (currentHasContent && isFlowHeading(trailingHeading)) {
          trailingHeading.remove();
          currentPage = nextOverflowPage();
          currentPage.body.appendChild(trailingHeading);
          currentHasContent = true;
          continue;
        }

        if (currentHasContent) {
          currentPage = nextOverflowPage();
          currentHasContent = false;
          continue;
        }

        currentPage.body.appendChild(remainder);
        currentPage.body.addClass("mn-codex__prose--oversize");
        currentHasContent = true;
        return;
      }

      if (remainder && !remainder.isConnected) {
        currentPage.body.appendChild(remainder);
        currentPage.body.addClass("mn-codex__prose--oversize");
        currentHasContent = true;
      }
    };

    for (let nodeIndex = 0; nodeIndex < sourceNodes.length; nodeIndex += 1) {
      const node = sourceNodes[nodeIndex];
      // 능력 색인은 종이(오른쪽) 쪽에: 설명이 왼쪽 쪽에서 끝났으면 오른쪽 쪽으로 넘김. 실험실 추가 2026-10-27
      if (node.nodeType === 1 && node.classList.contains("mn-codex__ab-roster-break")) {
        node.remove();
        if (currentPage.side === "left") {
          currentPage = nextPage();
          applyConfiguredPageMode(currentPage, activeConfiguredPageIndex);
          currentHasContent = false;
        }
        continue;
      }
      if (node.nodeType === 1 && node.classList.contains("mn-codex__page-break-marker")) {
        const isBookEntryBreak = node.classList.contains("mn-codex__book-entry-break");
        const nextConfiguredPageIndex = Number(node.getAttribute("data-mn-book-next-page-index"));
        const nextConfiguredMode = this.asText(node.getAttribute("data-mn-book-next-page-mode"), bookPageMode);
        const currentConfiguredMode = this.asText(configuredPages[activeConfiguredPageIndex]?.page_mode, bookPageMode);
        node.remove();
        const hasFollowingContent = sourceNodes.slice(nodeIndex + 1).some((candidate) => {
          if (candidate.nodeType === 1 && candidate.classList.contains("mn-codex__page-break-marker")) return false;
          return candidate.nodeType !== 3 || Boolean(String(candidate.textContent || "").trim());
        });
        if ((currentHasContent || hasConfiguredPages) && hasFollowingContent) {
          currentPage = node.hasAttribute("data-mn-next-spread") || (isBookEntryBreak && (currentConfiguredMode === "spread" || nextConfiguredMode === "spread"))
            ? nextSpreadPage()
            : nextPage();
          if (Number.isInteger(nextConfiguredPageIndex)) {
            activeConfiguredPageIndex = nextConfiguredPageIndex;
            applyConfiguredPageMode(currentPage, activeConfiguredPageIndex);
          }
          currentHasContent = false;
        }
        continue;
      }

      if (node.nodeType === 3 && !String(node.textContent || "").trim()) continue;
      if (node.nodeType === 1 && node.hasAttribute("data-mn-book-page-index")) {
        const pageIndex = Number(node.getAttribute("data-mn-book-page-index"));
        if (Number.isInteger(pageIndex)) {
          activeConfiguredPageIndex = pageIndex;
          applyConfiguredPageMode(currentPage, pageIndex);
        }
      }
      // 능력 띠: 이 펼침 위에 그림 띠를 걸고 두 쪽 글자리를 띠 아래로 내림(꼭 빈 왼쪽 쪽에서). 실험실 추가 2026-10-27
      // 쪽 그림: 제목이 왼쪽 석판 쪽에 놓이면 그 쪽 전체 바닥에 (오른쪽 종이 쪽은 글만). 실험실 추가 2026-10-28
      if (node.nodeType === 1 && node._mnPageArt && currentPage.side === "left" && currentPage.spread) {
        this.mountPageArt(node._mnPageArt.backdrop, currentPage.spread.leftPage);
      }
      if (node.nodeType === 1 && node._mnAbBand) {
        if (currentPage.side !== "left" || currentHasContent) {
          currentPage = nextSpreadPage();
          applyConfiguredPageMode(currentPage, activeConfiguredPageIndex);
          currentHasContent = false;
        }
        this.mountAbilityBand(node._mnAbBand, node._mnAbArt, currentPage.spread);
      }
      // 자리가 남을 때만 놓는 것(능력 색인): 이 쪽에 안 들어가면 다음 쪽으로 밀지 않고 뺌
      if (node.nodeType === 1 && node.hasAttribute("data-mn-flow-optional")) {
        currentPage.body.appendChild(node);
        if (autoPaginate && this.isPageOverflowing(currentPage.body)) node.remove();
        else currentHasContent = true;
        continue;
      }
      appendFlowNode(node);
    }

    if (!sourceNodes.length) {
      firstBody.createEl("p", { text: "내용을 입력해 주세요." });
    }

    if (hasConfiguredPages) {
      const pageStarts = new Map();
      for (const page of contentPages) {
        const heading = page.frame.querySelector("[data-mn-book-page-index]");
        if (!heading) continue;
        const pageIndex = Number(heading.getAttribute("data-mn-book-page-index"));
        if (Number.isInteger(pageIndex)) pageStarts.set(pageIndex, page);
      }
      configuredPages.forEach((pageData, pageIndex) => {
        const page = pageStarts.get(pageIndex);
        if (!page) return;
        const kind = this.asText(pageData._mnBookPageKind, "page");
        page.frame.addClass(`mn-codex__page-frame--${kind}`);
        page.frame.addClass(`mn-codex__page-frame--mode-${pageData.page_mode || bookPageMode}`);
        page.frame.setAttr("data-mn-book-page-index", String(pageIndex));
        page.frame.setAttr("data-mn-book-page-mode", pageData.page_mode || bookPageMode);
        if (pageData.page_mode === "spread") page.spread.book.addClass("mn-codex__book--logical-spread");
        page.frame.setAttr("data-mn-book-page-kind", kind);
        if (pageData._mnBookSectionIndex >= 0) {
          page.frame.setAttr("data-mn-book-section-index", String(pageData._mnBookSectionIndex));
          page.frame.setAttr("data-mn-book-section-title", this.asText(pageData._mnBookSectionTitle));
          // 쪽에도 장 번호(01부터) · 틀 이름을 달아 둠: 캐릭터 전용 지면(layout_variant)이 큰 장 번호 장식 · 틀별 모양에 씀. 실험실 추가 2026-10-27
          const pageNode = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
          if (pageNode) pageNode.setAttr("data-mn-section", String(pageData._mnBookSectionIndex + 1).padStart(2, "0"));
          if (pageNode && pageData._mnBookTemplate) {
            pageNode.setAttr("data-mn-template", pageData._mnBookTemplate);
            pageNode.setAttr("data-mn-page-kind", kind);
          }
        }
        page.frame.setAttr("data-mn-book-entry-index", String(pageData._mnBookEntryIndex));
        page.frame.setAttr("data-mn-book-persist-key", this.asText(pageData._mnBookPersistKey));
        if (kind === "section") {
          page.frame.setAttr("data-mn-book-section-start", "true");
          sectionDestinations.push({
            sectionIndex: pageData._mnBookSectionIndex,
            title: this.asText(pageData._mnBookSectionTitle, pageData.title),
            spreadIndex: spreads.indexOf(page.spread),
            side: page.side,
          });
        }
        const rawTag = pageData.page_tag;
        const hasPageTag = rawTag === true || (rawTag !== false && rawTag !== undefined && rawTag !== null && String(rawTag).trim());
        const destination = {
          pageIndex,
          sectionIndex: pageData._mnBookSectionIndex,
          title: this.asText(pageData.title, `PAGE ${String(pageIndex + 1).padStart(2, "0")}`),
          tag: rawTag === true ? this.asText(pageData.title) : hasPageTag ? this.asText(rawTag) : "",
          pageId: this.asText(pageData.page_id),
          spreadIndex: spreads.indexOf(page.spread),
          side: page.side,
          kind,
        };
        pageDestinations.push(destination);
        if (pageData.text_tone) {
          page.frame.addClass(`mn-codex__page-tone--${pageData.text_tone.replace(/[^a-z0-9_-]+/g, "-")}`);
        }
        if (pageData.text_effect) {
          page.frame.addClass(`mn-codex__page-effect--${pageData.text_effect.replace(/[^a-z0-9_-]+/g, "-")}`);
        }
        this.createBookStickers(pageData, page, sourcePath, component);
        placedPageImages.push(...this.createBookPageImages(pageData, page, sourcePath, component));
      });
      // 쪽 그림: 그 쪽 글이 끝나는 높이를 재서 글 자리만 살짝 누름. 실험실 추가 2026-10-28
      for (const page of contentPages) {
        const pageNode = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
        const art = pageNode && pageNode.querySelector(":scope > .mn-codex__page-art");
        if (!art) continue;
        const pageRect = pageNode.getBoundingClientRect();
        if (!pageRect.height) continue;
        let bottom = pageRect.top;
        for (const child of Array.from(page.body.children)) {
          const rect = child.getBoundingClientRect();
          if (rect.height) bottom = Math.max(bottom, rect.bottom);
        }
        const reach = (bottom - pageRect.top) / pageRect.height;
        art.style.setProperty("--mn-text-end", `${Math.min(100, Math.max(18, Math.round(reach * 100) + 2))}%`);
      }
      // 글이 쪽 높이 72% 아래까지 차면 큰 장 번호 장식은 숨김(글 뒤에 겹치지 않게). 실험실 추가 2026-10-27
      contentPages.forEach((page) => {
        const pageNode = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
        if (!pageNode || !pageNode.hasAttribute("data-mn-section")) return;
        const pageRect = pageNode.getBoundingClientRect();
        if (!pageRect.height) return;
        let bottom = 0;
        for (const child of Array.from(page.body.children)) {
          const rect = child.getBoundingClientRect();
          if (rect.height) bottom = Math.max(bottom, rect.bottom);
        }
        if (bottom && (bottom - pageRect.top) / pageRect.height > 0.72) pageNode.setAttr("data-mn-page-full", "true");
      });
      // 같은 장이 펼침 두 쪽에 걸치면 큰 장 번호 장식은 왼쪽 쪽에만. 실험실 추가 2026-10-27
      spreads.forEach((spread) => {
        if (!spread || !spread.book) return;
        const left = spread.book.querySelector(".mn-codex__page--left[data-mn-section]");
        const right = spread.book.querySelector(".mn-codex__page--right[data-mn-section]");
        if (left && right && left.getAttribute("data-mn-section") === right.getAttribute("data-mn-section")) {
          right.setAttr("data-mn-section-repeat", "true");
        }
      });
      // 빈 쪽(다음 펼침 왼쪽에서 시작하는 장 앞 등)은 텅 비워 두지 않고 다음 장을 조용히 알림 (캐릭터 전용 지면). 실험실 추가 2026-10-28
      if (this.asText(data.layout_variant).trim()) {
        const used = contentPages.slice(0, usedContentPageCount);
        used.forEach((page, index) => {
          if (String(page.body.textContent || "").trim() || page.body.querySelector("img, svg, canvas, .mn-codex__orbit")) return;
          const pageNode = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
          if (!pageNode || pageNode.querySelector(":scope > .mn-codex__page-art")) return;
          const later = used.slice(index + 1).find((candidate) => candidate.frame.querySelector("[data-mn-book-page-index]"));
          const heading = later && later.frame.querySelector("[data-mn-book-page-index]");
          const nextData = heading ? configuredPages[Number(heading.getAttribute("data-mn-book-page-index"))] : null;
          if (!nextData) return;
          const doc = pageNode.ownerDocument;
          const mark = doc.createElement("div");
          mark.className = "mn-codex__page-next";
          mark.setAttribute("aria-hidden", "true");
          const kicker = doc.createElement("span");
          kicker.className = "mn-codex__page-next-kicker";
          kicker.textContent = "NEXT";
          const number = doc.createElement("b");
          number.textContent = String(Math.max(0, nextData._mnBookSectionIndex) + 1).padStart(2, "0");
          const title = doc.createElement("span");
          title.className = "mn-codex__page-next-title";
          const sectionTitle = this.asText(nextData._mnBookSectionTitle, nextData.title);
          title.textContent = sectionTitle;
          mark.append(kicker, number, title);
          const pageTitle = this.asText(nextData.title).trim();
          if (pageTitle && pageTitle !== sectionTitle) {
            const sub = doc.createElement("span");
            sub.className = "mn-codex__page-next-sub";
            sub.textContent = pageTitle.replace(/\s*[:：]\s*/u, " · ");
            mark.appendChild(sub);
          }
          pageNode.appendChild(mark);
          pageNode.setAttr("data-mn-page-empty", "true");
        });
      }
    }
    contentPages.forEach((page) => {
      this.markLoneParagraph(page.body);
      const pageNode = typeof page.frame.closest === "function" ? page.frame.closest(".mn-codex__page") : null;
      if (pageNode) pageNode.classList.toggle("mn-codex__page--mode-spread", page.frame.classList.contains("mn-codex__page-frame--mode-spread"));
    });
    reader.classList.remove("mn-codex__reader--flowing");

    const usedLeafCount = (hasImage ? 1 : 0) + usedContentPageCount;
    const usedSpreadCount = Math.max(1, Math.ceil(usedLeafCount / 2));

    // Every visible copy leaf needs its own persistent image canvas. A blank
    // partner leaf or an auto-pagination continuation does not have a YAML page
    // record, so give it a stable physical-leaf key and restore its saved images.
    contentPages.forEach((page) => {
      const spreadIndex = spreads.indexOf(page.spread);
      if (spreadIndex < 0 || spreadIndex >= usedSpreadCount) return;
      let persistKey = this.asText(page.frame.getAttribute("data-mn-book-persist-key"));
      if (!persistKey) {
        persistKey = `${sourcePath}::book-leaf::${spreadIndex}::${page.side}`;
        page.frame.setAttr("data-mn-book-persist-key", persistKey);
        page.frame.setAttr("data-mn-book-page-kind", "leaf");
      }
      const persistedImages = this.pageImageLayouts?.[persistKey];
      if (!page.frame.querySelector(":scope > .mn-codex__placed-image") && Array.isArray(persistedImages)) {
        placedPageImages.push(...this.createBookPageImages({ page_images: persistedImages }, page, sourcePath, component));
      }
    });

    // Placed images use one uninterrupted canvas per physical spread. The
    // originating leaf only decides the initial insertion point; afterwards an
    // image can sit on the left, the gutter, the right, or across all three.
    await this.waitForLayout();
    spreads.slice(0, usedSpreadCount).forEach((spread, spreadIndex) => {
      const spreadKey = `${sourcePath}::book-spread::${spreadIndex}`;
      const layer = spread.book.createDiv({ cls: "mn-codex__spread-image-layer" });
      layer.setAttr("data-mn-book-persist-key", spreadKey);
      layer.setAttr("data-mn-book-spread-index", String(spreadIndex));
      const leafFigures = Array.from(spread.book.querySelectorAll(".mn-codex__page-frame--copy > .mn-codex__placed-image"));
      const persistedSpread = this.pageImageLayouts?.[spreadKey];

      if (Array.isArray(persistedSpread)) {
        leafFigures.forEach((figure) => figure.remove());
        placedPageImages.push(...this.createBookPageImages({ page_images: persistedSpread }, { frame: layer }, sourcePath, component));
        return;
      }

      const bookRect = spread.book.getBoundingClientRect();
      if (!bookRect.width || !bookRect.height) return;
      leafFigures.forEach((figure) => {
        const frame = figure.closest(".mn-codex__page-frame--copy");
        const frameRect = frame?.getBoundingClientRect();
        if (!frameRect?.width || !frameRect?.height) return;
        const readPercent = (name, fallback) => {
          const value = Number.parseFloat(figure.style.getPropertyValue(name));
          return Number.isFinite(value) ? value : fallback;
        };
        const leafX = readPercent("--mn-page-image-x", 50);
        const leafY = readPercent("--mn-page-image-y", 50);
        const leafWidth = readPercent("--mn-page-image-width", 24);
        const spreadX = ((frameRect.left - bookRect.left) + frameRect.width * leafX / 100) / bookRect.width * 100;
        const spreadY = ((frameRect.top - bookRect.top) + frameRect.height * leafY / 100) / bookRect.height * 100;
        const spreadWidth = frameRect.width / bookRect.width * leafWidth;
        figure.style.setProperty("--mn-page-image-x", `${spreadX.toFixed(2)}%`);
        figure.style.setProperty("--mn-page-image-y", `${spreadY.toFixed(2)}%`);
        figure.style.setProperty("--mn-page-image-width", `${spreadWidth.toFixed(2)}%`);
        figure.setAttr("data-mn-x", spreadX.toFixed(1));
        figure.setAttr("data-mn-y", spreadY.toFixed(1));
        figure.setAttr("data-mn-width", spreadWidth.toFixed(1));
        layer.appendChild(figure);
      });
    });
    spreads.forEach((spread, index) => {
      spread.book.classList.toggle("mn-codex__book--unused", index >= usedSpreadCount);
      spread.book.setAttr("aria-hidden", index === 0 ? "false" : "true");
    });

    const controls = root.createDiv({ cls: "mn-codex__book-controls" });
    const previous = controls.createEl("button", {
      cls: "mn-codex__book-button mn-codex__book-button--previous",
      text: "PREV",
      attr: { type: "button", "aria-label": "이전 장" },
    });
    const status = controls.createDiv({ cls: "mn-codex__book-status" });
    status.setAttr("aria-live", "polite");
    const next = controls.createEl("button", {
      cls: "mn-codex__book-button mn-codex__book-button--next",
      text: "NEXT",
      attr: { type: "button", "aria-label": "다음 장" },
    });

    let step = 0;
    let beforeFirst = null;
    let statusOffset = 0;
    let bookmarkJumpToken = 0;
    let activeSpreadIndex = -1;
    let spreadStateUpdates = 0;
    const bookmarkButtons = [];
    const tagButtons = [];
    const cleanups = [];
    const flipPool = this.createBookFlipDomPool(root.ownerDocument || document);
    const reducedMotionQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    const on = (target, event, handler) => {
      target.addEventListener(event, handler);
      cleanups.push(() => target.removeEventListener(event, handler));
    };
    const isSinglePage = () => root.getBoundingClientRect().width <= 760;
    const totalSteps = () => isSinglePage() ? usedLeafCount : usedSpreadCount;
    const destinationStep = (destination) => isSinglePage()
      ? destination.spreadIndex * 2 + (destination.side === "right" ? 1 : 0)
      : destination.spreadIndex;

    const updateBookmarks = () => {
      if (!bookmarkButtons.length && !tagButtons.length) return;
      let activeIndex = 0;
      bookmarkButtons.forEach(({ destination }, index) => {
        if (destinationStep(destination) <= step) activeIndex = index;
      });
      tagButtons.forEach(({ button, destination }) => {
        const active = destinationStep(destination) === step;
        button.classList.toggle("is-active", active);
        if (active) button.setAttr("aria-current", "page");
        else button.removeAttribute("aria-current");
      });
      bookmarkButtons.forEach(({ button }, index) => {
        const active = index === activeIndex;
        button.classList.toggle("is-active", active);
        if (active) {
          button.setAttr("aria-current", "page");
        } else {
          button.removeAttribute("aria-current");
        }
      });
    };

    // 시안(작가 요청 2026-10-28): 책장 넘김 · 은빛 빛줄기 — 캐릭터 전용 지면, 「효과 없음」 · 움직임 줄이기 설정이면 안 함.
    // 움직임은 회전 · 투명도만(그래픽 카드가 맡아 프레임 부담이 적음)
    let currentTurn = null;
    // 넘어가는 종이용 가벼운 그림: 큰 그림(폭 700px 넘음)은 넘어가는 종이에 넣으면 그 크기로 다시 풀어야 해서 첫 0.3초 멈칫함 →
    // 쉬는 틈에 폭 640px 로 줄인 그림 데이터(ImageBitmap)를 만들어 두고, 종이에서만 그림 대신 캔버스에 그려 씀 (다 넘어가면 원래 그림 그대로)
    const turnBitmaps = [];
    cleanups.push(() => turnBitmaps.forEach((bitmap) => bitmap.close && bitmap.close()));
    const makeTurnImage = (img) => {
      const view = img && img.ownerDocument && img.ownerDocument.defaultView;
      if (!img || img._mnTurnBitmap || img._mnTurnBusy || !(img.naturalWidth > 700) || !view || typeof view.createImageBitmap !== "function") return;
      img._mnTurnBusy = true;
      view.createImageBitmap(img, { resizeWidth: 640, resizeHeight: Math.max(1, Math.round(img.naturalHeight * 640 / img.naturalWidth)), resizeQuality: "medium" })
        .then((bitmap) => { turnBitmaps.push(bitmap); img._mnTurnBitmap = bitmap; })
        .catch(() => {});
    };
    // box-sizing · padding · border 도 옮김: 은빛 기사 초상은 사방 20px 안쪽 여백 안에만 그려져서, 빠지면 넘기는 동안 그림이 커 보였다 줄어듦
    const TURN_IMAGE_STYLES = ["position", "top", "right", "bottom", "left", "width", "height", "max-width", "max-height", "margin", "box-sizing", "padding",
      "border-width", "border-style", "border-color", "object-fit", "object-position",
      "transform", "transform-origin", "filter", "opacity", "display", "z-index", "border-radius", "clip-path", "mask-image", "-webkit-mask-image", "vertical-align"];
    const fxOn = (name) => root.classList.contains(`mn-sk-fx-${name}`) && !(reducedMotionQuery && reducedMotionQuery.matches);
    // 물감 방울: 「특징」(개요 장의 쪽 그림)이 도착하면 그림이 물감 방울로 툭툭 떨어져 번지며 드러남. 「책 효과」의 장마다 효과에 딸림. 책 내보내기 땐 안 함
    const ink = new InkRevealer(root.ownerDocument || document);
    cleanups.push(() => ink.destroy());
    // 책 내보내기 중이거나, 표지 밑에 미리 만들어 둔(안 보이는) 책장이면 연출을 안 함
    const quiet = () => {
      const body = root.ownerDocument && root.ownerDocument.body;
      return Boolean((body && body.classList.contains("mn-codex-exporting")) || root.closest(".mn-codex-host--parked"));
    };
    const inkOn = () => !ink.broken && !quiet();
    // 첫 쪽(작가 고름 2026-10-29): 흰 꽃잎이 바람에 실려 왼쪽 위에서 쪽을 스쳐 가고, 지나간 자리부터 초상이 드러남 (네이그림의 「흩날리는 꽃잎」).
    // 꽃잎은 위치 · 회전 · 투명도만 움직임(그래픽 카드 몫), 초상은 InkRevealer 의 바람 결로 걷힘
    const petalRuns = new Set();
    const finishPetals = () => { for (const stop of [...petalRuns]) stop(); };
    const petalGust = (page, delay) => {
      const doc = page.ownerDocument;
      const view = doc.defaultView || window;
      const width = page.clientWidth;
      const height = page.clientHeight;
      if (!width || !height) return;
      const layer = doc.createElement("div");
      layer.className = "mn-codex__petals";
      layer.setAttribute("aria-hidden", "true");
      page.appendChild(layer);
      const animations = [];
      let longest = 0;
      for (let i = 0; i < 16; i += 1) {
        const petal = doc.createElement("i");
        petal.className = "mn-codex__petal";
        const size = 24 + Math.random() * 16;
        petal.style.width = `${size.toFixed(1)}px`;
        petal.style.height = `${(size * 0.7).toFixed(1)}px`;
        layer.appendChild(petal);
        // 왼쪽 밖에서 들어와 오른쪽 아래로 빠져나감 — 바람에 출렁이며(위아래), 돌고(회전), 뒤집힘(앞뒤)
        const x0 = -0.08 * width - Math.random() * 0.12 * width;
        const y0 = (-0.25 + Math.random() * 0.9) * height;
        const travel = width * (1.2 + Math.random() * 0.25);
        const fall = travel * (0.32 + Math.random() * 0.22);
        const sway = (8 + Math.random() * 22) * (Math.random() < 0.5 ? -1 : 1);
        const waves = 0.8 + Math.random() * 0.9;
        const spin = (160 + Math.random() * 320) * (Math.random() < 0.5 ? -1 : 1);
        const flips = 1 + Math.floor(Math.random() * 3);
        const tilt = 20 + Math.random() * 30;
        const frames = [];
        for (let k = 0; k <= 10; k += 1) {
          const f = k / 10;
          const x = x0 + travel * f;
          const y = y0 + fall * f + Math.sin(f * Math.PI * 2 * waves) * sway;
          frames.push({
            offset: f,
            opacity: k === 0 || k === 10 ? 0 : 1,
            transform: `perspective(420px) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(spin * f).toFixed(1)}deg) rotateY(${(flips * 180 * f).toFixed(1)}deg) rotateX(${(tilt * Math.sin(f * Math.PI * 3)).toFixed(1)}deg)`,
          });
        }
        // 앞쪽 한 무리가 먼저 휙, 나머지가 조금씩 늦게 따라옴
        const start = delay + (i < 9 ? Math.random() * 260 : 220 + Math.random() * 520);
        const duration = 1500 + Math.random() * 900;
        animations.push(petal.animate(frames, { duration, delay: start, easing: "cubic-bezier(.3,.55,.45,1)", fill: "both" }));
        longest = Math.max(longest, start + duration);
      }
      let timer = 0;
      const stop = () => {
        petalRuns.delete(stop);
        view.clearTimeout(timer);
        animations.forEach((animation) => animation.cancel());
        layer.remove();
      };
      timer = view.setTimeout(stop, longest + 60);
      petalRuns.add(stop);
    };
    const playSheen = (delay) => {
      if (!fxOn("sheen") || marking) return;
      const single = isSinglePage();
      const spread = spreads[single ? Math.floor(step / 2) : step];
      if (!spread || !spread.leftPage || (single && step % 2)) return;
      const page = spread.leftPage;
      let sheen = page.querySelector(":scope > .mn-codex__sheen-box > .mn-codex__sheen");
      if (!sheen) {
        const box = page.ownerDocument.createElement("div");
        box.className = "mn-codex__sheen-box";
        box.setAttribute("aria-hidden", "true");
        sheen = page.ownerDocument.createElement("div");
        sheen.className = "mn-codex__sheen";
        box.appendChild(sheen);
        page.appendChild(box);
      }
      if (typeof sheen.animate !== "function") return;
      sheen.getAnimations().forEach((animation) => animation.cancel());
      sheen.animate([
        { transform: "translateX(-140%) skewX(-16deg)", opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { opacity: 1, offset: 0.7 },
        { transform: "translateX(330%) skewX(-16deg)", opacity: 0 },
      ], { duration: 1500, delay, easing: "cubic-bezier(.3,.1,.2,1)" });
    };

    // 장마다 다른 도착 효과 (시안 2026-10-28) — 개요: 기록이 차례로 떠오름 · 능력 목록: 줄이 오른쪽에서 차례로 · 능력 하나: 칼빛 한 줄이 띠를 가르고
    // 그림이 내려앉음 · 관계: 선이 그어지고 사람이 하나씩 · 여담: 취향 묶음이 천천히 떠오름 · 그 밖의 석판 쪽: 은빛 빛줄기. 위치 · 크기 · 투명도만 움직임
    let arrivalDelay = 120;
    let hushed = false; // 도착 효과를 잠깐 끔 (다시 그린 책이 보던 쪽으로 돌아갈 때)
    // 넘어가는 종이에 실려 오는 쪽은 종이가 다 내려앉은 뒤에 도착 효과 시작 (종이가 사라지는 순간 반쯤 떠오른 채로 튀지 않게)
    let arrivalSheet = null;
    // marking: 넘어오는 종이(복제한 새 쪽)에서도 떠오를 것들을 미리 숨기려고, 움직이는 대신 표시(mn-arrive)만 붙임
    let marking = false;
    const arriveEase = "cubic-bezier(.2,.7,.2,1)";
    const visibleEl = (el) => Boolean(el && el.getClientRects().length);
    const mark = (el) => { if (el) el.classList.add("mn-arrive"); };
    const rise = (els, { delay = 0, stagger = 60, dx = 0, dy = 12, duration = 520 } = {}) => {
      let index = 0;
      for (const el of els) {
        if (marking) { mark(el); continue; }
        if (!visibleEl(el) || typeof el.animate !== "function") continue;
        el.animate([{ opacity: 0, transform: `translate(${dx}px, ${dy}px)` }, { opacity: 1, transform: "translate(0px, 0px)" }],
          { duration, delay: delay + index * stagger, easing: arriveEase, fill: "backwards" });
        index += 1;
      }
      return index;
    };
    const arriveAbility = (page, spread, delay) => {
      const doc = page.ownerDocument;
      // 그림은 처음부터 다 보이고 크기만 살짝 가라앉음 — 반투명에서 진해지면 그림을 덜 읽은 것처럼 보여서 (작가 2026-10-29)
      const backdrop = page.querySelector(".mn-codex__ab-backdrop");
      if (marking) { if (backdrop) backdrop.classList.add("mn-arrive-settle"); }
      else if (visibleEl(backdrop)) {
        backdrop.animate([{ transform: "scale(1.05)" }, { transform: "scale(1)" }],
          { duration: 1400, delay, easing: "cubic-bezier(.2,.6,.2,1)", fill: "backwards" });
      }
      const band = page.querySelector(".mn-codex__ab-band");
      if (band && !marking) {
        let slash = band.querySelector(":scope > .mn-codex__slash");
        if (!slash) {
          slash = doc.createElement("div");
          slash.className = "mn-codex__slash";
          slash.setAttribute("aria-hidden", "true");
          band.appendChild(slash);
        }
        slash.getAnimations().forEach((animation) => animation.cancel());
        slash.animate([
          { transform: "translateX(-38%) rotate(-12deg) scaleX(.15)", opacity: 0 },
          { opacity: 1, offset: 0.35 },
          { transform: "translateX(38%) rotate(-12deg) scaleX(1)", opacity: 0 },
        ], { duration: 640, delay: delay + 60, easing: "cubic-bezier(.3,0,.2,1)", fill: "both" });
        rise(band.querySelectorAll(".mn-codex__ab-band-kicker, .mn-codex__ab-band-type, .mn-codex__ab-band-name, .mn-codex__ab-band-tags"),
          { delay: delay + 260, stagger: 70, dy: 14, duration: 600 });
      } else if (band) rise(band.querySelectorAll(".mn-codex__ab-band-kicker, .mn-codex__ab-band-type, .mn-codex__ab-band-name, .mn-codex__ab-band-tags"));
      rise(spread.book.querySelectorAll(".mn-codex__ab-quote, .mn-codex__ab-lead"), { delay: delay + 460, dy: 10, duration: 600 });
    };
    const arriveRelation = (spread, delay) => {
      const orbit = spread.book.querySelector(".mn-codex__orbit");
      if (marking && orbit) orbit.querySelectorAll(".mn-codex__orbit-node, .mn-codex__orbit-line, .mn-codex__orbit-ring").forEach(mark);
      else if (visibleEl(orbit)) {
        const k = getComputedStyle(orbit).getPropertyValue("--mn-orbit-k").trim() || "1";
        const base = `translate(-50%, -50%) scale(${k})`;
        const self = orbit.querySelector(".mn-codex__orbit-node--self");
        if (self) self.animate([{ opacity: 0, transform: `${base} scale(.7)` }, { opacity: 1, transform: `${base} scale(1)` }], { duration: 460, delay, easing: arriveEase, fill: "backwards" });
        orbit.querySelectorAll(".mn-codex__orbit-ring").forEach((ring) => ring.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: delay + 120, fill: "backwards" }));
        Array.from(orbit.querySelectorAll(".mn-codex__orbit-line")).forEach((line, index) => {
          const length = typeof line.getTotalLength === "function" ? line.getTotalLength() : 0;
          if (!length) return;
          line.style.strokeDasharray = String(length);
          const draw = line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: 420, delay: delay + 220 + index * 70, easing: arriveEase, fill: "backwards" });
          const reset = () => { line.style.strokeDasharray = ""; };
          draw.onfinish = reset;
          draw.oncancel = reset;
        });
        Array.from(orbit.querySelectorAll(".mn-codex__orbit-node:not(.mn-codex__orbit-node--self)")).forEach((node, index) => {
          node.animate([{ opacity: 0, transform: `${base} scale(.55)` }, { opacity: 1, transform: `${base} scale(1)` }],
            { duration: 440, delay: delay + 460 + index * 70, easing: "cubic-bezier(.3,1.45,.5,1)", fill: "backwards" });
        });
      }
      rise(spread.book.querySelectorAll(".mn-codex__rel-card:not([hidden]) > *"), { delay: delay + 320, stagger: 70 });
    };
    const playArrival = (baseDelay) => {
      if (hushed || !fxOn("sheen")) return;
      const single = isSinglePage();
      const spread = spreads[single ? Math.floor(step / 2) : step];
      if (!spread || !spread.book) return;
      const pages = single ? [step % 2 ? spread.rightPage : spread.leftPage] : [spread.leftPage, spread.rightPage];
      for (const page of pages) {
        if (!page) continue;
        const delay = arrivalSheet && arrivalSheet.page === page ? arrivalSheet.delay : baseDelay;
        const template = page.getAttribute("data-mn-template") || "";
        const kind = page.getAttribute("data-mn-page-kind") || "";
        const art = template === "overview" && kind === "entry" ? Array.from(page.querySelectorAll(".mn-codex__page-art img")).filter(visibleEl) : [];
        const portrait = spreads[0] && page === spreads[0].leftPage ? page.querySelector(".mn-codex__figure--book .mn-codex__art img") : null;
        if (page.classList.contains("mn-codex__page--ab-band")) arriveAbility(page, spread, delay);
        else if (art.length && !marking && inkOn()) art.forEach((img) => ink.play(img, { delay }));
        else if (portrait && visibleEl(portrait) && !marking && !quiet()) {
          petalGust(page, delay);
          if (inkOn()) ink.play(portrait, { delay: delay + 160, mode: "wind", duration: 1700 });
        }
        else if (template === "overview" && kind === "section") {
          rise(page.querySelectorAll(".mn-codex__section-index, .mn-codex__ov-alias, .mn-codex__ov-name, .mn-codex__ov-lead, .mn-codex__ov-stat, .mn-codex__ov-label, .mn-codex__ov-grid > div, .mn-codex__ov-chip"), { delay, stagger: 55 });
        } else if (template === "ability" && kind === "section") {
          rise(page.querySelectorAll(".mn-codex__ab-item"), { delay: delay + 80, stagger: 75, dx: 28, dy: 0, duration: 560 });
        } else if (template === "relation" && kind === "section") arriveRelation(spread, delay);
        else if (template === "personal") {
          rise(spread.book.querySelectorAll(".mn-codex__pe-group, .mn-codex__pe-quote, .mn-codex__pe-item"), { delay: delay + 60, stagger: 85, dy: 10, duration: 720 });
        } else if (page === spread.leftPage) playSheen(delay);
      }
    };

    // 넘어오는 종이용: 지금 쪽(이미 넘긴 뒤)의 떠오를 것들에 표시를 붙였다 뗌 — 복제본엔 표시가 남아 숨겨짐(styles.css .mn-arrive)
    const markArrival = (on) => {
      if (!fxOn("sheen")) return;
      if (on) {
        marking = true;
        try { playArrival(0); } finally { marking = false; }
      } else root.querySelectorAll(".mn-arrive, .mn-arrive-settle").forEach((el) => el.classList.remove("mn-arrive", "mn-arrive-settle"));
    };

    const activate = (nextStep) => {
      if (currentTurn) currentTurn.finish();
      // 번지던 그림은 바로 다 보이게 · 날던 꽃잎은 거둠 (넘어가는 종이에 반쯤 번진 그림이나 꽃잎이 찍히지 않게)
      ink.finishAll();
      finishPetals();
      const total = totalSteps();
      step = Math.max(0, Math.min(nextStep, total - 1));
      const single = isSinglePage();
      const spreadIndex = single ? Math.floor(step / 2) : step;
      const side = single && step % 2 ? "right" : "left";
      reader.setAttr("data-mobile-side", side);
      reader.classList.toggle("mn-codex__reader--single", single);

      const updateSpreadState = (index) => {
        const spread = spreads[index];
        if (!spread) return;
        spreadStateUpdates += 1;
        spread.book.classList.toggle("is-active", index === spreadIndex);
        spread.book.classList.toggle("is-before", index < spreadIndex);
        spread.book.classList.toggle("is-after", index > spreadIndex);
        spread.book.setAttr("aria-hidden", index === spreadIndex ? "false" : "true");
      };
      if (activeSpreadIndex < 0) {
        spreads.forEach((_spread, index) => updateSpreadState(index));
      } else if (activeSpreadIndex !== spreadIndex) {
        updateSpreadState(activeSpreadIndex);
        updateSpreadState(spreadIndex);
      } else {
        updateSpreadState(spreadIndex);
      }
      activeSpreadIndex = spreadIndex;
      // 지금 펼침에서 두 칸 넘게 떨어진 펼침은 그리지 않음(content-visibility) — 투명하게 겹쳐 둔 펼침까지 늘 그리던 걸 덜어 렉을 줄임.
      // 지금 · 앞뒤 펼침의 그림은 미리 읽어 둠(넘기는 순간 큰 그림을 읽느라 버벅이지 않게). 실험실 추가 2026-10-28
      spreads.forEach((spread, index) => {
        if (!spread || !spread.book) return;
        const far = Math.abs(index - spreadIndex) > 1;
        if (spread.book.classList.contains("is-far") !== far) spread.book.classList.toggle("is-far", far);
        if (!far && !spread._mnWarm) {
          spread._mnWarm = true;
          // 쉬는 틈에 (넘기는 도중에 큰 그림을 풀면 화면 그리기와 겹쳐 멈칫함)
          const view = root.ownerDocument.defaultView || window;
          const later = typeof view.requestIdleCallback === "function" ? (fn) => view.requestIdleCallback(fn, { timeout: 1500 }) : (fn) => setTimeout(fn, 900);
          later(() => spread.book.querySelectorAll("img").forEach((img) => {
            img.loading = "eager";
            if (typeof img.decode === "function") img.decode().then(() => makeTurnImage(img)).catch(() => {});
          }));
        }
      });
      playArrival(arrivalDelay);

      previous.disabled = step === 0 && !beforeFirst;
      next.disabled = step >= total - 1;
      const displayedStep = step + 1 + statusOffset;
      const displayedTotal = total + statusOffset;
      status.setText(`${String(displayedStep).padStart(2, "0")} / ${String(displayedTotal).padStart(2, "0")}`);
      status.setAttr("aria-label", `${displayedTotal}장 중 ${displayedStep}장`);
      updateBookmarks();
      root.dispatchEvent(new CustomEvent("mn-codex-page-activated", { detail: { step, spreadIndex, side } }));
    };

    const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
    const clearBookmarkAnimation = () => {
      flipPool.releaseAll();
      root.classList.remove("is-bookmark-turning", "is-bookmark-forward", "is-bookmark-backward");
      root.removeAttribute("aria-busy");
    };
    const jumpToSection = async (destination) => {
      const target = Math.max(0, Math.min(destinationStep(destination), totalSteps() - 1));
      if (target === step) {
        const current = bookmarkButtons.find(({ destination: item }) => item === destination);
        if (current) {
          current.button.addClass("is-pulsing");
          setTimeout(() => current.button.removeClass("is-pulsing"), 360);
        }
        return;
      }

      bookmarkJumpToken += 1;
      const token = bookmarkJumpToken;
      const start = step;
      const direction = target > start ? 1 : -1;
      const distance = Math.abs(target - start);
      const reducedMotion = Boolean(reducedMotionQuery?.matches);

      clearBookmarkAnimation();
      if (reducedMotion) {
        activate(target);
        return;
      }
      // 책장 넘김 효과(캐릭터 전용 지면)면 장 띠로 건너뛸 때도 종이 한 장이 넘어감 (앞 = 지금 쪽, 뒤 = 갈 장). 2026-10-28
      if (fxOn("turn")) {
        turnTo(target, true);
        return;
      }

      root.addClass("is-bookmark-turning");
      root.classList.toggle("is-bookmark-forward", direction > 0);
      root.classList.toggle("is-bookmark-backward", direction < 0);
      root.setAttr("aria-busy", "true");

      const leaving = spreads[activeSpreadIndex];
      const targetSpreadIndex = isSinglePage() ? Math.floor(target / 2) : target;
      const targetSpread = spreads[targetSpreadIndex];
      // Match the visible leaf count to the number of reader steps crossed.
      // Keep a compositor-safe cap for unusually long books.
      const sheetCount = Math.min(16, Math.max(1, distance));
      const stage = flipPool.acquire(sheetCount);
      root.appendChild(stage);
      const sheetDuration = 480;
      const sheetStagger = 52;
      const totalDuration = sheetDuration + (sheetCount - 1) * sheetStagger;
      stage.style.setProperty("--mn-flip-total", `${totalDuration}ms`);

      if (targetSpread) {
        const targetSnapshot = targetSpread.book.cloneNode(true);
        targetSnapshot.classList.remove("is-active", "is-before", "is-after", "is-far");
        targetSnapshot.classList.add("mn-codex__flip-target");
        targetSnapshot.setAttribute("aria-hidden", "true");
        stage.appendChild(targetSnapshot);
      }

      if (leaving) {
        const snapshot = leaving.book.cloneNode(true);
        snapshot.classList.remove("is-active", "is-before", "is-after", "is-far");
        snapshot.classList.add("mn-codex__flip-snapshot");
        snapshot.setAttribute("aria-hidden", "true");
        stage.appendChild(snapshot);
      }

      flipPool.appendSheets(stage, (sheet, sheetIndex) => {
        sheet.style.setProperty("--mn-flip-delay", `${sheetIndex * sheetStagger}ms`);
        sheet.style.setProperty("--mn-flip-z", String(sheetCount - sheetIndex));
        sheet.style.setProperty("--mn-flip-offset", `${sheetIndex * 0.7}px`);
      });

      activate(target);

      await wait(totalDuration + 36);
      if (token !== bookmarkJumpToken) return;
      clearBookmarkAnimation();
      const activeButton = bookmarkButtons.find(({ destination: item }) => item === destination);
      if (activeButton) activeButton.button.focus({ preventScroll: true });
    };

    /** 한 장 넘김: 떠나는 펼침의 남는 반쪽은 실제 요소를 잘라 그대로 두고, 넘어가는 종이(앞 = 떠나는 쪽, 뒤 = 새로 올 쪽)만 복제해 책등 축으로 돌림.
     *  한 쪽 보기 판은 떠나는 쪽이 들려 넘어가고(앞으로), 돌아올 쪽이 내려앉음(뒤로) */
    const turnTo = (target, jump = false) => {
      const total = totalSteps();
      const clamped = Math.max(0, Math.min(target, total - 1));
      const delta = clamped - step;
      if (currentTurn) currentTurn.finish();
      if (!fxOn("turn") || delta === 0 || (Math.abs(delta) !== 1 && !jump)) {
        activate(target);
        return;
      }
      const single = isSinglePage();
      const forward = delta > 0;
      const fromIndex = single ? Math.floor(step / 2) : step;
      const toIndex = single ? Math.floor(clamped / 2) : clamped;
      const fromSide = single ? (step % 2 ? "right" : "left") : "";
      const toSide = single ? (clamped % 2 ? "right" : "left") : "";
      const from = spreads[fromIndex];
      const to = spreads[toIndex];
      const track = root.querySelector(".mn-codex__book-track");
      if (!from || !to || !track || !from.book.offsetWidth) {
        activate(target);
        return;
      }
      const doc = root.ownerDocument;
      const W = from.book.offsetWidth;
      const spine = from.rightPage ? from.rightPage.offsetLeft : Math.round(W / 2);
      // 떠나는 쪽 그림 모양은 넘기기 전에 재 둠 — 종이는 activate 뒤에 복제하는데, 그때 재면 그 쪽이 이미 숨어 있어
      // 크기 · 확대가 빠진 값(100% · none)이 나와 넘기기 시작할 때 그림이 작아짐
      const turnStyles = new Map();
      from.book.querySelectorAll("img").forEach((img) => {
        if (!img._mnTurnBitmap) return;
        const computed = getComputedStyle(img);
        turnStyles.set(img, TURN_IMAGE_STYLES.map((name) => [name, computed.getPropertyValue(name)]));
      });
      const ghost = (spread, side) => {
        const clone = spread.book.cloneNode(true);
        clone.classList.remove("is-active", "is-before", "is-after", "is-far", "is-turn-hold");
        clone.style.clipPath = "";
        clone.classList.add("mn-codex__turn-ghost");
        if (side) clone.classList.add(`mn-codex__turn-ghost--show-${side}`);
        clone.setAttribute("aria-hidden", "true");
        clone.setAttribute("inert", "");
        clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
        const originals = spread.book.querySelectorAll("img");
        clone.querySelectorAll("img").forEach((img, index) => {
          const original = originals[index];
          img.loading = "eager";
          const bitmap = original && original._mnTurnBitmap;
          if (!bitmap) return;
          const canvas = doc.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          canvas.className = img.className;
          let styles = turnStyles.get(original);
          if (!styles) {
            const computed = getComputedStyle(original);
            styles = TURN_IMAGE_STYLES.map((name) => [name, computed.getPropertyValue(name)]);
          }
          styles.forEach(([name, value]) => canvas.style.setProperty(name, value));
          img.replaceWith(canvas);
        });
        clone.style.width = `${W}px`;
        return clone;
      };
      const layer = (cls, parent) => {
        const el = doc.createElement("div");
        el.className = cls;
        parent.appendChild(el);
        return el;
      };
      const duration = single ? 520 : 760;
      root.classList.add("mn-codex--turning");
      // 도착 효과: 종이 밑에서 드러나는 쪽은 종이가 걷힐 즈음, 종이에 실려 오는 쪽(두 쪽 판의 뒷면 · 한 쪽 판에서 뒤로)은 종이가 다 내려앉은 뒤에
      const sheetPage = single ? (forward ? null : (toSide === "right" ? to.rightPage : to.leftPage)) : (forward ? to.leftPage : to.rightPage);
      arrivalDelay = single ? 360 : 500;
      arrivalSheet = sheetPage ? { page: sheetPage, delay: duration } : null;
      activate(target);
      arrivalDelay = 120;
      arrivalSheet = null;
      const stage = layer(`mn-codex__turn-stage${forward ? "" : " is-backward"}${single ? " is-single" : ""}`, track);
      stage.setAttribute("aria-hidden", "true");
      stage.style.setProperty("--mn-turn-spine", `${spine}px`);
      let hold = null;
      let sheet;
      if (!single) {
        // 두 쪽: 떠나는 펼침은 남는 반쪽만 보이게 잡아 둠
        hold = from.book;
        hold.classList.add("is-turn-hold");
        hold.style.clipPath = forward ? `inset(0 ${W - spine}px 0 0)` : `inset(0 0 0 ${spine}px)`;
        const width = forward ? W - spine : spine;
        sheet = layer("mn-codex__turn-sheet", stage);
        sheet.style.left = `${forward ? spine : 0}px`;
        sheet.style.width = `${width}px`;
        const front = layer("mn-codex__turn-face", sheet);
        const frontGhost = ghost(from, "");
        frontGhost.style.left = `${forward ? -spine : 0}px`;
        front.appendChild(frontGhost);
        layer("mn-codex__turn-shade", front);
        const back = layer("mn-codex__turn-face mn-codex__turn-face--back", sheet);
        markArrival(true);
        const backGhost = ghost(to, "");
        markArrival(false);
        backGhost.style.left = `${forward ? width - spine : -spine}px`;
        back.appendChild(backGhost);
        layer("mn-codex__turn-shade", back);
        layer("mn-codex__turn-under", stage);
        layer("mn-codex__turn-over", stage);
      } else {
        sheet = layer("mn-codex__turn-sheet", stage);
        sheet.style.left = "0px";
        sheet.style.width = `${W}px`;
        if (!forward) {
          const still = layer("mn-codex__turn-still", stage);
          still.appendChild(ghost(from, fromSide));
          stage.appendChild(sheet);
        }
        const face = layer("mn-codex__turn-face", sheet);
        // 표시는 복제한 뒤 · 붙이기 전에 뗌 (붙인 뒤에 떼면 종이 속 복제본의 표시까지 지워져 다 보였다가 꺼짐)
        if (!forward) markArrival(true);
        const faceGhost = ghost(forward ? from : to, forward ? fromSide : toSide);
        if (!forward) markArrival(false);
        face.appendChild(faceGhost);
        layer("mn-codex__turn-shade", face);
      }
      stage.style.setProperty("--mn-turn-ms", `${duration}ms`);
      const view = doc.defaultView || window;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        stage.remove();
        if (hold) {
          hold.classList.remove("is-turn-hold");
          hold.style.clipPath = "";
        }
        // 잡아 둔 펼침이 제자리(투명)로 돌아가는 순간 전환 효과가 다시 돌지 않게 한 박자 뒤에 풂
        view.requestAnimationFrame(() => root.classList.remove("mn-codex--turning"));
        if (currentTurn === turn) currentTurn = null;
      };
      const turn = { finish };
      currentTurn = turn;
      sheet.addEventListener("animationend", (event) => { if (event.target === sheet) finish(); });
      setTimeout(finish, duration + 600);
    };

    const goPrevious = () => {
      if (step === 0 && beforeFirst) {
        if (currentTurn) currentTurn.finish();
        beforeFirst();
        return;
      }
      turnTo(step - 1);
    };

    on(previous, "click", goPrevious);
    on(next, "click", () => turnTo(step + 1));
    on(root, "keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        turnTo(step + 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        activate(0);
      } else if (event.key === "End") {
        event.preventDefault();
        activate(totalSteps() - 1);
      }
    });

    if (sectionDestinations.length) {
      sectionDestinations.sort((a, b) => a.sectionIndex - b.sectionIndex);
      const bookmarks = root.createEl("nav", {
        cls: "mn-codex__bookmarks",
        attr: { "aria-label": "장 바로가기" },
      });
      root.insertBefore(bookmarks, reader);
      sectionDestinations.forEach((destination, index) => {
        const button = bookmarks.createEl("button", {
          cls: "mn-codex__bookmark",
          attr: {
            type: "button",
            "aria-label": `${destination.title} 장으로 이동`,
            title: `${destination.title} 장으로 이동`,
          },
        });
        button.createSpan({
          cls: "mn-codex__bookmark-index",
          text: String(index + 1).padStart(2, "0"),
        });
        button.createSpan({ cls: "mn-codex__bookmark-label", text: destination.title });
        bookmarkButtons.push({ button, destination });
        on(button, "click", () => jumpToSection(destination));
      });
    }

    const taggedDestinations = pageDestinations.filter((destination) => destination.tag);
    if (taggedDestinations.length) {
      const tags = root.createEl("nav", {
        cls: "mn-codex__page-tags",
        attr: { "aria-label": "페이지 바로가기" },
      });
      root.insertBefore(tags, reader);
      taggedDestinations.forEach((destination, index) => {
        const button = tags.createEl("button", {
          cls: "mn-codex__page-tag",
          attr: {
            type: "button",
            "aria-label": `${destination.title} 페이지로 이동`,
            title: `${destination.title} 페이지로 이동`,
          },
        });
        button.createSpan({ cls: "mn-codex__page-tag-index", text: String(index + 1).padStart(2, "0") });
        button.createSpan({ cls: "mn-codex__page-tag-label", text: destination.tag });
        tagButtons.push({ button, destination });
        on(button, "click", () => jumpToSection(destination));
      });
    }

    // 표지가 앞에 붙은 책장이면 장 띠 맨 앞에 「00 표지」(누르면 표지로). 칸 수는 띠 칸 나눔에 씀. 실험실 추가 2026-10-27
    let coverTag = null;
    const syncCoverTag = () => {
      const strip = root.querySelector(":scope > .mn-codex__page-tags");
      if (!strip) return;
      if (beforeFirst && !coverTag) {
        coverTag = strip.createEl("button", {
          cls: "mn-codex__page-tag mn-codex__page-tag--cover",
          attr: { type: "button", "aria-label": "표지로", title: "표지로" },
        });
        coverTag.createSpan({ cls: "mn-codex__page-tag-index", text: "00" });
        coverTag.createSpan({ cls: "mn-codex__page-tag-label", text: "표지" });
        strip.insertBefore(coverTag, strip.firstChild);
        on(coverTag, "click", (event) => {
          event.preventDefault();
          if (beforeFirst) beforeFirst();
        });
      } else if (!beforeFirst && coverTag) {
        coverTag.remove();
        coverTag = null;
      }
      strip.style.setProperty("--mn-strip-count", String(Math.max(5, strip.children.length)));
      strip.setAttr("data-mn-strip-many", strip.children.length > 5 ? "true" : null);
    };
    syncCoverTag();

    const bookTools = controls.createDiv({ cls: "mn-codex__book-tools" });
    const pagePicker = bookTools.createEl("select", {
      cls: "mn-codex__page-picker",
      attr: { "aria-label": "페이지 선택", title: "원하는 페이지로 이동" },
    });
    pageDestinations.forEach((destination) => {
      const option = pagePicker.createEl("option", {
        text: `${String(destination.pageIndex + 1).padStart(2, "0")} · ${destination.title}`,
        value: String(destination.pageIndex),
      });
      option.setAttr("data-mn-spread-index", String(destination.spreadIndex));
      option.setAttr("data-mn-side", destination.side);
    });
    on(pagePicker, "change", () => {
      const destination = pageDestinations.find((item) => item.pageIndex === Number(pagePicker.value));
      if (destination) jumpToSection(destination);
    });

    // 능력 목록 · 색인 줄을 누르면 그 능력의 펼침으로 (줄 안의 링크는 링크대로). 실험실 추가 2026-10-27
    root.querySelectorAll("[data-mn-goto-page]").forEach((target) => {
      const destination = pageDestinations.find((item) => item.pageIndex === Number(target.getAttribute("data-mn-goto-page")));
      if (!destination) return;
      const go = (event) => {
        if (event.target && typeof event.target.closest === "function" && event.target.closest("a")) return;
        event.preventDefault();
        event.stopPropagation();
        jumpToSection(destination);
      };
      on(target, "click", go);
      on(target, "keydown", (event) => { if (event.key === "Enter" || event.key === " ") go(event); });
    });

    const syncPicker = () => {
      const active = [...pageDestinations].reverse().find((destination) => destinationStep(destination) <= step);
      if (active) pagePicker.value = String(active.pageIndex);
    };
    on(root, "mn-codex-page-activated", syncPicker);

    const guideButton = bookTools.createEl("button", {
      cls: "mn-codex__layout-guide-button",
      text: "배치 편집",
      attr: { type: "button", "aria-pressed": "false", title: "이미지 배치 가이드 토글" },
    });
    const insertImageButton = bookTools.createEl("button", {
      cls: "mn-codex__insert-image-button",
      text: "이미지 넣기",
      attr: { type: "button", title: "현재 선택한 페이지에 이미지 추가" },
    });
    const setGuideActive = (active) => {
      root.classList.toggle("is-layout-guide", active);
      guideButton.classList.toggle("is-active", active);
      guideButton.setAttr("aria-pressed", active ? "true" : "false");
      root.dispatchEvent(new CustomEvent("mn-codex-guide-change", { detail: { active } }));
    };
    on(guideButton, "click", () => {
      const active = !root.classList.contains("is-layout-guide");
      setGuideActive(active);
      new Notice(active
        ? "이미지를 검색해 원하는 지면에 배치할 수 있습니다."
        : "이미지 배치 가이드를 닫았습니다.");
    });

    this.installBookImageGuide({
      root,
      guideButton,
      insertImageButton,
      pagePicker,
      placedPageImages,
      on,
      addCleanup: (cleanup) => cleanups.push(cleanup),
      setGuideActive,
      sourcePath,
    });

    // 다시 그린 책이면 처음 펼침(0번)에서 도착 효과를 틀지 않음 — 곧 보던 쪽으로 돌아감 (restore)
    hushed = Boolean(root._mnBookQuietStart);
    activate(0);
    // 그 걸음에 보이는 쪽들 · 그 쪽들에 시작하는 장 · 쪽 번호(data-mn-book-page-index)
    const stepPages = (s) => {
      const single = isSinglePage();
      const spread = spreads[single ? Math.floor(s / 2) : s];
      if (!spread) return [];
      return single ? [s % 2 ? spread.rightPage : spread.leftPage] : [spread.leftPage, spread.rightPage];
    };
    const headsAt = (s) => {
      const out = [];
      for (const page of stepPages(s)) if (page) page.querySelectorAll("[data-mn-book-page-index]").forEach((h) => out.push(Number(h.getAttribute("data-mn-book-page-index"))));
      return out;
    };
    return {
      activate,
      totalSteps,
      getStep: () => step,
      // 지금 자리: 가장 가까이 앞에서 시작한 장 · 쪽 번호 + 거기서 몇 걸음 더 넘겼는지 (폭이 바뀌어 쪽 나누기가 달라져도 같은 글로 돌아가게)
      anchor: () => {
        for (let s = step; s >= 0; s -= 1) {
          const heads = headsAt(s);
          if (heads.length) return { step, pageIndex: heads[heads.length - 1], offset: step - s };
        }
        return { step, pageIndex: null, offset: 0 };
      },
      restore: (anchor) => {
        let target = anchor.step;
        if (anchor.pageIndex !== null) {
          for (let s = 0; s < totalSteps(); s += 1) {
            if (headsAt(s).includes(anchor.pageIndex)) { target = s + anchor.offset; break; }
          }
        }
        hushed = true;
        activate(Math.min(Math.max(0, target), totalSteps() - 1));
        hushed = false;
      },
      setBeforeFirst: (callback) => {
        beforeFirst = typeof callback === "function" ? callback : null;
        syncCoverTag();
        activate(step);
      },
      setStatusOffset: (offset) => {
        const numericOffset = Number(offset);
        statusOffset = Number.isFinite(numericOffset) ? Math.max(0, Math.floor(numericOffset)) : 0;
        activate(step);
      },
      cleanup: () => {
        bookmarkJumpToken += 1;
        clearBookmarkAnimation();
        cleanups.forEach((cleanup) => cleanup());
        flipPool.dispose();
      },
      getPerformanceStats: () => ({
        spreadStateUpdates,
        flipPool: flipPool.snapshot(),
      }),
    };
  }

  installBookImageGuide({ root, guideButton, insertImageButton, pagePicker, placedPageImages, on, addCleanup = () => {}, setGuideActive, sourcePath }) {
    // Direct manipulation already handles move, resize, rotate and autosave.
    // Keep only a compact contextual strip inside the existing bottom tools.
    const context = (guideButton.parentElement || root).createDiv({ cls: "mn-codex__layout-context" });
    context.setAttr("aria-live", "polite");
    const selection = context.createSpan({ cls: "mn-codex__layout-guide-selection", text: "이미지 미선택" });
    const copyButton = context.createEl("button", { text: "설정 복사", attr: { type: "button", title: "현재 펼침의 이미지 설정 복사" } });
    const deleteButton = context.createEl("button", { text: "삭제", attr: { type: "button", title: "선택 이미지 제거 (Delete)" } });
    copyButton.disabled = true;
    deleteButton.disabled = true;

    let selectedFigure = null;
    let selectedFrame = null;
    let saveQueue = Promise.resolve();
    let activePointerCleanup = null;

    const startPointerTracking = (move, finish) => {
      if (activePointerCleanup) activePointerCleanup();
      let frameId = 0;
      let latestEvent = null;
      let active = true;
      const requestFrame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
      const cancelFrame = typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : clearTimeout;
      const flushMove = () => {
        frameId = 0;
        if (!active || !latestEvent) return;
        const event = latestEvent;
        latestEvent = null;
        move(event);
      };
      const handleMove = (event) => {
        latestEvent = event;
        if (!frameId) frameId = requestFrame(flushMove);
      };
      const cleanup = () => {
        if (!active) return;
        active = false;
        if (frameId) cancelFrame(frameId);
        frameId = 0;
        latestEvent = null;
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleFinish);
        document.removeEventListener("pointercancel", handleFinish);
        if (activePointerCleanup === cleanup) activePointerCleanup = null;
      };
      const handleFinish = (event) => {
        if (latestEvent) move(event || latestEvent);
        cleanup();
        finish();
      };
      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleFinish);
      document.addEventListener("pointercancel", handleFinish);
      activePointerCleanup = cleanup;
    };
    addCleanup(() => {
      if (activePointerCleanup) activePointerCleanup();
    });

    const styleNumber = (figure, key, fallback) => {
      // Number(null) and Number("") are both 0. During a rebuild, restored
      // figures have CSS custom properties before their data-mn-* cache is
      // initialized, so treating a missing attribute as zero collapses them to
      // x:0 / y:0 / width:3 and makes them appear to vanish after navigation.
      const rawDataValue = figure?.getAttribute(`data-mn-${key}`);
      if (rawDataValue !== null && rawDataValue !== undefined && String(rawDataValue).trim() !== "") {
        const dataValue = Number(rawDataValue);
        if (Number.isFinite(dataValue)) return dataValue;
      }
      const property = key === "width" ? "--mn-page-image-width" : `--mn-page-image-${key}`;
      const value = Number.parseFloat(figure?.style.getPropertyValue(property));
      return Number.isFinite(value) ? value : fallback;
    };
    const setGeometry = (figure, changes = {}) => {
      if (!figure) return;
      const values = {
        x: Math.max(0, Math.min(100, changes.x ?? styleNumber(figure, "x", 50))),
        y: Math.max(0, Math.min(100, changes.y ?? styleNumber(figure, "y", 50))),
        width: Math.max(3, Math.min(100, changes.width ?? styleNumber(figure, "width", 24))),
        rotate: Math.max(-180, Math.min(180, changes.rotate ?? styleNumber(figure, "rotate", 0))),
      };
      Object.entries(values).forEach(([key, value]) => figure.setAttr(`data-mn-${key}`, value.toFixed(1)));
      figure.style.setProperty("--mn-page-image-x", `${values.x.toFixed(1)}%`);
      figure.style.setProperty("--mn-page-image-y", `${values.y.toFixed(1)}%`);
      figure.style.setProperty("--mn-page-image-width", `${values.width.toFixed(1)}%`);
      figure.style.setProperty("--mn-page-image-rotate", `${values.rotate.toFixed(1)}deg`);
      figure.setAttr(
        "data-mn-position-label",
        `x ${values.x.toFixed(1)} · y ${values.y.toFixed(1)} · ${values.width.toFixed(1)}% · ${values.rotate.toFixed(0)}°`,
      );
    };
    const syncContext = () => {
      copyButton.disabled = !selectedFigure && !selectedFrame;
      deleteButton.disabled = !selectedFigure;
    };
    const selectFrame = (frame) => {
      root.querySelectorAll(".mn-codex__page-frame--copy.is-guide-target").forEach((item) => item.removeClass("is-guide-target"));
      selectedFrame = frame || null;
      if (selectedFrame) selectedFrame.addClass("is-guide-target");
      if (!selectedFigure) selection.setText(selectedFrame ? "삽입 지면 선택됨" : "이미지 미선택");
      syncContext();
    };
    const selectFigure = (figure) => {
      root.querySelectorAll(".mn-codex__placed-image.is-selected").forEach((item) => item.removeClass("is-selected"));
      selectedFigure = figure || null;
      if (!selectedFigure) {
        selection.setText(selectedFrame ? "삽입 지면 선택됨" : "이미지 미선택");
        syncContext();
        return;
      }
      selectedFigure.addClass("is-selected");
      selectFrame(null);
      const imageRef = selectedFigure.getAttribute("data-image-ref") || "이미지";
      selection.setText(imageRef.split("/").pop() || imageRef);
      syncContext();
      if (!selectedFigure.querySelector(":scope > .mn-codex__transform-controls")) {
        const controls = selectedFigure.createDiv({ cls: "mn-codex__transform-controls", attr: { "aria-hidden": "true" } });
        ["nw", "ne", "sw", "se"].forEach((corner) => {
          controls.createDiv({
            cls: `mn-codex__image-resize-handle mn-codex__image-resize-handle--${corner}`,
            attr: { "data-mn-corner": corner, title: "드래그하여 비율 유지 크기 조절" },
          });
        });
        controls.createDiv({ cls: "mn-codex__image-rotate-stem" });
        controls.createDiv({
          cls: "mn-codex__image-rotate-handle",
          attr: { title: "드래그하여 자유 회전" },
        });
      }
      setGeometry(selectedFigure);
    };
    const canvasForFrame = (frame) => frame?.closest(".mn-codex__book--turn")?.querySelector(":scope > .mn-codex__spread-image-layer") || null;
    const ensureGrid = () => {
      root.querySelectorAll(".mn-codex__spread-image-layer").forEach((layer) => {
        if (!layer.querySelector(":scope > .mn-codex__layout-grid")) {
          layer.createDiv({ cls: "mn-codex__layout-grid", attr: { "aria-hidden": "true" } });
        }
      });
      root.querySelectorAll(".mn-codex__page-frame--copy").forEach((frame) => {
        if (!frame.querySelector(":scope > .mn-codex__leaf-image-add")) {
          const page = frame.closest(".mn-codex__page");
          const side = frame.classList.contains("mn-codex__page-frame--mode-spread")
            ? "펼침"
            : page?.classList.contains("mn-codex__page--right") ? "오른쪽" : "왼쪽";
          const leafAdd = frame.createEl("button", {
            cls: "mn-codex__leaf-image-add",
            text: `${side} + 이미지`,
            attr: { type: "button", title: `${side} 지면에 이미지 추가` },
          });
          on(leafAdd, "click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPicker(frame);
          });
        }
      });
    };
    const bindFigure = (figure) => {
      if (!figure || figure.hasAttribute("data-mn-layout-bound")) return;
      figure.setAttr("data-mn-layout-bound", "true");
      setGeometry(figure);
      let dragging = false;
      let resizing = false;
      let rotating = false;
      let resizeStartWidth = 24;
      let resizeStartDistance = 1;
      let rotateStartAngle = 0;
      let rotateStartValue = 0;
      let transformCenterX = 0;
      let transformCenterY = 0;
      let dragOffsetX = 0;
      let dragOffsetY = 0;
      const move = (event) => {
        if ((!dragging && !resizing && !rotating) || !root.classList.contains("is-layout-guide")) return;
        const canvas = figure.closest(".mn-codex__spread-image-layer");
        const rect = canvas?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        if (resizing) {
          const distance = Math.max(1, Math.hypot(event.clientX - transformCenterX, event.clientY - transformCenterY));
          setGeometry(figure, { width: resizeStartWidth * (distance / resizeStartDistance) });
        } else if (rotating) {
          const angle = Math.atan2(event.clientY - transformCenterY, event.clientX - transformCenterX) * 180 / Math.PI;
          let rotate = rotateStartValue + angle - rotateStartAngle;
          while (rotate > 180) rotate -= 360;
          while (rotate < -180) rotate += 360;
          if (event.shiftKey) rotate = Math.round(rotate / 15) * 15;
          setGeometry(figure, { rotate });
        } else {
          setGeometry(figure, {
            x: ((event.clientX - dragOffsetX - rect.left) / rect.width) * 100,
            y: ((event.clientY - dragOffsetY - rect.top) / rect.height) * 100,
          });
        }
      };
      const finish = () => {
        const changed = dragging || resizing || rotating;
        const canvas = figure.closest(".mn-codex__spread-image-layer");
        dragging = false;
        resizing = false;
        rotating = false;
        figure.removeClass("is-dragging");
        figure.removeClass("is-resizing");
        figure.removeClass("is-rotating");
        if (changed) void saveFrame(canvas, true);
      };
      on(figure, "pointerdown", (event) => {
        if (!root.classList.contains("is-layout-guide")) return;
        event.preventDefault();
        event.stopPropagation();
        selectFigure(figure);
        const canvas = figure.closest(".mn-codex__spread-image-layer");
        const rect = canvas?.getBoundingClientRect();
        if (!rect?.width || !rect?.height) return;
        const currentX = styleNumber(figure, "x", 50);
        const currentY = styleNumber(figure, "y", 50);
        transformCenterX = rect.left + rect.width * currentX / 100;
        transformCenterY = rect.top + rect.height * currentY / 100;
        if (event.target.closest(".mn-codex__image-rotate-handle")) {
          rotating = true;
          rotateStartAngle = Math.atan2(event.clientY - transformCenterY, event.clientX - transformCenterX) * 180 / Math.PI;
          rotateStartValue = styleNumber(figure, "rotate", 0);
          figure.addClass("is-rotating");
        } else if (event.target.closest(".mn-codex__image-resize-handle")) {
          resizing = true;
          resizeStartWidth = styleNumber(figure, "width", 24);
          resizeStartDistance = Math.max(1, Math.hypot(event.clientX - transformCenterX, event.clientY - transformCenterY));
          figure.addClass("is-resizing");
        } else {
          dragging = true;
          dragOffsetX = event.clientX - transformCenterX;
          dragOffsetY = event.clientY - transformCenterY;
          figure.addClass("is-dragging");
        }
        startPointerTracking(move, finish);
      });
      on(figure, "click", (event) => {
        if (!root.classList.contains("is-layout-guide")) return;
        event.preventDefault();
        event.stopPropagation();
      });
    };
    const createFigure = (file, frame) => {
      const canvas = canvasForFrame(frame);
      const canvasRect = canvas?.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      if (!canvasRect?.width || !canvasRect?.height || !frameRect?.width || !frameRect?.height) return null;
      const figure = canvas.createEl("figure", { cls: "mn-codex__placed-image mn-codex__placed-image--guide-new" });
      figure.setAttr("data-image-ref", file.path);
      figure.setAttr("data-mn-opacity", "1");
      figure.setAttr("data-mn-fit", "contain");
      figure.createEl("img", {
        attr: {
          src: this.versionResource(this.app.vault.getResourcePath(file), file.stat?.mtime),
          alt: file.basename,
          decoding: "async",
          loading: "eager",
        },
      });
      setGeometry(figure, {
        x: ((frameRect.left - canvasRect.left) + frameRect.width / 2) / canvasRect.width * 100,
        y: ((frameRect.top - canvasRect.top) + frameRect.height / 2) / canvasRect.height * 100,
        width: frameRect.width / canvasRect.width * 24,
        rotate: 0,
      });
      bindFigure(figure);
      placedPageImages.push(figure);
      return figure;
    };
    const currentFrame = () => {
      const pageIndex = Number(pagePicker?.value);
      const byPage = Number.isInteger(pageIndex)
        ? root.querySelector(`.mn-codex__page-frame--copy[data-mn-book-page-index="${pageIndex}"]`)
        : null;
      if (byPage) return byPage;
      return root.querySelector(".mn-codex__book--turn.is-active .mn-codex__page-frame--copy");
    };
    const openPicker = (targetFrame = null) => {
      new VaultImagePickerModal(this.app, (file) => {
        if (!root.classList.contains("is-layout-guide")) setGuideActive(true);
        const frame = targetFrame?.isConnected ? targetFrame : currentFrame();
        if (!frame) return new Notice("이미지를 넣을 현재 페이지를 찾지 못했습니다.");
        selectFrame(frame);
        const figure = createFigure(file, frame);
        if (!figure) return;
        selectFigure(figure);
        void saveFrame(canvasForFrame(frame), true);
        new Notice("펼침 전체 캔버스에 이미지를 넣었습니다. 왼쪽·책등 중앙·오른쪽 어디든 끊김 없이 배치할 수 있습니다.");
      }).open();
    };
    const serialize = (frame) => {
      const figures = frame ? Array.from(frame.querySelectorAll(":scope > .mn-codex__placed-image")) : [];
      if (!figures.length) return "";
        const kind = frame.getAttribute("data-mn-book-page-kind");
      const baseIndent = kind === "entry" ? 8 : kind === "section" ? 4 : 2;
      const base = " ".repeat(baseIndent);
      const item = " ".repeat(baseIndent + 2);
      const property = " ".repeat(baseIndent + 4);
      const lines = [`${base}page_images:`];
      figures.forEach((figure) => {
        const imageRef = String(figure.getAttribute("data-image-ref") || "").replace(/\\/g, "/").replace(/"/g, '\\"');
        const opacity = Number.parseFloat(figure.style.getPropertyValue("--mn-page-image-opacity"));
        const fit = figure.style.getPropertyValue("--mn-page-image-fit").trim() || figure.getAttribute("data-mn-fit") || "contain";
        lines.push(`${item}- image: "${imageRef}"`);
        lines.push(`${property}x: ${styleNumber(figure, "x", 50).toFixed(1)}`);
        lines.push(`${property}y: ${styleNumber(figure, "y", 50).toFixed(1)}`);
        lines.push(`${property}width: ${styleNumber(figure, "width", 24).toFixed(1)}`);
        lines.push(`${property}rotate: ${styleNumber(figure, "rotate", 0).toFixed(1)}`);
        lines.push(`${property}opacity: ${Number.isFinite(opacity) ? opacity : 1}`);
        lines.push(`${property}fit: ${fit}`);
        lines.push(`${property}behind_text: ${figure.classList.contains("mn-codex__placed-image--behind") ? "true" : "false"}`);
        if (figure.classList.contains("mn-codex__placed-image--flip")) lines.push(`${property}flip: true`);
      });
      return lines.join("\n");
    };
    const frameImageData = (frame) => frame
      ? Array.from(frame.querySelectorAll(":scope > .mn-codex__placed-image")).map((figure) => ({
          image: String(figure.getAttribute("data-image-ref") || "").replace(/\\/g, "/"),
          x: Number(styleNumber(figure, "x", 50).toFixed(1)),
          y: Number(styleNumber(figure, "y", 50).toFixed(1)),
          width: Number(styleNumber(figure, "width", 24).toFixed(1)),
          rotate: Number(styleNumber(figure, "rotate", 0).toFixed(1)),
          opacity: Number.parseFloat(figure.style.getPropertyValue("--mn-page-image-opacity")) || 1,
          fit: figure.style.getPropertyValue("--mn-page-image-fit").trim() || figure.getAttribute("data-mn-fit") || "contain",
          behind_text: figure.classList.contains("mn-codex__placed-image--behind"),
          flip: figure.classList.contains("mn-codex__placed-image--flip"),
        }))
      : [];
    const saveFrames = (frames, silent = false) => {
      const targets = Array.from(new Set(Array.from(frames || []).filter(Boolean)));
      const valid = targets.filter((frame) => frame.getAttribute("data-mn-book-persist-key"));
      if (!valid.length) {
        if (!silent) new Notice("이 페이지의 저장 위치를 찾지 못했습니다.");
        return Promise.resolve(false);
      }
      const write = async () => {
        valid.forEach((frame) => {
          const key = frame.getAttribute("data-mn-book-persist-key");
          this.pageImageLayouts[key] = frameImageData(frame);
        });
        this.persistedData = { ...(this.persistedData || {}), pageImageLayouts: this.pageImageLayouts };
        await this.saveData(this.persistedData);
        if (!silent) new Notice("현재 펼침 전체의 이미지 배치를 저장했습니다.");
        return true;
      };
      saveQueue = saveQueue.then(write, write);
      return saveQueue;
    };
    const saveFrame = (frame, silent = false) => saveFrames([frame], silent);

    placedPageImages.forEach(bindFigure);
    const handleGuideChange = (event) => {
      const active = Boolean(event.detail?.active);
      if (active) {
        ensureGrid();
      } else {
        root.removeClass("is-placing-image");
        selectFigure(null);
        selectFrame(null);
      }
    };
    on(root, "mn-codex-guide-change", handleGuideChange);
    on(insertImageButton, "click", () => openPicker());
    const removeSelected = () => {
      if (!selectedFigure) return;
      const frame = selectedFigure.closest(".mn-codex__spread-image-layer");
      selectedFigure.remove();
      selectedFigure = null;
      selectFrame(null);
      selection.setText("이미지 미선택");
      syncContext();
      void saveFrame(frame, true);
    };
    on(deleteButton, "click", removeSelected);
    on(root, "keydown", (event) => {
      if (!root.classList.contains("is-layout-guide") || !selectedFigure) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      removeSelected();
    });
    on(copyButton, "click", async () => {
      const frame = selectedFigure?.closest(".mn-codex__spread-image-layer") || canvasForFrame(selectedFrame);
      if (!frame) return new Notice("먼저 이미지를 놓거나 지면을 클릭하세요.");
      const snippet = serialize(frame);
      if (!snippet) return new Notice("선택한 지면에 이미지가 없습니다.");
      try {
        await navigator.clipboard.writeText(snippet);
        new Notice("현재 지면의 page_images 설정을 복사했습니다.");
      } catch (_error) {
        new Notice("클립보드 복사 권한을 확인하세요.");
      }
    });
    on(root, "click", (event) => {
      if (!root.classList.contains("is-layout-guide")) return;
      if (event.target.closest(".mn-codex__book-tools, .mn-codex__leaf-image-add, .mn-codex__placed-image")) return;
      const frame = event.target.closest(".mn-codex__book--turn.is-active .mn-codex__page-frame--copy");
      if (!frame) return;
      selectFigure(null);
      selectFrame(frame);
    });
  }

  async renderMarkdownWithPageBreaks(value, parent, sourcePath, component) {
    const markdown = this.asText(value);
    if (!markdown) return;
    const segments = markdown.split(PAGE_BREAK_PATTERN);
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index].trim()) {
        await this.renderMarkdown(segments[index], parent, sourcePath, component);
      }
      if (index < segments.length - 1) {
        parent.createDiv({ cls: "mn-codex__page-break-marker" });
      }
    }
  }

  /** 목록 · 표가 없고 문단이 하나뿐인 쪽 표시. 예전엔 CSS :has() 로 골랐는데, 쪽 나누기 중 글을 넣을 때마다 쪽 스타일을
   *  통째로 다시 계산하게 해서 책장 열기가 느렸음(렉). 실험실 추가 2026-10-28 */
  markLoneParagraph(body) {
    if (!body || !body.classList || !body.classList.contains("mn-codex__prose--page")) return;
    const lone = !body.querySelector(".mn-codex__sheet, ul, ol") && body.querySelectorAll(":scope > p").length === 1;
    if (body.classList.contains("mn-codex__prose--lone") !== lone) body.classList.toggle("mn-codex__prose--lone", lone);
  }

  /** 지면이 든 노트 화면 · 지면이 든 칸 표시 (보정 · 전체 화면 조각 CSS 가 예전엔 :has() 로 찾았는데, 지면 안에 글을 넣을 때마다
   *  노트 화면 전체 스타일을 다시 계산하게 해서 느렸음). 노트를 닫거나 바꾸면 표시를 거둠 */
  markCodexView(host, component) {
    let tries = 0;
    const mark = () => {
      const view = typeof host.closest === "function" ? host.closest(".markdown-preview-view, .markdown-source-view") : null;
      if (!view) {
        tries += 1;
        if (tries < 40) setTimeout(mark, 50);
        return;
      }
      view.classList.add("mn-codex-has-spread");
      const section = host.closest(".markdown-preview-sizer > div");
      if (section) section.classList.add("mn-codex-section");
      if (component && typeof component.register === "function") {
        component.register(() => setTimeout(() => {
          if (!view.querySelector(".mn-codex--spread")) view.classList.remove("mn-codex-has-spread");
        }, 0));
      }
    };
    mark();
  }

  isPageOverflowing(body) {
    this.markLoneParagraph(body);
    const height = Number(body.clientHeight || 0);
    if (!height) return false;
    return Number(body.scrollHeight || 0) > height + 2;
  }

  cloneElementTextRange(element, start, end) {
    if (!element || element.nodeType !== 1) return null;
    const documentRef = element.ownerDocument;
    const textLength = String(element.textContent || "").length;
    const from = Math.max(0, Math.min(Number(start) || 0, textLength));
    const to = Math.max(from, Math.min(Number(end) || 0, textLength));
    if (to <= from) return null;

    const walker = documentRef.createTreeWalker(element, 4);
    const textNodes = [];
    let textNode = walker.nextNode();
    while (textNode) {
      textNodes.push(textNode);
      textNode = walker.nextNode();
    }
    if (!textNodes.length) return null;

    const resolveBoundary = (offset, atEnd = false) => {
      if (offset <= 0) return { node: element, offset: 0 };
      let consumed = 0;
      for (const node of textNodes) {
        const length = String(node.nodeValue || "").length;
        if (offset <= consumed + length) {
          return { node, offset: Math.max(0, Math.min(length, offset - consumed)) };
        }
        consumed += length;
      }
      return atEnd
        ? { node: element, offset: element.childNodes.length }
        : { node: textNodes[textNodes.length - 1], offset: String(textNodes[textNodes.length - 1].nodeValue || "").length };
    };

    const range = documentRef.createRange();
    const startBoundary = resolveBoundary(from, false);
    const endBoundary = resolveBoundary(to, true);
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);
    const clone = element.cloneNode(false);
    clone.appendChild(range.cloneContents());
    return clone;
  }

  getTextCutOffsets(text) {
    const value = String(text || "");
    if (!value) return { preferred: [], codePoints: [] };
    const preferred = new Set();
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
        for (const segment of segmenter.segment(value)) {
          const offset = segment.index + segment.segment.length;
          if (offset > 0 && offset < value.length) preferred.add(offset);
        }
      } catch (error) {
        // Fall through to punctuation and code-point boundaries.
      }
    }
    for (let index = 1; index < value.length; index += 1) {
      if (/\s|[.!?…,:;。！？、)\]}]/u.test(value[index - 1])) preferred.add(index);
    }

    const codePointOffsets = [];
    let offset = 0;
    for (const character of Array.from(value)) {
      offset += character.length;
      if (offset < value.length) codePointOffsets.push(offset);
    }
    return {
      preferred: Array.from(preferred).sort((a, b) => a - b),
      codePoints: codePointOffsets,
    };
  }

  splitTextElementToFit(element, body) {
    if (!element || element.nodeType !== 1 || !body) return null;
    if (!element.matches("p, blockquote, pre")) return null;
    if (element.querySelector("img, svg, canvas, video, audio, iframe, input, table, .math, .math-block, .mermaid")) {
      return null;
    }
    const text = String(element.textContent || "");
    const totalLength = text.length;
    if (totalLength < 2) return null;

    const offsets = this.getTextCutOffsets(text);
    const hasPriorBodyCopy = Array.from(body.children).some((child) => (
      !child.classList.contains("mn-codex__heading--book-page")
      && !child.classList.contains("mn-codex__book-illustration")
    ));
    const minimumHead = totalLength >= 40 && hasPriorBodyCopy ? 12 : 1;
    const minimumTail = totalLength >= 40 ? 12 : 1;
    const findBest = (candidates) => {
      const usable = candidates.filter((offset) => offset >= minimumHead && offset <= totalLength - minimumTail);
      let low = 0;
      let high = usable.length - 1;
      let best = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const cut = usable[middle];
        const candidate = this.cloneElementTextRange(element, 0, cut);
        if (!candidate) {
          high = middle - 1;
          continue;
        }
        body.appendChild(candidate);
        const fits = !this.isPageOverflowing(body);
        candidate.remove();
        if (fits) {
          best = cut;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return best;
    };

    let bestCut = findBest(offsets.preferred);
    if (!bestCut) bestCut = findBest(offsets.codePoints);
    if (!bestCut || bestCut >= totalLength) return null;

    const head = this.cloneElementTextRange(element, 0, bestCut);
    const tail = this.cloneElementTextRange(element, bestCut, totalLength);
    if (!head || !tail || !String(head.textContent || "").trim() || !String(tail.textContent || "").trim()) {
      return null;
    }
    head.classList.add("mn-codex__flow-fragment", "mn-codex__flow-fragment--head");
    tail.classList.add("mn-codex__flow-fragment", "mn-codex__flow-fragment--tail");
    return { head, tail };
  }

  splitListToFit(element, body) {
    if (!element || element.nodeType !== 1 || !element.matches("ul, ol") || !body) return null;
    const items = Array.from(element.children).filter((child) => child.tagName === "LI");
    if (items.length < 2) return null;
    const buildList = (start, end) => {
      const list = element.cloneNode(false);
      items.slice(start, end).forEach((item) => list.appendChild(item.cloneNode(true)));
      if (list.tagName === "OL" && start > 0) {
        const base = Number(element.getAttribute("start") || 1);
        list.setAttribute("start", String((Number.isFinite(base) ? base : 1) + start));
      }
      // 번호 줄 목록(전용 지면의 CSS 카운터)도 넘어간 쪽에서 번호를 이어서. 실험실 추가 2026-10-27
      if (list.tagName === "UL" && start > 0) {
        const offset = (Number(element.getAttribute("data-mn-list-offset")) || 0) + start;
        list.setAttribute("data-mn-list-offset", String(offset));
        list.style.counterReset = `mnsk ${offset}`;
      }
      return list;
    };

    let low = 1;
    let high = items.length - 1;
    let bestCount = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = buildList(0, middle);
      body.appendChild(candidate);
      const fits = !this.isPageOverflowing(body);
      candidate.remove();
      if (fits) {
        bestCount = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    // 쪽 끝 · 다음 쪽 머리에 한 줄만 외톨이로 남기지 않음(앞뒤 모두 두 줄 이상, 안 되면 목록째 넘김). 실험실 추가 2026-10-27
    if (items.length - bestCount < 2) bestCount = items.length - 2;
    if (bestCount < 2) return null;
    if (!bestCount || bestCount >= items.length) return null;
    const head = buildList(0, bestCount);
    const tail = buildList(bestCount, items.length);
    head.classList.add("mn-codex__flow-fragment", "mn-codex__flow-fragment--head");
    tail.classList.add("mn-codex__flow-fragment", "mn-codex__flow-fragment--tail");
    return { head, tail };
  }

  splitFlowNodeToFit(node, body) {
    if (!node || node.nodeType !== 1) return null;
    return this.splitListToFit(node, body) || this.splitTextElementToFit(node, body);
  }

  waitForLayout() {
    return new Promise((resolve) => {
      const frame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
      frame(() => frame(resolve));
    });
  }

  createFolio(parent, value, side) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    parent.createDiv({
      cls: `mn-codex__folio mn-codex__folio--${side}`,
      text: this.asText(value),
    });
  }

  async renderProfile(data, root, sourcePath, component) {
    const header = root.createDiv({ cls: "mn-codex__profile-header" });
    this.createHeading(data, header);

    const grid = root.createDiv({ cls: "mn-codex__profile-grid" });
    await this.createFigure(data, grid, sourcePath, component, "portrait");
    const panel = grid.createDiv({ cls: "mn-codex__profile-panel" });

    if (data.quote) {
      this.createInlineQuote(data.quote, panel);
    }
    await this.createFacts(data.facts, panel, sourcePath, component);
    if (data.content) {
      const body = panel.createDiv({ cls: "mn-codex__prose" });
      await this.renderMarkdown(data.content, body, sourcePath, component);
    }
  }

  async renderCreature(data, root, sourcePath, component) {
    const positionInput = this.asText(data.image_position, "left").toLowerCase();
    const position = IMAGE_POSITIONS.has(positionInput) ? positionInput : "left";
    root.addClass(`mn-codex--image-${position}`);

    const header = root.createDiv({ cls: "mn-codex__creature-header" });
    this.createHeading(data, header);
    const grid = root.createDiv({ cls: "mn-codex__creature-grid" });
    const figure = await this.createFigure(data, grid, sourcePath, component, "creature");
    const panel = grid.createDiv({ cls: "mn-codex__creature-panel" });
    if (position === "right") {
      grid.insertBefore(panel, figure);
    }

    await this.createFacts(data.facts, panel, sourcePath, component);
    this.createTraits(data.traits, panel);
    if (data.content) {
      const body = panel.createDiv({ cls: "mn-codex__prose" });
      await this.renderMarkdown(data.content, body, sourcePath, component);
    }
  }

  async renderInfobox(data, root, sourcePath, component) {
    const frame = root.createDiv({ cls: "mn-codex__infobox-frame" });
    if (data.image) {
      await this.createFigure(data, frame, sourcePath, component, "emblem");
    }
    this.createHeading(data, frame);
    await this.createFacts(data.facts, frame, sourcePath, component);
    if (data.content) {
      const body = frame.createDiv({ cls: "mn-codex__prose" });
      await this.renderMarkdown(data.content, body, sourcePath, component);
    }
  }

  async renderSkills(data, root, sourcePath, component) {
    const heading = root.createDiv({ cls: "mn-codex__skills-header" });
    this.createHeading(data, heading);
    const requestedColumns = Number.parseInt(data.columns, 10);
    const columns = requestedColumns === 1 || requestedColumns === 3 ? requestedColumns : 2;
    root.addClass(`mn-codex--columns-${columns}`);

    const skills = Array.isArray(data.skills) ? data.skills : [];
    const grid = root.createDiv({ cls: "mn-codex__skills-grid" });
    if (!skills.length) {
      grid.createDiv({ cls: "mn-codex__empty", text: "skills 목록이 비어 있습니다." });
      return;
    }

    for (const entry of skills) {
      const skill = entry && typeof entry === "object" ? entry : { name: entry };
      const card = grid.createDiv({ cls: "mn-codex__skill-card" });
      const cardHead = card.createDiv({ cls: "mn-codex__skill-head" });
      cardHead.createSpan({
        cls: "mn-codex__skill-icon",
        text: this.asText(skill.icon, "✦"),
      });
      const titles = cardHead.createDiv({ cls: "mn-codex__skill-titles" });
      titles.createDiv({ cls: "mn-codex__skill-name", text: this.asText(skill.name, "이름 없는 기술") });
      if (skill.rank) {
        titles.createDiv({ cls: "mn-codex__skill-rank", text: this.asText(skill.rank) });
      }
      if (skill.description) {
        const description = card.createDiv({ cls: "mn-codex__skill-description" });
        await this.renderMarkdown(skill.description, description, sourcePath, component);
      }
    }
  }

  renderQuote(data, root) {
    const mark = root.createDiv({ cls: "mn-codex__quote-mark", text: "“" });
    mark.setAttr("aria-hidden", "true");
    root.createEl("blockquote", {
      cls: "mn-codex__quote-text",
      text: this.asText(data.quote || data.content, "인용문을 입력하세요."),
    });
    if (data.attribution) {
      root.createDiv({
        cls: "mn-codex__quote-attribution",
        text: `— ${this.asText(data.attribution)}`,
      });
    }
  }

  renderDivider(data, root) {
    root.createDiv({ cls: "mn-codex__divider-rule mn-codex__divider-rule--start" });
    const copy = root.createDiv({ cls: "mn-codex__divider-copy" });
    this.createHeading(data, copy);
    root.createDiv({ cls: "mn-codex__divider-ornament", text: "◆" });
    root.createDiv({ cls: "mn-codex__divider-rule mn-codex__divider-rule--end" });
  }

  async renderSpoiler(data, root, sourcePath, component) {
    const details = root.createEl("details", { cls: "mn-codex__spoiler" });
    if (data.open === true) {
      details.setAttr("open", "");
    }
    details.createEl("summary", {
      text: this.asText(data.title || data.spoiler_title, "작가 전용 · 진실 보기"),
    });
    const body = details.createDiv({ cls: "mn-codex__spoiler-body" });
    await this.renderMarkdown(data.content || "숨겨진 내용을 입력하세요.", body, sourcePath, component);
  }

  // ---------- 장마다 다른 틀 (개요 · 능력 · 관계). 실험실 추가 2026-10-27 ----------
  // 장에 `template: 개요 | 능력 | 관계 | 기본`을 적으면 그 틀, 안 적으면 캐릭터 전용 지면(layout_variant)일 때만 장 제목으로 고름.
  // 글은 작가가 쓴 그대로 두고 놓는 모양만 바꿈 (「이름 : 값」 표를 인물 카드로, 「신탁 : 네이그림」을 종류 표식 + 이름으로, 관계 쪽은 두 사람을 잇는 그림).

  bookTemplateOf(section, data) {
    const names = { "개요": "overview", overview: "overview", "능력": "ability", ability: "ability", "관계": "relation", relation: "relation", "여담": "personal", personal: "personal", "기본": "", plain: "", none: "" };
    const raw = this.asText(section && (section.template ?? section["틀"])).trim().toLowerCase();
    if (raw) return Object.prototype.hasOwnProperty.call(names, raw) ? names[raw] : "";
    if (!this.asText(data && data.layout_variant).trim()) return "";
    const title = this.asText(section && section.title);
    if (/개요|소개|프로필|기본\s*정보/u.test(title)) return "overview";
    if (/능력|기술|전투|스킬/u.test(title)) return "ability";
    if (/관계|인연/u.test(title)) return "relation";
    if (/여담|취향|사적|비하인드/u.test(title)) return "personal";
    return "";
  }

  /** 제목 아래로 이 쪽에 렌더된 글 노드들(다음 쪽 나눔 표시 전까지) */
  templateNodesAfter(heading) {
    const nodes = [];
    for (let node = heading.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node.classList.contains("mn-codex__book-entry-break")) break;
      nodes.push(node);
    }
    return nodes;
  }

  /** 「종류 : 이름」을 첫 쌍점에서 둘로 (링크는 그대로 옮김). 쌍점이 없으면 null */
  splitTypeName(container) {
    const kids = Array.from(container.childNodes);
    const at = kids.findIndex((node) => node.nodeType === 3 && /[:：]/u.test(node.textContent));
    if (at < 0) return null;
    const doc = container.ownerDocument;
    const type = doc.createElement("span");
    const name = doc.createElement("span");
    kids.slice(0, at).forEach((node) => type.appendChild(node));
    const [before, ...after] = kids[at].textContent.split(/[:：]/u);
    if (before.trim()) type.appendChild(doc.createTextNode(before.trim()));
    const rest = after.join(":").replace(/^\s+/u, "");
    if (rest) name.appendChild(doc.createTextNode(rest));
    kids.slice(at + 1).forEach((node) => name.appendChild(node));
    kids[at].remove();
    if (!type.textContent.trim() || !name.textContent.trim()) return null;
    return { type, name };
  }

  /** 「A, B」 값을 칩 여러 개로 (쉼표가 글 노드 안에 있을 때만 자름, 링크는 통째로) */
  valueChips(dd, doc) {
    const chips = [];
    let chip = doc.createElement("span");
    const flush = () => { if (chip.textContent.trim()) { chip.className = "mn-codex__ov-chip"; chips.push(chip); } chip = doc.createElement("span"); };
    for (const node of Array.from(dd.childNodes)) {
      if (node.nodeType !== 3) { chip.appendChild(node); continue; }
      const parts = node.textContent.split(/[,，、]/u);
      parts.forEach((part, i) => {
        if (i > 0) flush();
        const text = i === 0 ? part.replace(/^\s+/u, "") : part.trim();
        if (text) chip.appendChild(doc.createTextNode(text));
      });
    }
    flush();
    return chips;
  }

  async shapeBookTemplate(pageData, heading, data, sourcePath, configuredPages, component) {
    const template = this.asText(pageData && pageData._mnBookTemplate);
    if (!template || !heading) return;
    const kind = this.asText(pageData._mnBookPageKind);
    heading.classList.add(`mn-codex__heading--tpl-${template}`);
    try {
      if (template === "overview") this.shapeOverview(heading, data, sourcePath);
      else if (template === "ability") this.shapeAbility(pageData, heading, kind, sourcePath, configuredPages, data);
      else if (template === "relation") await this.shapeRelation(pageData, heading, kind, data, sourcePath, component);
      else if (template === "personal" && kind === "section") this.shapePersonal(heading);
    } catch (error) {
      console.warn("MN Codex: 틀을 입히지 못했어요", template, error);
    }
  }

  /** 개요: 「이름 : 값」 표를 인물 카드로 — 이명 · 이름(큰 이름), 소개 한 줄, 투력 · 항력(큰 숫자), 겉모습(작은 표), 소속 · 능력(칩) */
  shapeOverview(heading, data, sourcePath) {
    // 장 첫 쪽은 머리글을 한 줄로: 「SECTION 01 · 개요」 (큰 장 제목 · 영문 부제 · 머리줄은 CSS 에서 숨김, 인물 이름이 주인공)
    const index = heading.querySelector(".mn-codex__section-index");
    const sectionTitle = heading.getAttribute("data-mn-book-section-title");
    if (index && sectionTitle) index.textContent = `${index.textContent} · ${sectionTitle}`;
    const nodes = this.templateNodesAfter(heading);
    const dl = nodes.find((node) => node.nodeType === 1 && node.matches("dl.mn-codex__sheet"));
    if (!dl) return;
    const doc = dl.ownerDocument;
    const pairs = [];
    for (const dt of Array.from(dl.querySelectorAll("dt"))) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== "DD") continue;
      pairs.push({ key: dt.textContent.replace(/[:：]\s*$/u, "").trim(), dt, dd });
    }
    const take = (keys) => keys.map((key) => {
      const at = pairs.findIndex((pair) => pair.key === key);
      return at < 0 ? null : pairs.splice(at, 1)[0];
    }).filter(Boolean);
    const [alias] = take(["이명"]);
    const [name] = take(["이름"]);
    const stats = take(["투력", "항력", "등위"]);
    const affiliation = take(["소속"]);
    const abilities = take(["신탁", "신기"]);
    const profile = pairs;

    const blocks = [];
    const block = (cls) => { const div = doc.createElement("div"); div.className = cls; blocks.push(div); return div; };
    const label = (parent, text) => { const div = doc.createElement("div"); div.className = "mn-codex__ov-label"; div.textContent = text; parent.appendChild(div); return div; };
    if (alias || name) {
      const hero = block("mn-codex__ov-hero");
      if (alias) { const span = doc.createElement("div"); span.className = "mn-codex__ov-alias"; Array.from(alias.dd.childNodes).forEach((n) => span.appendChild(n)); hero.appendChild(span); }
      if (name) { const span = doc.createElement("div"); span.className = "mn-codex__ov-name"; Array.from(name.dd.childNodes).forEach((n) => span.appendChild(n)); hero.appendChild(span); }
    }
    // 표 바로 뒤 첫 문단(소개 한 줄)을 이름 밑으로
    const after = nodes.slice(nodes.indexOf(dl) + 1).find((node) => node.nodeType === 1);
    if (after && after.tagName === "P") { after.classList.add("mn-codex__ov-lead"); blocks.push(after); }
    if (stats.length) {
      const row = block("mn-codex__ov-stats");
      for (const stat of stats) {
        const cell = doc.createElement("div");
        cell.className = "mn-codex__ov-stat";
        const k = doc.createElement("div"); k.className = "mn-codex__ov-stat-key"; Array.from(stat.dt.childNodes).forEach((n) => k.appendChild(n));
        const v = doc.createElement("div"); v.className = "mn-codex__ov-stat-value"; Array.from(stat.dd.childNodes).forEach((n) => v.appendChild(n));
        cell.append(k, v);
        row.appendChild(cell);
      }
    }
    if (profile.length) {
      const wrap = block("mn-codex__ov-profile");
      label(wrap, "PROFILE");
      const list = doc.createElement("dl");
      list.className = "mn-codex__ov-grid";
      for (const pair of profile) {
        const item = doc.createElement("div");
        item.append(pair.dt, pair.dd);
        list.appendChild(item);
      }
      wrap.appendChild(list);
    }
    const chipRow = (pairsIn, title, withKey) => {
      if (!pairsIn.length) return;
      const row = block("mn-codex__ov-row");
      label(row, title);
      const chips = doc.createElement("div");
      chips.className = "mn-codex__ov-chips";
      for (const pair of pairsIn) {
        if (withKey) {
          const chip = doc.createElement("span");
          chip.className = "mn-codex__ov-chip mn-codex__ov-chip--keyed";
          const k = doc.createElement("span"); k.className = "mn-codex__ov-chip-key"; k.textContent = pair.key;
          const v = doc.createElement("span"); Array.from(pair.dd.childNodes).forEach((n) => v.appendChild(n));
          chip.append(k, v);
          chips.appendChild(chip);
        } else {
          this.valueChips(pair.dd, doc).forEach((chip) => chips.appendChild(chip));
        }
      }
      row.appendChild(chips);
      return row;
    };
    // 소속: 「조직도에서 보기 ↗」(이 인물 카드 → 소속 조직 순으로 찾아 가운데로), 링크 없는 칩은 눌러서 그 조직으로. 실험실 추가 2026-10-28
    const selfName = this.asText(data && (data._mnCharacterName || data.title)).trim();
    const affRow = chipRow(affiliation, "AFFILIATION", false);
    if (affRow) {
      const chipEls = Array.from(affRow.querySelectorAll(".mn-codex__ov-chip"));
      const orgNames = chipEls.map((chip) => chip.textContent.trim()).filter(Boolean);
      const go = doc.createElement("button");
      go.type = "button";
      go.className = "mn-codex__ov-go";
      go.textContent = "조직도에서 보기 ↗";
      go.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); this.showInOrgChart([selfName, ...orgNames]); });
      affRow.querySelector(".mn-codex__ov-label").appendChild(go);
      for (const chip of chipEls) {
        if (chip.querySelector("a")) continue;
        chip.classList.add("is-org");
        chip.setAttribute("role", "button");
        chip.setAttribute("tabindex", "0");
        chip.title = `조직도에서 「${chip.textContent.trim()}」 보기`;
        const open = (event) => { event.preventDefault(); event.stopPropagation(); this.showInOrgChart([chip.textContent.trim()]); };
        chip.addEventListener("click", open);
        chip.addEventListener("keydown", (event) => { if (event.key === "Enter") open(event); });
      }
    }
    chipRow(abilities, "ABILITY", true);
    // 위치: 노트 속성 「위치」가 있으면 「지도에서 보기 ↗」(세계판에서 이 인물로)
    const front = this.noteFrontmatter(sourcePath);
    const place = front ? this.plainLink(front["위치"]) : "";
    if (place) {
      const row = block("mn-codex__ov-row");
      const head = label(row, "LOCATION");
      const go = doc.createElement("button");
      go.type = "button";
      go.className = "mn-codex__ov-go";
      go.textContent = "지도에서 보기 ↗";
      go.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); this.showOnMap(sourcePath); });
      head.appendChild(go);
      const chips = doc.createElement("div");
      chips.className = "mn-codex__ov-chips";
      const chip = doc.createElement("span");
      chip.className = "mn-codex__ov-chip";
      chip.textContent = place;
      chips.appendChild(chip);
      row.appendChild(chips);
    }
    // 표 자리에 블록들을 차례로 (블록마다 따로 놓아 넘치면 다음 쪽으로 이어지게)
    for (const div of blocks) dl.parentNode.insertBefore(div, dl);
    dl.remove();
  }

  /** 여담: 「좋아하는 것 · 싫어하는 것 · 취미 … : 값」은 왼쪽 석판에 칩 묶음(값이 비면 「—」), 「한마디 · 좌우명 : 값」은 인용 상자(비면 숨김),
   *  목록(「- …」)은 오른쪽 종이에 번호 붙은 여담 줄(없으면 「01 —」 한 줄). 글은 쓴 그대로이고 놓는 모양만 바뀜. 실험실 추가 2026-10-28 */
  shapePersonal(heading) {
    const doc = heading.ownerDocument;
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const nodes = this.templateNodesAfter(heading).filter((node) => node.nodeType === 1);
    const dl = nodes.find((node) => node.matches("dl.mn-codex__sheet"));
    const pairs = [];
    if (dl) {
      for (const dt of Array.from(dl.querySelectorAll("dt"))) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") pairs.push({ key: dt.textContent.replace(/[:：]\s*$/u, "").trim(), dt, dd });
      }
    }
    const QUOTE = /^(한마디|좌우명|말버릇|입버릇)$/u;
    const groups = pairs.filter((pair) => !QUOTE.test(pair.key));
    const quote = pairs.find((pair) => QUOTE.test(pair.key) && pair.dd.textContent.trim());
    const lists = nodes.filter((node) => /^(UL|OL)$/u.test(node.tagName));
    const last = nodes.length ? nodes[nodes.length - 1] : heading;

    const likes = el("div", "mn-codex__pe-likes");
    for (const pair of groups) {
      const row = el("div", "mn-codex__pe-group");
      const key = el("div", "mn-codex__pe-key");
      Array.from(pair.dt.childNodes).forEach((node) => key.appendChild(node));
      const values = el("div", "mn-codex__pe-chips");
      const chips = this.valueChips(pair.dd, doc);
      if (chips.length) chips.forEach((chip) => { chip.className = "mn-codex__pe-chip"; values.appendChild(chip); });
      else values.appendChild(el("span", "mn-codex__pe-empty", "—"));
      row.append(key, values);
      likes.appendChild(row);
    }

    const trivia = el("div", "mn-codex__pe-trivia");
    trivia.appendChild(el("div", "mn-codex__ov-label mn-codex__pe-label", "TRIVIA"));
    const items = lists.flatMap((list) => Array.from(list.children).filter((child) => child.tagName === "LI"));
    const rows = items.length ? items : [null];
    rows.forEach((li, index) => {
      const row = el("div", "mn-codex__pe-item");
      row.appendChild(el("em", "", String(index + 1).padStart(2, "0")));
      const text = el("div", "mn-codex__pe-text");
      if (li) Array.from(li.childNodes).forEach((node) => text.appendChild(node));
      else { text.textContent = "—"; text.classList.add("is-empty"); row.classList.add("is-empty"); }
      row.appendChild(text);
      trivia.appendChild(row);
    });

    let quoteBox = null;
    if (quote) {
      quoteBox = el("figure", "mn-codex__pe-quote");
      const label = el("div", "mn-codex__ov-label mn-codex__pe-label");
      label.textContent = quote.key;
      const said = el("blockquote", "");
      Array.from(quote.dd.childNodes).forEach((node) => said.appendChild(node));
      quoteBox.append(label, said);
    }

    // 놓기: 표 자리에 취향 묶음, 그 뒤 쪽 나눔(오른쪽 종이로) → 여담 줄 → 한마디
    const pageBreak = el("div", "mn-codex__page-break-marker");
    if (dl) dl.replaceWith(likes);
    else last.after(likes);
    lists.forEach((list) => list.remove());
    const tail = [pageBreak, trivia];
    if (quoteBox) tail.push(quoteBox);
    const after = this.templateNodesAfter(heading);
    (after.length ? after[after.length - 1] : likes).after(...tail);
  }

  /** 능력 쪽 그림 칸(visual · visual_focus · visual_scale)을 <img> 로 */
  abilityVisualImage(doc, pageData, sourcePath, alt) {
    const src = this.resolveImage(this.asText(pageData.visual).trim(), sourcePath);
    if (!src) return null;
    const focus = this.asText(pageData.visual_focus).trim() || "50% 30%";
    const scale = Number(pageData.visual_scale) || 1;
    const img = doc.createElement("img");
    img.src = src;
    img.alt = alt || "";
    img.loading = "lazy";
    img.style.objectPosition = focus;
    if (scale > 1) { img.style.transform = `scale(${scale})`; img.style.transformOrigin = focus; }
    // 확대해도 테가 같이 커지지 않게 안쪽 창(테 · 바탕 · 잘라내기)으로 한 겹 감쌈
    const win = doc.createElement("span");
    win.className = "mn-codex__ab-visual-window";
    win.appendChild(img);
    return win;
  }

  /** 능력: 목록 「신탁 : 네이그림」은 번호 · 종류 표식 · 이름 (+ 그림 있는 능력은 작은 그림), 하위 쪽은 그림 판(있으면) · 종류 표식 · 큰 이름 · 표식 고리 */
  shapeAbility(pageData, heading, kind, sourcePath, configuredPages, data) {
    const doc = heading.ownerDocument;
    const nameOf = (title) => {
      const match = this.asText(title).match(/^\s*([^:：]{1,10}?)\s*[:：]\s*(.+)$/u);
      return (match ? match[2] : this.asText(title)).trim();
    };
    if (kind === "section") {
      const pages = new Map();
      for (const page of configuredPages || []) {
        if (page._mnBookPageKind === "entry" && page._mnBookSectionIndex === pageData._mnBookSectionIndex) pages.set(nameOf(page.title), page);
      }
      for (const node of this.templateNodesAfter(heading)) {
        if (node.nodeType !== 1 || !/^(UL|OL)$/u.test(node.tagName)) continue;
        node.classList.add("mn-codex__ab-index");
        for (const li of Array.from(node.children)) {
          const split = this.splitTypeName(li);
          const name = split ? split.name : doc.createElement("span");
          if (!split) Array.from(li.childNodes).forEach((n) => name.appendChild(n));
          name.className = "mn-codex__ab-name";
          li.textContent = "";
          if (split) split.type.className = "mn-codex__ab-type";
          const type = split ? split.type : doc.createElement("span");
          if (!split) { type.className = "mn-codex__ab-type mn-codex__ab-type--empty"; type.setAttribute("aria-hidden", "true"); type.textContent = "—"; }
          li.append(type, name);
          li.classList.add("mn-codex__ab-item");
          if (!split) li.classList.add("mn-codex__ab-item--untyped");
          const page = pages.get(name.textContent.trim());
          const target = page ? (configuredPages || []).indexOf(page) : -1;
          if (target >= 0) {
            li.setAttribute("data-mn-goto-page", String(target));
            li.setAttribute("role", "button");
            li.setAttribute("tabindex", "0");
            li.setAttribute("title", `${name.textContent.trim()} 쪽으로`);
          }
          const img = page && page.visual ? this.abilityVisualImage(doc, page, sourcePath, name.textContent.trim()) : null;
          const thumb = doc.createElement("span");
          thumb.className = img ? "mn-codex__ab-thumb" : "mn-codex__ab-thumb mn-codex__ab-thumb--empty";
          if (img) thumb.appendChild(img);
          else thumb.setAttribute("aria-hidden", "true");
          li.appendChild(thumb);
        }
        if (node.children.length > 5) node.classList.add("mn-codex__ab-index--many");
        // 그림이 하나도 없으면 빈 액자도 빼서 지금 모양 그대로
        if (!node.querySelector(".mn-codex__ab-thumb:not(.mn-codex__ab-thumb--empty)")) node.querySelectorAll(".mn-codex__ab-thumb").forEach((el) => el.remove());
      }
      return;
    }
    if (kind !== "entry") return;
    if (this.asText(data && data.layout_variant).trim()) {
      this.shapeAbilityBand(pageData, heading, sourcePath, configuredPages || []);
      return;
    }
    const title = heading.querySelector(".mn-codex__title");
    const split = title ? this.splitTypeName(title) : null;
    if (split && title) {
      title.textContent = "";
      Array.from(split.name.childNodes).forEach((n) => title.appendChild(n));
      const type = doc.createElement("div");
      type.className = "mn-codex__ab-type mn-codex__ab-type--head";
      type.textContent = split.type.textContent.trim();
      heading.insertBefore(type, heading.querySelector(".mn-codex__title-row"));
    }
    const seal = doc.createElement("div");
    seal.className = "mn-codex__ab-seal";
    seal.setAttribute("aria-hidden", "true");
    const mark = doc.createElement("span");
    mark.className = "mn-codex__ab-star";
    seal.appendChild(mark);
    const img = pageData.visual ? this.abilityVisualImage(doc, pageData, sourcePath, title ? title.textContent : "") : null;
    if (!img) { heading.appendChild(seal); return; }
    // 그림 판: 작은 머리 바로 밑에 넓은 그림 창, 표식 고리는 창 오른쪽 아래 모서리에 걸침
    heading.classList.add("mn-codex__heading--ab-visual");
    const plate = doc.createElement("div");
    plate.className = "mn-codex__ab-visual";
    const frame = doc.createElement("div");
    frame.className = "mn-codex__ab-visual-frame";
    frame.appendChild(img);
    plate.append(frame, seal);
    const kicker = heading.querySelector(".mn-codex__section-kicker");
    heading.insertBefore(plate, kicker ? kicker.nextSibling : heading.firstChild);
  }

  /** 능력 장의 능력 목록: 장 첫 쪽 글의 「- 종류 : 이름」 줄(없으면 하위 쪽 제목). 하위 쪽이 있는 능력엔 그 쪽 번호 */
  abilityRoster(pageData, configuredPages) {
    const plain = (text) => this.asText(text).replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/gu, (_m, target, alias) => alias || target).trim();
    const parse = (text) => {
      const match = plain(text).match(/^\s*([^:：]{1,10}?)\s*[:：]\s*(.+)$/u);
      return match ? { type: match[1].trim(), name: match[2].trim() } : { type: "", name: plain(text) };
    };
    const sectionIndex = pageData._mnBookSectionIndex;
    const entries = configuredPages
      .map((page, index) => ({ page, index }))
      .filter(({ page }) => page._mnBookPageKind === "entry" && page._mnBookSectionIndex === sectionIndex);
    const section = configuredPages.find((page) => page._mnBookPageKind === "section" && page._mnBookSectionIndex === sectionIndex);
    const lines = this.asText(section && section.content).split(/\r?\n/u)
      .map((line) => line.match(/^\s*[-*+]\s+(.+)$/u))
      .filter(Boolean)
      .map((match) => parse(match[1]));
    const roster = lines.length ? lines : entries.map(({ page }) => parse(page.title));
    return roster.map((item) => {
      const hit = entries.find(({ page }) => parse(page.title).name === item.name);
      return { ...item, pageIndex: hit ? hit.index : -1 };
    });
  }

  /** 첫 문단 끝 「…:분류」(쌍점 뒤 짧은 말)를 떼어 분류 표식 재료로. 문장 부호가 있거나 길거나 줄이 바뀌면 그대로 둠 */
  takeTrailingClass(p) {
    const kids = Array.from(p.childNodes);
    let at = -1;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      if (kids[i].nodeName === "BR") return null;
      if (kids[i].nodeType === 3 && /[:：]/u.test(kids[i].textContent)) { at = i; break; }
    }
    if (at < 0) return null;
    const text = kids[at].textContent;
    const cut = Math.max(text.lastIndexOf(":"), text.lastIndexOf("："));
    const head = text.slice(0, cut).replace(/\s+$/u, "");
    const tailText = text.slice(cut + 1);
    const tailNodes = kids.slice(at + 1);
    const tailAll = (tailText + tailNodes.map((node) => node.textContent).join("")).trim();
    const headAll = (kids.slice(0, at).map((node) => node.textContent).join("") + head).trim();
    if (!tailAll || !headAll || Array.from(tailAll).length > 24 || /[.!?。…]/u.test(tailAll)) return null;
    const doc = p.ownerDocument;
    const box = doc.createElement("span");
    if (tailText.trim()) box.appendChild(doc.createTextNode(tailText.replace(/^\s+/u, "")));
    tailNodes.forEach((node) => box.appendChild(node));
    kids[at].textContent = head;
    return box;
  }

  /** 쪽 그림(장 · 쪽의 visual): 능력 하위 쪽(띠 펼침)을 뺀 모든 쪽. 제목이 왼쪽 석판 쪽에 놓이면 그 쪽 전체 바닥에 은은하게 깔고
   *  글 자리만 살짝 어둡게 눌러 읽히게 함(오른쪽 종이 쪽은 글만). 캐릭터 전용 지면만. 실험실 추가 2026-10-28 */
  hasPageArt(pageData, data) {
    if (!pageData || !this.asText(pageData.visual).trim()) return false;
    if (!this.asText(data && data.layout_variant).trim()) return false;
    return !(pageData._mnBookTemplate === "ability" && pageData._mnBookPageKind === "entry");
  }

  preparePageArt(pageData, heading, data, sourcePath) {
    if (!heading || !this.hasPageArt(pageData, data)) return;
    const art = this.abilityVisualImage(heading.ownerDocument, pageData, sourcePath, this.asText(pageData.title));
    if (!art) return;
    const backdrop = heading.ownerDocument.createElement("div");
    backdrop.className = "mn-codex__page-art";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.appendChild(art);
    heading._mnPageArt = { backdrop };
  }

  mountPageArt(backdrop, page) {
    if (!backdrop || !page) return;
    page.classList.add("mn-codex__page--has-art");
    page.insertBefore(backdrop, page.firstChild);
  }

  /** 능력 하위 쪽(전용 지면): 새 펼침 왼쪽 쪽 전체에 능력 그림을 배경으로 깔고, 그 위에 이름 묶음(번호 · 종류 · 큰 이름 · 분류),
   *  아래 어둠 위에 설명 + 글 끝 능력 색인. 설명이 짧으면 인용처럼 크게, 길면 첫 문단만 조금 크게 하고 이름 자리를 줄여 글자리를 넓힘.
   *  넘치면 오른쪽 쪽 · 다음 펼침으로 이어짐 (작가 고름 2026-10-27) */
  shapeAbilityBand(pageData, heading, sourcePath, configuredPages) {
    const doc = heading.ownerDocument;
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const pad = (value) => String(value).padStart(2, "0");
    const titleEl = heading.querySelector(".mn-codex__title");
    const titleCopy = titleEl ? titleEl.cloneNode(true) : el("span");
    const split = this.splitTypeName(titleCopy);
    const nameBox = el("div", "mn-codex__ab-band-name");
    Array.from((split ? split.name : titleCopy).childNodes).forEach((node) => nameBox.appendChild(node));
    const nameText = nameBox.textContent.trim();
    const typeText = split ? split.type.textContent.trim() : "";
    const nameLength = Array.from(nameText.replace(/\s+/gu, "")).length;
    if (nameLength >= 9) nameBox.classList.add("mn-codex__ab-band-name--xlong");
    else if (nameLength >= 6) nameBox.classList.add("mn-codex__ab-band-name--long");

    const blocks = this.templateNodesAfter(heading).filter((node) => node.nodeType === 1);
    const firstP = blocks.find((node) => node.tagName === "P");
    const classBox = firstP ? this.takeTrailingClass(firstP) : null;
    const textLength = blocks.reduce((sum, node) => sum + node.textContent.trim().length, 0);
    const short = Boolean(firstP) && blocks.length === 1 && textLength <= 90;
    if (firstP) firstP.classList.add(short ? "mn-codex__ab-quote" : "mn-codex__ab-lead");

    const roster = this.abilityRoster(pageData, configuredPages);
    const selfIndex = configuredPages.indexOf(pageData);
    let order = roster.findIndex((item) => item.pageIndex === selfIndex);
    if (order < 0) order = Math.max(0, Number(pageData._mnBookEntryIndex) || 0);

    const band = el("div", "mn-codex__ab-band");
    band.setAttribute("aria-hidden", "true");
    if (textLength > 240 || blocks.length > 2) band.classList.add("mn-codex__ab-band--compact");
    const art = pageData.visual ? this.abilityVisualImage(doc, pageData, sourcePath, nameText) : null;
    if (!art) band.classList.add("mn-codex__ab-band--bare");
    const no = el("div", "mn-codex__ab-band-no");
    no.append(el("b", "", pad(order + 1)), el("small", "", `/ ${pad(Math.max(roster.length, order + 1))}`));
    const copy = el("div", "mn-codex__ab-band-copy");
    const kicker = heading.querySelector(".mn-codex__section-kicker");
    const kickerText = kicker ? kicker.textContent.trim() : "";
    copy.appendChild(el("div", "mn-codex__ab-band-kicker", kickerText ? `${kickerText} · ABILITY` : "ABILITY"));
    if (typeText) copy.appendChild(el("span", "mn-codex__ab-band-type", typeText));
    copy.appendChild(nameBox);
    if (classBox) {
      const tags = el("div", "mn-codex__ab-band-tags");
      this.valueChips(classBox, doc).forEach((chip) => {
        chip.className = "mn-codex__ab-band-tag";
        tags.appendChild(chip);
      });
      if (tags.childElementCount) copy.appendChild(tags);
    }
    band.append(no, copy);
    heading.classList.add("mn-codex__heading--ab-band");
    heading._mnAbBand = band;
    heading._mnAbArt = art;

    if (roster.length < 2) return;
    const after = this.templateNodesAfter(heading);
    const last = after.length ? after[after.length - 1] : heading;
    const pageBreak = el("div", "mn-codex__ab-roster-break");
    pageBreak.setAttribute("aria-hidden", "true");
    const nav = el("nav", "mn-codex__ab-roster");
    nav.setAttribute("aria-label", "능력 색인");
    nav.setAttribute("data-mn-flow-optional", "true");
    nav.appendChild(el("div", "mn-codex__ab-roster-label", "ABILITY INDEX"));
    const list = el("div", `mn-codex__ab-roster-list${roster.length > 6 ? " mn-codex__ab-roster-list--many" : ""}`);
    roster.forEach((item, index) => {
      const current = item.pageIndex >= 0 && item.pageIndex === selfIndex;
      const linked = item.pageIndex >= 0 && !current;
      const row = el(linked ? "button" : "div", "mn-codex__ab-roster-row");
      if (linked) {
        row.type = "button";
        row.setAttribute("data-mn-goto-page", String(item.pageIndex));
        row.title = `${item.name} 쪽으로`;
      }
      if (current) {
        row.classList.add("is-current");
        row.setAttribute("aria-current", "page");
      }
      if (item.pageIndex < 0) row.classList.add("is-plain");
      row.append(el("em", "", pad(index + 1)), el("span", "mn-codex__ab-roster-type", item.type), el("span", "mn-codex__ab-roster-name", item.name));
      list.appendChild(row);
    });
    nav.appendChild(list);
    last.after(pageBreak, nav);
  }

  /** 능력 쪽 걸기: 이름 자리 높이는 펼침 높이의 비율(px, 오른쪽 색인 높이 맞춤에도 씀), 이름 묶음은 왼쪽 쪽 글 시작선에 맞추고,
   *  능력 그림은 왼쪽 쪽 바닥에 배경으로 */
  mountAbilityBand(band, art, spread) {
    if (!band || !spread || !spread.book || !spread.leftPage) return;
    const book = spread.book;
    const page = spread.leftPage;
    // 한 쪽 보기 판은 책이 낮아서 이름 자리를 조금 더 높게 (번호와 이름 묶음이 포개지지 않게)
    const single = typeof book.closest === "function" && book.closest(".mn-codex--single-edition");
    const ratio = band.classList.contains("mn-codex__ab-band--compact") ? (single ? 0.44 : 0.36) : (single ? 0.53 : 0.45);
    const height = Math.round((book.offsetHeight || book.clientHeight || 640) * ratio);
    book.style.setProperty("--mn-ab-band-h", `${height}px`);
    book.classList.add("mn-codex__book--ab-band");
    page.classList.add("mn-codex__page--ab-band");
    // 그림 없는 능력은 이름 자리에 큰 번호가 있어서 쪽 아래 큰 장 번호는 뺌
    page.classList.toggle("mn-codex__page--ab-bare", !art);
    const pageRect = page.getBoundingClientRect();
    const body = spread.leftFrame && spread.leftFrame.querySelector(".mn-codex__prose--page");
    const bodyRect = body ? body.getBoundingClientRect() : null;
    if (bodyRect && pageRect.width && page.offsetWidth) {
      const view = book.ownerDocument && book.ownerDocument.defaultView;
      const padding = view ? Number.parseFloat(view.getComputedStyle(body).paddingLeft) || 0 : 0;
      const inset = (bodyRect.left - pageRect.left) / pageRect.width * page.offsetWidth + padding;
      band.style.setProperty("--mn-ab-band-inset", `${Math.round(inset)}px`);
    }
    if (art) {
      const backdrop = book.ownerDocument.createElement("div");
      backdrop.className = "mn-codex__ab-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.appendChild(art);
      page.insertBefore(backdrop, page.firstChild);
    }
    page.appendChild(band);
  }

  /** 노트 속성(frontmatter) */
  noteFrontmatter(path) {
    try {
      const vault = this.app && this.app.vault;
      const file = vault && path ? vault.getAbstractFileByPath(path) : null;
      return (file && this.app.metadataCache.getFileCache(file)?.frontmatter) || null;
    } catch (error) {
      return null;
    }
  }

  /** 세계판 플러그인(조직도 · 지도)에 부탁 */
  sekaipanPlugin() {
    const plugins = this.app && this.app.plugins;
    return plugins && plugins.plugins ? plugins.plugins["mn-sekaipan"] || null : null;
  }

  async showInOrgChart(names) {
    const plugin = this.sekaipanPlugin();
    if (plugin && typeof plugin.showInOrgChart === "function") return plugin.showInOrgChart(names);
    new Notice("조직도는 세계판 플러그인(MN 세계판)이 켜져 있어야 열려요.");
  }

  async showOnMap(path) {
    const plugin = this.sekaipanPlugin();
    if (plugin && typeof plugin.showOnMap === "function") return plugin.showOnMap(path);
    new Notice("지도는 세계판 플러그인(MN 세계판)이 켜져 있어야 열려요.");
  }

  /** [[노트|별칭]] · [[노트]] → 보이는 글자 */
  plainLink(value) {
    return this.asText(value).replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/gu, (_m, target, alias) => alias || target).trim();
  }

  /** 인물 도감 그리기 */
  async renderRoster(options, el, sourcePath, state) {
    el.addClass("mn-roster");
    const folder = this.asText(options.folder).trim().replace(/\/?$/u, "/");
    const cache = this.app && this.app.metadataCache;
    const files = this.characterNoteFiles().filter((file) => folder === "/" || file.path.startsWith(folder));
    const list = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value])
      .map((item) => this.plainLink(item))
      .filter(Boolean);
    const people = [];
    for (const file of files) {
      const front = (cache && cache.getFileCache(file)?.frontmatter) || {};
      const data = await this.readCodexData(file);
      const face = data && Array.isArray(data.detail_images) && data.detail_images[0] ? this.asText(data.detail_images[0]) : "";
      const portrait = this.asText(front["초상"] || front.portrait).trim();
      const ref = face || portrait || this.asText(data && (data.book_image || data.image)).trim();
      people.push({
        file,
        name: this.asText(data && data.title).trim() || file.basename,
        alias: this.plainLink(front["이명"]),
        job: this.plainLink(front["하는 일"]),
        groups: list(front["소속"]),
        race: this.plainLink(front["종족"]),
        time: this.plainLink(front["시점"]),
        test: /시험/u.test(this.asText(front["시점"])),
        place: this.plainLink(front["위치"]),
        front,
        src: ref ? this.resolveImage(ref, file.path) : "",
        focus: face && Array.isArray(data.detail_focus) && data.detail_focus[0] ? this.asText(data.detail_focus[0]) : "50% 18%",
        scale: face && Array.isArray(data.detail_scale) && Number(data.detail_scale[0]) > 1 ? Number(data.detail_scale[0]) : 1,
        // 그 인물 지면의 색(page_tint) — 캐릭터 전용 지면이 아니면 없음. 실험실 추가 2026-10-28
        look: data && this.asText(data.layout_variant).trim() ? (VARIANT_TINTS[this.asText(data.page_tint).trim()] || [0, 1]) : null,
      });
    }
    people.sort((a, b) => Number(a.test) - Number(b.test) || a.name.localeCompare(b.name, "ko"));

    const head = el.createDiv({ cls: "mn-roster__head" });
    const titles = head.createDiv();
    titles.createDiv({ cls: "mn-roster__kicker", text: "CHARACTER INDEX" });
    titles.createDiv({ cls: "mn-roster__title", text: this.asText(options.title, "인물 도감") });
    const count = head.createDiv({ cls: "mn-roster__count" });

    // 찾기 · 정렬 줄: 인물이 많아져도 바로 찾게. 이 줄은 다시 그리지 않음(글 쓰는 중에 칸이 사라지지 않게)
    const tools = el.createDiv({ cls: "mn-roster__tools" });
    const search = tools.createEl("input", { cls: "mn-roster__search", attr: { type: "search", placeholder: "이름 · 이명 · 소속 · 종족 · 위치 · 신탁 · 신기로 찾기", "aria-label": "인물 찾기" } });
    search.value = state.query || "";
    const order = tools.createEl("select", { cls: "mn-roster__order", attr: { "aria-label": "정렬" } });
    const filters = el.createDiv({ cls: "mn-roster__filters" });
    // 소속 · 종족 목록: 사람 많은 차례(같으면 이름 차례), 인원 수와 함께
    const tally = (valuesOf) => {
      const counts = new Map();
      people.forEach((person) => valuesOf(person).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1)));
      return { counts, values: [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, "ko")) };
    };
    // 거르기 창에서 고를 거리: 소속 · 종족 · 위치. 한 거리 안에선 고른 것 중 하나라도(또는), 거리끼리는 모두(그리고)
    const FACETS = [
      { key: "groups", label: "소속", of: (person) => person.groups },
      { key: "races", label: "종족", of: (person) => (person.race ? [person.race] : []) },
      { key: "places", label: "위치", of: (person) => (person.place ? [person.place] : []) },
    ].map((facet) => ({ ...facet, ...tally(facet.of) }));
    const grid = el.createDiv({ cls: "mn-roster__grid" });
    const chip = (label, active, onClick, extra = "") => {
      const button = filters.createEl("button", { cls: `mn-roster__filter${active ? " is-on" : ""}${extra}`, text: label, attr: { type: "button" } });
      button.addEventListener("click", onClick);
      return button;
    };
    // 표로 보기: 여러 인물을 한 줄씩 나란히. 머리 줄을 누르면 정렬(투력 · 항력은 수로, 빈 칸은 늘 아래). 칸은 값이 하나라도 있는 것만
    const openPerson = (person, event) => {
      event.preventDefault();
      const workspace = this.app && this.app.workspace;
      if (workspace && typeof workspace.openLinkText === "function") workspace.openLinkText(person.file.path, sourcePath, event.ctrlKey || event.metaKey ? "tab" : false);
    };
    const cellText = (person, key) => (key === "소속" ? person.groups.join(" · ") : (Array.isArray(person.front[key]) ? person.front[key] : [person.front[key]])
      .map((item) => this.plainLink(item)).filter(Boolean).join(" · "));
    const NUMERIC = new Set(["투력", "항력"]);
    const columns = ["소속", "종족", "투력", "항력", "신탁", "신기", "위치", "하는 일"].filter((key) => people.some((person) => cellText(person, key)));
    // 정렬(카드 · 표 같이): 없으면 기본(시험 노트 뒤 · 이름 차례). 투력 · 항력은 수로, 「최근」은 노트 고친 때, 빈 칸은 늘 아래
    const sortValue = (person, key) => (key === "이름" ? person.name : key === "최근" ? (person.file.stat && person.file.stat.mtime) || null
      : NUMERIC.has(key) ? this.recordAmount(cellText(person, key)) : cellText(person, key));
    const sorted = (list) => {
      if (!state.sort) return list;
      const { key, dir } = state.sort;
      return list.slice().sort((a, b) => {
        const x = sortValue(a, key);
        const y = sortValue(b, key);
        const ex = x === null || x === "";
        const ey = y === null || y === "";
        if (ex || ey) return Number(ex) - Number(ey);
        return (typeof x === "number" ? x - y : String(x).localeCompare(String(y), "ko")) * dir;
      });
    };
    const ORDERS = [["", "기본 차례"], ["이름:1", "이름 차례"], ["투력:-1", "투력 높은 차례"], ["최근:-1", "최근 고친 차례"]];
    const drawOrder = () => {
      order.empty();
      const now = state.sort ? `${state.sort.key}:${state.sort.dir}` : "";
      const options = ORDERS.some(([value]) => value === now) ? ORDERS : [...ORDERS, [now, `「${state.sort.key}」 ${state.sort.dir < 0 ? "높은" : "낮은"} 차례`]];
      options.forEach(([value, label]) => order.createEl("option", { text: label, attr: { value } }));
      order.value = now;
    };
    order.addEventListener("change", () => {
      const [key, dir] = order.value.split(":");
      state.sort = key ? { key, dir: Number(dir) } : null;
      state.more = 0;
      drawGrid();
    });
    let searchTimer = 0;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = search.value; state.more = 0; drawGrid(); }, 120);
    });
    // 찾기: 띄어 쓴 낱말이 모두 들어 있는 사람(이름 · 이명 · 소속 · 종족 · 위치 · 하는 일 · 신탁 · 신기 · 노트 이름)
    const matches = (person) => {
      const words = String(state.query || "").toLowerCase().split(/\s+/u).filter(Boolean);
      if (!words.length) return true;
      const hay = [person.name, person.alias, person.job, person.race, person.place, person.file.basename, ...person.groups, cellText(person, "신탁"), cellText(person, "신기")]
        .join(" ").toLowerCase();
      return words.every((word) => hay.includes(word));
    };
    const passes = (person) => !(state.hideTest && person.test) && matches(person)
      && FACETS.every((facet) => !state.picked[facet.key].size || facet.of(person).some((value) => state.picked[facet.key].has(value)));
    const drawTable = (rows) => {
      const wrap = grid.createDiv({ cls: "mn-roster__table-wrap" });
      const table = wrap.createEl("table", { cls: "mn-roster__table" });
      const headRow = table.createEl("thead").createEl("tr");
      ["이름", ...columns].forEach((key) => {
        const on = state.sort && state.sort.key === key;
        const th = headRow.createEl("th", { cls: `${NUMERIC.has(key) ? "is-number" : ""}${on ? " is-sorted" : ""}`, attr: { tabindex: "0", title: `${key}로 정렬` } });
        th.createSpan({ text: key });
        th.createSpan({ cls: "mn-roster__sort", text: on ? (state.sort.dir < 0 ? "↓" : "↑") : "" });
        const sortBy = () => {
          state.sort = on ? { key, dir: -state.sort.dir } : { key, dir: NUMERIC.has(key) ? -1 : 1 };
          state.more = 0;
          drawGrid();
        };
        th.addEventListener("click", sortBy);
        th.addEventListener("keydown", (event) => { if (event.key === "Enter") sortBy(); });
      });
      const body = table.createEl("tbody");
      rows.forEach((person) => {
        const tr = body.createEl("tr", { cls: person.test ? "is-test" : "", attr: { tabindex: "0", title: `${person.name} 인물 페이지 열기` } });
        const nameCell = tr.createEl("td", { cls: "mn-roster__cell-name" });
        if (person.alias) nameCell.createDiv({ cls: "mn-roster__cell-alias", text: person.alias });
        const nameLine = nameCell.createDiv({ cls: "mn-roster__cell-title", text: person.name });
        if (person.test) nameLine.createSpan({ cls: "mn-roster__cell-badge", text: "시험" });
        columns.forEach((key) => {
          const text = cellText(person, key);
          const wrap = ["소속", "위치", "하는 일"].includes(key) ? " is-wrap" : "";
          tr.createEl("td", { cls: `${NUMERIC.has(key) ? "is-number" : ""}${wrap}${text ? "" : " is-empty"}`, text: text || "—" });
        });
        tr.addEventListener("click", (event) => openPerson(person, event));
        tr.addEventListener("keydown", (event) => { if (event.key === "Enter") openPerson(person, event); });
      });
    };
    // 한 번에 그리는 수: 카드 24명 · 표 60줄, 그다음은 「더 보기」 (그림을 한꺼번에 수백 장 풀지 않게)
    const PAGE = { card: 24, table: 60 };
    const drawGrid = () => {
      filters.empty();
      drawOrder();
      // 소속 · 종족 · 위치는 따로 뜨는 「인물 거르기」 창에서 찾아 고름 — 여기엔 단추와 고른 것 꼬리표(3개까지, 넘으면 +n)만
      const tags = FACETS.flatMap((facet) => [...state.picked[facet.key]].map((value) => ({ facet, value })));
      const openFilter = () => {
        new RosterFilterModal(this.app, FACETS, state.picked, () => people.filter(passes).length, () => { state.more = 0; drawGrid(); }).open();
      };
      chip(tags.length ? `거르기 · ${tags.length}` : "거르기", tags.length > 0, openFilter, " mn-roster__filter--open");
      tags.slice(0, 3).forEach(({ facet, value }) => {
        const tag = chip(`${value} ✕`, false, () => { state.picked[facet.key].delete(value); state.more = 0; drawGrid(); }, " mn-roster__filter--tag");
        tag.setAttr("title", `${facet.label} 「${value}」 빼기`);
      });
      if (tags.length > 3) chip(`+${tags.length - 3}`, false, openFilter, " mn-roster__filter--tag");
      if (state.query || tags.length) {
        chip("거르기 풀기", false, () => {
          state.query = "";
          search.value = "";
          FACETS.forEach((facet) => state.picked[facet.key].clear());
          state.more = 0;
          drawGrid();
        }, " mn-roster__filter--clear");
      }
      if (people.some((person) => person.test)) {
        chip(state.hideTest ? "시험 노트 보기" : "시험 노트 숨기기", false, () => { state.hideTest = !state.hideTest; state.more = 0; drawGrid(); }, " mn-roster__filter--toggle");
      }
      chip(state.view === "table" ? "카드로 보기" : "표로 보기", false, () => { state.view = state.view === "table" ? "card" : "table"; state.more = 0; drawGrid(); }, " mn-roster__filter--view");
      grid.empty();
      grid.classList.toggle("is-table", state.view === "table");
      const found = sorted(people.filter(passes));
      const page = PAGE[state.view === "table" ? "table" : "card"];
      const limit = page * (1 + (state.more || 0));
      const shown = found.slice(0, limit);
      count.setText(`${String(found.length).padStart(2, "0")} / ${String(people.length).padStart(2, "0")}`);
      const drawMore = () => {
        if (found.length <= limit) return;
        const rest = found.length - limit;
        const more = grid.createEl("button", { cls: "mn-roster__more", text: `${Math.min(page, rest)}명 더 보기 · 남은 ${rest}명`, attr: { type: "button" } });
        more.addEventListener("click", () => { state.more = (state.more || 0) + 1; drawGrid(); });
      };
      if (!found.length) grid.createDiv({ cls: "mn-roster__none", text: state.query ? `「${state.query}」에 맞는 인물이 없어요.` : "조건에 맞는 인물이 없어요." });
      else if (state.view === "table") drawTable(shown);
      if (state.view === "table") {
        drawMore();
        return;
      }
      const cards = grid.createDiv({ cls: "mn-roster__cards" });
      shown.forEach((person, index) => {
        const card = cards.createEl("button", { cls: `mn-roster__card${person.test ? " is-test" : ""}`, attr: { type: "button", title: `${person.name} 인물 페이지 열기` } });
        if (person.look) {
          const [hue, chroma] = person.look;
          card.addClass("has-look");
          card.style.setProperty("--mn-roster-accent", `oklch(from #4e6382 l calc(c * ${chroma}) calc(h + ${hue}))`);
          card.style.setProperty("--mn-roster-slate", `oklch(from #1d2433 l calc(c * ${chroma}) calc(h + ${hue}))`);
        }
        const figure = card.createDiv({ cls: "mn-roster__figure" });
        if (person.src) {
          const img = figure.createEl("img", { attr: { src: person.src, alt: "", loading: "lazy" } });
          img.style.objectPosition = person.focus;
          if (person.scale > 1) { img.style.transform = `scale(${person.scale})`; img.style.transformOrigin = person.focus; }
        } else {
          figure.addClass("mn-roster__figure--mono");
          figure.createSpan({ text: Array.from(person.name)[0] || "?" });
        }
        if (person.test) figure.createSpan({ cls: "mn-roster__badge", text: "시험" });
        const body = card.createDiv({ cls: "mn-roster__body" });
        body.createSpan({ cls: "mn-roster__no", text: String(index + 1).padStart(2, "0") });
        if (person.alias) body.createDiv({ cls: "mn-roster__alias", text: person.alias });
        body.createDiv({ cls: "mn-roster__name", text: person.name });
        if (person.job) body.createDiv({ cls: "mn-roster__job", text: person.job });
        if (person.groups.length) {
          const row = body.createDiv({ cls: "mn-roster__groups" });
          person.groups.forEach((group) => row.createSpan({ cls: "mn-roster__group", text: group }));
        }
        const meta = [person.race, person.time && !person.test ? `시점 ${person.time}` : ""].filter(Boolean).join(" · ");
        if (meta) body.createDiv({ cls: "mn-roster__meta", text: meta });
        if (person.place) {
          const where = body.createDiv({ cls: "mn-roster__place" });
          where.createSpan({ text: person.place });
          const map = where.createSpan({ cls: "mn-roster__map", text: "지도 ↗", attr: { role: "button", tabindex: "0", title: `세계판에서 ${person.name} 보기` } });
          const open = (event) => { event.preventDefault(); event.stopPropagation(); this.showOnMap(person.file.path); };
          map.addEventListener("click", open);
          map.addEventListener("keydown", (event) => { if (event.key === "Enter") open(event); });
        }
        card.addEventListener("click", (event) => {
          event.preventDefault();
          const workspace = this.app && this.app.workspace;
          if (workspace && typeof workspace.openLinkText === "function") workspace.openLinkText(person.file.path, sourcePath, event.ctrlKey || event.metaKey ? "tab" : false);
        });
      });
      drawMore();
    };
    drawGrid();
  }

  /** 기록표 능력 다각형: 축마다 { axis, grade: { tier, step } | null, derived, note }. 가운데 = 가장 낮은 단의 시작, 바깥 테 = 가장 높은 단의 Ⅹ, 한 칸 = 한 등급.
   *  등급이 없는 축(미정)은 가운데에 두고 이름 아래 「미정」. 정해진 축이 하나도 없으면 fallbackTier 단으로 테를 그림 */
  recordRadar(rows, doc, fallbackTier = 0) {
    const NS = "http://www.w3.org/2000/svg";
    const count = rows.length;
    const at = (grade) => grade.tier * 10 + grade.step;
    const known = rows.filter((row) => row.grade);
    const tiers = known.length ? known.map((row) => row.grade.tier) : [fallbackTier];
    const lo = Math.min(...tiers) * 10, hi = Math.max(...tiers) * 10 + 10;
    const span = (hi - lo) / 10;
    const W = 520, R = 112, cx = W / 2, cy = R + 48;
    const angle = (index) => -Math.PI / 2 + (index * 2 * Math.PI) / count;
    const lowest = Math.max(...rows.map((_, index) => Math.sin(angle(index))));
    const H = Math.ceil(cy + lowest * (R + 18) + (lowest > 0.5 ? 6 : -4) + 17 + 12);
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "mn-record__radar");
    const add = (tag, attrs, text, parent = svg) => {
      const node = doc.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
      if (text !== undefined) node.textContent = text;
      parent.appendChild(node);
      return node;
    };
    const point = (index, r) => [cx + Math.cos(angle(index)) * r, cy + Math.sin(angle(index)) * r];
    const radius = (value) => (R * (value - lo)) / (hi - lo);
    const path = (points) => points.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ") + " Z";
    // 테: 한 단이면 한 등급마다, 두 단이면 Ⅴ · Ⅹ, 그 위로는 단 끝(Ⅹ)만
    const every = span === 1 ? 1 : span === 2 ? 5 : 10;
    for (let value = lo + 1; value <= hi; value += 1) {
      const step = ((value - 1) % 10) + 1;
      if (step % every) continue;
      add("path", { d: path(rows.map((_, index) => point(index, radius(value)))), class: `mn-record__radar-ring${step === 10 ? " is-tier" : step === 5 ? " is-half" : ""}` });
    }
    rows.forEach((row, index) => {
      const [x, y] = point(index, R);
      add("line", { x1: cx, y1: cy, x2: x, y2: y, class: `mn-record__radar-spoke${row.grade ? "" : " is-unset"}` });
    });
    // 테 이름: 첫 축과 둘째 축 사이 변 위에. 한 단이면 Ⅴ · Ⅹ(Ⅰ은 가운데 단 이름과 겹쳐 뺌), 여러 단이면 단 끝마다 「M2 Ⅹ」
    const middle = (angle(0) + angle(1)) / 2, inset = Math.cos(Math.PI / count);
    const marks = span === 1 ? [[lo + 5, "Ⅴ"], [lo + 10, "Ⅹ"]] : Array.from({ length: span }, (_, k) => [lo + 10 * (k + 1), `M${lo / 10 + k} Ⅹ`]);
    marks.forEach(([value, text]) => {
      const r = radius(value) * inset;
      add("text", { x: cx + Math.cos(middle) * r + 3, y: cy + Math.sin(middle) * r + 3, class: "mn-record__radar-mark" }, text);
    });
    add("text", { x: cx, y: cy + 5, "text-anchor": "middle", class: "mn-record__radar-tier" }, `M${lo / 10}`);
    const shape = rows.map((row, index) => point(index, row.grade ? radius(at(row.grade)) : 0));
    if (known.length) add("path", { d: path(shape), class: "mn-record__radar-shape" });
    const best = known.length ? Math.max(...known.map((row) => at(row.grade))) : -1;
    // derived = 큰 축 등급을 안 적어서 세부 중 가장 높은 값을 옅게 보여 줌. data-index로 축을 고름(renderRecord)
    rows.forEach((row, index) => {
      if (!row.grade) return;
      const [x, y] = shape[index];
      add("circle", { cx: x, cy: y, r: 4, "data-index": index, class: `mn-record__radar-dot${at(row.grade) === best ? " is-best" : ""}${row.derived ? " is-derived" : ""}` });
    });
    // 축 이름 + 등급: 위 축은 위로, 아래 축은 아래로, 옆 축은 바깥쪽으로 붙임. 메모는 이름에 마우스를 올리면
    rows.forEach((row, index) => {
      const [x, y] = point(index, R + 18), cos = Math.cos(angle(index)), sin = Math.sin(angle(index));
      const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
      const dy = sin < -0.5 ? -14 : sin > 0.5 ? 6 : -4;
      const label = add("text", { x, y: y + dy, "text-anchor": anchor, "data-index": index, class: `mn-record__radar-axis${row.grade ? "" : " is-unset"}` }, row.axis);
      if (row.note) add("title", {}, `${row.axis} — ${row.note}`, label);
      const grade = add("text", { x, y: y + dy + 17, "text-anchor": anchor, "data-index": index, class: `mn-record__radar-grade${row.derived ? " is-derived" : ""}${row.grade ? "" : " is-unset"}` });
      if (!row.grade) {
        grade.textContent = "미정";
        return;
      }
      add("tspan", { class: "mn-record__radar-grade-tier" }, `M${row.grade.tier} `, grade);
      add("tspan", { class: "mn-record__radar-grade-step" }, GRADE_STEPS[row.grade.step - 1], grade);
    });
    return svg;
  }

  /** 기록표 한 줄 「축: 값 — 메모」(또는 { 축: 값 }) → { axis, value, note } */
  recordSplit(item) {
    const text = item && typeof item === "object" ? Object.entries(item).map(([key, value]) => `${key}: ${this.asText(value)}`)[0] || "" : this.plainLink(item);
    const match = text.match(/^([^:：]+)[:：]\s*([^—]*?)\s*(?:—\s*(.*))?$/u);
    return match ? { axis: match[1].trim(), value: match[2].trim(), note: (match[3] || "").trim() } : { axis: text.trim(), value: "", note: "" };
  }

  /** 내성주(작가 설명 2026-11-01): 극한의 경험 · 감각 · 충격으로 몸에 새겨진 고유한 능력(패시브 또는 액티브). 더 강해질 수 있고, 몇 개를 가졌는지가 중요한 지표.
   *  속성 「내성주」, 없으면 기록표 블록 초안. 한 줄 「통찰안: 패시브 · M3 Ⅳ · 충격 — 메모」 또는 { 이름, 갈래, 등급, 계기, 얻은 때, 메모, 강해진 기록: ["시점 · M2 Ⅶ", …] } */
  recordResists(sourcePath, options = {}) {
    const vault = this.app && this.app.vault;
    const cache = this.app && this.app.metadataCache;
    const file = vault && typeof vault.getAbstractFileByPath === "function" ? vault.getAbstractFileByPath(sourcePath) : null;
    const front = (file && cache && cache.getFileCache(file)?.frontmatter) || {};
    const present = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "");
    const draft = !present(front["내성주"]) && !!options && present(options["내성주"]);
    const source = present(front["내성주"]) ? front["내성주"] : draft ? options["내성주"] : null;
    const resists = (Array.isArray(source) ? source : source ? [source] : []).map((item) => {
      let raw = item;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const pick = (...keys) => { for (const key of keys) if (present(raw[key])) return raw[key]; return ""; };
        if (pick("이름", "name")) {
          return {
            name: this.plainLink(pick("이름", "name")), kind: this.plainLink(pick("갈래", "종류")), gradeText: this.plainLink(pick("등급")),
            cause: this.plainLink(pick("계기")), when: this.plainLink(pick("얻은 때", "시점")), note: this.plainLink(pick("메모", "설명")),
            history: [].concat(pick("강해진 기록") || []).map((entry) => this.plainLink(entry)).filter(Boolean), raw: item,
          };
        }
        raw = Object.entries(raw).map(([key, value]) => `${key}: ${this.asText(value)}`)[0] || "";
      }
      const row = this.recordSplit(raw);
      if (!row.axis || /^(미정|\?|-|—)$/u.test(row.axis)) return null;
      const parts = row.value.split(/\s*·\s*/u).filter(Boolean);
      const kind = parts.find((part) => RECORD_KINDS.includes(part)) || "";
      const gradeText = parts.find((part) => parseRecordGrade(part)) || "";
      return { name: row.axis, kind, gradeText, cause: parts.filter((part) => part !== kind && part !== gradeText).join(" · "), when: "", note: row.note, history: [], raw: item };
    }).filter(Boolean);
    resists.forEach((resist, index) => { resist.no = index + 1; resist.grade = parseRecordGrade(resist.gradeText); });
    return { file, source, draft, resists };
  }

  /** 내성주 관리 패널 안: 머리(보유 · 평균) → 도구(갈래 · 차례 · 찾기 · ＋ 더하기) → 왼쪽 목록 · 오른쪽 자세히 / 더하기 / 고치기.
   *  적으면 노트 속성 「내성주」에 씀(블록 초안이었으면 그 내용째 속성으로 옮김). 속성이 바뀌면 ResistPanelModal이 다시 부름 */
  recordResistManager(root, sourcePath, options = {}) {
    const { file, draft, resists } = this.recordResists(sourcePath, options);
    const KINDS = RECORD_KINDS;
    root.empty();
    root.addClass("mn-resist");
    // 거르기 · 차례 · 고른 줄은 노트마다 기억(패널을 닫았다 열어도 그대로)
    if (!this.recordResistState) this.recordResistState = new Map();
    if (!this.recordResistState.has(sourcePath)) this.recordResistState.set(sourcePath, { kind: "전체", sort: "적은 차례", query: "", selected: 0, mode: "view", confirm: 0 });
    const state = this.recordResistState.get(sourcePath);
    const redraw = () => this.recordResistManager(root, sourcePath, options);
    const press = (node, run) => {
      node.setAttr("role", "button");
      node.setAttr("tabindex", "0");
      node.addEventListener("click", run);
      node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(event); } });
    };
    const manager = this.app && this.app.fileManager;
    const writable = !!(file && manager && typeof manager.processFrontMatter === "function");
    // 지금 보이는 목록(블록 초안이면 그것)을 통째로 속성 「내성주」에. 다 지우면 「미정」
    const save = async (items, select) => {
      state.mode = "view";
      state.confirm = 0;
      state.selected = select;
      await manager.processFrontMatter(file, (fm) => { fm["내성주"] = items.length ? items : "미정"; });
    };
    const rank = (resist) => (resist.grade ? resist.grade.tier * 10 + resist.grade.step : -1);
    const tally = KINDS.map((kind) => [kind, resists.filter((r) => r.kind === kind).length]).filter(([, count]) => count);
    const unsorted = resists.filter((r) => !KINDS.includes(r.kind)).length;
    const { graded, mean } = recordResistMean(resists);
    if (!writable) state.mode = "view";
    if (!resists.some((r) => r.no === state.selected)) {
      if (state.mode === "edit") state.mode = "view";
      state.selected = state.mode === "add" || !resists.length ? 0 : resists[0].no;
    }
    const gradeInto = (parent, grade, text) => {
      const mark = parent.createSpan({ cls: `mn-record__grade${grade ? "" : " is-unset"}` });
      if (grade) {
        mark.createSpan({ cls: "mn-record__grade-tier", text: `M${grade.tier}` });
        mark.createSpan({ cls: "mn-record__grade-step", text: GRADE_STEPS[grade.step - 1] });
      } else mark.setText(text || "등급 미정");
      return mark;
    };
    const pipsInto = (parent, grade) => {
      const pips = parent.createSpan({ cls: "mn-record__grade-pips", attr: { title: grade ? `M${grade.tier} 단 안에서 ${grade.step} / 10칸` : "미정" } });
      for (let i = 1; i <= 10; i += 1) pips.createSpan({ cls: `mn-record__grade-pip${grade && i <= grade.step ? " is-on" : ""}${grade && i === grade.step ? " is-last" : ""}` });
      return pips;
    };

    // 머리: 무엇인지 · 보유 · 평균
    const head = root.createDiv({ cls: "mn-resist__head" });
    head.createDiv({ cls: "mn-resist__lead", text: "극한의 경험 · 감각 · 충격이 몸에 새긴 고유한 능력(패시브 · 액티브) · 더 강해질 수 있고, 몇 개를 가졌는지가 중요한 지표" });
    const facts = head.createDiv({ cls: "mn-resist__facts" });
    const count = facts.createSpan({ cls: `mn-resist__fact is-count${resists.length ? "" : " is-unset"}` });
    count.createSpan({ cls: "mn-record__label", text: "보유" });
    count.createSpan({ cls: "mn-resist__fact-value", text: resists.length ? `${resists.length}` : "미정" });
    const average = facts.createSpan({ cls: "mn-resist__fact", attr: mean && graded.length < resists.length ? { title: `등급을 적은 ${graded.length}개의 평균이에요` } : {} });
    average.createSpan({ cls: "mn-record__label", text: "평균" });
    gradeInto(average, mean, "미정");
    if (draft) facts.createSpan({ cls: "mn-record__draft", text: "미리보기", attr: { title: "속성에 아직 없고 기록표 블록에 적은 초안이에요 · 여기서 적으면 속성으로 옮겨져요" } });

    // 도구: 갈래로 거르기 · 등급 순 · 이름 찾기(많을 때) · ＋ 더하기
    const tools = root.createDiv({ cls: "mn-resist__tools" });
    const kinds = [["전체", resists.length], ...tally, ...(unsorted ? [["갈래 미정", unsorted]] : [])];
    if (!kinds.some(([kind]) => kind === state.kind)) state.kind = "전체";
    const chip = (group, value, label, on) => {
      const node = group.createSpan({ cls: `mn-record__resist-chip${on ? " is-on" : ""}`, text: label });
      press(node, () => {
        if (value === "적은 차례" || value === "등급 순") state.sort = value; else state.kind = value;
        redraw();
      });
    };
    if (kinds.length > 2) {
      const group = tools.createSpan({ cls: "mn-record__resist-group" });
      kinds.forEach(([kind, total]) => chip(group, kind, `${kind} ${total}`, state.kind === kind));
    }
    if (graded.length > 1) {
      const group = tools.createSpan({ cls: "mn-record__resist-group" });
      ["적은 차례", "등급 순"].forEach((value) => chip(group, value, value, state.sort === value));
    }
    if (resists.length >= 8) {
      const search = tools.createEl("input", { cls: "mn-record__resist-search", attr: { type: "search", placeholder: "이름 · 계기 찾기", "aria-label": "내성주 찾기" } });
      search.value = state.query;
      search.addEventListener("input", () => { state.query = search.value.trim(); state.typing = search.selectionStart; redraw(); });
      if (state.typing !== undefined) {
        const at = state.typing;
        state.typing = undefined;
        setTimeout(() => { search.focus(); search.setSelectionRange(at, at); }, 0);
      }
    }
    if (writable) {
      const add = tools.createSpan({ cls: `mn-resist__add${state.mode === "add" ? " is-on" : ""}`, text: "＋ 내성주 더하기" });
      press(add, () => { state.mode = "add"; state.selected = 0; state.confirm = 0; redraw(); });
    }

    // 본문: 왼쪽 목록 · 오른쪽 자세히
    const body = root.createDiv({ cls: "mn-resist__body" });
    const list = body.createDiv({ cls: "mn-resist__list" });
    const side = body.createDiv({ cls: "mn-resist__side" });
    const query = state.query.toLowerCase();
    let rows = resists.filter((r) => state.kind === "전체" || (state.kind === "갈래 미정" ? !KINDS.includes(r.kind) : r.kind === state.kind));
    if (query) rows = rows.filter((r) => [r.name, r.cause, r.note, r.when].join(" ").toLowerCase().includes(query));
    if (state.sort === "등급 순") rows = rows.slice().sort((a, b) => rank(b) - rank(a) || a.no - b.no);
    if (!resists.length) list.createDiv({ cls: "mn-record__resist-empty", text: "아직 정하지 않았어요" });
    else if (!rows.length) list.createDiv({ cls: "mn-record__resist-empty", text: query ? `「${state.query}」에 맞는 내성주가 없어요` : "이 갈래의 내성주는 없어요" });
    rows.forEach((resist) => {
      const row = list.createDiv({ cls: `mn-resist__row${resist.no === state.selected && state.mode !== "add" ? " is-on" : ""}` });
      row.createSpan({ cls: "mn-record__resist-no", text: String(resist.no).padStart(2, "0") });
      const title = row.createSpan({ cls: "mn-record__resist-title" });
      title.createSpan({ cls: "mn-record__resist-name", text: resist.name });
      if (resist.kind) title.createSpan({ cls: `mn-record__resist-kind${resist.kind === "액티브" ? " is-active" : ""}`, text: resist.kind });
      if (resist.history.length) title.createSpan({ cls: "mn-record__resist-grown", text: `↑ ${resist.history.length}`, attr: { title: `더 강해진 기록 ${resist.history.length}번` } });
      gradeInto(row, resist.grade, resist.gradeText);
      press(row, () => { state.selected = resist.no; state.mode = "view"; state.confirm = 0; redraw(); });
    });

    const selected = resists.find((r) => r.no === state.selected) || null;
    // 더하기 · 고치기 칸. 등급은 「M3 Ⅳ」 · 「M3 IV」 · 「M3 4」 다 받아서 「M3 Ⅳ」로 적음.
    // 고칠 때 등급이 바뀌면 옛 등급을 강해진 기록에 남길지 고름(기본 남김 — 내성주는 더 강해지니까)
    const formOf = (host, resist) => {
      const form = host.createDiv({ cls: "mn-record__resist-form" });
      form.createDiv({ cls: "mn-record__resist-form-title", text: resist ? `${resist.name} 고치기` : "내성주 더하기" });
      const grid = form.createDiv({ cls: "mn-record__resist-form-grid" });
      const field = (label, value, placeholder, wide = false) => {
        const wrap = grid.createEl("label", { cls: `mn-record__resist-field${wide ? " is-wide" : ""}` });
        wrap.createSpan({ cls: "mn-record__label", text: label });
        const input = wrap.createEl("input", { attr: { type: "text", placeholder } });
        input.value = value || "";
        return input;
      };
      const name = field("이름", resist && resist.name, "예: 통찰안");
      const kindWrap = grid.createDiv({ cls: "mn-record__resist-field" });
      kindWrap.createSpan({ cls: "mn-record__label", text: "갈래" });
      const kindGroup = kindWrap.createDiv({ cls: "mn-record__resist-group" });
      let kind = resist ? resist.kind : "";
      const kindChips = ["패시브", "액티브", "미정"].map((value) => {
        const node = kindGroup.createSpan({ cls: "mn-record__resist-chip", text: value });
        press(node, () => { kind = value === "미정" ? "" : value; paintKind(); });
        return [node, value];
      });
      const paintKind = () => kindChips.forEach(([node, value]) => node.toggleClass("is-on", (kind || "미정") === value));
      paintKind();
      const grade = field("등급", resist && resist.gradeText, "예: M3 Ⅳ");
      const cause = field("계기", resist && resist.cause, "예: 충격 · 감각 · 경험");
      const when = field("얻은 때", resist && resist.when, "예: 시점");
      const note = field("메모", resist && resist.note, "어떤 능력인지", true);
      let keep = null;
      if (resist && resist.grade) {
        const wrap = form.createEl("label", { cls: "mn-record__resist-keep" });
        keep = wrap.createEl("input", { attr: { type: "checkbox" } });
        keep.checked = true;
        wrap.appendText(` 등급이 바뀌면 옛 등급(${recordGradeText(resist.grade)})을 강해진 기록에 남기기`);
      }
      const foot = form.createDiv({ cls: "mn-record__resist-form-foot" });
      const error = foot.createSpan({ cls: "mn-record__resist-error" });
      const cancel = foot.createSpan({ cls: "mn-record__resist-button", text: "그만" });
      const ok = foot.createSpan({ cls: "mn-record__resist-button is-primary", text: resist ? "고치기" : "더하기" });
      const submit = async () => {
        const data = { name: name.value.trim(), kind, grade: grade.value.trim(), cause: cause.value.trim(), when: when.value.trim(), note: note.value.trim() };
        if (!data.name) { error.setText("이름을 적어 주세요"); name.focus(); return; }
        if (data.grade && !/^(미정|\?|-|—)$/u.test(data.grade)) {
          const parsed = parseRecordGrade(data.grade);
          if (!parsed) { error.setText("등급은 「M3 Ⅳ」처럼 적어요"); grade.focus(); return; }
          data.grade = recordGradeText(parsed);
        } else data.grade = "";
        const items = resists.map((r) => r.raw);
        const history = resist ? [...resist.history] : [];
        if (resist && resist.grade && keep && keep.checked && data.grade && data.grade !== recordGradeText(resist.grade)) history.push(`${resist.when || "미정"} · ${recordGradeText(resist.grade)}`);
        const fields = { 이름: data.name, 갈래: data.kind, 등급: data.grade, 계기: data.cause, "얻은 때": data.when, 메모: data.note };
        const wasObject = resist && resist.raw && typeof resist.raw === "object";
        let item;
        if (wasObject || data.when || history.length || /[:：]/u.test(data.name) || /—/u.test(data.cause)) {
          item = wasObject ? { ...resist.raw } : {};
          ["name", "종류", "시점", "설명"].forEach((alias) => delete item[alias]);
          Object.entries(fields).forEach(([key, value]) => { if (value) item[key] = value; else delete item[key]; });
          if (history.length) item["강해진 기록"] = history; else delete item["강해진 기록"];
        } else {
          const value = [data.kind, data.grade, data.cause].filter(Boolean).join(" · ");
          item = value || data.note ? `${data.name}:${value ? ` ${value}` : ""}${data.note ? ` — ${data.note}` : ""}` : data.name;
        }
        if (resist) items[resist.no - 1] = item; else items.push(item);
        ok.setText("적는 중…");
        await save(items, resist ? resist.no : items.length);
      };
      const stop = () => { state.mode = "view"; if (!state.selected && resists.length) state.selected = resists[0].no; redraw(); };
      press(cancel, stop);
      press(ok, submit);
      form.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stop(); }
        else if (event.key === "Enter" && event.target && event.target.tagName === "INPUT" && event.target.type === "text") { event.preventDefault(); submit(); }
      });
      setTimeout(() => name.focus(), 0);
    };

    if (state.mode === "add") { formOf(side, null); return; }
    if (state.mode === "edit" && selected) { formOf(side, selected); return; }
    if (!selected) {
      side.createDiv({ cls: "mn-resist__hint", text: resists.length ? "왼쪽에서 내성주를 고르면 여기에 자세히 나와요" : writable ? "「＋ 내성주 더하기」로 하나씩 적어요" : "속성 「내성주」에 「이름: 패시브 · M3 Ⅳ · 충격 — 메모」처럼 한 줄씩 적어요" });
      return;
    }
    // 고른 내성주 자세히: 이름 · 갈래 · 등급 → 계기 · 얻은 때 → 메모 → 강해진 기록 → 고치기 · 지우기
    const card = side.createDiv({ cls: "mn-resist__card" });
    const top = card.createDiv({ cls: "mn-resist__card-top" });
    top.createSpan({ cls: "mn-record__resist-no", text: String(selected.no).padStart(2, "0") });
    top.createSpan({ cls: "mn-resist__card-name", text: selected.name });
    if (selected.kind) top.createSpan({ cls: `mn-record__resist-kind${selected.kind === "액티브" ? " is-active" : ""}`, text: selected.kind });
    const gradeLine = card.createDiv({ cls: "mn-resist__card-grade" });
    gradeInto(gradeLine, selected.grade, selected.gradeText);
    if (selected.grade) pipsInto(gradeLine, selected.grade);
    const detail = [["계기", selected.cause], ["얻은 때", selected.when]].filter(([, value]) => value);
    if (detail.length) {
      const line = card.createDiv({ cls: "mn-record__resist-meta" });
      detail.forEach(([label, value]) => {
        const meta = line.createSpan({ cls: "mn-record__resist-meta-item" });
        meta.createSpan({ cls: "mn-record__label", text: label });
        meta.createSpan({ text: value });
      });
    }
    if (selected.note) card.createDiv({ cls: "mn-record__profile-note mn-record__resist-note", text: selected.note });
    // 더 강해진 내력: 「시점 · 등급」 → 옛 등급에서 지금까지 화살표로
    if (selected.history.length) {
      const trail = card.createDiv({ cls: "mn-record__resist-trail" });
      trail.createSpan({ cls: "mn-record__label", text: "강해진 기록" });
      selected.history.forEach((entry) => {
        const [time, value] = entry.split(/\s*·\s*/u);
        trail.createSpan({ cls: "mn-record__resist-step", text: value ? `${value}${time && time !== "미정" ? ` (${time})` : ""}` : time });
        trail.createSpan({ cls: "mn-record__resist-arrow", text: "→" });
      });
      trail.createSpan({ cls: "mn-record__resist-step is-now", text: selected.grade ? `${recordGradeText(selected.grade)} 지금` : "지금" });
    }
    if (!detail.length && !selected.note && !selected.history.length) card.createDiv({ cls: "mn-record__resist-empty", text: "계기 · 메모를 아직 안 적었어요" });
    if (!writable) return;
    const actions = card.createDiv({ cls: "mn-record__resist-row-actions" });
    if (state.confirm === selected.no) {
      actions.createSpan({ cls: "mn-record__resist-error", text: `「${selected.name}」 지울까요?` });
      const no = actions.createSpan({ cls: "mn-record__resist-button", text: "그만" });
      const yes = actions.createSpan({ cls: "mn-record__resist-button is-danger", text: "지우기" });
      press(no, () => { state.confirm = 0; redraw(); });
      press(yes, async () => {
        yes.setText("지우는 중…");
        await save(resists.map((r) => r.raw).filter((_, index) => index !== selected.no - 1), 0);
      });
      return;
    }
    const edit = actions.createSpan({ cls: "mn-record__resist-button", text: "✎ 고치기" });
    const remove = actions.createSpan({ cls: "mn-record__resist-button", text: "지우기" });
    press(edit, () => { state.mode = "edit"; state.confirm = 0; redraw(); });
    press(remove, () => { state.confirm = selected.no; redraw(); });
  }

  /** 「160만~163만」 · 「2,600」 · 「3.4」 → 앞쪽 수(정렬용). 수가 없으면 null */
  recordAmount(value) {
    const match = this.plainLink(value).replace(/,/gu, "").match(/(\d+(?:\.\d+)?)\s*(억|만|천)?/u);
    if (!match) return null;
    return Number(match[1]) * ({ 억: 1e8, 만: 1e4, 천: 1e3 }[match[2]] || 1);
  }

  /** 속성 값 칸: 링크([[…|…]])는 눌러서 그 노트로, 여러 개면 「 · 」로 */
  recordValue(parent, value, sourcePath) {
    const items = (Array.isArray(value) ? value : [value]).map((item) => this.asText(item).trim()).filter(Boolean);
    items.forEach((item, index) => {
      if (index) parent.appendText(" · ");
      const link = item.match(/^\[\[([^\]|]+)\|?([^\]]*)\]\]$/u);
      if (!link) {
        parent.appendText(item);
        return;
      }
      const span = parent.createSpan({ cls: "mn-record__link", text: link[2] || link[1], attr: { role: "link", tabindex: "0", title: `${link[1]} 열기` } });
      const open = (event) => {
        event.preventDefault();
        const workspace = this.app && this.app.workspace;
        if (workspace && typeof workspace.openLinkText === "function") workspace.openLinkText(link[1], sourcePath, event.ctrlKey || event.metaKey ? "tab" : false);
      };
      span.addEventListener("click", open);
      span.addEventListener("keydown", (event) => { if (event.key === "Enter") open(event); });
    });
  }

  /** 인물 기록표 그리기: 이름 · 이명 → 수치(투력 · 항력) → 나머지 속성(노트에 적힌 차례) → 비어 있는 칸(속성 「미정」 · 책의 빈 줄) */
  async renderRecord(el, sourcePath, options = {}) {
    el.addClass("mn-record");
    const vault = this.app && this.app.vault;
    const cache = this.app && this.app.metadataCache;
    const file = vault && typeof vault.getAbstractFileByPath === "function" ? vault.getAbstractFileByPath(sourcePath) : null;
    const front = (file && cache && cache.getFileCache(file)?.frontmatter) || {};
    const data = file ? await this.readCodexData(file) : null;
    const name = this.asText(data && data.title).trim() || sourcePath.split("/").pop().replace(/\.md$/u, "");
    const has = (value) => (Array.isArray(value) ? value : [value]).some((item) => this.plainLink(item) !== "");
    const unset = (value) => !has(value) || (Array.isArray(value) ? value : [value]).every((item) => /^(미정|\?|-|—)$/u.test(this.plainLink(item)));
    const test = /시험/u.test(this.asText(front["시점"]));

    const head = el.createDiv({ cls: "mn-record__head" });
    const titles = head.createDiv();
    titles.createDiv({ cls: "mn-record__kicker", text: "CHARACTER RECORD" });
    if (has(front["이명"])) titles.createDiv({ cls: "mn-record__alias", text: this.plainLink(front["이명"]) });
    titles.createDiv({ cls: "mn-record__title", text: name });
    const tags = head.createDiv({ cls: "mn-record__tags" });
    if (test) tags.createSpan({ cls: "mn-record__tag is-test", text: "시험" });
    if (has(front["상태"])) tags.createSpan({ cls: "mn-record__tag", text: this.plainLink(front["상태"]) });

    const sheet = el.createDiv({ cls: "mn-record__sheet" });
    const STATS = ["투력", "항력"];
    const stats = STATS.filter((key) => key in front);
    if (stats.length) {
      const row = sheet.createDiv({ cls: "mn-record__stats" });
      stats.forEach((key) => {
        const cell = row.createDiv({ cls: `mn-record__stat${unset(front[key]) ? " is-unset" : ""}` });
        cell.createDiv({ cls: "mn-record__label", text: key });
        cell.createDiv({ cls: "mn-record__number", text: unset(front[key]) ? "미정" : this.plainLink(front[key]) });
      });
    }

    // 스테이터스(작가와 의논 중 2026-10-29) — 속성에 있으면 속성, 없으면 블록에 적은 초안을 「미리보기」로
    //  ① 관측 기록: 투력 · 항력을 잰 때(시점)와 함께. 맨 위 줄이 최신, 오르면 위에 한 줄 더하고 옛 값은 성장 기록으로 남김
    //  ② 능력(작가와 정함 2026-10-30): 모든 능력을 M 등급으로, 틀(전투 · 의지 · 실현)마다 따로. 축이 셋 이상이면 다각형
    const present = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "");
    const sourceOf = (key) => (present(front[key]) ? front[key] : options && present(options[key]) ? options[key] : null);
    const draft = (key) => !present(front[key]) && options && present(options[key]);
    const listOf = (key) => {
      const value = sourceOf(key);
      return Array.isArray(value) ? value : value ? [value] : [];
    };
    const sectionHead = (box, label, sub, key) => {
      const head = box.createDiv({ cls: "mn-record__section-head" });
      head.createSpan({ cls: "mn-record__label", text: label });
      head.createSpan({ cls: "mn-record__section-sub", text: sub });
      if ([].concat(key).some(draft)) head.createSpan({ cls: "mn-record__draft", text: "미리보기", attr: { title: "속성에 아직 없고 기록표 블록에 적은 초안이에요" } });
    };
    // 「시점 · 투력 · 항력」 글 한 줄 또는 { 시점, 투력, 항력 }
    const log = listOf("투력 기록").map((item) => {
      if (item && typeof item === "object") return { time: this.plainLink(item["시점"]), power: this.plainLink(item["투력"]), resist: this.plainLink(item["항력"]) };
      const [time, power, resist] = this.plainLink(item).split(/\s*·\s*/u);
      return { time, power, resist };
    }).filter((row) => row.power || row.resist);
    if (log.length) {
      const box = sheet.createDiv({ cls: "mn-record__section" });
      sectionHead(box, "관측 기록", "잰 때와 함께 쌓아요 · 오르면 위에 한 줄 더하고 옛 값은 성장 기록으로", "투력 기록");
      const rows = box.createDiv({ cls: "mn-record__log" });
      log.forEach((row, index) => {
        const line = rows.createDiv({ cls: `mn-record__log-row${index === 0 ? " is-latest" : ""}` });
        line.createSpan({ cls: "mn-record__log-time", text: !row.time || row.time === "미정" ? "시점 미정" : row.time });
        line.createSpan({ cls: "mn-record__log-value", text: row.power ? `투력 ${row.power}` : "" });
        line.createSpan({ cls: "mn-record__log-value", text: row.resist ? `항력 ${row.resist}` : "" });
        line.createSpan({ cls: "mn-record__log-tag", text: index === 0 ? "최신" : "" });
      });
      if (log.length === 1) rows.createDiv({ cls: "mn-record__log-next", text: "다음에 잰 값이 생기면 이 위에 한 줄 더해요" });
    }
    // ③ 능력 — 남과 비교하지 않고 그 사람 기록만으로 셈이 되게(누가 세져도 안 흔들림, 세지면 시점 줄만 더함).
    //    「축: M3 Ⅶ — 메모」. M0 Ⅰ부터 한 단에 Ⅰ~Ⅹ, Ⅹ 다음은 다음 단 Ⅰ(M10을 넘어도 그대로 늘어남)
    //    틀마다 따로: 축이 셋 이상이면 다각형(축 수만큼 각), 둘 이하면 줄로
    const splitAbility = (item) => this.recordSplit(item);
    const parseGrade = parseRecordGrade;
    const DERIVED_TIP = "큰 축 등급을 안 적어서 세부 중 가장 높은 값을 옅게 보여 줘요";
    const UNSET = /^(미정|\?|-|—)$/u;
    const gradeMark = (parent, row, cls = "") => {
      const grade = row.shown || row.grade;
      const mark = parent.createSpan({ cls: `mn-record__grade${cls}${grade ? "" : " is-unset"}${row.derived ? " is-derived" : ""}` });
      if (row.derived) mark.setAttr("title", DERIVED_TIP);
      if (grade) {
        mark.createSpan({ cls: "mn-record__grade-tier", text: `M${grade.tier}` });
        mark.createSpan({ cls: "mn-record__grade-step", text: GRADE_STEPS[grade.step - 1] });
      } else {
        mark.textContent = row.value || "미정";
      }
      return grade;
    };
    const gradeRow = (parent, row) => {
      const line = parent.createDiv({ cls: "mn-record__grade-row" });
      line.createSpan({ cls: "mn-record__profile-axis", text: row.axis });
      const grade = gradeMark(line, row);
      const pips = line.createSpan({ cls: `mn-record__grade-pips${row.derived ? " is-derived" : ""}`, attr: { title: grade ? `M${grade.tier} 단 안에서 ${grade.step} / 10칸` : "미정" } });
      for (let i = 1; i <= 10; i += 1) pips.createSpan({ cls: `mn-record__grade-pip${grade && i <= grade.step ? " is-on" : ""}${grade && i === grade.step ? " is-last" : ""}` });
      line.createSpan({ cls: "mn-record__profile-note", text: row.note });
      return line;
    };
    // 틀 하나: 「큰 축: 등급」과 「큰 축 > 세부: 등급」(› 도 됨)을 모아 큰 축마다 { 등급, 세부[] }.
    //   정해 둔 큰 축이 있는 틀(전투)은 그 축을 늘 다 보여 줌(안 적었으면 미정) → 그 밖에 적은 축. 세부도 정해 둔 것 → 그 밖에 적은 것
    //   큰 축 등급은 작가가 직접 적고(작가 고름 2026-11-01), 비워 두고 세부만 적으면 세부 중 가장 높은 값을 옅게(derived)
    const AXIS_ALIAS = { 내구: "내구도", 민첩함: "민첩" };
    const gradeIndex = (grade) => grade.tier * 10 + grade.step;
    const buildFrame = (title, key) => {
      const canon = RECORD_AXES[key] || [];
      const axes = new Map();
      const ensure = (name) => {
        if (!axes.has(name)) axes.set(name, { axis: name, value: "", note: "", grade: null, written: [] });
        return axes.get(name);
      };
      canon.forEach(([name]) => ensure(name));
      listOf(key).map(splitAbility).filter((row) => row.axis).forEach((row) => {
        const [big, sub] = row.axis.split(/\s*[>›]\s*/u).map((part) => part.trim());
        const entry = ensure(AXIS_ALIAS[big] || big);
        const grade = parseGrade(row.value);
        if (sub) entry.written.push({ axis: sub, value: row.value, note: row.note, grade });
        else Object.assign(entry, { value: row.value, note: row.note, grade });
      });
      const rows = [...axes.values()].map((entry) => {
        const canonSubs = (canon.find(([axis]) => axis === entry.axis) || [entry.axis, []])[1];
        const written = new Map(entry.written.map((sub) => [sub.axis, sub]));
        const subs = [...canonSubs.map((sub) => written.get(sub) || { axis: sub, value: "", note: "", grade: null }), ...entry.written.filter((sub) => !canonSubs.includes(sub.axis))];
        const top = entry.written.filter((sub) => sub.grade).reduce((best, sub) => (!best || gradeIndex(sub.grade) > gradeIndex(best.grade) ? sub : best), null);
        const derived = !entry.grade && top ? top.grade : null;
        const filled = entry.written.filter((sub) => sub.grade || (sub.value && !UNSET.test(sub.value))).length;
        return { ...entry, subs, derived, top, filled, shown: entry.grade || derived, note: entry.note || (derived ? `큰 축 미정 · 세부 「${top.axis}」 값` : "") };
      });
      return { title, key, fixed: canon.length > 0, rows, written: listOf(key).length > 0 };
    };
    const FRAMES = [["전투", "전투 등급"], ["의지 · 실현", "의지 · 실현 등급"]];
    const frames = FRAMES.map(([title, key]) => buildFrame(title, key)).filter((frame) => frame.written);
    if (frames.length) {
      const box = sheet.createDiv({ cls: "mn-record__section" });
      sectionHead(box, "능력 · 등급", "M0 Ⅰ부터 한 단에 Ⅰ~Ⅹ, Ⅹ 다음은 다음 단 Ⅰ · 틀마다 따로", frames.map((frame) => frame.key));
      // 펼친 큰 축은 노트 · 틀마다 하나씩 기억(속성이 바뀌어 다시 그려도 그대로)
      if (!this.recordAxisState) this.recordAxisState = new Map();
      if (!this.recordAxisState.has(sourcePath)) this.recordAxisState.set(sourcePath, {});
      const opened = this.recordAxisState.get(sourcePath);
      const doc = el.ownerDocument || document;
      const press = (node, run) => {
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
        node.addEventListener("click", run);
        node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(event); } });
      };
      const SCALE = "가운데 = 그 단의 시작 · 바깥 테 = Ⅹ · 한 칸이 한 등급 · 금빛 점 = 가장 높은 축";
      frames.forEach((frame) => {
        box.createDiv({ cls: "mn-record__frame-title", text: frame.title });
        const holder = box.createDiv({ cls: "mn-record__frame" });
        const known = frame.rows.filter((row) => row.shown);
        // 정해 둔 큰 축이 있는 틀은 늘 다각형(큰 축만, 아래에 줄을 두지 않음). 그 밖의 틀은 등급이 셋 이상이면 다각형, 아니면 줄
        const chart = frame.fixed || known.length >= 3;
        const onChart = frame.fixed ? frame.rows : known;
        if (opened[frame.key] && !frame.rows.some((row) => row.axis === opened[frame.key] && row.subs.length)) delete opened[frame.key];
        const toggle = (axis) => {
          if (opened[frame.key] === axis) delete opened[frame.key]; else opened[frame.key] = axis;
          draw(true);
        };
        const radarOf = (rows, fallback) => this.recordRadar(rows.map((row) => ({ axis: row.axis, grade: row.shown || row.grade, derived: !!row.derived, note: row.note })), doc, fallback);
        const fallbackTier = known.length ? Math.min(...known.map((row) => row.shown.tier)) : 0;
        // 세부: 셋 이상이면 그 축만의 다각형(무력 → 완력 · 각력 · 악력), 둘 이하면 줄
        const drawSubs = (parent, row, swap) => {
          if (row.subs.length >= 3) {
            const svg = radarOf(row.subs, row.shown ? row.shown.tier : fallbackTier);
            svg.classList.add("is-sub");
            if (swap) svg.classList.add("is-swap");
            parent.appendChild(svg);
            parent.createDiv({ cls: "mn-record__scale", text: `${row.axis}의 세부 · ${SCALE} · 미정은 가운데` });
            const noted = row.subs.filter((sub) => sub.note);
            if (noted.length) {
              const list = parent.createDiv({ cls: "mn-record__sub-notes" });
              noted.forEach((sub) => {
                const line = list.createDiv({ cls: "mn-record__sub-note" });
                line.createSpan({ cls: "mn-record__profile-axis", text: sub.axis });
                gradeMark(line, sub);
                line.createSpan({ cls: "mn-record__profile-note", text: sub.note });
              });
            }
          } else {
            const list = parent.createDiv({ cls: "mn-record__subs" });
            row.subs.forEach((sub) => gradeRow(list, sub));
          }
          if (!row.filled) parent.createDiv({ cls: "mn-record__subs-hint", text: `세부는 「${row.axis} > ${row.subs[0].axis}: M3 Ⅴ — 메모」처럼 적어요` });
        };
        const draw = (swap = false) => {
          holder.empty();
          const pick = frame.rows.find((row) => row.axis === opened[frame.key]) || null;
          if (chart && pick) {
            // 큰 축을 누른 뒤: 그 축의 세부 다각형으로 바뀜. 「← 전투」로 돌아감
            const head = holder.createDiv({ cls: "mn-record__detail-head" });
            const back = head.createSpan({ cls: "mn-record__detail-back", text: `← ${frame.title}`, attr: { title: `${frame.title} 큰 축으로 돌아가기` } });
            press(back, () => toggle(pick.axis));
            head.createSpan({ cls: "mn-record__detail-axis", text: pick.axis });
            gradeMark(head, pick);
            if (pick.note) head.createSpan({ cls: "mn-record__profile-note", text: pick.note });
            drawSubs(holder, pick, swap);
            return;
          }
          if (chart) {
            const svg = radarOf(onChart, fallbackTier);
            if (swap) svg.classList.add("is-swap");
            holder.appendChild(svg);
            onChart.forEach((row, index) => {
              if (!row.subs.length) return;
              svg.querySelectorAll(`.mn-record__radar-axis[data-index="${index}"], .mn-record__radar-grade[data-index="${index}"]`).forEach((node) => {
                node.classList.add("is-pick");
                press(node, () => toggle(row.axis));
              });
            });
            holder.createDiv({ cls: "mn-record__scale", text: `${SCALE}${onChart.some((row) => row.subs.length) ? " · 축 이름을 누르면 세부" : ""}` });
            if (!frame.fixed) frame.rows.filter((row) => !row.shown).forEach((row) => gradeRow(holder, row));
            return;
          }
          // 줄 모양 틀: 세부가 있는 줄을 누르면 그 아래에 세부
          frame.rows.forEach((row) => {
            const line = gradeRow(holder, row);
            if (!row.subs.length) return;
            const open = row === pick;
            line.addClass("has-subs");
            line.toggleClass("is-open", open);
            line.setAttribute("aria-expanded", String(open));
            line.createSpan({ cls: "mn-record__axis-toggle", text: `${row.filled ? `세부 ${row.filled} ` : ""}${open ? "▴" : "▾"}` });
            press(line, () => toggle(row.axis));
            if (open) drawSubs(holder.createDiv({ cls: "mn-record__sub-block" }), row, swap);
          });
        };
        draw();
      });
    }
    // ④ 내성주: 기록표엔 보유 수 · 평균만 두고, 목록 · 더하기 · 고치기는 별도 패널에서(작가 2026-11-01 「별도 패널이 열리게 해서 관리」)
    const { source: resistSource, resists } = this.recordResists(sourcePath, options);
    if (resistSource !== null) {
      const openPanel = () => new ResistPanelModal(this.app, this, sourcePath, options, name).open();
      const press = (node, run) => {
        node.setAttr("role", "button");
        node.setAttr("tabindex", "0");
        node.addEventListener("click", run);
        node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(event); } });
      };
      // 맨 위 숫자 줄에 보유 수 (누르면 관리 패널)
      let statRow = sheet.querySelector(":scope > .mn-record__stats");
      if (!statRow) { statRow = sheet.createDiv({ cls: "mn-record__stats" }); sheet.prepend(statRow); }
      const stat = statRow.createDiv({ cls: `mn-record__stat mn-record__stat--resist is-link${resists.length ? "" : " is-unset"}`, attr: { title: "눌러서 내성주 관리 패널 열기" } });
      stat.createDiv({ cls: "mn-record__label", text: "내성주" });
      stat.createDiv({ cls: "mn-record__number", text: resists.length ? `${resists.length}` : "미정" });
      const tally = RECORD_KINDS.map((kind) => [kind, resists.filter((r) => r.kind === kind).length]).filter(([, total]) => total);
      if (tally.length) stat.createDiv({ cls: "mn-record__stat-sub", text: tally.map(([kind, total]) => `${kind} ${total}`).join(" · ") });
      press(stat, openPanel);
      // 아래 칸: 보유 · 평균 한 줄 + 「관리 패널」
      const box = sheet.createDiv({ cls: "mn-record__section mn-record__section--resist" });
      sectionHead(box, "내성주", "극한의 경험 · 감각 · 충격이 몸에 새긴 고유한 능력 · 더 강해질 수 있음", "내성주");
      const { graded, mean } = recordResistMean(resists);
      const bar = box.createDiv({ cls: "mn-record__resist-bar", attr: { title: "눌러서 내성주 관리 패널 열기" } });
      const facts = bar.createDiv({ cls: "mn-record__resist-facts" });
      const count = facts.createSpan({ cls: `mn-record__resist-fact is-count${resists.length ? "" : " is-unset"}` });
      count.createSpan({ cls: "mn-record__label", text: "보유" });
      count.createSpan({ cls: "mn-record__resist-fact-value", text: resists.length ? `${resists.length}` : "미정" });
      const average = facts.createSpan({ cls: "mn-record__resist-fact is-mean", attr: mean && graded.length < resists.length ? { title: `등급을 적은 ${graded.length}개의 평균이에요` } : {} });
      average.createSpan({ cls: "mn-record__label", text: "평균" });
      const value = average.createSpan({ cls: "mn-record__resist-fact-value" });
      if (mean) {
        value.addClass("mn-record__grade");
        value.createSpan({ cls: "mn-record__grade-tier", text: `M${mean.tier}` });
        value.createSpan({ cls: "mn-record__grade-step", text: GRADE_STEPS[mean.step - 1] });
      } else value.setText("미정");
      bar.createSpan({ cls: "mn-record__resist-toggle", text: "관리 패널 ▸" });
      press(bar, openPanel);
    }
    // 속성 칸: 노트에 적힌 차례 그대로. 지면 · 관리용 칸은 뺌. 세계판이 쓰는 칸(소속 · 종족 · 하는 일 · 위치 · 시점)은 없어도 「미정」으로 보임
    const HIDDEN = new Set(["분류", "상태", "이명", "초상", "공개", "만든날", "정리", "cssclasses", "cssclass", "tags", "aliases", "position", "투력 기록", "전투 등급", "의지 · 실현 등급", "내성주", ...STATS]);
    const keys = Object.keys(front).filter((key) => !HIDDEN.has(key));
    ["소속", "종족", "하는 일", "위치", "시점"].forEach((key) => { if (!keys.includes(key)) keys.push(key); });
    const grid = sheet.createDiv({ cls: "mn-record__grid" });
    keys.forEach((key) => {
      const cell = grid.createDiv({ cls: `mn-record__cell${unset(front[key]) ? " is-unset" : ""}` });
      // 긴 값(소속 여럿 등)은 두 칸 너비로 — 한 칸에선 이름 가운데서 꺾임
      const length = (Array.isArray(front[key]) ? front[key] : [front[key]]).map((item) => this.plainLink(item)).filter(Boolean).join(" · ").length;
      if (length > 11) cell.addClass("is-wide");
      cell.createDiv({ cls: "mn-record__label", text: key });
      const value = cell.createDiv({ cls: "mn-record__value" });
      if (unset(front[key])) value.setText("미정");
      else this.recordValue(value, front[key], sourcePath);
    });

    // 비어 있는 칸: 속성의 「미정」 + 책 글에서 「이름 :」 뒤가 빈 줄(여담의 좋아하는 것 · 싫어하는 것 …)
    const gaps = [...stats, ...keys].filter((key) => unset(front[key]));
    const blank = [];
    const scan = (title, content) => {
      const empty = this.asText(content).split(/\r?\n/u).map((line) => line.match(/^\s*([^:：\n]{1,24}?)\s*[:：]\s*$/u)).filter(Boolean).map((match) => match[1].trim());
      if (empty.length) blank.push(`${title} — ${empty.join(" · ")}`);
    };
    (Array.isArray(data && data.book_sections) ? data.book_sections : []).forEach((section) => {
      const title = this.asText(section && section.title).trim() || "장";
      scan(title, section && section.content);
      (Array.isArray(section && section.pages) ? section.pages : []).forEach((page) => scan(`${title} · ${this.asText(page && page.title).trim()}`, page && page.content));
    });
    if (gaps.length || blank.length) {
      const foot = el.createDiv({ cls: "mn-record__gaps" });
      foot.createDiv({ cls: "mn-record__kicker", text: `비어 있는 칸 ${gaps.length + blank.length}` });
      const list = foot.createDiv({ cls: "mn-record__gap-list" });
      gaps.forEach((key) => list.createSpan({ cls: "mn-record__gap", text: `속성 — ${key}` }));
      blank.forEach((text) => list.createSpan({ cls: "mn-record__gap", text: `책 ${text}` }));
    }
    el.createDiv({ cls: "mn-record__note", text: "값은 노트 맨 위 속성에서 고쳐요. 고치면 이 표와 인물 도감 표가 바로 바뀌어요." });
  }

  /** 인물 노트들(속성 「분류: 인물」) */
  characterNoteFiles() {
    const vault = this.app && this.app.vault;
    const cache = this.app && this.app.metadataCache;
    if (!vault || typeof vault.getMarkdownFiles !== "function" || !cache) return [];
    return vault.getMarkdownFiles().filter((file) => {
      const front = cache.getFileCache(file)?.frontmatter;
      return front && this.asText(front["분류"]).trim() === "인물";
    });
  }

  /** 노트의 지면 블록(```mn-codex) 데이터. 고친 시각(mtime)이 같으면 다시 읽지 않음 */
  async readCodexData(file) {
    if (!file || !this.app?.vault || typeof this.app.vault.cachedRead !== "function") return null;
    this._mnCodexCache = this._mnCodexCache || new Map();
    const mtime = file.stat ? file.stat.mtime : 0;
    const hit = this._mnCodexCache.get(file.path);
    if (hit && hit.mtime === mtime) return hit.data;
    let data = null;
    try {
      const text = await this.app.vault.cachedRead(file);
      const match = String(text).match(/```mn-codex[^\n]*\n([\s\S]*?)\n```/u);
      if (match) data = parseYaml(match[1]);
    } catch (error) {
      data = null;
    }
    this._mnCodexCache.set(file.path, { mtime, data });
    return data;
  }

  /** 다른 인물 노트의 관계 장에 이 이름(selfName)으로 적힌 쪽들 → 관계도 사람 (그 노트 주인이 사람, 그쪽 글 · 관계 한 줄 그대로) */
  async incomingRelations(selfName, sourcePath) {
    if (!selfName) return [];
    const out = [];
    for (const file of this.characterNoteFiles()) {
      if (file.path === sourcePath) continue;
      const data = await this.readCodexData(file);
      if (!data || !Array.isArray(data.book_sections)) continue;
      const owner = this.asText(data.title).trim() || file.basename;
      if (owner === selfName) continue;
      for (const section of data.book_sections) {
        if (!section || typeof section !== "object") continue;
        const explicit = this.asText(section.template ?? section["틀"]).trim();
        const isRelation = explicit ? /^(관계|relation)$/iu.test(explicit) : /관계|인연/u.test(this.asText(section.title));
        if (!isRelation || !Array.isArray(section.pages)) continue;
        for (const page of section.pages) {
          if (!page || this.asText(page.title).trim() !== selfName) continue;
          // 그 사람 얼굴: 그 노트의 왼쪽 창 1(얼굴 컷) · 초점 → 없으면 책장 그림 · 표지 그림 (자기 페이지 가운데 얼굴과 같은 방식)
          const ref = Array.isArray(data.detail_images) && data.detail_images[0] ? data.detail_images[0] : (data.book_image || data.image || "");
          const focus = Array.isArray(data.detail_focus) && data.detail_focus[0] ? this.asText(data.detail_focus[0]) : "50% 30%";
          out.push({ title: owner, relation: this.asText(page.relation), content: this.asText(page.content), portrait: this.asText(ref), _mnPortraitFocus: ref ? focus : "", _mnFrom: owner, _mnFromPath: file.path });
        }
      }
    }
    // 노트 속성 「관계」(세계판 마을 카드 · 관계 장 저장이 적음)에 이 사람이 있으면 그 노트 주인도 (관계 장에 이미 적었으면 그쪽 글이 우선). 실험실 추가 2026-10-28
    const vault = this.app && this.app.vault;
    const cache = this.app && this.app.metadataCache;
    const files = vault && typeof vault.getMarkdownFiles === "function" && cache ? vault.getMarkdownFiles() : [];
    for (const file of files) {
      if (file.path === sourcePath) continue;
      const front = cache.getFileCache(file)?.frontmatter;
      if (!front || front["관계"] === undefined) continue;
      const entry = this.parseRelationProperty(front["관계"]).find((item) => item.name === selfName);
      if (!entry) continue;
      const owner = this.asText(front["이름"]).trim() || file.basename;
      if (owner === selfName) continue;
      const same = out.find((item) => item._mnFromPath === file.path);
      if (same) {
        if (!this.asText(same.relation).trim()) same.relation = this.relationPropertyLine(entry);
        continue;
      }
      out.push({ title: owner, relation: this.relationPropertyLine(entry), content: "", _mnFrom: owner, _mnFromPath: file.path, _mnFromProp: true });
    }
    return out;
  }

  /** 노트 속성 「관계」 → [{ name, word, favor }]. 세계판 마을 카드는 「[[이름]] 친구 (+3), [[이름]] 적」 한 줄로, 인물 노트는 목록으로 적음 */
  parseRelationProperty(value) {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : String(value).split(/,\s*(?=\[\[)/u);
    const out = [];
    for (const item of items) {
      const match = this.asText(item).trim().match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*(.*?)\s*(?:\(([+-]?\d+)\))?\s*$/u);
      if (!match) continue;
      out.push({ name: match[1].trim().split("/").pop().replace(/\.md$/u, ""), word: match[2].trim(), favor: match[3] === undefined ? null : Number(match[3]) });
    }
    return out;
  }

  /** 관계 한 줄: 관계 낱말 · 우호도(세계판과 같은 이름: −5 원수 … +5 맹우) */
  relationPropertyLine(entry) {
    const names = ["원수", "증오", "적대", "경계", "냉담", "중립", "호감", "호의", "우호", "신뢰", "맹우"];
    const favor = Number.isInteger(entry.favor) && Math.abs(entry.favor) <= 5 ? `${entry.favor > 0 ? "+" : ""}${entry.favor} ${names[entry.favor + 5]}` : "";
    return [entry.word, favor].filter(Boolean).join(" · ");
  }

  /** 관계 장의 사람들을 노트 속성 「관계」에도 [[이름]]으로 남김 (없는 사람만 더하고, 속성에만 있는 사람 · 우호도는 그대로). 실험실 추가 2026-10-28 */
  async syncRelationProperty(path, data) {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path || ""));
    const manager = this.app && this.app.fileManager;
    if (!(file instanceof TFile) || !manager || typeof manager.processFrontMatter !== "function") return;
    const pages = [];
    for (const section of Array.isArray(data && data.book_sections) ? data.book_sections : []) {
      if (!section || typeof section !== "object") continue;
      const explicit = this.asText(section.template ?? section["틀"]).trim();
      const isRelation = explicit ? /^(관계|relation)$/iu.test(explicit) : /관계|인연/u.test(this.asText(section.title));
      if (!isRelation) continue;
      for (const page of Array.isArray(section.pages) ? section.pages : []) {
        const name = this.asText(page && page.title).trim();
        if (name) pages.push({ name, word: this.asText(page.relation).trim() });
      }
    }
    if (!pages.length) return;
    await manager.processFrontMatter(file, (front) => {
      const current = front["관계"];
      const entries = this.parseRelationProperty(current);
      const keep = Array.isArray(current) ? current.map((item) => this.asText(item)) : current ? String(current).split(/,\s*(?=\[\[)/u) : [];
      let changed = false;
      for (const page of pages) {
        if (entries.some((entry) => entry.name === page.name)) continue;
        keep.push(`[[${page.name}]]${page.word ? ` ${page.word}` : ""}`);
        changed = true;
      }
      if (changed) front["관계"] = keep;
    });
  }

  /** 관계도에서 새 인물 노트 만들기: 지금 노트와 같은 지면 틀(전용 지면은 임시로 빌려 씀), 값은 모두 「미정」. 만든 뒤 엶 */
  async createCharacterNote(name, sourcePath, sourceData) {
    const vault = this.app && this.app.vault;
    if (!vault || typeof vault.create !== "function") throw new Error("보관소에 쓸 수 없어요");
    const safe = this.asText(name).replace(/[\\/:*?"<>|#^[\]]/gu, "").trim();
    if (!safe) throw new Error("이름이 비었어요");
    const folder = /^The Main - 인물\//u.test(sourcePath) ? sourcePath.replace(/\/[^/]*$/u, "") : "The Main - 인물";
    const path = normalizePath(`${folder}/${safe}.md`);
    if (vault.getAbstractFileByPath(path)) {
      await this.app.workspace.openLinkText(path, sourcePath, false);
      return path;
    }
    const sourceName = this.asText(sourceData && (sourceData._mnCharacterName || sourceData.title)).trim() || "원래";
    const variant = this.asText(sourceData && sourceData.layout_variant).trim();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const q = (value) => JSON.stringify(value);
    const lines = [
      "---", "분류: 인물", "상태: 작가 작성 중", "하는 일: 미정", "시점: 미정", `만든날: ${today}`, "cssclasses:", "  - mn-codex-fullpage", "---", "",
      "```mn-codex", "type: spread", "theme: mely", "layout_mode: black-tide",
      variant ? `layout_variant: ${variant} # ${sourceName} 지면의 틀(배치)만 빌려 씀 — 색 · 무늬 · 문장은 아래 칸 (✎ 글 고치기 → 지면)` : null,
      variant ? `page_tint: 먹 # 지면 색: ${VARIANT_TINT_NAMES.join(" · ")} (은회 = ${sourceName} 지면 색 그대로)` : null,
      variant ? "page_pattern: 없음 # 바탕 무늬: 검(떠 있는 검) · 없음" : null,
      variant ? "page_emblem: 없음 # 문장(표지 왼쪽 위 · 개요 그림 메달): 그림 경로 · 없음" : null,
      "visual_mode: live", "deck: auto",
      `title: ${q(safe)}`, `book_title: ${q(safe)}`, 'book_eyebrow: ""', 'book_subtitle: ""', "book_page_style: archive", "book_page_mode: left",
      "book_sections:",
      '  - title: "개요"', "    subtitle: BASE . RECORD", "    content: |", `      이름 : ${safe}`, "      소속 : 미정", "      종족 : 미정",
      '  - title: "능력"', "    subtitle: ABILITY · TECHNIQUE", "    content: |", "      - 미정",
      '  - title: "관계"', "    subtitle: RELATION · CHRONICLE", '    content: ""',
      '  - title: "여담"', "    subtitle: PERSONAL · NOTES", "    content: |", "      좋아하는 것 :", "      싫어하는 것 :", "      취미 :",
      'content: ""', "```", "",
      "> [!note]- 메모", `> ${sourceName} 노트의 관계도에서 만든 빈 인물 노트예요. 값은 모두 미정이에요. ${sourceName} 노트에 적힌 관계는 이 노트의 관계도에도 저절로 떠요.`, "",
    ].filter((line) => line !== null);
    await vault.create(path, lines.join("\n"));
    new Notice(`「${safe}」 인물 노트를 만들었어요 (값은 모두 미정).`);
    if (this.app.workspace && typeof this.app.workspace.openLinkText === "function") await this.app.workspace.openLinkText(path, sourcePath, false);
    return path;
  }

  /** 이 노트의 관계 장에 사람 쪽(제목 · 빈 관계 한 줄 · 빈 글)을 넣음. 블록을 통째로 다시 쓰지 않고 줄만 끼워 넣어 노트의 주석을 지킴 */
  async addRelationPage(sourcePath, data, sectionIndex, sectionTitle, name, relation = "") {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(sourcePath || ""));
    if (!(file instanceof TFile)) {
      new Notice("이 노트를 찾지 못했어요.");
      return false;
    }
    let result = "";
    await this.app.vault.process(file, (text) => {
      const next = this.insertRelationPageText(text, data, sectionIndex, sectionTitle, name, relation);
      result = !next ? "" : next === text ? "same" : "ok";
      return next || text;
    });
    if (result === "ok") {
      try {
        await this.syncRelationProperty(sourcePath, { book_sections: [{ title: sectionTitle, template: "관계", pages: [{ title: name, relation }] }] });
      } catch (error) {
        console.warn("MN Codex: 속성 「관계」에 남기지 못했어요", error);
      }
    }
    new Notice(result === "ok" ? `「${name}」 쪽을 이 노트 관계 장에 빈 칸으로 넣었어요. ✎ 글 고치기에서 채워요.`
      : result === "same" ? `「${name}」 쪽은 이미 이 노트 관계 장에 있어요.`
      : "관계 장 자리를 찾지 못해 넣지 않았어요. ✎ 글 고치기에서 직접 넣어 주세요.");
    return result === "ok";
  }

  insertRelationPageText(text, data, sectionIndex, sectionTitle, name, relation = "") {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const blocks = [];
    for (let i = 0; i < lines.length; i += 1) {
      const fence = (lines[i].match(/^\s*(`{3,}|~{3,})\s*mn-codex\b/) || [])[1];
      if (!fence) continue;
      const closer = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j])) j += 1;
      blocks.push([i + 1, j]);
      i = j;
    }
    const parse = (from, to, source = lines) => { try { return parseYaml(source.slice(from, to).join("\n")); } catch (error) { return null; } };
    const title = this.asText(data && data.title).trim();
    const block = blocks.length === 1 ? blocks[0] : blocks.find(([from, to]) => this.asText((parse(from, to) || {}).title).trim() === title);
    if (!block) return "";
    const [from, to] = block;
    const parsed = parse(from, to);
    const sections = parsed && Array.isArray(parsed.book_sections) ? parsed.book_sections : [];
    let pick = sections.findIndex((section) => this.asText(section && section.title).trim() === this.asText(sectionTitle).trim());
    if (pick < 0) pick = Number(sectionIndex);
    const section = sections[pick];
    if (!section) return "";
    if ((Array.isArray(section.pages) ? section.pages : []).some((page) => this.asText(page && page.title).trim() === name)) return text;
    // book_sections 의 항목 줄들
    const head = lines.findIndex((line, k) => k >= from && k < to && /^book_sections:\s*$/u.test(line));
    if (head < 0) return "";
    const items = [];
    let itemIndent = -1;
    let end = to;
    for (let k = head + 1; k < to; k += 1) {
      const line = lines[k];
      if (!line.trim() || /^\s*#/u.test(line)) continue;
      const indent = line.match(/^\s*/u)[0].length;
      if (indent === 0 && !/^- /u.test(line)) { end = k; break; }
      if (itemIndent < 0 && /^\s*- /u.test(line)) itemIndent = indent;
      if (indent === itemIndent && /^\s*- /u.test(line)) items.push(k);
    }
    if (pick >= items.length) return "";
    const start = items[pick];
    const stop = pick + 1 < items.length ? items[pick + 1] : end;
    const keyIndent = " ".repeat(itemIndent + 2);
    const lastFilled = (k) => { while (k > start && !lines[k - 1].trim()) k -= 1; return k; };
    const q = (value) => JSON.stringify(value);
    const entry = (indent) => [`${indent}- title: ${q(name)}`, `${indent}  relation: ${q(this.asText(relation))}`, `${indent}  content: ""`];
    const next = lines.slice();
    const pagesAt = lines.findIndex((line, k) => k > start && k < stop && new RegExp(`^${keyIndent}pages:\\s*(\\[\\s*\\])?\\s*$`, "u").test(line));
    if (pagesAt < 0) {
      next.splice(lastFilled(stop), 0, `${keyIndent}pages:`, ...entry(`${keyIndent}  `));
    } else {
      next[pagesAt] = `${keyIndent}pages:`;
      const firstItem = lines.slice(pagesAt + 1, stop).find((line) => /^\s*- /u.test(line));
      const pageIndent = firstItem ? firstItem.match(/^\s*/u)[0] : `${keyIndent}  `;
      let k = pagesAt + 1;
      for (; k < stop; k += 1) {
        const line = lines[k];
        if (!line.trim()) continue;
        const indent = line.match(/^\s*/u)[0].length;
        if (indent < pageIndent.length || (indent === pageIndent.length && !/^\s*- /u.test(line))) break;
      }
      next.splice(lastFilled(k), 0, ...entry(pageIndent));
    }
    // 넣은 뒤 다시 읽어 그 장에 그 사람 쪽이 생겼는지 확인 (아니면 쓰지 않음)
    const added = parse(from, to + next.length - lines.length, next);
    const check = added && Array.isArray(added.book_sections) ? added.book_sections[pick] : null;
    if (!check || !(Array.isArray(check.pages) ? check.pages : []).some((page) => this.asText(page && page.title).trim() === name)) return "";
    return next.join(eol);
  }

  /** 관계 쪽 사람 그림: 쪽의 portrait → 그 이름의 인물 노트 속성 「초상」 → 없으면 첫 글자 */
  relationPortrait(name, pageData, sourcePath) {
    const direct = this.asText(pageData && pageData.portrait).trim();
    if (direct) return this.resolveImage(direct, (pageData && pageData._mnFromPath) || sourcePath);
    try {
      const cache = this.app && this.app.metadataCache;
      const file = cache && typeof cache.getFirstLinkpathDest === "function" ? cache.getFirstLinkpathDest(name, sourcePath) : null;
      const front = file && cache.getFileCache(file)?.frontmatter;
      const portrait = front && this.asText(front["초상"] || front.portrait).trim();
      if (portrait) return this.resolveImage(portrait, file.path);
    } catch (error) {
      // 노트가 없거나 속성이 없으면 첫 글자로
    }
    return "";
  }

  relationFace(doc, name, src, focus, extraClass, tag = "div") {
    const who = doc.createElement(tag);
    who.className = `mn-codex__rel-who${extraClass ? ` ${extraClass}` : ""}`;
    const face = doc.createElement("span");
    face.className = "mn-codex__rel-face";
    if (src) {
      face.style.backgroundImage = `url("${src}")`;
      if (focus) face.style.backgroundPosition = focus;
    } else {
      face.classList.add("mn-codex__rel-face--mono");
      face.textContent = Array.from(name.trim())[0] || "?";
    }
    const label = doc.createElement("span");
    label.className = "mn-codex__rel-name";
    label.textContent = name;
    who.append(face, label);
    return who;
  }

  /**
   * 관계: 왼쪽 쪽엔 관계도(가운데 나, 둘레에 사람 동그라미 — 많으면 두 겹), 오른쪽 쪽엔 고른 사람의 글.
   * 동그라미를 누르면 오른쪽만 바뀜(쪽이 늘지 않음). 사람 = 관계 장의 하위 쪽(제목 · 관계 한 줄 · 그림 · 글).
   */
  async shapeRelation(pageData, heading, kind, data, sourcePath, component) {
    if (kind !== "section") return;
    const own = Array.isArray(pageData._mnRelationPeople) ? pageData._mnRelationPeople : [];
    // 다른 인물 노트의 관계 장에 이 사람이 적혀 있으면 이 관계도에도 띄움 (그쪽 글 그대로, 「○○ 노트에서」 표시). 실험실 추가 2026-10-28
    const incoming = await this.incomingRelations(this.asText(data._mnCharacterName || data.title).trim(), sourcePath);
    const people = own.slice();
    // 내 노트 속성 「관계」(세계판 카드 등)에만 있는 사람도 띄움. 실험실 추가 2026-10-28
    for (const entry of this.parseRelationProperty((this.noteFrontmatter(sourcePath) || {})["관계"])) {
      if (!entry.name || people.some((person) => this.asText(person.title).trim() === entry.name)) continue;
      people.push({ title: entry.name, relation: this.relationPropertyLine(entry), content: "", _mnProp: true });
    }
    for (const item of incoming) {
      const same = people.find((person) => this.asText(person.title).trim() === item.title);
      if (same) same._mnAlso = (same._mnAlso || []).concat(item);
      else people.push(item);
    }
    if (!people.length) return;
    const doc = heading.ownerDocument;
    const parent = heading.parentNode;
    const nodes = this.templateNodesAfter(heading);
    const anchor = nodes.length ? nodes[nodes.length - 1].nextSibling : heading.nextSibling;
    const selfName = this.asText(data._mnCharacterName || data.title).trim();
    const selfRef = Array.isArray(data.detail_images) && data.detail_images[0] ? data.detail_images[0] : (data.book_image || data.image);
    const selfSrc = selfRef ? this.resolveImage(this.asText(selfRef), sourcePath) : "";
    const selfFocus = Array.isArray(data.detail_focus) && data.detail_focus[0] ? this.asText(data.detail_focus[0]) : "50% 30%";
    const sectionNo = String(Math.max(0, pageData._mnBookSectionIndex) + 1).padStart(2, "0");
    const sectionTitle = this.asText(pageData._mnBookSectionTitle);
    // 사람의 인물 노트: 있으면 눌러서 열기(Ctrl/⌘ 누른 채면 새 탭), 없으면 알림만. 실험실 추가 2026-10-27
    const noteOf = (name) => {
      try {
        const cache = this.app && this.app.metadataCache;
        const file = cache && typeof cache.getFirstLinkpathDest === "function" ? cache.getFirstLinkpathDest(name, sourcePath) : null;
        return file && /\.md$/iu.test(this.asText(file.path)) ? file : null;
      } catch (error) {
        return null;
      }
    };
    const openPerson = (name, event) => {
      const file = noteOf(name);
      const workspace = this.app && this.app.workspace;
      if (!file || !workspace || typeof workspace.openLinkText !== "function") {
        new Notice(`「${name}」 인물 노트가 아직 없어요. 오른쪽 카드의 「인물 노트 만들기」로 만들 수 있어요.`);
        return;
      }
      workspace.openLinkText(file.path, sourcePath, event && (event.ctrlKey || event.metaKey) ? "tab" : false);
    };

    // 자리: 겹마다 8 · 12 · 16명. 8명까지 한 겹, 20명까지 두 겹, 그 뒤로 세 겹(남는 사람은 바깥 겹에 몰아 둠).
    // 바깥 겹은 안쪽 겹 사이사이(반 칸 어긋남)에 놓아 이름이 겹치지 않게
    const count = people.length;
    const caps = [8, 12, 16];
    const ringCount = count <= 8 ? 1 : count <= 20 ? 2 : 3;
    const rings = ringCount === 1 ? [36] : ringCount === 2 ? [29, 46] : [22, 35.5, 49];
    const sizes = [];
    let left = count;
    for (let r = 0; r < ringCount; r += 1) {
      const take = r === ringCount - 1 ? left : Math.min(caps[r], left);
      sizes.push(take);
      left -= take;
    }
    const spots = [];
    sizes.forEach((n, ring) => {
      const start = -90 + (ring > 0 ? 180 / n : 0);
      for (let k = 0; k < n; k += 1) {
        const angle = (start + (360 / n) * k) * Math.PI / 180;
        spots.push({ ring, angle, x: 50 + rings[ring] * Math.cos(angle), y: 50 + rings[ring] * Math.sin(angle) });
      }
    });

    const label = doc.createElement("div");
    label.className = "mn-codex__ov-label mn-codex__orbit-label";
    label.textContent = `RELATIONS · ${String(count).padStart(2, "0")}`;
    const orbit = doc.createElement("div");
    orbit.className = `mn-codex__orbit${ringCount > 1 ? " mn-codex__orbit--dense" : ""}${ringCount > 2 ? " mn-codex__orbit--crowd" : ""}`;
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "mn-codex__orbit-lines");
    svg.setAttribute("aria-hidden", "true");
    const ringEls = rings.map((r) => {
      const ring = doc.createElementNS(NS, "ellipse");
      ring.setAttribute("cx", "50"); ring.setAttribute("cy", "50"); ring.setAttribute("rx", String(r)); ring.setAttribute("ry", String(r));
      ring.setAttribute("class", "mn-codex__orbit-ring");
      ring.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(ring);
      return ring;
    });
    const lines = spots.map((spot) => {
      const line = doc.createElementNS(NS, "line");
      line.setAttribute("x1", "50"); line.setAttribute("y1", "50");
      line.setAttribute("x2", spot.x.toFixed(2)); line.setAttribute("y2", spot.y.toFixed(2));
      line.setAttribute("class", "mn-codex__orbit-line");
      line.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(line);
      return line;
    });
    orbit.appendChild(svg);
    const center = this.relationFace(doc, selfName, selfSrc, selfFocus, "mn-codex__orbit-node mn-codex__orbit-node--self");
    center.style.left = "50%";
    center.style.top = "50%";
    orbit.appendChild(center);
    const buttons = people.map((person, i) => {
      const name = this.asText(person.title).trim();
      const button = this.relationFace(doc, name, this.relationPortrait(name, person, sourcePath), person._mnPortraitFocus || "", "mn-codex__orbit-node", "button");
      button.type = "button";
      button.style.left = `${spots[i].x}%`;
      button.style.top = `${spots[i].y}%`;
      const note = this.asText(person.relation).trim();
      if (note) { const span = doc.createElement("span"); span.className = "mn-codex__rel-note"; span.textContent = note; button.appendChild(span); }
      const hasNote = Boolean(noteOf(name));
      if (!hasNote) button.classList.add("mn-codex__orbit-node--no-note");
      if (person._mnFrom || person._mnProp) button.classList.add("mn-codex__orbit-node--incoming");
      button.setAttribute("aria-label", `${name}${note ? ` · ${note}` : ""} · ${hasNote ? "눌러서 인물 노트 열기" : "인물 노트 없음"}`);
      button.title = `${name} · ${hasNote ? "눌러서 인물 노트 열기" : "인물 노트 없음"}`;
      orbit.appendChild(button);
      return button;
    });

    // 오른쪽 쪽: 고른 사람 (처음엔 첫 사람)
    const pageBreak = doc.createElement("div");
    pageBreak.className = "mn-codex__page-break-marker";
    const detail = doc.createElement("div");
    detail.className = "mn-codex__rel-detail";
    parent.insertBefore(label, anchor);
    parent.insertBefore(orbit, anchor);
    parent.insertBefore(pageBreak, anchor);
    parent.insertBefore(detail, anchor);
    const cards = [];
    for (const [i, person] of people.entries()) {
      const name = this.asText(person.title).trim();
      const card = doc.createElement("div");
      card.className = "mn-codex__rel-card";
      card.hidden = i !== 0;
      const kicker = doc.createElement("div");
      kicker.className = "mn-codex__section-kicker mn-codex__rel-kicker";
      kicker.textContent = `${sectionNo} / ${sectionTitle} · ${String(i + 1).padStart(2, "0")}${person._mnFrom ? ` · ${person._mnFrom} 노트에서` : person._mnProp ? " · 노트 속성에서" : ""}`;
      const title = doc.createElement("div");
      title.className = "mn-codex__rel-card-name";
      title.textContent = name;
      const hasNote = Boolean(noteOf(name));
      const open = doc.createElement("button");
      open.type = "button";
      open.className = `mn-codex__rel-open${hasNote ? "" : " is-create"}`;
      open.textContent = hasNote ? "인물 노트 열기 ↗" : "인물 노트 만들기 ＋";
      open.title = hasNote ? `${name} 인물 노트 열기` : `${name} 인물 노트를 이 지면 틀로 새로 만들어요 (값은 모두 미정)`;
      open.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (noteOf(name)) { openPerson(name, event); return; }
        open.disabled = true;
        try {
          await this.createCharacterNote(name, sourcePath, data);
        } catch (error) {
          new Notice(`「${name}」 인물 노트를 만들지 못했어요: ${error && error.message ? error.message : error}`);
          open.disabled = false;
        }
      });
      const pair = doc.createElement("div");
      pair.className = "mn-codex__rel-map";
      pair.appendChild(this.relationFace(doc, selfName, selfSrc, selfFocus, "mn-codex__rel-who--self"));
      const link = doc.createElement("div");
      link.className = "mn-codex__rel-link";
      const note = this.asText(person.relation).trim();
      if (note) { const span = doc.createElement("span"); span.className = "mn-codex__rel-note"; span.textContent = note; link.appendChild(span); }
      pair.appendChild(link);
      const other = this.relationFace(doc, name, this.relationPortrait(name, person, sourcePath), person._mnPortraitFocus || "", "mn-codex__rel-who--other", "button");
      other.type = "button";
      other.title = `${name} · ${hasNote ? "눌러서 인물 노트 열기" : "인물 노트 없음"}`;
      other.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openPerson(name, event); });
      pair.appendChild(other);
      const body = doc.createElement("div");
      body.className = "mn-codex__rel-body";
      card.append(kicker, title, open, pair, body);
      detail.appendChild(card);
      if (person._mnFrom || person._mnProp) {
        const from = doc.createElement("div");
        from.className = "mn-codex__rel-from";
        from.textContent = person._mnProp ? "이 노트 속성 「관계」에 적힌 관계예요 (세계판 카드 등)."
          : person._mnFromProp ? `${person._mnFrom} 노트 속성 「관계」에 적힌 관계예요.` : `${person._mnFrom} 노트의 관계 장에 적힌 글이에요.`;
        body.appendChild(from);
        // 저쪽 노트에만 적힌 관계: 이 노트 관계 장에도 그 사람 쪽을 빈 칸으로 넣어 내 쪽 시선을 따로 적게. 실험실 추가 2026-10-28
        const mine = doc.createElement("button");
        mine.type = "button";
        mine.className = "mn-codex__rel-open mn-codex__rel-mine";
        mine.textContent = person._mnProp ? "관계 장에도 적기 ＋" : "내 노트에도 적기 ＋";
        mine.title = `이 노트(${selfName})의 관계 장에 「${name}」 쪽을 빈 칸으로 넣어요. 글은 ✎ 글 고치기에서 채워요`;
        mine.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          mine.disabled = true;
          try {
            if (!await this.addRelationPage(sourcePath, data, pageData._mnBookSectionIndex, sectionTitle, name, person._mnProp ? this.asText(person.relation) : "")) mine.disabled = false;
          } catch (error) {
            new Notice(`관계를 넣지 못했어요: ${error && error.message ? error.message : error}`);
            mine.disabled = false;
          }
        });
        body.appendChild(mine);
      }
      const text = doc.createElement("div");
      body.appendChild(text);
      await this.renderMarkdown(person.content || "", text, person._mnFromPath || sourcePath, component);
      for (const also of person._mnAlso || []) {
        const block = doc.createElement("div");
        block.className = "mn-codex__rel-also";
        const label = doc.createElement("div");
        label.className = "mn-codex__rel-from";
        label.textContent = `${also._mnFrom} 노트에서${also.relation ? ` · ${also.relation}` : ""}`;
        const text = doc.createElement("div");
        block.append(label, text);
        body.appendChild(block);
        await this.renderMarkdown(also.content || "", text, also._mnFromPath || sourcePath, component);
      }
      cards.push(card);
    }
    const select = (index) => {
      buttons.forEach((button, i) => { button.classList.toggle("is-active", i === index); button.setAttribute("aria-pressed", String(i === index)); });
      lines.forEach((line, i) => line.classList.toggle("is-active", i === index));
      cards.forEach((card, i) => { card.hidden = i !== index; });
    };
    // 마우스를 올리면 오른쪽에 그 사람 글, 누르면 인물 노트 열기. 터치는 첫 번째로 글, 두 번째로 열기
    buttons.forEach((button, i) => {
      const name = this.asText(people[i].title).trim();
      button.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") select(i); });
      button.addEventListener("focus", () => { if (button.matches(":focus-visible")) select(i); });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.classList.contains("is-active")) openPerson(name, event);
        else select(i);
      });
    });
    select(0);

    // 쪽에 놓인 뒤 실제 크기로 다시 놓기: 판 = 「RELATIONS」 줄 아래 ~ 쪽 글 칸 바닥, 가운데에서 동그라미가 판 밖으로 안 나가는 반지름
    const factors = ringCount === 1 ? [0.8] : ringCount === 2 ? [0.56, 1] : [0.48, 0.74, 1];
    const layout = () => {
      const body = orbit.closest(".mn-codex__prose--page");
      const width = orbit.clientWidth;
      if (!body || !width) return;
      const room = Math.floor(body.getBoundingClientRect().bottom - orbit.getBoundingClientRect().top - 6);
      if (room > 160 && Math.abs(room - orbit.clientHeight) > 2) orbit.style.height = `${room}px`;
      const height = orbit.clientHeight;
      // 자리가 좁으면(한 쪽 보기 판 등) 사람 동그라미 · 이름을 같은 비율로 줄여 가운데 동그라미와 포개지지 않게. 2026-10-28
      const selfHalf = Math.max(center.offsetWidth, center.offsetHeight) / 2;
      let otherHalf = 0;
      for (const button of buttons) otherHalf = Math.max(otherHalf, button.offsetWidth / 2, button.offsetHeight / 2);
      let k = 1;
      for (const candidate of [1, 0.9, 0.8, 0.7, 0.62, 0.55]) {
        k = candidate;
        if (Math.max(40, Math.min(width, height) / 2 - otherHalf * k - 4) * factors[0] >= (selfHalf + otherHalf) * k + 6) break;
      }
      orbit.style.setProperty("--mn-orbit-k", String(k));
      const half = otherHalf * k;
      const maxR = Math.max(40, Math.min(width, height) / 2 - half - 4);
      const cx = width / 2;
      const cy = height / 2;
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      center.style.left = `${cx}px`;
      center.style.top = `${cy}px`;
      ringEls.forEach((ring, r) => {
        ring.setAttribute("cx", String(cx)); ring.setAttribute("cy", String(cy));
        ring.setAttribute("rx", String(maxR * factors[r])); ring.setAttribute("ry", String(maxR * factors[r]));
      });
      spots.forEach((spot, i) => {
        const r = maxR * factors[spot.ring];
        const x = cx + r * Math.cos(spot.angle);
        const y = cy + r * Math.sin(spot.angle);
        buttons[i].style.left = `${x}px`;
        buttons[i].style.top = `${y}px`;
        lines[i].setAttribute("x1", String(cx)); lines[i].setAttribute("y1", String(cy));
        lines[i].setAttribute("x2", String(x)); lines[i].setAttribute("y2", String(y));
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => layout());
      observer.observe(orbit);
      if (component && typeof component.register === "function") component.register(() => observer.disconnect());
    }
  }

  createHeading(data, parent) {
    const heading = parent.createDiv({ cls: "mn-codex__heading" });
    if (data.eyebrow) {
      heading.createDiv({ cls: "mn-codex__eyebrow", text: this.asText(data.eyebrow) });
    }
    const bookPageKind = this.asText(data._mnBookPageKind).toLowerCase();
    const sectionIndex = Number(data._mnBookSectionIndex);
    const sectionTitle = this.asText(data._mnBookSectionTitle);
    if (bookPageKind === "section" && Number.isInteger(sectionIndex) && sectionIndex >= 0) {
      heading.createDiv({
        cls: "mn-codex__section-index",
        text: `SECTION ${String(sectionIndex + 1).padStart(2, "0")}`,
      });
    } else if (bookPageKind === "entry" && sectionTitle) {
      heading.createDiv({
        cls: "mn-codex__section-kicker",
        text: `${String(Math.max(0, sectionIndex) + 1).padStart(2, "0")} / ${sectionTitle}`,
      });
    }
    const titleRow = heading.createDiv({ cls: "mn-codex__title-row" });
    titleRow.createEl("h3", {
      cls: "mn-codex__title",
      text: this.asText(data.title, "제목 없음"),
    });
    if (data.badge) {
      titleRow.createSpan({ cls: "mn-codex__badge", text: this.asText(data.badge) });
    }
    if (data.subtitle) {
      heading.createDiv({ cls: "mn-codex__subtitle", text: this.asText(data.subtitle) });
    }
    return heading;
  }

  createInlineQuote(value, parent) {
    const quote = parent.createEl("blockquote", { cls: "mn-codex__inline-quote" });
    quote.createSpan({ cls: "mn-codex__inline-quote-mark", text: "“" });
    quote.createSpan({ text: this.asText(value) });
  }

  async createFacts(rawFacts, parent, sourcePath, component) {
    const facts = this.normalizeFacts(rawFacts);
    if (!facts.length) {
      return;
    }

    const list = parent.createEl("dl", { cls: "mn-codex__facts" });
    for (const fact of facts) {
      list.createEl("dt", { text: fact.label });
      const value = list.createEl("dd");
      await this.renderMarkdown(fact.value, value, sourcePath, component);
    }
  }

  createTraits(rawTraits, parent) {
    const traits = Array.isArray(rawTraits)
      ? rawTraits
      : rawTraits
        ? [rawTraits]
        : [];
    if (!traits.length) {
      return;
    }

    const wrap = parent.createDiv({ cls: "mn-codex__traits" });
    for (const trait of traits) {
      wrap.createSpan({ cls: "mn-codex__trait", text: this.asText(trait) });
    }
  }

  createBookStickers(data, page, sourcePath, component) {
    const rawStickers = Array.isArray(data.stickers)
      ? data.stickers
      : data.stickers
        ? [data.stickers]
        : [];
    if (!rawStickers.length) return [];

    const asLength = (value, fallback) => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "number" && Number.isFinite(value)) return `${value}%`;
      const text = String(value).trim();
      return /^-?\d+(?:\.\d+)?(?:%|px|rem|em|cqi|cqb|vw|vh)?$/i.test(text) ? text : fallback;
    };
    const asNumber = (value, fallback, minimum, maximum) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
    };
    const scopes = new Set(["spread", "page", "left", "right"]);
    const created = [];

    rawStickers.forEach((rawSticker, stickerIndex) => {
      const sticker = rawSticker && typeof rawSticker === "object" && !Array.isArray(rawSticker)
        ? rawSticker
        : { image: rawSticker };
      const imageRef = this.asText(sticker.image || sticker.src).trim();
      if (!imageRef) return;

      const scopeInput = this.asText(sticker.scope || sticker.side, "page").toLowerCase();
      const scope = scopes.has(scopeInput) ? scopeInput : "page";
      const target = scope === "spread"
        ? page.spread.book
        : scope === "left"
          ? page.spread.leftFrame
          : scope === "right"
            ? page.spread.rightFrame
            : page.frame;
      const src = this.resolveImage(imageRef, sourcePath);
      if (!src || !target) return;

      const figure = target.createEl("figure", {
        cls: `mn-codex__sticker mn-codex__sticker--${scope}`,
      });
      figure.setAttr("aria-hidden", "true");
      figure.setAttr("data-image-ref", imageRef);
      figure.setAttr("data-mn-sticker-index", String(stickerIndex));
      figure.style.setProperty("--mn-sticker-x", asLength(sticker.x, "75%"));
      figure.style.setProperty("--mn-sticker-y", asLength(sticker.y, "50%"));
      figure.style.setProperty("--mn-sticker-width", asLength(sticker.width || sticker.size, "18%"));
      figure.style.setProperty("--mn-sticker-rotate", `${asNumber(sticker.rotate, 0, -45, 45)}deg`);
      figure.style.setProperty("--mn-sticker-opacity", String(asNumber(sticker.opacity, 1, 0, 1)));
      figure.style.setProperty("--mn-sticker-z", String(Math.round(asNumber(sticker.z || sticker.z_index, 16, 2, 28))));
      if (this.asBoolean(sticker.flip, false)) figure.addClass("mn-codex__sticker--flip");

      const img = figure.createEl("img", {
        attr: {
          alt: "",
          decoding: "async",
          loading: "eager",
          src,
        },
      });
      if (typeof component?.registerDomEvent === "function") {
        component.registerDomEvent(img, "error", () => figure.remove());
      }
      created.push(figure);
    });
    return created;
  }

  createBookPageImages(data, page, sourcePath, component) {
    const rawImages = Array.isArray(data.page_images)
      ? data.page_images
      : data.page_images
        ? [data.page_images]
        : [];
    if (!rawImages.length || !page?.frame) return [];

    const asLength = (value, fallback) => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "number" && Number.isFinite(value)) return `${value}%`;
      const text = String(value).trim();
      return /^-?\d+(?:\.\d+)?(?:%|px|rem|em|cqi|cqb|vw|vh)?$/i.test(text) ? text : fallback;
    };
    const asNumber = (value, fallback, minimum, maximum) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
    };
    const fits = new Set(["contain", "cover"]);
    const anchors = {
      "top-left": ["12%", "14%"], top: ["50%", "14%"], "top-right": ["88%", "14%"],
      left: ["12%", "50%"], center: ["50%", "50%"], right: ["88%", "50%"],
      "bottom-left": ["12%", "86%"], bottom: ["50%", "86%"], "bottom-right": ["88%", "86%"],
    };
    const created = [];
    rawImages.forEach((raw, index) => {
      const imageData = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { image: raw };
      const imageRef = this.asText(imageData.image || imageData.src).trim();
      const src = this.resolveImage(imageRef, sourcePath);
      if (!imageRef || !src) return;
      const anchor = anchors[this.asText(imageData.anchor, "center").toLowerCase()] || anchors.center;
      const figure = page.frame.createEl("figure", { cls: "mn-codex__placed-image" });
      figure.setAttr("data-mn-image-index", String(index));
      figure.setAttr("data-image-ref", imageRef);
      figure.style.setProperty("--mn-page-image-x", asLength(imageData.x, anchor[0]));
      figure.style.setProperty("--mn-page-image-y", asLength(imageData.y, anchor[1]));
      figure.style.setProperty("--mn-page-image-width", asLength(imageData.width || imageData.size, "24%"));
      figure.style.setProperty("--mn-page-image-height", asLength(imageData.height, "auto"));
      figure.style.setProperty("--mn-page-image-rotate", `${asNumber(imageData.rotate, 0, -45, 45)}deg`);
      figure.style.setProperty("--mn-page-image-opacity", String(asNumber(imageData.opacity, 1, 0, 1)));
      figure.style.setProperty("--mn-page-image-z", String(Math.round(asNumber(imageData.z || imageData.z_index, 12, 2, 24))));
      const fit = this.asText(imageData.fit, "contain").toLowerCase();
      figure.style.setProperty("--mn-page-image-fit", fits.has(fit) ? fit : "contain");
      if (this.asBoolean(imageData.behind_text, false)) figure.addClass("mn-codex__placed-image--behind");
      if (this.asBoolean(imageData.flip, false)) figure.addClass("mn-codex__placed-image--flip");
      const img = figure.createEl("img", {
        attr: {
          src,
          alt: this.asText(imageData.alt),
          decoding: "async",
          loading: "eager",
        },
      });
      if (typeof component?.registerDomEvent === "function") {
        component.registerDomEvent(img, "error", () => figure.remove());
      }
      created.push(figure);
    });
    return created;
  }

  enhanceBookText(parent) {
    if (!parent) return;
    const effects = {
      red: "red", blue: "blue", teal: "teal", gold: "gold", muted: "muted",
      glow: "glow", marker: "marker", underline: "underline", whisper: "whisper", danger: "danger",
    };
    parent.querySelectorAll("mark").forEach((mark) => mark.addClass("mn-codex__text-marker"));
    parent.querySelectorAll("code").forEach((code) => {
      const text = String(code.textContent || "");
      const match = text.match(/^([a-z]+)::([\s\S]+)$/i);
      if (!match) return;
      const effect = effects[match[1].toLowerCase()];
      if (!effect) return;
      const span = code.ownerDocument.createElement("span");
      span.className = `mn-codex__text-effect mn-codex__text-effect--${effect}`;
      span.textContent = match[2];
      code.replaceWith(span);
    });
  }

  createBookIllustration(data, parent, sourcePath, component) {
    const imageRef = this.asText(data.book_illustration).trim();
    if (!imageRef) return null;

    const positions = new Set(["left", "right"]);
    const sizes = new Set(["small", "medium", "large", "wide"]);
    const styles = new Set(["ink", "plain"]);
    const positionInput = this.asText(data.book_illustration_position, "right").toLowerCase();
    const sizeInput = this.asText(data.book_illustration_size, "medium").toLowerCase();
    const styleInput = this.asText(data.book_illustration_style, "ink").toLowerCase();
    const position = positions.has(positionInput) ? positionInput : "right";
    const size = sizes.has(sizeInput) ? sizeInput : "medium";
    const illustrationStyle = styles.has(styleInput) ? styleInput : "ink";
    const figure = parent.createEl("figure", {
      cls: `mn-codex__book-illustration mn-codex__book-illustration--${position} mn-codex__book-illustration--${size} mn-codex__book-illustration--${illustrationStyle}`,
    });
    figure.setAttr("data-image-ref", imageRef);

    const src = this.resolveImage(imageRef, sourcePath);
    if (!src) {
      figure.addClass("mn-codex__book-illustration--missing");
      figure.createDiv({ cls: "mn-codex__book-illustration-missing", text: "삽화를 찾지 못했습니다." });
      return figure;
    }

    const img = figure.createEl("img", {
      attr: {
        alt: this.asText(data.book_illustration_alt, `${this.asText(data.title, "기록")} 삽화`),
        loading: "lazy",
        src,
      },
    });
    if (typeof component?.registerDomEvent === "function") {
      component.registerDomEvent(img, "error", () => {
        img.remove();
        figure.addClass("mn-codex__book-illustration--missing");
        if (!figure.querySelector(".mn-codex__book-illustration-missing")) {
          figure.createDiv({ cls: "mn-codex__book-illustration-missing", text: "삽화를 찾지 못했습니다." });
        }
      });
    }
    if (data.book_illustration_caption) {
      figure.createEl("figcaption", { text: this.asText(data.book_illustration_caption) });
    }
    return figure;
  }

  async createFigure(data, parent, sourcePath, component, variant) {
    const figure = parent.createEl("figure", {
      cls: `mn-codex__figure mn-codex__figure--${variant}`,
    });
    if (variant === "book") {
      figure.setAttr("data-plate", this.asText(data.plate_label, "PLATE 01"));
    }
    const art = figure.createDiv({ cls: "mn-codex__art" });
    const focusInput = this.asText(data.image_focus, "center").toLowerCase();
    const focus = IMAGE_FOCUS.has(focusInput) ? focusInput : "center";
    art.addClass(`mn-codex__art--focus-${focus}`);
    const fitInput = this.asText(data.image_fit, "contain").toLowerCase();
    const fit = IMAGE_FITS.has(fitInput) ? fitInput : "contain";
    art.addClass(`mn-codex__art--fit-${fit}`);

    const imageRef = this.asText(data.image);
    const src = this.resolveImage(imageRef, sourcePath);
    if (src) {
      const img = art.createEl("img", {
        attr: {
          alt: this.asText(data.image_alt, data.title || "도감 이미지"),
          loading: "lazy",
          src,
        },
      });
      component.registerDomEvent(img, "error", () => {
        img.remove();
        this.createImagePlaceholder(art, imageRef);
      });
    } else {
      this.createImagePlaceholder(art, imageRef);
    }

    if (data.caption) {
      figure.createEl("figcaption", { text: this.asText(data.caption) });
    }
    return figure;
  }

  createImagePlaceholder(parent, imageRef) {
    if (parent.querySelector(".mn-codex__image-placeholder")) {
      return;
    }
    const placeholder = parent.createDiv({ cls: "mn-codex__image-placeholder" });
    placeholder.createDiv({ cls: "mn-codex__image-glyph", text: "◇" });
    placeholder.createDiv({
      cls: "mn-codex__image-message",
      text: imageRef ? "이미지를 찾지 못했습니다" : "이미지를 넣어 주세요",
    });
    if (imageRef) {
      placeholder.setAttr("title", imageRef);
    }
  }

  resolveImage(rawValue, sourcePath) {
    if (!rawValue) {
      return this.resolveFirstImage(sourcePath);
    }

    let link = rawValue.trim();
    if (link.toLowerCase() === "auto") {
      return this.resolveFirstImage(sourcePath);
    }
    const wikiMatch = link.match(/^!?\[\[([\s\S]+?)\]\]$/);
    if (wikiMatch) {
      link = wikiMatch[1].split("|")[0].trim();
    }

    if (link.toLowerCase().startsWith("plugin:")) {
      const assetName = normalizePath(link.slice("plugin:".length).trim());
      if (!assetName || assetName.includes("..") || assetName.startsWith("/")) {
        return "";
      }
      const adapter = this.app && this.app.vault && this.app.vault.adapter;
      if (!adapter || typeof adapter.getResourcePath !== "function") {
        return "";
      }
      const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
      return this.versionResource(
        adapter.getResourcePath(normalizePath(`${pluginDir}/assets/${assetName}`)),
        this.manifest.version
      );
    }

    if (/^(https?:|data:|app:|file:)/i.test(link)) {
      return link;
    }

    const destination = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
    if (destination instanceof TFile) {
      return this.versionResource(this.app.vault.getResourcePath(destination), destination.stat && destination.stat.mtime);
    }

    const exact = this.app.vault.getAbstractFileByPath(normalizePath(link));
    if (exact instanceof TFile) {
      return this.versionResource(this.app.vault.getResourcePath(exact), exact.stat && exact.stat.mtime);
    }
    return "";
  }

  versionResource(resource, stamp) {
    const value = String(resource || "");
    if (!value) return "";
    const separator = value.includes("?") ? "&" : "?";
    return `${value}${separator}mn-codex=${encodeURIComponent(String(stamp || this.manifest.version))}`;
  }

  resolveFirstImage(sourcePath) {
    const sourceFile = this.app.vault.getAbstractFileByPath(normalizePath(sourcePath));
    if (!(sourceFile instanceof TFile)) {
      return "";
    }

    const cache = this.app.metadataCache.getFileCache(sourceFile);
    const embeds = cache && Array.isArray(cache.embeds) ? cache.embeds : [];
    const imagePattern = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
    for (const embed of embeds) {
      const link = this.asText(embed && embed.link).split("#")[0].trim();
      if (!imagePattern.test(link)) {
        continue;
      }
      const destination = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
      if (destination instanceof TFile) {
        return this.versionResource(this.app.vault.getResourcePath(destination), destination.stat && destination.stat.mtime);
      }
    }
    return "";
  }

  normalizeFacts(rawFacts) {
    if (!rawFacts) {
      return [];
    }
    if (Array.isArray(rawFacts)) {
      return rawFacts
        .map((fact) => {
          if (fact && typeof fact === "object") {
            return {
              label: this.asText(fact.label || fact.name, "항목"),
              value: this.asText(fact.value || fact.content, "—"),
            };
          }
          return { label: "항목", value: this.asText(fact) };
        })
        .filter((fact) => fact.value);
    }
    if (typeof rawFacts === "object") {
      return Object.entries(rawFacts).map(([label, value]) => ({
        label,
        value: this.asText(value, "—"),
      }));
    }
    return [];
  }

  async renderMarkdown(value, parent, sourcePath, component) {
    const markdown = this.asText(value);
    if (!markdown) {
      return;
    }
    await MarkdownRenderer.render(this.app, markdown, parent, sourcePath, component);
    if (typeof parent.closest === "function" && parent.closest("[class*='mn-codex--variant-']")) this.toFactSheets(parent);
  }

  /**
   * 「이름 : 값」 줄이 세 줄 이상 이어진 문단을 두 칸 표(dl)로 바꿈 (캐릭터 전용 지면에서만). 실험실 추가 2026-10-27
   * 글은 노트에 쓴 그대로이고, 보이는 모양만 표가 됨 (링크 · 굵은 글씨도 그대로 옮김).
   */
  toFactSheets(parent) {
    const KEY = /^\s*([^:：\n]{1,12}?)\s*[:：]\s*/u;
    for (const p of Array.from(parent.querySelectorAll("p"))) {
      const lines = [[]];
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeName === "BR") lines.push([]);
        else lines[lines.length - 1].push(node);
      }
      const texts = lines.map((nodes) => nodes.map((n) => n.textContent).join("").replace(/\n/g, " "));
      const filled = texts.filter((t) => t.trim());
      if (filled.length < 3 || !filled.every((t) => KEY.test(t))) continue;
      const dl = p.ownerDocument.createElement("dl");
      dl.className = "mn-codex__sheet";
      lines.forEach((nodes, i) => {
        const m = texts[i].match(KEY);
        if (!m) return;
        const dt = dl.createEl("dt");
        const dd = dl.createEl("dd");
        // 이름 부분(링크면 링크 그대로)과 값 부분을 나눔: 앞에서부터 이름 글자 수만큼은 dt 로
        let keyLeft = m[0].length;
        for (const node of nodes) {
          const len = node.textContent.length;
          if (keyLeft <= 0) { dd.appendChild(node); continue; }
          if (len <= keyLeft) {
            const visible = node.textContent.replace(/[:：]\s*$/u, "").trim();
            if (node.nodeType === 1) dt.appendChild(node);
            else if (visible) dt.appendText(visible.replace(/\s*[:：]\s*$/u, ""));
            keyLeft -= len;
          } else {
            const text = node.textContent;
            const head = text.slice(0, keyLeft).replace(/\s*[:：]\s*$/u, "").trim();
            if (head) dt.appendText(head);
            dd.appendText(text.slice(keyLeft));
            keyLeft = 0;
          }
        }
      });
      p.replaceWith(dl);
    }
  }

  asBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(normalized)) return true;
    if (["false", "no", "off", "0"].includes(normalized)) return false;
    return fallback;
  }

  asText(value, fallback = "") {
    if (value === undefined || value === null || value === "") {
      return fallback;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.asText(item)).join(", ");
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }

  renderError(parent, message, error) {
    const box = parent.createDiv({ cls: "mn-codex-error" });
    box.createEl("strong", { text: `MN Illuminated Codex: ${message}` });
    box.createEl("pre", {
      text: error instanceof Error ? error.message : String(error),
    });
  }
};
