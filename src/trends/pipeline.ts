import type { XClient } from "../channels/x/client.js"
import { buildSearchQueries } from "./queryBuilder.js"
import { annotateWithGlobalTrends } from "./globalContext.js"
import { extractPainPointSignals } from "./painPoints.js"
import { classifyMomentum } from "./recommendation.js"
import { scoreTrends } from "./scorer.js"
import { filterSpamAndDuplicates } from "./spamFilter.js"
import { NoSignalsError } from "./types.js"
import type { TrendAnalysisResult, TrendSource, TrendSourceInput } from "./types.js"

export type TrendPipelineDeps = {
  trendSources: TrendSource[]
  xClient: XClient
  now?: Date
  annotateGlobalTrends?: boolean
}

export const runTrendPipeline = async (
  input: TrendSourceInput,
  deps: TrendPipelineDeps,
): Promise<TrendAnalysisResult> => {
  const now = deps.now ?? new Date()

  const results = await Promise.all(deps.trendSources.map((source) => source.fetchSignals(input)))
  const merged = results.flat()

  const filtered = filterSpamAndDuplicates(merged)
  if (filtered.length === 0) {
    throw new NoSignalsError()
  }

  let trendingTopics = scoreTrends(filtered, now)
  if (deps.annotateGlobalTrends !== false) {
    trendingTopics = await annotateWithGlobalTrends(trendingTopics, deps.xClient)
  }

  const painPointSignals = extractPainPointSignals(filtered)
  const recommendation = classifyMomentum(trendingTopics)

  return {
    query: {
      niche: input.niche,
      keywords: input.keywords,
      searchQueriesUsed: buildSearchQueries(input),
    },
    trendingTopics,
    painPointSignals,
    recommendation,
  }
}
