import { Injectable } from "@nestjs/common";
// Value imports, NOT `import type`: Nest reads these classes from the emitted
// decorator metadata to resolve the constructor, and a type-only import is
// erased at compile time — the code would compile and then fail to inject.
// The rule is disabled here so `eslint --fix` cannot silently reintroduce it.
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Prisma, PrismaService } from "../../prisma/prisma.service";
/* eslint-enable @typescript-eslint/consistent-type-imports */
import { ValidationError } from "../../common/errors/api-errors";

type Tx = Prisma.TransactionClient;

export interface ResolvedPostingDate {
  /** The commercial date of the revised document — always preserved as-is. */
  documentDate: string;
  /** Where the reversal and the replacement actually post. */
  postingDate: string;
  /** True when the document date's own period could not take the entries. */
  crossesClosedPeriod: boolean;
  /** Arabic explanation, shown in the preview whenever the two dates differ. */
  noteAr: string | null;
}

/**
 * Where a revision's accounting lands.
 *
 * A closed month is closed. The revision never reopens it, never edits an entry
 * inside it and never back-dates into it — it posts the correction into the
 * first period that will actually accept it, while the documents keep their own
 * commercial dates. Both dates are recorded on the revision row so the trail
 * shows the difference rather than hiding it.
 */
@Injectable()
export class PostingPeriodService {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: Tx) {
    return tx ?? this.prisma;
  }

  /**
   * @param documentDate  the revised invoice date (yyyy-mm-dd)
   * @param originalDate  the date the currently effective version posted on
   */
  async resolve(documentDate: string, originalDate: string, tx?: Tx): Promise<ResolvedPostingDate> {
    const db = this.db(tx);
    const periods = await db.financialPeriod.findMany({
      select: { year: true, month: true, status: true },
      orderBy: [{ year: "asc" }, { month: "asc" }],
    });
    const key = (y: number, m: number) => y * 100 + m;
    const byKey = new Map(periods.map((p) => [key(p.year, p.month), p.status]));

    const docKey = keyOf(documentDate);
    const origKey = keyOf(originalDate);

    // Both halves of the correction must land in one open period, otherwise the
    // reversal and the replacement would straddle a boundary and neither the
    // trial balance nor the month-end comparison would tie out. The candidate
    // must therefore be open AND not earlier than either document.
    const docOpen = byKey.get(docKey) === "OPEN";
    const origOpen = byKey.get(origKey) === "OPEN";

    if (docOpen && origOpen) {
      const chosen = docKey >= origKey ? documentDate : originalDate;
      return {
        documentDate,
        postingDate: normalise(chosen),
        crossesClosedPeriod: false,
        noteAr: null,
      };
    }

    const minKey = Math.max(docKey, origKey);
    const candidate = periods.find((p) => key(p.year, p.month) >= minKey && p.status === "OPEN");
    if (!candidate) {
      throw new ValidationError({
        reason: "no_open_posting_period",
        documentDate,
        originalPostingDate: originalDate,
      });
    }

    const postingDate = firstDayOf(candidate.year, candidate.month);
    const blockedYear = Math.floor(minKey / 100);
    const blockedMonth = minKey % 100;
    return {
      documentDate,
      postingDate,
      crossesClosedPeriod: true,
      noteAr:
        `الفترة المحاسبية ${blockedYear}/${String(blockedMonth).padStart(2, "0")} ` +
        `مقفلة أو غير مفتوحة، لذلك سيتم ترحيل قيود العكس وإعادة الترحيل في ` +
        `${candidate.year}/${String(candidate.month).padStart(2, "0")} مع الاحتفاظ بتاريخ الفاتورة كما هو.`,
    };
  }
}

function keyOf(isoDate: string): number {
  const [y, m] = isoDate.split("-");
  return Number(y) * 100 + Number(m);
}

function normalise(isoDate: string): string {
  return isoDate.slice(0, 10);
}

function firstDayOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
