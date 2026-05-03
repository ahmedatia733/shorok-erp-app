import { Injectable, NestMiddleware } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { PrismaService } from "../../prisma/prisma.service";

const HEADER = "idempotency-key";
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Implements optional `Idempotency-Key` semantics on write requests:
 *   - First request with key K + a given (method, path) is processed; the
 *     response body + status are stored hashed for 24h.
 *   - A repeat with the same K replays the stored response without invoking
 *     the handler.
 *
 * Read endpoints (GET, HEAD, OPTIONS) ignore the header.
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const key = req.header(HEADER);
    if (!key) return next();

    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      res.status(existing.statusCode).json(existing.responseBody);
      return;
    }

    // Patch res.json so we can capture the outgoing response and persist it.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const hash = createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
      void this.prisma.idempotencyKey.upsert({
        where: { key },
        create: {
          key,
          method,
          path: req.originalUrl.slice(0, 240),
          responseHash: hash,
          responseBody: body as object,
          statusCode: res.statusCode,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
        update: {
          responseHash: hash,
          responseBody: body as object,
          statusCode: res.statusCode,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      return originalJson(body);
    };

    next();
  }
}
