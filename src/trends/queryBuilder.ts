import type { TrendSourceInput } from "./types.js"

const MAX_QUERY_LENGTH = 500
const TERMS_PER_BROAD_QUERY = 5
const DEMAND_TERMS_LIMIT = 3
const DEMAND_PHRASES = ["looking for", "recommend", "alternative to", "how do i", "anyone know"]

const quoteTerm = (term: string): string => (/\s/.test(term) ? `"${term.replace(/"/g, "")}"` : term)

const normalizeTerms = (input: TrendSourceInput): string[] => {
  const raw = [input.niche, ...input.keywords]
  const seen = new Set<string>()
  const terms: string[] = []
  for (const value of raw) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(trimmed)
  }
  return terms
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const applyFilters = (query: string, language?: string): string => {
  const withFilters = language ? `${query} -is:retweet -is:reply lang:${language}` : `${query} -is:retweet -is:reply`
  return withFilters.length > MAX_QUERY_LENGTH ? withFilters.slice(0, MAX_QUERY_LENGTH) : withFilters
}

/**
 * Builds X Recent Search query strings scoped to the niche, so trend discovery
 * finds niche-specific conversation directly rather than waiting for a topic to
 * break into X's generic (non-niche) global trending list.
 */
export const buildSearchQueries = (input: TrendSourceInput): string[] => {
  const terms = normalizeTerms(input)
  if (terms.length === 0) return []

  const queries: string[] = []

  for (const group of chunk(terms, TERMS_PER_BROAD_QUERY)) {
    const orGroup = group.map(quoteTerm).join(" OR ")
    queries.push(applyFilters(`(${orGroup})`, input.language))
  }

  const demandTerms = terms.slice(0, DEMAND_TERMS_LIMIT).map(quoteTerm).join(" OR ")
  const demandPhraseGroup = DEMAND_PHRASES.map((phrase) => `"${phrase}"`).join(" OR ")
  queries.push(applyFilters(`(${demandTerms}) (${demandPhraseGroup})`, input.language))

  return queries
}
