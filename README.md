# 두근 트레이딩 통합 대시보드

코인봇 + 주식봇 통합 모니터링 + 컨트롤 대시보드.

## 모드

- **로컬** (`http://127.0.0.1:9000`): 봇 API 직접 호출
- **외부** (이 GitHub Pages URL): Firebase Firestore 통한 실시간 동기화 + 컨트롤

## 작동 조건

- 집 Mac에서 봇 + Firebase Bridge 가동 중이어야 함
- Firestore 보안 규칙에 `trading_status`, `trading_commands` 컬렉션 허용 필요

## 컨트롤

- 운영 모드: 러닝 / 정리중지 / 완전종료
- 거래 모드: DEMO ↔ REAL 토글 (관리자 비밀번호 요구)
- 긴급청산: 보유 전량 즉시 청산
