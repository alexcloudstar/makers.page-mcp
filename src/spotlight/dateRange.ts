const MS_PER_DAY = 24 * 60 * 60 * 1000
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

export type DayRange = {
  dateKey: string
  startIso: string
  endIso: string
}

/** Resolves a `YYYY-MM-DD` input (or, if omitted, yesterday) to a UTC calendar-day range. */
export const resolveTargetDay = (dateInput?: string, reference: Date = new Date()): DayRange => {
  if (dateInput !== undefined) {
    if (!DATE_KEY_RE.test(dateInput)) {
      throw new Error(`Invalid date "${dateInput}"; expected YYYY-MM-DD.`)
    }
    const start = new Date(`${dateInput}T00:00:00.000Z`)
    if (Number.isNaN(start.getTime())) {
      throw new Error(`Invalid date "${dateInput}"; expected YYYY-MM-DD.`)
    }
    return { dateKey: dateInput, startIso: start.toISOString(), endIso: new Date(start.getTime() + MS_PER_DAY).toISOString() }
  }

  const todayStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()))
  const start = new Date(todayStart.getTime() - MS_PER_DAY)
  return { dateKey: start.toISOString().slice(0, 10), startIso: start.toISOString(), endIso: todayStart.toISOString() }
}
