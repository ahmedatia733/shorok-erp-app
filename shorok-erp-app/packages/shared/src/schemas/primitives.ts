import { z } from "zod";

/**
 * Decimal-as-string schema. Money columns are NUMERIC; we serialize them as
 * strings on the wire to preserve full precision (no float rounding).
 * Pattern matches signed/unsigned integers and decimals.
 */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, { message: "must be a decimal string like '12.34'" });

export const UuidSchema = z.string().uuid();
export const IsoDateSchema = z.string().date();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** E.164 phone format, e.g. "+201234567890". Validation is liberal here;
 *  the API normalizes via libphonenumber-js with default country EG. */
export const PhoneE164Schema = z
  .string()
  .regex(/^\+?[1-9]\d{6,14}$/, { message: "must be a valid phone number" });
