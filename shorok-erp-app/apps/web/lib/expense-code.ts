/**
 * Suggesting the next expense account code.
 *
 * It only ever proposes. The field stays editable, and the server owns
 * uniqueness because an account code is unique across the whole chart of
 * accounts, not just across expenses — so a suggestion that looks free here can
 * still collide with a cash or revenue account, and the create call is what
 * settles it.
 */

/**
 * The next code in whatever pattern the chart already uses.
 *
 * The existing expense accounts run 6100, 6200, 6300…, so the obvious next code
 * is the highest of those plus the same step. Once the hundreds are used up it
 * steps by one rather than rolling into 7000, which belongs to another section.
 */
export function suggestExpenseCode(existing: string[]): string {
  const numeric = existing
    .filter((c) => /^6\d{3}$/.test(c))
    .map((c) => parseInt(c, 10))
    .sort((a, b) => a - b);
  if (numeric.length === 0) return "6100";
  const last = numeric[numeric.length - 1]!;
  const next = last % 100 === 0 ? last + 100 : last + 1;
  return next > 6999 ? String(last + 1) : String(next);
}
