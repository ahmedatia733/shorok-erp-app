import { Injectable } from "@nestjs/common";
import { Prisma, PrismaService } from "../../prisma/prisma.service";

type Tx = Prisma.TransactionClient;

/**
 * Resolves posting-affecting configuration "as of" a document's posting date
 * (Constitution VIII — configuration is effective-dated; posted documents are
 * never rewritten by later config changes). The rule is uniform: pick the row
 * with the greatest effective_from that is <= the posting date.
 */
@Injectable()
export class EffectiveConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** Posting profile in force on `date` (YYYY-MM-DD), or null if none yet. */
  async postingProfileAsOf(date: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.postingProfile.findFirst({
      where: { effectiveFrom: { lte: new Date(date) } },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /** Active tax profile in force on `date`, or null if none yet. */
  async taxProfileAsOf(date: string, tx?: Tx) {
    const db = tx ?? this.prisma;
    return db.taxProfile.findFirst({
      where: { effectiveFrom: { lte: new Date(date) }, active: true },
      orderBy: { effectiveFrom: "desc" },
    });
  }
}
