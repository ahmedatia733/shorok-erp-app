import { Decimal } from "decimal.js";

/**
 * Turns a variant's stored board size into the badge a storekeeper recognises:
 * «ك» for the standard 5.25 m board, «ص» for the standard 4.00 m board, and
 * «م/خ» for anything else.
 *
 * The badge is a *label*, not an identity. Stock identity in this system is
 * (Branch, ProductVariant) and nothing else, so nothing here is ever stored:
 * every value is derived at read time from `ProductVariant.sizeMetersPerBoard`,
 * which is the only dimension a variant actually has. Two variants that both
 * show «م/خ» are still two different variants and must stay apart.
 *
 * The comparison is exact-Decimal on purpose. `Number("5.25") === 5.25` happens
 * to hold, but the moment a size is stored as 5.2500 and compared after any
 * arithmetic that equality stops being trustworthy, and a board of the wrong
 * size would be labelled as standard. Decimal.equals() has no such failure mode.
 */

/** The two sizes the business treats as standard, as exact decimals. */
export const LARGE_BOARD_METRES = new Decimal("5.25");
export const SMALL_BOARD_METRES = new Decimal("4");

export type TransferSizeBadge = "LARGE" | "SMALL" | "CUSTOM";

export interface TransferSizeDisplay {
  badge: TransferSizeBadge;
  badgeAr: string;
  badgeEn: string;
  /** «5.25 م» / «3.00 × 3.00 م» — dimensions only, no badge. */
  dimensionsLabelAr: string;
  dimensionsLabelEn: string;
  /** «ك — 5.25 م» — the full card label. */
  labelAr: string;
  labelEn: string;
  boardSizeMeters: string;
  /** Null unless a width is genuinely stored — never invented. */
  widthMeters: string | null;
}

const BADGE_AR: Record<TransferSizeBadge, string> = {
  LARGE: "ك",
  SMALL: "ص",
  CUSTOM: "م/خ",
};

const BADGE_EN: Record<TransferSizeBadge, string> = {
  LARGE: "Large",
  SMALL: "Small",
  CUSTOM: "Special",
};

export class SizeClassificationError extends Error {
  constructor(readonly code: "size_missing" | "size_invalid" | "size_not_positive") {
    super(code);
    this.name = "SizeClassificationError";
  }
}

/**
 * Parses a stored size without ever letting a raw DecimalError escape — an
 * unusable size must be reported as "this option is blocked", not as a crash.
 */
function toSize(raw: Decimal | string | number | null | undefined): Decimal {
  if (raw === null || raw === undefined || raw === "") {
    throw new SizeClassificationError("size_missing");
  }
  let value: Decimal;
  try {
    value = new Decimal(raw as Decimal.Value);
  } catch {
    throw new SizeClassificationError("size_invalid");
  }
  if (!value.isFinite()) throw new SizeClassificationError("size_invalid");
  if (value.lte(0)) throw new SizeClassificationError("size_not_positive");
  return value;
}

/**
 * The classification itself.
 *
 * `5.25`, `5.2500` and `5.25000` are the same number and all classify as ك;
 * `4`, `4.0` and `4.0000` all classify as ص. Everything else positive is م/خ.
 */
export function classifyBoardSize(raw: Decimal | string | number | null | undefined): TransferSizeBadge {
  const size = toSize(raw);
  if (size.equals(LARGE_BOARD_METRES)) return "LARGE";
  if (size.equals(SMALL_BOARD_METRES)) return "SMALL";
  return "CUSTOM";
}

/** Two decimal places is how sizes are written on the shop floor: 5.25, 4.00. */
const dp2 = (v: Decimal): string => v.toFixed(2);

/**
 * Builds the display model for one variant.
 *
 * `widthMeters` exists in the signature because the formatter is also used for
 * genuinely two-dimensional stock, but a ProductVariant stores exactly one
 * dimension (`sizeMetersPerBoard`), so the transfer path always passes null. A
 * second dimension is never fabricated to make a label look richer.
 */
export function classifyTransferSizeOption(input: {
  sizeMetersPerBoard: Decimal | string | number | null | undefined;
  widthMeters?: Decimal | string | number | null;
}): TransferSizeDisplay {
  const size = toSize(input.sizeMetersPerBoard);
  const badge = classifyBoardSize(size);

  let width: Decimal | null = null;
  if (input.widthMeters !== null && input.widthMeters !== undefined && input.widthMeters !== "") {
    const parsed = new Decimal(input.widthMeters as Decimal.Value);
    // A zero or negative width is not a dimension; treat it as absent rather
    // than printing "5.25 × 0.00 م".
    if (parsed.isFinite() && parsed.gt(0)) width = parsed;
  }

  const dimensionsLabelAr = width ? `${dp2(size)} × ${dp2(width)} م` : `${dp2(size)} م`;
  const dimensionsLabelEn = width ? `${dp2(size)} × ${dp2(width)} m` : `${dp2(size)} m`;

  return {
    badge,
    badgeAr: BADGE_AR[badge],
    badgeEn: BADGE_EN[badge],
    dimensionsLabelAr,
    dimensionsLabelEn,
    labelAr: `${BADGE_AR[badge]} — ${dimensionsLabelAr}`,
    labelEn: `${BADGE_EN[badge]} — ${dimensionsLabelEn}`,
    boardSizeMeters: size.toFixed(4),
    widthMeters: width ? width.toFixed(4) : null,
  };
}

/** Non-throwing variant for list building: an unusable size yields null. */
export function tryClassifyTransferSizeOption(input: {
  sizeMetersPerBoard: Decimal | string | number | null | undefined;
  widthMeters?: Decimal | string | number | null;
}): TransferSizeDisplay | null {
  try {
    return classifyTransferSizeOption(input);
  } catch (e) {
    if (e instanceof SizeClassificationError) return null;
    throw e;
  }
}

// ── source availability (shared by the size picker and the product picker) ──

export interface SourceAvailabilityVerdict {
  enabled: boolean;
  disabledReason: string | null;
  disabledReasonAr: string | null;
}

/**
 * Whether one variant can be transferred out of one branch right now.
 *
 * This is the single definition of "available in the source warehouse". The
 * size cards ask it per variant; the product picker asks it for every variant
 * of a product and shows the product when any answer is yes. Keeping it in one
 * function is the point: if the two screens ever disagreed, the picker would
 * offer a product whose every size then turned out to be greyed out, which is
 * exactly the confusion this feature exists to remove.
 *
 * An inconsistent balance is reported, never repaired, and never satisfied from
 * a sibling variant.
 */
export function decideSourceAvailability(input: {
  variantActive: boolean;
  boards: Decimal;
  metres: Decimal;
}): SourceAvailabilityVerdict {
  if (!input.variantActive) {
    return { enabled: false, disabledReason: "VARIANT_INACTIVE", disabledReasonAr: "هذا المقاس غير نشط." };
  }
  if (input.boards.isZero() !== input.metres.isZero()) {
    return {
      enabled: false,
      disabledReason: "SOURCE_BALANCE_INCONSISTENT",
      disabledReasonAr: "الرصيد يحتاج مراجعة قبل التحويل",
    };
  }
  if (input.boards.lte(0) || input.metres.lte(0)) {
    return {
      enabled: false,
      disabledReason: "SOURCE_SIZE_OPTION_UNAVAILABLE",
      disabledReasonAr: "غير متاح في المخزن المحدد",
    };
  }
  return { enabled: true, disabledReason: null, disabledReasonAr: null };
}
