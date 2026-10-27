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
class CodexEditModal extends Modal {
  constructor(app, data, onSave) {
    super(app);
    this.data = JSON.parse(JSON.stringify(data || {}));
    this.onSave = onSave;
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
    });

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
      this.field(card, "틀 (개요 · 능력 · 관계 · 기본)", section.template, (v) => { section.template = v.trim(); }, { placeholder: "비우면 장 제목으로 고름" });
      this.field(card, "글", section.content, (v) => { section.content = v; }, { area: true, rows: 6 });
      const tpl = String(section.template || "").trim();
      const isRelation = tpl ? /^(관계|relation)$/iu.test(tpl) : /관계|인연/u.test(String(section.title || ""));
      const isAbility = tpl ? /^(능력|ability)$/iu.test(tpl) : /능력|기술|전투|스킬/u.test(String(section.title || ""));
      if (!Array.isArray(section.pages)) section.pages = [];
      section.pages.forEach((page, pi) => {
        const pc = card.createDiv({ cls: "mn-codex-editor__page" });
        const ph = pc.createDiv({ cls: "mn-codex-editor__head" });
        ph.createSpan({ text: `쪽 ${pi + 1}` });
        this.tools(ph, section.pages, pi, rerender, "쪽");
        this.field(pc, "쪽 제목", page.title, (v) => { page.title = v; });
        if (isAbility) {
          this.field(pc, "능력 그림", page.visual, (v) => { page.visual = v; }, { pick: true, placeholder: "왼쪽 쪽 전체에 배경으로 깔림 · 비우면 그림 없이" });
          this.field(pc, "그림 초점 (가로% 세로%)", page.visual_focus, (v) => { page.visual_focus = v; }, { placeholder: "50% 30%" });
          this.field(pc, "그림 확대 (1 = 그대로)", page.visual_scale, (v) => { page.visual_scale = v; }, { placeholder: "1" });
        }
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

  /** 빈 칸은 키째 빼서 YAML 을 짧게 */
  clean(d) {
    const out = { ...d };
    for (const k of ["title", "subtitle", "content", "image", "book_image"]) if (out[k] === "") delete out[k];
    if (Array.isArray(out.detail_images)) {
      const list = out.detail_images.map((v) => (v == null ? "" : String(v).trim()));
      if (list.every((v) => !v)) delete out.detail_images;
      else out.detail_images = list;
    }
    if (out.facts && !Object.keys(out.facts).length) delete out.facts;
    out.book_sections = (out.book_sections || []).map((s) => {
      const sec = { ...s };
      if (!sec.subtitle) delete sec.subtitle;
      if (!sec.template) delete sec.template;
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
          await this.renderCodex(data, el, ctx.sourcePath, child);
          this.registerMelyDeckCandidate(data, el, ctx.sourcePath, child);
          this.addEditButton(el, data, ctx);
        } catch (error) {
          el.empty();
          this.renderError(el, "레이아웃을 그리지 못했습니다.", error);
        }
      }
    );

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
  }

  /** 지면 오른쪽 위 「글 고치기」 단추 (마우스를 올리면 보임). 표지 다음 책장에도 같은 단추를 달아 줌 */
  addEditButton(host, data, ctx) {
    if (typeof Modal !== "function" || typeof stringifyYaml !== "function") return;
    const open = () => new CodexEditModal(this.app, data, (next) => this.saveCodexBlock(host, ctx, next)).open();
    host._mnOpenEditor = open;
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

    const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
    const assetUrl = (name) => {
      const vaultPath = normalizePath(`${pluginDir}/assets/${name}`);
      const resource = String(adapter.getResourcePath(vaultPath));
      const separator = resource.includes("?") ? "&" : "?";
      return `${resource}${separator}mn-codex=${encodeURIComponent(this.manifest.version)}`
        .replace(/"/g, "%22");
    };

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
      --mn-onal-keishon-medal: url("${assetUrl("onal-keishon-medal.png")}");
    }`;
    document.head.appendChild(style);
    if (typeof this.register === "function") this.register(() => style.remove());
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
    if (/^[a-z0-9-]{1,40}$/u.test(variant)) root.addClass(`mn-codex--variant-${variant}`);
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
          return;
        }
      }
    }

    const inlineBook = await this.createMelyInlineBook(cover, sourcePath);
    if (!inlineBook) return;
    this.connectMelyCoverToBook(cover, inlineBook);
    this.activateMelyBookSequence(cover, inlineBook, "book");
  }

  async createMelyInlineBook(cover, sourcePath) {
    if (cover?._mnMelyInlineBook?.isConnected) return cover._mnMelyInlineBook;
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
      }
      const brand = this.asText(sourceData.brand || sourceData.archive_brand).trim().toUpperCase();
      if (bookRoot && brand) bookRoot.setAttr("data-mn-brand", brand);
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
    book.hidden = !showingBook;
    cover.classList.toggle("is-active", !showingBook);
    book.classList.toggle("is-active", showingBook);
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
    book.hidden = !showingBook;
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
    const showcaseBrand = this.asText(data.brand || data.archive_brand, inferredBrand || "MELY")
      .trim()
      .toUpperCase();
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
      const codexRoot = typeof scene.closest === "function" ? scene.closest(".mn-codex") : null;
      if (codexRoot) codexRoot.classList.add(`mn-codex--variant-${layoutVariant}`);
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
      scene.createDiv({ cls: "mn-mely-showcase__ghost", text: showcaseBrand });
    }

    const indexRail = scene.createDiv({ cls: "mn-mely-showcase__index" });
    indexRail.createSpan({ text: this.asText(data.plate_label, `${showcaseBrand} / ARCHIVE`) });
    indexRail.createSpan({ text: "OBSERVATION RECORD" });

    const utility = scene.createDiv({ cls: "mn-mely-showcase__utility" });
    utility.createSpan({ cls: "mn-mely-showcase__utility-kicker", text: `${showcaseBrand} / SUBJECT DATA` });
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
      } catch (error) {
        renderScopeCleanup();
        renderScopeCleanup = () => {};
        throw error;
      } finally {
        building = false;
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
    if (hasConfiguredPages) {
      for (let pageIndex = 1; pageIndex < configuredPages.length; pageIndex += 1) {
        const pageData = configuredPages[pageIndex];
        const entryBreak = firstBody.createDiv({ cls: "mn-codex__page-break-marker mn-codex__book-entry-break" });
        entryBreak.setAttr("data-mn-book-next-page-index", String(pageIndex));
        entryBreak.setAttr("data-mn-book-next-page-mode", pageData.page_mode || bookPageMode);
        // 관계도는 왼쪽(관계도) | 오른쪽(고른 사람 글)이 한 펼침이어야 해서 새 펼침의 왼쪽 쪽에서 시작
        if (pageData._mnBookTemplate === "relation" && pageData._mnBookPageKind === "section") entryBreak.setAttr("data-mn-next-spread", "true");
        // 능력 하위 쪽(전용 지면)은 그림 띠가 두 쪽 위를 가로질러서 역시 새 펼침의 왼쪽 쪽에서 시작
        if (pageData._mnBookTemplate === "ability" && pageData._mnBookPageKind === "entry" && this.asText(data.layout_variant).trim()) entryBreak.setAttr("data-mn-next-spread", "true");
        const heading = prepareBookHeading(pageData, firstBody, pageIndex);
        this.createBookIllustration(pageData, firstBody, sourcePath, component);
        await this.renderMarkdownWithPageBreaks(pageData.content, firstBody, sourcePath, component);
        await this.shapeBookTemplate(pageData, heading, data, sourcePath, configuredPages, component);
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
        if (remainder.nodeType === 1 && remainder.classList.contains("mn-codex__orbit")) {
          for (const scale of [0.9, 0.8, 0.7, 0.6, 0.5]) {
            remainder.style.width = `${scale * 100}%`;
            remainder.style.marginInline = "auto";
            if (!this.isPageOverflowing(currentPage.body)) {
              currentHasContent = true;
              return;
            }
          }
          remainder.style.width = "";
          remainder.style.marginInline = "";
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
    }

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

    const activate = (nextStep) => {
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
        targetSnapshot.classList.remove("is-active", "is-before", "is-after");
        targetSnapshot.classList.add("mn-codex__flip-target");
        targetSnapshot.setAttribute("aria-hidden", "true");
        stage.appendChild(targetSnapshot);
      }

      if (leaving) {
        const snapshot = leaving.book.cloneNode(true);
        snapshot.classList.remove("is-active", "is-before", "is-after");
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

    const goPrevious = () => {
      if (step === 0 && beforeFirst) {
        beforeFirst();
        return;
      }
      activate(step - 1);
    };

    on(previous, "click", goPrevious);
    on(next, "click", () => activate(step + 1));
    on(root, "keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        activate(step + 1);
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

    activate(0);
    return {
      activate,
      totalSteps,
      getStep: () => step,
      setBeforeFirst: (callback) => {
        beforeFirst = typeof callback === "function" ? callback : null;
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

  isPageOverflowing(body) {
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
    const names = { "개요": "overview", overview: "overview", "능력": "ability", ability: "ability", "관계": "relation", relation: "relation", "기본": "", plain: "", none: "" };
    const raw = this.asText(section && (section.template ?? section["틀"])).trim().toLowerCase();
    if (raw) return Object.prototype.hasOwnProperty.call(names, raw) ? names[raw] : "";
    if (!this.asText(data && data.layout_variant).trim()) return "";
    const title = this.asText(section && section.title);
    if (/개요|소개|프로필|기본\s*정보/u.test(title)) return "overview";
    if (/능력|기술|전투|스킬/u.test(title)) return "ability";
    if (/관계|인연/u.test(title)) return "relation";
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
      if (template === "overview") this.shapeOverview(heading);
      else if (template === "ability") this.shapeAbility(pageData, heading, kind, sourcePath, configuredPages, data);
      else if (template === "relation") await this.shapeRelation(pageData, heading, kind, data, sourcePath, component);
    } catch (error) {
      console.warn("MN Codex: 틀을 입히지 못했어요", template, error);
    }
  }

  /** 개요: 「이름 : 값」 표를 인물 카드로 — 이명 · 이름(큰 이름), 소개 한 줄, 투력 · 항력(큰 숫자), 겉모습(작은 표), 소속 · 능력(칩) */
  shapeOverview(heading) {
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
    };
    chipRow(affiliation, "AFFILIATION", false);
    chipRow(abilities, "ABILITY", true);
    // 표 자리에 블록들을 차례로 (블록마다 따로 놓아 넘치면 다음 쪽으로 이어지게)
    for (const div of blocks) dl.parentNode.insertBefore(div, dl);
    dl.remove();
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
    const ratio = band.classList.contains("mn-codex__ab-band--compact") ? 0.36 : 0.45;
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

  /** 관계 쪽 사람 그림: 쪽의 portrait → 그 이름의 인물 노트 속성 「초상」 → 없으면 첫 글자 */
  relationPortrait(name, pageData, sourcePath) {
    const direct = this.asText(pageData && pageData.portrait).trim();
    if (direct) return this.resolveImage(direct, sourcePath);
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
    const people = Array.isArray(pageData._mnRelationPeople) ? pageData._mnRelationPeople : [];
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
      const button = this.relationFace(doc, name, this.relationPortrait(name, person, sourcePath), "", "mn-codex__orbit-node", "button");
      button.type = "button";
      button.style.left = `${spots[i].x}%`;
      button.style.top = `${spots[i].y}%`;
      const note = this.asText(person.relation).trim();
      if (note) { const span = doc.createElement("span"); span.className = "mn-codex__rel-note"; span.textContent = note; button.appendChild(span); }
      button.setAttribute("aria-label", `${name}${note ? ` · ${note}` : ""} 글 보기`);
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
      kicker.textContent = `${sectionNo} / ${sectionTitle} · ${String(i + 1).padStart(2, "0")}`;
      const title = doc.createElement("div");
      title.className = "mn-codex__rel-card-name";
      title.textContent = name;
      const pair = doc.createElement("div");
      pair.className = "mn-codex__rel-map";
      pair.appendChild(this.relationFace(doc, selfName, selfSrc, selfFocus, "mn-codex__rel-who--self"));
      const link = doc.createElement("div");
      link.className = "mn-codex__rel-link";
      const note = this.asText(person.relation).trim();
      if (note) { const span = doc.createElement("span"); span.className = "mn-codex__rel-note"; span.textContent = note; link.appendChild(span); }
      pair.appendChild(link);
      pair.appendChild(this.relationFace(doc, name, this.relationPortrait(name, person, sourcePath), "", "mn-codex__rel-who--other"));
      const body = doc.createElement("div");
      body.className = "mn-codex__rel-body";
      card.append(kicker, title, pair, body);
      detail.appendChild(card);
      await this.renderMarkdown(person.content || "", body, sourcePath, component);
      cards.push(card);
    }
    const select = (index) => {
      buttons.forEach((button, i) => { button.classList.toggle("is-active", i === index); button.setAttribute("aria-pressed", String(i === index)); });
      lines.forEach((line, i) => line.classList.toggle("is-active", i === index));
      cards.forEach((card, i) => { card.hidden = i !== index; });
    };
    buttons.forEach((button, i) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); select(i); }));
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
      let half = 0;
      for (const button of buttons) half = Math.max(half, button.offsetWidth / 2, button.offsetHeight / 2);
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
