import { Injectable } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import type { MovementType } from "@shorok/shared";

interface SummaryInputs {
  movementType: MovementType;
  /** Already-decimal-string boards delta (signed). */
  boardsDelta: string;
  metersDelta: string;
  actorName: string;
  productLabelAr: string;
  productLabelEn: string;
  branchNameAr: string;
  branchNameEn: string;
}

/**
 * Builds the AR + EN audit summaries for a single InventoryEngine action.
 * The wording is keyed by movement type and (for ADJUSTMENT/COUNT_CORRECTION)
 * the sign of the delta so messages read naturally in both locales.
 */
@Injectable()
export class InventorySummaryBuilder {
  constructor(private readonly i18n: I18nService) {}

  async build(input: SummaryInputs): Promise<{ ar: string; en: string }> {
    const key = this.keyFor(input);
    const argsAr = {
      actor: input.actorName,
      product: input.productLabelAr,
      branch: input.branchNameAr,
      boards: this.absIfNeeded(input.boardsDelta, key),
      meters: this.absIfNeeded(input.metersDelta, key),
    };
    const argsEn = { ...argsAr, product: input.productLabelEn, branch: input.branchNameEn };

    const ar = (await this.i18n.translate(`inventory.summary.${key}`, {
      lang: "ar",
      args: argsAr,
    })) as string;
    const en = (await this.i18n.translate(`inventory.summary.${key}`, {
      lang: "en",
      args: argsEn,
    })) as string;

    return { ar, en };
  }

  private keyFor(input: SummaryInputs): string {
    const isPositive = !input.boardsDelta.startsWith("-");
    switch (input.movementType) {
      case "RECEIPT":
        return "RECEIPT";
      case "SALE":
        return "SALE";
      case "ADJUSTMENT":
        return isPositive ? "ADJUSTMENT_POSITIVE" : "ADJUSTMENT_NEGATIVE";
      case "COUNT_CORRECTION":
        if (input.boardsDelta === "0.0000" || Number(input.boardsDelta) === 0) {
          return "COUNT_CORRECTION_NO_VARIANCE";
        }
        return isPositive ? "COUNT_CORRECTION_POSITIVE" : "COUNT_CORRECTION_NEGATIVE";
    }
  }

  /** Strip the leading `-` for messages that already wire the sign in copy
   *  (e.g., RECEIPT is always positive, ADJUSTMENT_NEGATIVE bakes the "-"). */
  private absIfNeeded(value: string, _key: string): string {
    return value.replace(/^-/, "");
  }
}
