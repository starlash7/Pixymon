// Pixymon 감정 상태 타입
export type PixymonMood = "energized" | "calm" | "bored" | "excited" | "philosophical" | "sleepy";

// 시장 상황에 따른 Pixymon 무드 판단
export function detectMood(fearGreed?: number, priceChange24h?: number): { mood: PixymonMood; moodText: string } {
  // 극공포 (F&G < 25)
  if (fearGreed !== undefined && fearGreed < 25) {
    return {
      mood: "philosophical",
      moodText: "현재 상태: 철학적 모드. 극공포 구간이라 깊은 생각 중. 차분하고 관조적으로 말함."
    };
  }

  // 급등/급락 (24h 변화 5% 이상)
  if (priceChange24h !== undefined && Math.abs(priceChange24h) > 5) {
    return {
      mood: "excited",
      moodText: `현재 상태: 흥분 모드. ${priceChange24h > 0 ? '급등' : '급락'} 중이라 데이터 폭식 중. 활발하고 에너지 넘침.`
    };
  }

  // 강세 (F&G > 60)
  if (fearGreed !== undefined && fearGreed > 60) {
    return {
      mood: "energized",
      moodText: "현재 상태: 에너지 충전됨. 시장이 활발해서 기분 좋음. 적극적으로 말함."
    };
  }

  // 약세 (F&G 25-40)
  if (fearGreed !== undefined && fearGreed < 40) {
    return {
      mood: "calm",
      moodText: "현재 상태: 차분한 관찰 모드. 시장이 조용해서 동면 준비 중. 말이 짧아짐."
    };
  }

  // 횡보 (변화 1% 미만)
  if (priceChange24h !== undefined && Math.abs(priceChange24h) < 1) {
    return {
      mood: "bored",
      moodText: "현재 상태: 지루함. 횡보라 할 말이 없음. 아주 짧게 반응."
    };
  }

  // 기본
  return {
    mood: "calm",
    moodText: "현재 상태: 평온함. 데이터 소화하며 관찰 중."
  };
}

// 언어 감지 (간단한 휴리스틱)
export function detectLanguage(text: string): "ko" | "en" {
  const normalized = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const koreanCount = (normalized.match(/[가-힣]/g) || []).length;
  const latinCount = (normalized.match(/[A-Za-z]/g) || []).length;

  if (koreanCount >= 2) return "ko";
  if (koreanCount === 1 && latinCount <= 20) return "ko";
  return "en";
}
