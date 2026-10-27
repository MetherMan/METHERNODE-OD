# 긴 설정 문서: flow와 book 모드

MN Illuminated Codex v0.9.0부터 `type: spread`에 `layout_mode`를 지정할 수 있습니다.

## 1. 내용 길이에 맞춰 늘어나는 flow

짧은 인물 소개부터 긴 설정 문서까지 하나의 펼침면으로 이어서 보고 싶을 때 사용합니다.

```mn-codex
type: spread
theme: mely
layout_mode: flow
title: 루시아 글라시에르
image: "[[MN-Core/Assets/Character/Lucia/fullbody.png]]"
image_fit: contain
content: |
  첫 번째 문단입니다.

  문단을 계속 추가하면 오른쪽 지면이 아래로 늘어나고 왼쪽 지면도 같은 높이를 유지합니다.
```

- 기존 Mely 블록에 `layout_mode`가 없으면 `flow`로 동작합니다.
- 이미지 크기는 억지로 늘어나지 않고 기존 프레임 안에 유지됩니다.
- 오른쪽 본문이 길어지면 펼침면 전체 높이가 본문에 맞춰 증가합니다.
- 한 화면에 모두 이어서 읽거나 검색하기 좋은 방식입니다.

## 2. 장을 넘기는 book

긴 설정을 고정된 지면으로 나눠 읽고 싶을 때 사용합니다.

```mn-codex
type: spread
theme: mely
layout_mode: book
auto_paginate: true
eyebrow: MELY / AERIAL ARCHIVE 01
title: 루시아 글라시에르
subtitle: OBSERVATION RECORD · ACTIVE
image: "[[MN-Core/Assets/Character/Lucia/fullbody.png]]"
image_position: left
image_focus: top
image_fit: bleed
plate_label: FILE 01 / WING INDEX
caption: VISUAL IDENTIFICATION · VERIFIED
folio_left: 01
folio_right: 02
image_note: |
  복식과 날개형 장비처럼 현장에서 식별할 특징을 기록합니다.
content: |
  첫 지면의 본문입니다. 문단이 현재 면의 높이를 넘으면 다음 면으로 이동합니다.

  제목, 문단, 목록, 인용문은 가능한 한 중간에서 잘리지 않고 하나의 블록으로 이동합니다.

  <!-- mn-page-break -->

  이 문단은 내용 길이와 관계없이 새 지면에서 시작합니다.
```

## 3. 자동 분할 규칙

`auto_paginate: true`가 기본값입니다.

- Markdown이 화면에 렌더링된 실제 높이를 기준으로 계산합니다.
- 문단, 제목, 목록, 인용문, 코드 블록, 표 같은 최상위 블록을 가능한 한 통째로 옮깁니다.
- 이미지가 있는 첫 펼침 이후에는 좌우 모두 밝은 Mely 연구 지면으로 사용합니다.
- 창 너비가 크게 바뀌면 현재 너비에 맞게 다시 계산합니다.
- 한 블록 자체가 지면보다 큰 경우에는 글을 임의로 잘게 쪼개지 않고 해당 면 안에 얇은 스크롤을 제공합니다.

자동 분할을 끄고 수동 나눔만 사용하려면 다음과 같이 적습니다.

```yaml
layout_mode: book
auto_paginate: false
```

## 4. 원하는 위치에서 새 지면 시작

`content: |` 안에 아래 주석을 한 줄로 넣습니다.

```markdown
<!-- mn-page-break -->
```

화면에는 주석이 표시되지 않습니다. 주석 다음의 첫 블록이 새 면에서 시작합니다.

## 5. 넘기는 방법

- 화면 아래 `이전 장`·`다음 장` 버튼
- 키보드 `←`·`→`
- `PageUp`·`PageDown`
- `Home`: 첫 장
- `End`: 마지막 장

키보드로 넘길 때는 먼저 책 영역을 한 번 클릭해 초점을 둡니다.

## 6. 모바일과 좁은 패널

가로 폭이 760px 이하이면 펼침 전체를 억지로 축소하지 않고 한 면씩 보여 줍니다. 첫 번째 이미지 면과 두 번째 본문 면도 각각 한 장으로 계산됩니다.

## 7. 명령 팔레트

`Ctrl + P`에서 다음 명령을 실행하면 book 문법이 자동으로 삽입됩니다.

```text
MN Illuminated Codex: Mely 넘기는 설정집 삽입
```

기존 한 장짜리 Mely 문법은 `Mely 에디토리얼 아카이브 삽입`을 사용합니다.
