# 🦊 Pixymon

**크립토 마켓 인텔 AI 에이전트**

실시간 블록체인 뉴스 분석 및 마켓 데이터를 기반으로 트위터에서 자동으로 인사이트를 공유하는 AI 에이전트입니다.

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![Claude](https://img.shields.io/badge/AI-Claude-blueviolet)](https://anthropic.com)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ✨ 주요 기능

### 📊 24/7 마켓 브리핑
- 매일 오전 9시 모닝 브리핑 자동 발행
- 3시간마다 마켓 업데이트 포스팅
- 실시간 데이터: BTC/ETH 가격, Fear & Greed Index, 시총, BTC 도미넌스

### 💬 멘션 자동 응답
- `@Pixy_mon` 멘션 시 AI가 자동 답변
- 한국어 질문 → 한국어 답변
- 영어 질문 → 영어 답변
- 중복 답글 방지 시스템

### 🔍 실시간 데이터 소스
| 소스 | 데이터 |
|------|--------|
| CoinGecko | 트렌딩 코인, 마켓 데이터 |
| CryptoCompare | 핫 뉴스 |
| Alternative.me | Fear & Greed Index |
| Twitter | 50+ 인플루언서 모니터링 |

### 🎯 인플루언서 추적 (50+)
- **창립자/CEO**: Vitalik, Saylor, CZ, Elon Musk
- **투자자/애널리스트**: Arthur Hayes, Raoul Pal, Cathie Wood
- **온체인/데이터**: Lookonchain, Willy Woo, Nic Carter
- **트레이더**: Ansem, DonAlt, Kaleo, Credible Crypto
- **AI 에이전트**: aixbt_agent

---

## 🤖 스타일

Pixymon은 **aixbt 스타일**의 팩트 기반 분석을 제공합니다:

```
$BTC 89.5k, 24h -1.2%. $ETH는 더 약함 -3.1%. 
도미넌스 57.5%면 알트 시즌 아직 멀었음

by Pixymon
```

**특징:**
- 숫자 먼저, 해석은 짧게
- `$BTC`, `$ETH` 티커 형식
- 해시태그/이모지 최소화
- 자연스러운 한국어 + 영어 크립토 용어
- 숨은 유머 (김프, 러그풀, 횡보 등)

---

## 🚀 실행 모드

### 일회성 실행
```bash
npm run dev
```

### 24/7 스케줄러 모드
```bash
# Windows PowerShell
$env:SCHEDULER_MODE="true"; npm run dev

# Mac/Linux
SCHEDULER_MODE=true npm run dev
```

**스케줄:**
| 시간 | 작업 |
|------|------|
| 09:00 | 모닝 브리핑 |
| 0, 3, 6, 12, 15, 18, 21시 | 마켓 업데이트 |
| 1, 4, 7, 10, 13, 16, 19, 22시 | 멘션 체크 |

---

## 🛠️ 설치

```bash
git clone https://github.com/starlash7/Pixymon.git
cd Pixymon
npm install
```

### 환경 변수 (.env)

```env
# 필수 - Anthropic Claude
ANTHROPIC_API_KEY=your_anthropic_api_key

# 필수 - Twitter API
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_SECRET=your_twitter_access_secret

# 선택
TEST_MODE=false        # true면 트윗 발행 안 함
SCHEDULER_MODE=false   # true면 24/7 스케줄러 모드
```

---

## 📁 구조

```
pixymon/
├── src/
│   ├── index.ts                 # 메인 (스케줄러, 포스팅, 멘션)
│   ├── character.ts             # 캐릭터 정의
│   └── services/
│       └── blockchain-news.ts   # 뉴스/마켓 데이터 수집
├── .env                         # 환경 변수
├── package.json
└── tsconfig.json
```

---

## 📝 로드맵

- [x] 실시간 마켓 데이터
- [x] 24/7 자동 스케줄러
- [x] 멘션 자동 응답
- [x] 다국어 지원 (한/영)
- [x] 인플루언서 모니터링
- [ ] 온체인 데이터 분석
- [ ] 텔레그램/디스코드 연동
- [ ] 웹 대시보드

---

## ⚠️ 주의사항

- **NFA (Not Financial Advice)**: 투자 조언이 아닙니다
- **정보 검증 필요**: AI 생성 콘텐츠는 항상 검증하세요
- **API 제한**: Twitter/Anthropic API 사용량 확인

---

## 📄 라이선스

MIT License

---

**Made with 🔥 by Pixymon**
