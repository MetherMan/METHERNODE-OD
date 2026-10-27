# MN Illuminated Codex

v1.15.0은 긴 Mely 설정집의 재페이징·장 이동·이미지 배치 편집 경로를 수명주기 단위로 리팩터링했습니다. 애니메이션 전용 DOM 오브젝트 풀, 활성 펼침면 상수 시간 갱신, 드래그 이벤트의 프레임 단위 합치기를 적용해 긴 책에서도 반복 조작의 할당과 전역 리스너 수가 늘지 않도록 정리했습니다.

사용자가 제공한 최종 원본 1·2·3·4와 승인된 5번을 기준으로 Mely 디자인을 **1~5번 하이브리드 지면**으로 렌더링합니다. 원본에서 추출한 고정 장식층은 플러그인 자산으로 사용하고, 캐릭터 이미지·제목·부제·본문·사실표는 실제 Markdown 데이터로 그 위에 배치합니다. 따라서 완성 미리보기의 구도는 유지하면서 내용과 이미지 비율은 자유롭게 바꿀 수 있습니다.

개발 의사결정과 최적화 근거는 [`docs/README.md`](docs/README.md)에서 시작합니다.

Ribbon Slash·Tidal Crescent·Horn Slash·Portrait Echo는 예전 근사 CSS가 아니라 각 최종 원본의 대각선, 초승달, 세로 제목축, 잔상층, 하단 자료판 좌표에 맞춰 제작했습니다. 3번의 붓자국은 캐릭터 앞 장식층으로 분리했고, 4번은 주인물과 4중 잔상의 크기·간격 및 제목 좌표를 원본에 맞췄습니다. 장식층에는 캐릭터와 문서 내용이 들어 있지 않으므로 `image`, `title`, `subtitle`, `content`, `facts`는 그대로 교체할 수 있습니다.

긴 설정에는 `layout_mode: flow`와 `layout_mode: book`을 사용합니다. `flow`는 내용 길이에 맞춰 펼침면이 아래로 늘어나고, `book`은 실제 렌더링 높이를 측정해 문단·제목·목록 단위로 다음 지면에 배치한 뒤 버튼이나 방향키로 넘겨 봅니다. 자세한 문법은 `BOOK-MODE.md`에 정리되어 있습니다.

처음 설치하거나 이전 버전에서 교체하는 경우에는 **`상세-사용설명서.md`를 먼저 읽어 주세요.** 특히 플러그인 폴더가 두 겹으로 들어가면 Obsidian이 계속 이전 버전을 불러옵니다.

메러노더 설정 문서를 **삽화가 있는 설정집·인물 도감·생물 도감**처럼 보여 주는 오프라인 Obsidian 플러그인입니다.

Mely 전용 에디토리얼 아카이브는 사용자가 제공한 흑백 붓질, 건축 도면 콜라주, 검은 깃털, 고딕 선화와 날개 판화를 지면 소재로 사용합니다. 이미지 보드·검은 받침판·라벨·캡션을 서로 다른 미세 각도로 어긋나게 배치하며, 캐릭터는 각 레이아웃의 안전 영역 안에서 `contain`·`cover`·`bleed` 규칙으로 표시됩니다. Bodoni Moda와 고운바탕도 플러그인에 포함했으므로 네트워크 없이 동일하게 표시됩니다.

`mn-codex` 코드블록 안에 간단한 YAML을 적으면 다음 레이아웃으로 렌더링합니다.

- 흑백·서리빛 Mely 에디토리얼 펼침면
- 내용 길이에 따라 늘어나는 flow 지면과 좌우로 넘기는 book 지면
- 중앙 책등과 좌우 양피지 페이지가 있는 이미지 + 설명 펼친 책
- 흑·백·적 고대비의 Redline 게임 아카이브
- 흑연·청록 신호 기반의 Resonance 게임 아카이브
- 전신 이미지 + 프로필/인포박스
- 생물 도감
- 독립형 인포박스
- 기술 카드 묶음
- 장식 인용문과 장 구분선
- 접이식 스포일러

외부 라이브러리, 계정, 서버, 네트워크 요청, 텔레메트리를 사용하지 않습니다. 이미지와 문서는 기존 볼트 안에 그대로 남습니다. 데스크톱과 모바일에서 모두 동작하도록 Node.js/Electron 전용 기능도 사용하지 않았습니다.

## 설치

1. 이 폴더의 이름이 `mn-illuminated-codex`인지 확인합니다.
2. 폴더 전체를 볼트의 `.obsidian/plugins/` 안으로 복사합니다.

   최종 모양은 아래와 같습니다.

   ```text
   내 볼트/
   └─ .obsidian/
      └─ plugins/
         └─ mn-illuminated-codex/
            ├─ manifest.json
            ├─ main.js
            ├─ styles.css
            ├─ mely-reference-material.css
            ├─ mely-angled-layout.css
            └─ assets/
               ├─ fonts/
               ├─ vellum-texture.webp
               ├─ codex-corner.svg
               ├─ redline-texture.webp
               └─ resonance-texture.webp
   ```

3. Obsidian을 다시 시작하거나 `설정 → 커뮤니티 플러그인`을 새로 고칩니다.
4. 제한 모드를 해제한 뒤 **MN Illuminated Codex**를 켭니다.

로컬 플러그인을 처음 시험할 때는 볼트 백업을 권장합니다. 이 플러그인 자체는 파일을 생성·이동·삭제하지 않고, 명령을 실행한 현재 편집 위치에 Markdown 양식만 삽입합니다.

## 가장 빠른 사용법

Markdown 문서를 연 뒤 왼쪽 리본의 **펼친 책 아이콘**을 누르면 아래 17종을 순서대로 고를 수 있습니다. 또는 명령 팔레트(`Ctrl/Cmd + P`)에서 `레이아웃 선택기 열기`를 실행합니다.

1. `01 · Mely 리본 슬래시`
2. `02 · Mely 타이달 크레센트`
3. `03 · Mely 혼 슬래시`
4. `04 · Mely 포트레이트 에코`
5. `05 · Mely 블랙 타이드`
6. `06 · Mely 에디토리얼 아카이브`
7. `07 · Mely 넘기는 설정집`
8. `08 · Redline 스타일 아카이브`
9. `09 · Resonance 공명 아카이브`
10. `10 · 양피지 좌우 펼침`
11. `11 · 인물 프로필`
12. `12 · 생물 도감`
13. `13 · 인포박스`
14. `14 · 기술 카드 묶음`
15. `15 · 장식 인용문`
16. `16 · 장식 구분선`
17. `17 · 접이식 스포일러`

각 항목을 명령 팔레트에서 직접 실행하는 것도 가능합니다.

빈 양식을 넣은 다음 제목, 이미지 경로, 본문을 바꾸면 됩니다. 문장을 먼저 선택한 뒤 명령을 실행하면 이미지+설명, 프로필, 생물 도감 등의 `content`에 선택 문장이 들어갑니다. 스포일러 명령은 선택 문장을 접이식 영역 안에 넣습니다.

## 이미지 경로

기존 볼트 구조를 그대로 사용할 수 있습니다.

```yaml
image: MN-Core/Assets/Character/Lucia/lucia-fullbody.png
image_fit: contain
```

위키링크도 지원합니다.

```yaml
image: "[[MN-Core/Assets/Character/Lucia/lucia-fullbody.png]]"
```

같은 이름의 이미지가 여럿이면 `MN-Core`부터 시작하는 전체 볼트 경로가 가장 안전합니다. 오프라인 사용을 위해 웹 URL보다 볼트 내부 이미지를 권장합니다.

`image_fit: contain`은 그림 전체가 보이는 도감식 삽화에 적합합니다. `image_fit: cover`는 이미지가 페이지 영역을 가득 채우며, 이때는 가장자리 융합 효과 대신 원본 색과 사각 구도를 유지합니다.

예시 구조:

```text
MN-Core/
└─ Assets/
   ├─ Character/
   ├─ Creature/
   └─ Emblem/

MN-Node/
└─ Character/
   └─ Main/
      └─ Mely/
         ├─ 원년/
         └─ 현행/
```

## 기본 문법

### 이미지 + 설명 펼침

```yaml
type: spread
theme: parchment
eyebrow: MELY ARCHIVE · CURRENT ERA
title: 루시아 글라시에르
subtitle: 얼어붙은 호수의 감시자
image: MN-Core/Assets/Character/Lucia/lucia-study.png
image_alt: 루시아 설정화
image_position: left
image_focus: center
caption: 의상 및 장비 연구
folio_left: 12
folio_right: 13
image_note: |
  왼쪽 삽화 아래에 들어갈 짧은 관찰 기록입니다.
content: |
  본문에는 **강조**, [[내부 링크]], 목록 등 Obsidian Markdown을 쓸 수 있습니다.
```

실제 노트에서는 위 YAML의 앞뒤를 아래처럼 `mn-codex` 코드 펜스로 감쌉니다.

````markdown
```mn-codex
type: spread
theme: parchment
title: 루시아 글라시에르
image: MN-Core/Assets/Character/Lucia/lucia-study.png
content: |
  그림 옆에 놓일 설명입니다.
```
````

### 프로필과 인포박스

```yaml
type: profile
theme: frost
eyebrow: MELY · PERSONNEL FILE
title: 루시아 글라시에르
subtitle: Lucia Glacier
badge: 현행 Mely
image: MN-Core/Assets/Character/Lucia/lucia-fullbody.png
image_focus: top
quote: 나는 얼음을 믿지 않아. 그 위를 걷는 사람을 믿지.
facts:
  소속: Mely
  분류: 주역
  시대: 현행
  역할: 북부 경계 감시자
  상태: 활동
content: |
  인물의 첫인상, 핵심 갈등, 다른 인물과의 관계를 적습니다.
```

`type: infobox`를 쓰면 같은 `facts` 문법을 폭이 좁은 독립형 정보상자로 렌더링합니다.

### 생물 도감

```yaml
type: creature
theme: forest
eyebrow: FIELD BESTIARY · 017
title: 서리깃 와이번
subtitle: Cryopteryx borealis
badge: 관찰 등급 B
image: MN-Core/Assets/Creature/frostwing-wyvern.png
image_position: right
facts:
  서식지: 북부 빙곡
  활동기: 초겨울
  위험도: 중간
traits:
  - 냉기 내성
  - 군집 비행
  - 빛 반사 깃털
content: |
  관찰 기록과 생태적 특징을 적습니다.
```

### 기술 카드

```yaml
type: skills
theme: ember
eyebrow: TECHNIQUE PLATE
title: 기술 및 전투 습관
columns: 2
skills:
  - name: 빙면 도약
    icon: ◇
    rank: 기동
    description: 얇은 얼음의 파동을 읽고 무너지기 직전의 면을 발판으로 삼는다.
  - name: 백색 잔향
    icon: ✦
    rank: 감지
    description: 눈에 남은 진동으로 지나간 존재의 방향을 추적한다.
```

`columns`는 `1`, `2`, `3`을 지원하며 작은 화면에서는 자동으로 한 열이 됩니다.

### 접이식 스포일러

Obsidian callout을 이용하므로 편집 화면과 읽기 화면에서 자연스럽게 접고 펼칠 수 있습니다.

```markdown
> [!mn-spoiler]- 작가 전용 · 진실 보기
> 이 안에 반전이나 폐기 전 설정을 적습니다.
>
> - 관련 비밀: [[스포일러 문서]]
> - 공개 시점: 3막 이후
```

코드블록 방식도 지원합니다.

````markdown
```mn-codex
type: spoiler
theme: moon
title: 작가 전용 · 진실 보기
open: false
content: |
  숨길 내용을 적습니다.
```
````

## 값 참고표

| 항목 | 값 |
|---|---|
| `type` | `spread`, `profile`, `creature`, `infobox`, `skills`, `quote`, `divider`, `spoiler` |
| `theme` | `redline`, `resonance`, `parchment`, `frost`, `ember`, `forest`, `ink`, `moon` |
| `image_position` | `left`, `right` |
| `image_focus` | `top`, `center`, `bottom` |
| `image_note` | 삽화 페이지 아래에 놓이는 짧은 Markdown 주석 |
| `folio_left`, `folio_right` | 좌우 페이지 하단의 쪽 번호 |
| `facts` | `항목명: 값` 형태의 YAML 객체 |
| `traits` | YAML 목록 |
| `content` | `|` 다음 줄부터 두 칸 들여쓴 Markdown |

YAML에서는 콜론(`:`), 대괄호, 특수문자가 들어간 짧은 값을 따옴표로 감싸면 안전합니다. `content: |` 아래의 본문은 반드시 두 칸 이상 들여씁니다.

## 테마와 호환성

- 밝은/어두운 Obsidian 테마를 자동으로 따라갑니다.
- 폭이 좁은 창과 모바일에서는 좌우 배치가 세로 배치로 바뀝니다.
- 외부 폰트를 내려받지 않습니다. 설치된 `Pretendard`, `Noto Serif KR`, `Nanum Myeongjo`가 있으면 우선 사용하고, 없으면 현재 Obsidian 테마 글꼴을 사용합니다.
- 다른 테마의 스타일을 덮어쓰지 않도록 CSS를 `.mn-codex`와 `mn-*` callout에 한정했습니다.

전체 조합 예시는 `MN-Codex-사용-예시.md`에서 볼 수 있습니다.

## MVP에서 의도적으로 제외한 것

- 이미지 생성·편집
- 설정 내용을 자동으로 다른 폴더로 이동하는 기능
- Dataview 등 다른 커뮤니티 플러그인 의존성
- 온라인 동기화나 AI 연결

이 버전은 **아름다운 레이아웃을 빠르게 삽입하고 Markdown으로 오래 보존하는 것**에 집중합니다.
# Mely 선택형 쇼케이스

명령 팔레트에서 `MN Illuminated Codex`를 검색하면 다음 다섯 디자인을 문서에 바로 삽입할 수 있습니다.

- `01 · Mely 리본 슬래시 삽입`
- `02 · Mely 타이달 크레센트 삽입`
- `03 · Mely 혼 슬래시 삽입`
- `04 · Mely 포트레이트 에코 삽입`
- `05 · Mely 블랙 타이드 삽입`

이 다섯 명령은 미리보기와 같은 구성을 바로 확인할 수 있도록 플러그인 내장 샘플 이미지를 함께 삽입합니다. 실제 문서에서는 `image:` 값을 원하는 볼트 이미지 경로 또는 `[[위키링크]]`로 바꾸면 됩니다.

다섯 Mely 레이아웃은 완성 이미지를 붙이지 않습니다. `image`, `title`, `subtitle`, `content`, `facts`를 실제 HTML 요소로 렌더링하며, 승인된 디자인의 3:2 구도와 좌표 체계를 유지합니다. 예전 문서에 `visual_mode: exact`가 남아 있어도 호환을 위해 자동으로 라이브 레이아웃으로 처리됩니다.

삽입된 블록에서 `image:`만 지정하면 됩니다. 비워 두면 현재 문서에 첨부된 첫 번째 이미지를 자동으로 사용합니다. 안전하게 전신을 표시하려면 `image_fit: contain`을 유지하고, 화면을 가득 채우려면 `cover`, 의도적으로 크게 넘치게 하려면 `bleed`로 바꿀 수 있습니다.

다섯 디자인은 `layout_mode` 값으로도 직접 선택할 수 있습니다: `ribbon-slash`, `tidal-crescent`, `horn-slash`, `portrait-echo`, `black-tide`.

## Mely 표지에서 캐릭터 소개 페이지로 넘기기

Mely 1·2·3·4·5 쇼케이스 블록은 캐릭터의 표지입니다. `deck: auto`를 넣으면 표지의 `NEXT`가 같은 캐릭터의 소개 책장을 만듭니다. 소개 책장 이미지는 표지 `image:`를 재사용하지 않고 `book_image:`에서 별도로 받습니다.

```yaml
# 첫 번째 mn-codex 블록
layout_mode: ribbon-slash
deck: auto
image: "Dummy/cover.png"
book_title: "니그라 생태 관측록"
book_eyebrow: BESTIARY / DRAGON ARCHIVE
book_subtitle: FIELD NOTES · REVISED
book_image: "" # 한쪽 전체를 쓰는 이미지가 필요할 때만 경로 입력
book_illustration: "Dummy/dragon-sketch.png" # 본문 속 작은 삽화
book_illustration_position: right # left 또는 right
book_illustration_size: medium # small, medium, large, wide
book_illustration_style: ink # 양피지 선화 느낌; 원본 색상은 plain
book_illustration_caption: 고룡의 날개 골격 모식도
book_page_style: parchment # 기존 흰 기록지는 archive
book_page_mode: leaf # leaf=좌우 각각 한 장, spread=좌우 전체가 한 장
book_pages:
  - title: "01 · 개요"
    eyebrow: CHARACTER FILE / 01
    subtitle: ORIGIN · SUMMARY
    content: |
      니그라의 기원과 핵심 설정을 기록합니다.
  - title: "02 · 외형과 복식"
    illustration: "Dummy/dragon-sketch.png"
    illustration_position: right
    illustration_size: medium
    illustration_style: ink
    illustration_caption: 날개 골격 모식도
    content: |
      외형, 복식, 날개형 장비를 기록합니다.
      삽화를 비우면 이 지면 전체가 글 공간이 됩니다.
  - title: "03 · 성격"
    content: |
      성격과 행동 원칙을 기록합니다.
  - title: "04 · 능력"
    content: |
      능력, 전투 방식, 약점을 기록합니다.
  - title: "05 · 관계"
    content: |
      주요 인물과의 관계를 기록합니다.
  - title: "06 · 연혁"
    content: |
      사건과 관측 기록을 시간순으로 적습니다.

# book_pages를 쓰지 않을 때만 사용하는 한 덩어리 자동 넘김 본문
book_content: ""

# 선택 사항: 별도로 꾸민 책장을 사용하고 싶을 때만 바로 다음 mn-codex 블록 추가
layout_mode: book
auto_paginate: true
```

별도 `book` 블록이 없으면 `book_image:`와 쇼케이스의 `content:`로 소개 책장을 만듭니다. `book_image:`를 비우면 이미지 칸을 만들지 않고 양쪽 지면을 제목·본문용으로 사용합니다. 바로 뒤에 `layout_mode: book` 블록이 있으면 자동 생성본 대신 그 사용자 정의 책장을 사용합니다. 본문이 지면을 넘으면 문단 단위로 자동 배치되고, `<!-- mn-page-break -->`로 원하는 위치에서 새 장을 시작할 수 있습니다. 첫 book 장의 `PREV`를 누르면 다시 쇼케이스 표지로 돌아갑니다.

`book_pages:`에서는 배열 항목 하나가 실제 지면 한 장입니다. 데스크톱에서는 두 장씩 한 펼침으로 보이므로 위의 6개 항목은 3개 펼침이 되고, `NEXT`를 두 번 더 눌러 마지막 지면까지 이동합니다. 6장 제한은 없으며 항목을 10개, 20개로 계속 추가할 수 있습니다. 각 항목마다 `title`, `eyebrow`, `subtitle`, `badge`, `illustration`, `illustration_position`, `illustration_size`, `illustration_style`, `illustration_caption`, `content`를 독립적으로 지정합니다. `illustration:`을 생략하거나 `""`로 비우면 해당 지면은 제목과 글만 사용합니다. `book_pages`가 하나라도 있으면 `book_content` 대신 페이지 배열을 사용합니다.

페이지 안의 제목 계층은 모든 장에서 같습니다. `title`은 페이지의 큰 제목이고 `subtitle`은 그 아래의 작은 소제목이며, `eyebrow`는 제목 위에 놓이는 가장 작은 분류 문구입니다. 첫 페이지만 더 크게 만들지 않으므로 `01 · 개요`, `02 · 외형과 복식`처럼 같은 계층의 제목은 같은 크기로 표시됩니다.

장과 하위 페이지를 구분하려면 평면형 `book_pages` 대신 `book_sections`를 사용합니다. 각 섹션의 `title`은 책갈피 대상이 되는 장 제목이자 별도의 장 시작 페이지가 되고, 내부 `pages`는 그 장에 속한 설명 페이지가 됩니다. `book_sections`가 있으면 이를 우선 사용하고 `book_pages`는 무시합니다.

`book_sections`를 사용하면 별도 설정 없이 각 장의 `title`이 책 오른쪽 가장자리의 책갈피로 자동 표시됩니다. 책갈피를 누르면 중간 펼침을 화면에 하나씩 표시하지 않고 목표 장으로 한 번만 전환하며, 그 위에서 여러 장의 반쪽 종이가 3D로 연속 회전하는 folio flip이 실행됩니다. 목표 지면은 전환 전에 미리 준비되어 종이 아래에서 글과 장식이 함께 서서히 드러납니다. `NEXT`와 `PREV`로 이동해도 현재 위치에 해당하는 책갈피가 자동으로 강조됩니다.

```yaml
book_sections:
  - title: "개요"
    subtitle: ORIGIN · SUMMARY
    content: |
      개요 장의 도입문입니다.
    pages:
      - title: "정보 1"
        content: |
          첫 번째 정보를 설명합니다.
      - title: "정보 2"
        content: |
          두 번째 정보를 설명합니다.
  - title: "기술"
    subtitle: ABILITY · TECHNIQUE
    content: |
      기술 장의 도입문입니다.
    pages:
      - title: "기술 1"
        content: |
          기술의 효과와 조건을 설명합니다.
      - title: "기술 2"
        content: |
          기술의 효과와 조건을 설명합니다.
```

`book_page_mode: leaf`는 `book_pages` 항목을 왼쪽·오른쪽에 한 장씩 배치하는 기본 방식입니다. `book_page_mode: spread`로 바꾸면 항목 하나가 왼쪽과 오른쪽 전체를 한 페이지로 사용하며, 다음 항목은 반드시 다음 펼침에서 시작합니다. 긴 본문은 같은 펼침의 왼쪽에서 오른쪽으로 이어진 뒤 필요하면 다음 펼침으로 계속 흐릅니다.

`auto_paginate: true`인 책은 긴 문단을 통째로 넘기지 않고 문장·단어 경계에서 잘라 빈 공간을 먼저 채웁니다. 링크와 강조 같은 인라인 서식은 유지되고, 목록은 항목 단위로 나뉘며 번호가 이어집니다. 소제목은 다음 본문과 함께 넘어가 지면 밑에 혼자 남지 않습니다. 작성자가 직접 넘길 위치는 `<!-- mn-page-break -->`로 고정할 수 있습니다. 너비가 긴 코드와 표는 글자를 누르지 않고 지면 안에서만 가로로 스크롤됩니다.

### 페이지별 반쪽/전체 모드·바로가기

```yaml
book_page_mode: leaf # 책 기본값
book_pages:
  - title: "개요"
    page_mode: leaf
    tag: 개요
    content: |
      반쪽 지면입니다.
  - title: "대형 관계도"
    page_mode: spread
    tag: 관계도
    content: |
      이 항목만 좌우 전체를 사용합니다.
  - title: "기술 1"
    page_mode: leaf
    tag: 기술 1
    content: |
      다시 반쪽 지면입니다.
```

긴 본문은 다음 지정 항목을 덮어쓰지 않고, 현재 페이지 제목의 `CONTINUED` 지면을 생성합니다. `tag:`는 책 위쪽 전용 레일에 나타나며 클릭하면 해당 페이지로 즉시 이동합니다.

### 텍스트 색상·효과

`red::위험`, `blue::물 속성`, `teal::관측`, `gold::중요`, `glow::신비`, `marker::형광펜`, `underline::밑줄`, `muted::부가 설명`처럼 인라인 코드 안에 적으면 책 전용 효과가 적용됩니다. 예: `` `gold::중요한 설정` ``. 페이지 전체에는 `text_tone: red|blue|teal`, `text_effect: glow`를 쓸 수 있습니다.

### 페이지 이미지 자유 배치

```yaml
page_images:
  - image: "Dummy/Nigura.png"
    anchor: bottom-right # top-left/top/top-right/left/center/right/bottom-left/bottom/bottom-right
    width: 26
    rotate: -3
    opacity: 0.92
    behind_text: true
  - image: "Dummy/SD/1.png"
    x: 18
    y: 24
    width: 14
    fit: contain
```

`배치 편집`을 누르면 현재 펼침의 독립 지면 위에 `왼쪽 + 이미지`, `오른쪽 + 이미지` 버튼이 각각 나타납니다. 누른 쪽은 **초기 생성 위치만** 정합니다. 생성된 그림은 좌·우 페이지로 나뉘지 않고 펼침 전체를 하나의 캔버스로 사용하므로, 왼쪽에서 오른쪽까지 끊김 없이 드래그할 수 있고 **책등 중앙에 이미지 중심을 놓거나 양쪽에 걸치게 배치**할 수 있습니다. 페이지 선택 메뉴 옆의 공통 `이미지 넣기` 버튼도 계속 사용할 수 있습니다. 네 모서리의 금색 원형 손잡이는 비율 유지 확대·축소, 위쪽 원형 손잡이는 자유 회전이며 `Shift`를 누른 회전은 15도 단위로 맞춰집니다. 본문을 가리는 별도 대형 패널은 사용하지 않으며, 선택 파일명·`설정 복사`·`삭제`만 기존 하단 도구 줄에 작게 표시됩니다. `Delete` 또는 `Backspace`로도 선택 이미지를 지울 수 있습니다. 변경 결과는 노트·펼침별로 자동 저장되어 재실행 후에도 복원됩니다. `설정 복사`는 YAML 원문도 함께 관리하고 싶을 때만 사용하면 됩니다. 본문 옆으로 자연스럽게 흐르는 삽화는 `illustration:`, 절대 좌표 배치는 `page_images:`를 사용하면 됩니다.

각 `book_pages` 항목에는 장식용 `stickers:`를 원하는 만큼 넣을 수 있습니다. `scope: spread`는 펼침 전체, `left`와 `right`는 지정 지면, `page`는 현재 본문 지면을 기준으로 합니다. `x`, `y`, `width`의 숫자는 해당 영역에 대한 백분율이고 `rotate`는 각도입니다.

```yaml
book_pages:
  - title: "01 · 개요"
    stickers:
      - image: "Dummy/SD/1.png"
        scope: spread
        x: 72
        y: 42
        width: 18
        rotate: -4
      - image: "Dummy/SD/4.png"
        scope: spread
        x: 80
        y: 74
        width: 25
        rotate: 3
    content: |
      스티커와 함께 표시할 본문입니다.
```

선택 옵션으로 `opacity: 0.8`, `flip: true`, `z: 18`도 사용할 수 있습니다. 스티커는 장식 레이어라 링크와 NEXT/PREV 조작을 막지 않습니다.

`book_image`는 책의 한쪽 지면 전체를 차지하는 큰 이미지이고, `book_illustration`은 본문 속에 작게 들어가 글이 옆으로 흐르는 도감 삽화입니다. `book_page_style: parchment`는 따뜻한 판타지 양피지, `archive`는 기존의 흰 Mely 기록지입니다. `book_title`, `book_eyebrow`, `book_subtitle`은 표지의 `title`, `eyebrow`, `subtitle`과 독립적입니다. 전용 필드를 생략하면 표지 값을 이어받고, `book_eyebrow: ""` 또는 `book_subtitle: ""`처럼 빈 값을 명시하면 책장에서는 해당 문구를 숨깁니다.

책장 전환 없이 표지만 표시하려면 `deck: auto`를 지우거나 `deck: false`로 바꾸면 됩니다.

이전 버전의 `pages:` 배열은 호환을 위해 남아 있지만, 이는 한 쇼케이스 안에서 캐릭터 데이터를 교체하는 별도 기능입니다. 일반 캐릭터 소개는 `deck: auto`만 사용하면 됩니다.

```yaml
title: "첫 번째 캐릭터"
image: "Dummy/first.png"
facts:
  상태: ACTIVE
content: |
  첫 번째 캐릭터 기록입니다.
pages:
  - title: "두 번째 캐릭터"
    image: "Dummy/second.png"
    facts:
      상태: UNKNOWN
    content: |
      두 번째 캐릭터 기록입니다.
  - title: "세 번째 캐릭터"
    image: "Dummy/third.png"
    content: |
      세 번째 캐릭터 기록입니다.
```

각 추가 페이지는 생략한 값을 첫 번째 페이지에서 이어받습니다. 따라서 `subtitle`, `caption`, 공통 보안 문구 등을 매번 반복할 필요가 없습니다.

Mely 5의 좌측 타원 컷은 기본적으로 상단·중앙·하단을 서로 다르게 보여 줍니다. 그림마다 구도가 다르면 다음 값으로 세 컷을 독립 조절할 수 있습니다.

```yaml
detail_focus:
  - 50% 18%
  - 50% 50%
  - 50% 82%
detail_scale: [2.05, 2.05, 2.05]
```

완전히 다른 이미지를 각 타원에 넣으려면 `detail_images:`에 이미지 경로 세 개를 적습니다.

```yaml
detail_images:
  - "Dummy/face.png"
  - "Dummy/weapon.png"
  - "Dummy/costume.png"
```
