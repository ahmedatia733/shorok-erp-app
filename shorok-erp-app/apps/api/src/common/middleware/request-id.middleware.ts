import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Adds an `x-request-id` to every request/response (incoming if present, generated otherwise). */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header("x-request-id");
    const id = incoming && incoming.length <= 120 ? incoming : randomUUID();
    (req as Request & { id: string }).id = id;
    res.setHeader("x-request-id", id);
    next();
  }
}
