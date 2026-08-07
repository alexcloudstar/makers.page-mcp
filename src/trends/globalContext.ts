import type { XClient } from "../channels/x/client.js"
import type { TrendingTopic } from "./types.js"

const WORLDWIDE_WOEID = 1
const MAX_GLOBAL_TRENDS = 50

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()

/**
 * Best-effort enrichment: flags topics that are also on X's worldwide trending list.
 * Never fatal, since GET /2/trends/by/woeid is optional secondary context, not the
 * mechanism that finds niche-specific trends (that's Recent Search, see xSource.ts).
 */
export const annotateWithGlobalTrends = async (
  topics: TrendingTopic[],
  xClient: XClient,
): Promise<TrendingTopic[]> => {
  if (topics.length === 0) return topics

  let globalTrends: Array<{ name: string }> = []
  try {
    globalTrends = await xClient.getTrendsByWoeid(WORLDWIDE_WOEID, MAX_GLOBAL_TRENDS)
  } catch {
    return topics
  }

  const globalNormalized = new Set(globalTrends.map((trend) => normalize(trend.name)))
  if (globalNormalized.size === 0) return topics

  return topics.map((topic) => ({
    ...topic,
    alsoTrendingGlobally: globalNormalized.has(normalize(topic.topic)),
  }))
}
