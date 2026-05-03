import parsePhoneNumber from "libphonenumber-js";

/**
 * Normalize a user-supplied phone string to E.164. Uses Egypt as the default
 * country when the input lacks a leading `+`. Returns null when the input
 * cannot be parsed as a valid phone number.
 */
export function normalizePhoneE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumber(trimmed, "EG");
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number;
  } catch {
    return null;
  }
}
