// nflverse gives gameday (YYYY-MM-DD) + gametime (HH:MM) in US Eastern time.
// Storage is UTC (Appendix B), so convert with the US DST rule — no tz
// database needed: EDT (-4) from the second Sunday of March 02:00 to the
// first Sunday of November 02:00, EST (-5) otherwise.

function nthSundayOfMonth(year: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstSundayDate = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSundayDate + (n - 1) * 7;
}

/** Eastern-time UTC offset in hours (negative) for a local ET date/time. */
export function easternOffsetHours(year: number, month0: number, day: number, hour: number): number {
  const dstStartDay = nthSundayOfMonth(year, 2, 2); // 2nd Sunday of March
  const dstEndDay = nthSundayOfMonth(year, 10, 1); // 1st Sunday of November
  const afterStart =
    month0 > 2 || (month0 === 2 && (day > dstStartDay || (day === dstStartDay && hour >= 2)));
  const beforeEnd =
    month0 < 10 || (month0 === 10 && (day < dstEndDay || (day === dstEndDay && hour < 2)));
  return afterStart && beforeEnd ? -4 : -5;
}

/** 'YYYY-MM-DD' + 'HH:MM' Eastern → UTC ISO string. */
export function easternToUtcIso(gameday: string, gametime: string): string {
  const [y, m, d] = gameday.split('-').map(Number);
  const [hh, mm] = gametime.split(':').map(Number);
  if (!y || !m || d === undefined || hh === undefined || mm === undefined || Number.isNaN(hh)) {
    throw new Error(`bad eastern datetime: ${gameday} ${gametime}`);
  }
  const offset = easternOffsetHours(y, m - 1, d, hh);
  return new Date(Date.UTC(y, m - 1, d, hh - offset, mm)).toISOString();
}
