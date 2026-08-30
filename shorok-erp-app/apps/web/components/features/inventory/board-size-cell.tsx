"use client";

import { classifyBoardSize, type BoardSize } from "@shorok/shared";
import { Badge } from "../../ui/badge";
import type { AppLocale } from "../../../i18n";

/**
 * How a board size looks everywhere it appears.
 *
 * كبير and صغير are the two standard boards; anything else was cut for a
 * particular job. The class is what a person reads at a glance, but the
 * measurement has to stay next to it — «م ق» on its own says a board was
 * unusual without saying which board, and 3.4375 m and 3.75 m are different
 * things to have in stock.
 *
 * One component rather than a cell written per screen, so the movements list,
 * the stock table and the compact previews cannot drift into three slightly
 * different ideas of what كبير looks like. The classification itself comes from
 * the shared helper; nothing here decides it.
 */

const VARIANT: Record<BoardSize["kind"], "info" | "success" | "warning"> = {
  BIG: "info",
  SMALL: "success",
  CUSTOM: "warning",
};

interface Props {
  /**
   * The classification the API already derived, when the caller has it, or a
   * raw `sizeMetersPerBoard` to classify here. Both routes end in the same
   * shared helper.
   */
  boardSize?: BoardSize | null;
  sizeMetersPerBoard?: string | number | null;
  locale: AppLocale;
  className?: string;
}

export function BoardSizeCell({ boardSize, sizeMetersPerBoard, locale, className }: Props) {
  const size = boardSize ?? classifyBoardSize(sizeMetersPerBoard);
  const ar = locale === "ar";
  return (
    <span
      dir="ltr"
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className ?? ""}`}
      title={ar ? size.longAr : size.longEn}
    >
      <Badge variant={VARIANT[size.kind]}>{ar ? size.shortAr : size.shortEn}</Badge>
      <span>
        {size.meters} {ar ? "م" : "m"}
      </span>
    </span>
  );
}
