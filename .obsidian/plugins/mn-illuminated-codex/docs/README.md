# 개발 문서

MN Illuminated Codex의 구현 의도와 검증 근거를 사용 설명서와 분리한다. 사용 문법은 상위 `README.md`와 `BOOK-MODE.md`, 여기서는 설계 선택과 트레이드오프를 다룬다.

## 문서 지도

- [ARCHITECTURE.md](ARCHITECTURE.md): 렌더링 파이프라인, 소유권, 수명주기
- [REFACTORING.md](REFACTORING.md): 문제 정의, 선택 이유, 대안과 트레이드오프
- [PERFORMANCE.md](PERFORMANCE.md): 성능 예산, 구조적 지표, 프로파일링·회귀 검증 방법

## 기준본

실제 Obsidian이 로드하는 기준본은 다음 디렉터리다.

```text
.obsidian/plugins/mn-illuminated-codex/
├─ main.js
├─ styles.css
├─ manifest.json
└─ docs/
```

볼트 루트의 `tmp/test-mely-cover-book.js`가 DOM 가짜 객체를 사용한 빠른 회귀 검증을 담당한다. 실행 방법과 수동 프로파일링 절차는 `PERFORMANCE.md`에 기록했다.

볼트의 `.obsidian/main.js`와 `.obsidian/manifest.json`은 v0.9.0 시점의 구형 배포 사본이며 현재 플러그인 기준본이 아니다. 두 사본을 동시에 수정하지 않아 회귀 대상과 실행 대상이 엇갈리지 않도록 한다.
