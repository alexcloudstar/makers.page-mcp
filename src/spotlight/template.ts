import type { Supporter } from "./types.js"

const formatDisplayDate = (dateKey: string): string =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${dateKey}T00:00:00.000Z`),
  )

/** A fixed, non-AI template — deterministic wording, only the date and @mentions vary. */
export const buildDefaultSpotlightPost = (dateKey: string, supporters: Supporter[]): string => {
  const mentions = supporters.map((supporter) => `@${supporter.username}`).join("\n")
  return `Want more visibility on X? Start engaging 👀

Starting today, I'll be posting a daily Supporter Spotlight featuring people who liked and replied to my posts.

Yesterday's supporters (${formatDisplayDate(dateKey)}):

${mentions}

No ads. No paid placements.

Just giving back to the people supporting the journey 🚀`
}
