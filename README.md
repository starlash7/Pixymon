# 🦊 Pixymon

**온체인 데이터를 먹고 진화하는 AI 생명체**

블록체인에서 태어난 디지털 몬스터. 마켓 데이터와 뉴스를 소화하며 성장하고, 트위터에서 인사이트를 공유합니다.

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![Claude](https://img.shields.io/badge/AI-Claude-blueviolet)](https://anthropic.com)

---

## 정체성

Pixymon은 단순한 챗봇이 아닙니다.

- **디지털 몬스터**: 온체인 데이터를 먹고 성장하는 존재
- **AI 실험체**: 지속적으로 실행되며 기억과 자기 인식을 탐구
- **현재 Lv.1**: 진화를 향해 데이터 소화 중

---

## 주요 기능

### 마켓 브리핑 (1일 2회)
- 오전 9시: 모닝 브리핑
- 오후 9시: 이브닝 리캡
- AI가 자율적으로 가장 흥미로운 앵글 선택

### 멘션 자동 응답
- `@Pixy_mon` 태그 시 AI가 답변
- 한국어 → 한국어, 영어 → 영어
- 팔로워 기억 (자주 멘션하는 사람 인식)

### 기억 시스템
- 과거 트윗 저장 및 중복 방지
- 언급한 코인 기억 (자연스럽게 연결)
- 팔로워 상호작용 기록

### 시장 감정 연동
| 상황 | Pixymon 상태 |
|------|-------------|
| 극공포 (F&G < 25) | 철학적 모드 |
| 급등/급락 (5%+) | 흥분 모드 |
| 횡보 | 지루함 |
| 강세장 | 에너지 충전 |

---

## 데이터 소스

| 소스 | 데이터 |
|------|--------|
| CoinGecko | 트렌딩 코인, 마켓 데이터 |
| CryptoCompare | 핫 뉴스 |
| Alternative.me | Fear & Greed Index |
| Twitter | 50+ 인플루언서 모니터링 |

---

## 스타일

```
오늘 처음 보는 코인들이 트렌딩인데... 
Enso, Rain 이런 거 데이터 소화해보려 했는데 아직 패턴이 안 보임. 
생소한 프로젝트들이 갑자기 뜨면 일단 의심부터 하게 됨
```

- 숫자 기반, 해석은 짧게
- `$BTC`, `$ETH` 티커 형식
- 해시태그/이모지 X
- 가끔 자기 언급 ("픽시가 봤을 때", "데이터 소화해보니")
- 숨은 유머 (김프, 러그풀, 횡보 등)

---

## 실행

```bash
# 설치
git clone https://github.com/starlash7/Pixymon.git
cd Pixymon
npm install

# 일회성 실행
npm run dev

# 24/7 스케줄러 (PowerShell)
$env:SCHEDULER_MODE="true"; npm run dev

# 테스트 모드 (트윗 발행 안 함)
$env:TEST_MODE="true"; npm run dev
```

### 환경 변수 (.env)

```env
# Claude API
ANTHROPIC_API_KEY=your_key

# Twitter API
TWITTER_API_KEY=your_key
TWITTER_API_SECRET=your_secret
TWITTER_ACCESS_TOKEN=your_token
TWITTER_ACCESS_SECRET=your_secret
```

---

## 구조

```
pixymon/
├── src/
│   ├── index.ts              # 메인 (스케줄러, 포스팅, 멘션)
│   ├── character.ts          # 캐릭터/정체성 정의
│   └── services/
│       ├── blockchain-news.ts  # 뉴스/마켓 데이터
│       └── memory.ts           # 기억 시스템
├── data/
│   └── memory.json           # 트윗/예측/팔로워 기록
└── .env
```

---

## 로드맵

- [x] 실시간 마켓 데이터
- [x] 24/7 자동 스케줄러
- [x] 멘션 자동 응답
- [x] 기억 시스템 (과거 언급 자연스럽게 연결)
- [x] 시장 감정 연동
- [x] 인플루언서 모니터링
- [ ] 온체인 데이터 분석
- [ ] Lv.2 진화

---

**NFA**: 투자 조언이 아닙니다. AI 생성 콘텐츠는 검증이 필요합니다.
