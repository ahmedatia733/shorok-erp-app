import { Injectable } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";

interface BaseSummaryInputs {
  actorName: string;
  customerName: string;
  branchNameAr: string;
  branchNameEn: string;
}

type SummaryKey =
  | "created"
  | "updated"
  | "confirmed"
  | "price_approved"
  | "cancelled"
  | "collection_recorded"
  | "collection_refunded";

interface BuildArgs extends BaseSummaryInputs {
  key: SummaryKey;
  /** Extra args passed straight to the i18n template (`required`, `amount`, `deviation`). */
  extra?: Record<string, string | number>;
}

/**
 * Builds AR + EN audit summaries for order-lifecycle events. The wording
 * comes from `apps/api/src/i18n/{ar,en}/orders.json` so we never store a
 * translation key in `human_readable_summary_*` (Constitution Principle IV).
 */
@Injectable()
export class OrdersSummaryBuilder {
  constructor(private readonly i18n: I18nService) {}

  async build(input: BuildArgs): Promise<{ ar: string; en: string }> {
    const argsAr = {
      actor: input.actorName,
      customer: input.customerName,
      branch: input.branchNameAr,
      ...(input.extra ?? {}),
    };
    const argsEn = {
      actor: input.actorName,
      customer: input.customerName,
      branch: input.branchNameEn,
      ...(input.extra ?? {}),
    };

    const ar = (await this.i18n.translate(`orders.summary.${input.key}`, {
      lang: "ar",
      args: argsAr,
    })) as string;
    const en = (await this.i18n.translate(`orders.summary.${input.key}`, {
      lang: "en",
      args: argsEn,
    })) as string;

    return { ar, en };
  }
}
