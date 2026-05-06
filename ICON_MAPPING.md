# 아이콘 시스템 — 이모지 → SVG 매핑 표

> 작성일: 2026-05-06
> 적용 파일: `index.html`, `persona_analytics.html`, `mobile.html`
> public 사본: `~/trading-dashboard-public/` 동일 동기화

## 원칙

| 분류 | 처리 | 이유 |
|---|---|---|
| **아이콘 용도 이모지** (장식·라벨) | SVG 로 교체 | 시스템 폰트별 렌더링 차이 큼 (애플 vs 구글) |
| **상태 인디케이터** (🟢🔴🟡⚪) | 이모지 유지 | 색상 의미 + 작은 영역에 SVG 비효율 |
| **국기** (🇰🇷🇺🇸) | 이모지 유지 | 국가 식별 의미 명확, SVG 대체 부담 |
| **결과 마크** (✅❌⚠️) | 이모지 유지 | 알림/토스트의 단순 시각 신호 |
| **`<option>` 안 이모지** | 이모지 유지 | HTML select 옵션에 SVG 렌더 불가 |

## 매핑 표 (현재 적용)

| 이모지 | SVG ID | 용도 | 주요 사용처 |
|---|---|---|---|
| 📊 | `i-bar-chart` | 분석/통계 | 페르소나 분석 헤더, 보유종목 분석 라벨 |
| 📅 | `i-calendar` | 거래 달력 | 시트 헤더 |
| 🔔 | `i-bell` | 알림 | 시트 헤더 |
| 🤖 | `i-bot` | 자가개선 (큰 헤더) | 시트 헤더 |
| ⚙️ / ⚙ | `i-settings` | 설정/비중 | 시트 헤더, section-link |
| 🎯 | `i-target` | 판매 예정 | 보유종목 카드 |
| 💰 | `i-money` | 판매하기 | 보유종목 액션 버튼 |
| 🪙 | `i-coin` | 코인 | 보유종목 라벨 (UI 분기 시) |
| 📈 | `i-trending` | 주식/상승 | 보유종목 라벨 (UI 분기 시) |
| 🎭 | `i-mask` | 페르소나별 | 자가개선 시트 소제목 |
| 🔧 | `i-wrench` | 자가개선 (작은 라벨) | 자가개선 시트 소제목 |
| ⏳ | `i-hourglass` | 판매 예약됨 | 보유종목 액션 |
| 📦 | `i-package` | ZIP 다운로드 | persona_analytics 리포트 |
| 💡 | `i-bulb` | 팁/안내 | persona_analytics 안내문 |

## 유지된 이모지 (의도)

```
🟢 큰 수익 / 수익 진행
⚪ 보합 (모멘텀 관찰)
🟡 손실 진입 (-1.5% 임박)
🔴 손절 임박 / 판매 예약됨
✅ 작업 성공 (toast)
❌ 작업 실패 (toast)
⚠️ 경고 (toast)
ℹ️ 정보 (toast)
🇰🇷 / 🇺🇸 국가 식별 (서브탭, 달력 옵션)
```

## SVG 사용 표준

```html
<svg width="14" height="14" style="vertical-align:-2px;stroke:currentColor;fill:none;stroke-width:2">
  <use href="#i-bar-chart"/>
</svg>
```

- **stroke:currentColor** — 부모 텍스트 색상 자동 상속
- **fill:none** — outline 스타일 (Feather/Lucide 계열)
- **stroke-width:2** — 24×24 viewBox 기준 두께 일관
- 인라인 사용 시 `vertical-align:-2px` 또는 `display:inline-flex; align-items:center; gap:4~6px`
- 작은 영역(11px)·중간(14~16px)·헤더(18~22px) 3종 사용

## SVG 정의 위치

각 HTML 파일 상단 `<svg width="0" height="0" style="position:absolute"><defs>...</defs></svg>` 블록.
새 아이콘 추가 시:
1. `index.html` defs 에 추가
2. `persona_analytics.html` defs 에 추가 (필요한 것만)
3. `mobile.html` defs 에 추가 (필요한 것만)
4. `trading-dashboard-public/` 동기화

## 다음에 추가하면 좋을 아이콘

- `i-flask` — 실험실/베타 기능
- `i-shield` — 안전/리스크 관리
- `i-lightning` — 빠른 실행
- `i-bookmark` — 즐겨찾기 종목
- `i-warning-triangle` — 경고 (현재 ⚠️ 이모지 사용 중)

## Lucide / Feather Icons 참고

이번 추가분의 path 데이터는 [Lucide](https://lucide.dev) 와 [Feather](https://feathericons.com) 의 outline 스타일을 차용. 라이선스 ISC/MIT — 무료 사용 가능.
