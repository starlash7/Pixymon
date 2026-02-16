# Pixymon

온체인 데이터를 먹고 진화하는 AI 생명체형 트위터 에이전트.

[![Twitter](https://img.shields.io/badge/Twitter-@Pixy__mon-1DA1F2?style=flat&logo=twitter)](https://twitter.com/Pixy_mon)
[![AI](https://img.shields.io/badge/LLM-Claude-blue)](https://www.anthropic.com/)

<p align="center">
  <img src="./docs/assets/pixymon-sprite.jpg" alt="Pixymon sprite sheet" width="720" />
</p>

## Latest Status

- Last updated: 2026-02-16 (KST)
- Runtime: Node.js + TypeScript
- LLM: `claude-sonnet-4-5-20250929`
- Default branch: `main`

## What It Does

1. Mention auto-reply
- Detects `@Pixy_mon` mentions and generates contextual replies.
- Stores follower interaction context in local memory.

2. Proactive engagement
- Periodically comments on influencer tweets.
- Daily cap + duplicate prevention logic enabled.

3. Scheduler mode
- Runs mention check every 3 hours.
- Runs proactive engagement every 3 hours (30m offset).
- Briefing auto-posting is currently disabled in runtime entrypoint.

4. Memory system
- Persists tweets, predictions, followers, and mention cursor in `data/memory.json`.

## Data Sources

- CoinGecko (market/trending)
- CryptoCompare (news)
- Alternative.me (Fear & Greed)
- Twitter API v2

## Run

```bash
npm ci
npm run dev
```

Scheduler mode:

```bash
SCHEDULER_MODE=true npm run dev
```

Test mode (no real post):

```bash
TEST_MODE=true npm run dev
```

## Environment Variables

```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here

TWITTER_API_KEY=your_twitter_api_key_here
TWITTER_API_SECRET=your_twitter_api_secret_here
TWITTER_ACCESS_TOKEN=your_twitter_access_token_here
TWITTER_ACCESS_SECRET=your_twitter_access_secret_here
TWITTER_USERNAME=Pixy_mon

TEST_MODE=true
SCHEDULER_MODE=false
NODE_ENV=development
LOG_LEVEL=info
```

## Project Structure

```text
src/
├── index.ts
├── character.ts
├── config/
│   └── influencers.ts
├── services/
│   ├── blockchain-news.ts
│   ├── briefing.ts
│   ├── engagement.ts
│   ├── llm.ts
│   ├── memory.ts
│   ├── onchain-data.ts
│   ├── reflection.ts
│   ├── research-engine.ts
│   └── twitter.ts
├── types/
│   ├── agent.ts
│   └── index.ts
└── utils/
    └── mood.ts
```

## Team Workflow

- Multi-workspace / branch workflow: `docs/agent-workflow.md`

## Build

```bash
npm run build
```

NFA: 투자 조언이 아니며, AI 생성 결과는 검증이 필요합니다.
