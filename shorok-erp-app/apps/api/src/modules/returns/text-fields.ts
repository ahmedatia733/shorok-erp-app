/**
 * Explicit update semantics for the optional free-text columns on returns
 * (header reason/notes and per-line reason/note).
 *
 * The old `value ?? undefined` pattern made a stored value impossible to CLEAR,
 * because `undefined` means "don't touch this column" in Prisma. These helpers
 * separate the three intents:
 *
 *   patchText  (PUT / partial update)
 *     undefined        → undefined  → property omitted, PRESERVE what is stored
 *     "" / whitespace  → null       → deliberately cleared
 *     non-empty        → trimmed    → stored trimmed
 *
 *   newText    (CREATE, and the line rows that update/confirm recreate)
 *     undefined / "" / whitespace → null
 *     non-empty                   → trimmed
 */
export const patchText = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : (v ?? "").trim() || null;

export const newText = (v: string | null | undefined): string | null =>
  (v ?? "").trim() || null;

/**
 * Resolve a per-line text field when a draft is updated by delete-and-recreate.
 * Lines are physically replaced, so "preserve" must copy the PRIOR stored value:
 *   req omitted (undefined) → the existing line's stored value (or null if new)
 *   req empty / whitespace  → null (deliberate clear)
 *   req non-empty           → trimmed
 */
export const resolveLineText = (
  reqValue: string | null | undefined,
  existingValue: string | null | undefined,
): string | null =>
  reqValue === undefined ? (existingValue ?? null) : newText(reqValue);
