import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Single shared PrismaClient. Every command handler that mutates state MUST
 * run inside `this.runInTransaction(...)` so that domain writes and the
 * AuditLog row commit atomically (Constitution Principle III).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside a Prisma interactive transaction. The callback receives
   * a transactional client; everything done with that client commits or
   * rolls back together. AuditService.write must be called with this same
   * `tx` instance (never with the root prisma client).
   */
  runInTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(fn, {
      timeout: options?.timeoutMs ?? 10_000,
      isolationLevel: "ReadCommitted",
    });
  }
}

// Re-export the Prisma namespace so callers don't need a second import.
import { Prisma } from "@prisma/client";
export { Prisma };
