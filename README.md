# 두근 트레이딩 대시보드

코인봇 + 주식봇 통합 모니터링 · 컨트롤 · 자가개선 시스템.
**모바일 우선 디자인** (max-width 480px), 토스 스타일 UI.

- 외부 접속: <https://600-g.github.io/trading-dashboard/>
- 로컬 (개발): <http://127.0.0.1:9000>

---

## 폴더 구조

```
~/trading-dashboard/
├── index.html              # 메인 대시보드 (모바일/데스크 통합)
├── persona_analytics.html  # 페르소나 통합 분석
├── persona_settings.html   # 페르소나 비중 설정
├── app.js                  # (legacy) 데스크탑 v1 — index.html이 대체 중
├── system_api.py           # FastAPI :9000 (봇 프록시 + analytics + export)
├── firebase_bridge.py      # Firestore push/watch
├── start-all.sh / stop-all.sh / status.sh
├── deploy.sh               # github pages (trading-dashboard-public) 배포
├── CLAUDE.md               # Claude Code 작업 가이드 (필독)
├── README.md               # 이 파일
├── _reference/             # 명세 + 디자인 참조 (수정 X)
│   ├── persona_analytics.html       # 디자인 원본
│   ├── persona_settings.html        # 디자인 원본
│   ├── mobile_dashboard.html        # 모바일 토스 스타일 원본
│   ├── 페르소나_통합분석_명세서.md
│   ├── 페르소나_설정_통합가이드.md
│   └── 전체_리포트_내보내기_명세서.md
├── data/ logs/ pids/       # 런타임 (gitignore)
└── venv/                   # Python venv (gitignore)
```

---

## 5 프로세스 (start-all.sh)

| 프로세스 | 위치 | 포트 | 역할 |
|---|---|---|---|
| coinbot-main | ~/coinbot/ | 9001 | 24/7 코인 매매 + control_api 내장 |
| stockbot-main | ~/Desktop/주식 자동봇/ | — | KR/US 자동 분기 매매 |
| stockbot-api | 동일 | 9002 | 주식봇 컨트롤 API |
| system-api | 이 폴더 | 9000 | 봇 프록시 + analytics + export |
| firebase-bridge | 이 폴더 | — | Firestore push/watch (외부 모바일용) |

---

## 주요 endpoint (`system_api.py`)

| Method | Path | 역할 |
|---|---|---|
| GET | `/status/{coin\|stock}` | 봇 status.json 프록시 |
| POST | `/api/positions/close` | 종목 판매 예약 |
| POST | `/api/positions/cancel` | 판매 예약 취소 |
| GET | `/api/personas/stats?market=` | 페르소나 30일 통계 |
| GET | `/api/personas/analytics/{persona}?market=` | 통합 분석 (stats+slot+positions+watching+expected) |
| GET | `/api/personas/comparison?market=&days=` | 4 페르소나 누적 PnL 라인차트 |
| GET | `/api/personas/current-weight?market=` | 현재 비중 + pending |
| POST | `/api/personas/weight` | 비중 변경 (다음 시장 시작 시 적용) |
| GET | `/api/personas/{persona}/export/{csv\|text\|link}` | 단일 페르소나 export |
| GET | `/api/export/full-report?market=&days=&format=zip\|md\|json` | 전체 리포트 (Claude 분석용 ZIP) |
| GET | `/api/calendar?market=&days=` | 일자별 거래/PnL/페르소나 |
| GET | `/api/improve/summary?market=&days=` | 자가개선 통합 요약 |

---

## 자주 쓰는 명령

```bash
# 5개 프로세스 시작/종료/상태
~/trading-dashboard/start-all.sh
~/trading-dashboard/stop-all.sh
~/trading-dashboard/status.sh

# 사이트 배포
cp index.html persona_analytics.html persona_settings.html ~/trading-dashboard-public/
cd ~/trading-dashboard-public && git add -A && git commit -m '...' && git push origin main

# 봇 control API
curl -X POST http://127.0.0.1:9001/mode/run     # 코인봇 시작
curl -X POST http://127.0.0.1:9002/trade/demo   # 주식봇 DEMO 전환
curl    http://127.0.0.1:9001/health             # 코인봇 상태

# system_api 재시작
ps -ef | grep "uvicorn system_api" | grep -v grep | awk '{print $2}' | xargs kill -9
nohup ./venv/bin/python -m uvicorn system_api:app --host 127.0.0.1 --port 9000 \
  >> logs/system-api.log 2>&1 &

# 강제 status export
~/coinbot/venv/bin/python -m scripts.export_status
"/Users/600mac/Desktop/주식 자동봇/venv/bin/python" "/Users/600mac/Desktop/주식 자동봇/run.py" status
```

---

## 디버깅

| 증상 | 원인 / 해결 |
|---|---|
| KOSPI/KOSDAQ value=NaN | yfinance 장 마감 후 NaN → `_last_valid_close` + 디스크 캐시 fallback (적용됨) |
| Firestore push 실패 (`nan compliant`) | `_to_fs_value` NaN→null 가드 (적용됨) |
| 외부 모바일 시장 빈셀 | bridge가 `persona_by_market` push 안 함 → bridge 재시작 |
| persona 비중 저장 405 (외부) | github.io는 정적 → Firestore `trading_commands` 컬렉션 발행 → bridge가 system_api 호출 (적용됨) |
| 페르소나 카드 더미값 잠깐 노출 | HTML 정적 더미 → 스켈레톤 교체 완료 |

---

## 명세 / 가이드 (`_reference/`)

| 파일 | 내용 |
|---|---|
| `페르소나_설정_통합가이드.md` | persona_settings.html 사양 |
| `페르소나_통합분석_명세서.md` | persona_analytics.html + analytics endpoint 사양 |
| `전체_리포트_내보내기_명세서.md` | full-report ZIP/MD/JSON export 사양 |

봇 본체 사양은 `~/Desktop/주식 자동봇/MASTER_SPEC_v2.md` (4 페르소나, Phase 1~4) + `~/Desktop/주식 자동봇/MOBILE_UX_SPEC.md` (모바일 분기 명세).

---

## 페르소나 시스템 (Master Spec v2 §1)

| 페르소나 | 역할 | 시간 캡 | 손절 |
|---|---|---:|---:|
| 단타맨 ⚡ | 당일 청산 회전 | 4h | -1.0% |
| 스윙맨 🛡 | 1~5일 한방 스윙 | 5d | -1.5% |
| 쿨마봇 🚀 | Qullamaggie 정통 EP | 30d | low_of_day |
| 존버맨 🌳 | 안전 자산 천천히 | 14d | -2.0% |

**기본 비중** (시장별 분리): 쿨마봇 35% / 스윙맨 30% / 단타맨 25% / 존버맨 10%
**일 변경 한도**: 3회 / 페르소나 5~60% / 합계 100% 강제 (절대룰)

---

## 절대 룰 (Master Spec v2 §12 — auto_tune 못 건드림)

```
STOP_LOSS = -0.015 / EMERGENCY_STOP = -0.030
DAILY_LOSS_LIMIT = -0.03 / BALANCE_DROP_20 = True
LLM 파싱 실패 → 진입 차단
주말 KR 강제 청산 / US 04:50 강제 청산
WEIGHT_CHANGE_DAILY_LIMIT = 3
WEIGHT_PERSONA_RANGE = [5, 60]
WEIGHT_TOTAL_REQUIRED = 100
```

---

## 보안

`config.json` (KIS/Upbit 키 + 텔레그램 토큰), `firebase-config.json`, `data/*.db`, `logs/`, `pids/` 모두 `.gitignore`. **절대 commit 금지**.
