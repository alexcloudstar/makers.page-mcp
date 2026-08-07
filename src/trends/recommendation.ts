import type { Recommendation, TrendingTopic } from "./types.js"

export const classifyMomentum = (topics: TrendingTopic[]): Recommendation => {
  const top = topics[0]

  if (!top) {
    return {
      urgency: "later",
      reason: "No strong trending topic was found for this niche right now. Broaden your keywords or check back later.",
    }
  }

  if (top.growth === "exploding" && top.confidence >= 50) {
    return {
      urgency: "post_now",
      reason: `"${top.topic}" is exploding in your niche right now (score ${top.score}/100, confidence ${top.confidence}%). Post while the conversation is hot.`,
    }
  }

  if (top.growth === "rising" || top.growth === "exploding") {
    return {
      urgency: "today",
      reason: `"${top.topic}" is ${top.growth} (score ${top.score}/100, confidence ${top.confidence}%). Worth posting today while it's still gaining traction.`,
    }
  }

  return {
    urgency: "later",
    reason: `The top topic "${top.topic}" is ${top.growth}. No urgent window right now, plan the post for later.`,
  }
}
