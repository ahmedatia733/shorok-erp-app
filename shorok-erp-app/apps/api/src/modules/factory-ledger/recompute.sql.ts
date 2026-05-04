import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * T099 — Per-supplier `running_balance` recompute.
 *
 * Runs inside the caller's transaction. Each row's `running_balance` becomes
 * the cumulative sum of `(total_amount − paid_amount)` over all rows for
 * that supplier ordered by `(order_date, created_at, id)` — so a row that
 * is back-dated into the middle of an existing series still produces a
 * correct chronological running balance.
 *
 * Conventions:
 *   - Purchase row: total_amount > 0; paid_amount is partial-with-purchase.
 *     Net delta = total_amount − paid_amount. Positive ⇒ we owe the supplier.
 *   - Payment-only row: total_amount = 0; paid_amount > 0.
 *     Net delta = −paid_amount ⇒ balance shrinks.
 *
 * Concurrency:
 *   We take `SELECT … FOR UPDATE` on the supplier row before the recompute,
 *   so concurrent inserts on the same supplier serialize. The lock is
 *   released at end-of-tx.
 *
 * Production note:
 *   `factory_ledger_entries` is logically append-only (no in-place edits of
 *   recorded purchases or payments — corrections via new rows). The cached
 *   `running_balance` is the only column we mutate; production deployments
 *   that connect as the restricted `shorok_app` role should either move the
 *   UPDATE into a `SECURITY DEFINER` SQL function with `EXECUTE` granted
 *   to the app role, or grant UPDATE on this single column to `shorok_app`.
 *   In dev/test the migration owner has full UPDATE so the bare query is
 *   sufficient.
 */
@Injectable()
export class FactoryLedgerRecompute {
  async run(tx: Prisma.TransactionClient, supplierId: string): Promise<void> {
    // Per-supplier serialization lock: held for the rest of the tx.
    await tx.$queryRaw`
      SELECT id FROM suppliers WHERE id = ${supplierId}::uuid FOR UPDATE
    `;

    await tx.$executeRaw`
      UPDATE factory_ledger_entries f
      SET running_balance = sub.balance
      FROM (
        SELECT id,
               SUM(total_amount - paid_amount)
                 OVER (ORDER BY order_date, created_at, id) AS balance
        FROM factory_ledger_entries
        WHERE supplier_id = ${supplierId}::uuid
      ) sub
      WHERE f.id = sub.id
        AND f.supplier_id = ${supplierId}::uuid
    `;
  }
}
