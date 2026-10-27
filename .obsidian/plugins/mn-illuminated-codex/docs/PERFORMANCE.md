# 성능 예산과 검증

## 목표

성능 목표는 특정 PC의 일회성 밀리초 수치보다 책의 길이와 이미지 수가 늘어나도 반복 조작 비용이 함께 증가하지 않는 구조적 불변식을 우선한다.

| 경로 | v1.14.2 이전 | v1.15.0 | 불변식 |
|---|---:|---:|---|
| 페이지 이동 시 펼침면 상태 갱신 | 전체 `S` | 최초 `S`, 이후 최대 2 | 반복 이동 `O(1)` |
| 북마크 이동 1회의 장식 DOM 새 할당 | 무대 1 + 종이 `d` + 종이면 `2d` | 워밍업 후 0 | `d ≤ 16`, 풀 상한 16 |
| 배치 이미지 `I`개의 전역 pointer 리스너 | `3I` 상시 | 대기 0, 제스처 중 3 | 이미지 수와 무관 |
| pointermove DOM 쓰기 | 이벤트당 1회 | 프레임당 최대 1회 | 최신 좌표만 반영 |
| 리사이즈 재빌드 자원 | 코드 블록 종료까지 누적 가능 | 직전 빌드 unload | 생존 렌더 스코프 1개 |

`S`는 물리 펼침면 수, `d`는 이동 거리와 16 중 작은 값, `I`는 자유 배치 이미지 수다. 현재·목표 페이지 스냅샷 2개는 내용 정합성 때문에 매 전환마다 새로 만들고 종료 즉시 해제한다.

## 런타임 카운터

책 root의 제어기는 개발자 도구에서 다음 카운터를 제공한다.

```js
$0.closest(".mn-codex")._mnBookController.getPerformanceStats()
```

예시 구조:

```json
{
  "spreadStateUpdates": 14,
  "flipPool": {
    "stages": { "created": 1, "reused": 4, "released": 5, "discarded": 0 },
    "sheets": { "created": 8, "reused": 27, "released": 35, "discarded": 0 }
  }
}
```

이 카운터는 운영 로그나 텔레메트리를 보내지 않고 현재 DOM 제어기 메모리에만 존재한다.

## 자동 검증

볼트 루트에서:

```powershell
node --check .\.obsidian\plugins\mn-illuminated-codex\main.js
node .\tmp\test-mely-cover-book.js
```

회귀 하네스는 다음을 확인한다.

- 표지 ↔ 자동 생성 book 연결과 페이지 상태
- 리빌드 후 이미지 좌표·크기·회전 보존
- 오브젝트 풀의 무대 identity 재사용
- 첫 전환에서만 종이를 생성하고 두 번째 전환에서 전부 재사용하는지
- 풀 dispose 시 활성 DOM과 보관 DOM을 모두 해제하는지

## 수동 프로파일링

1. Obsidian 개발자 도구의 Performance 패널을 연다.
2. 20개 이상 페이지와 10개 이상 배치 이미지가 있는 book을 준비한다.
3. 순차 NEXT/PREV 10회, 먼 북마크 이동 5회, 이미지 드래그·회전·크기 조절을 각각 3초간 수행한다.
4. Event Listeners에서 pointermove/up/cancel이 대기 중 0, 제스처 중 각 1인지 확인한다.
5. 북마크 이동 두 번째부터 `flipPool.*.reused`가 증가하고 `created`는 이전 최대 종이 수를 초과하지 않는지 확인한다.
6. 패널 폭을 반복 변경한 뒤 Heap snapshot에서 연결이 끊긴 `.mn-codex__book` 수가 재빌드 횟수와 함께 늘어나지 않는지 확인한다.

## 해석 시 주의

위 표의 개선치는 코드 구조에서 증명할 수 있는 할당·리스너·복잡도 지표다. 특정 기기의 FPS, 메모리 MB, 렌더링 ms는 자산 크기·Obsidian 버전·패널 폭에 의존하므로 실측 로우 데이터 없이 성과로 기재하지 않는다.
