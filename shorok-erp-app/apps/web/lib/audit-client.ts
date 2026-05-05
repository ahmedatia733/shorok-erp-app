"use client";

import type { AuditLog } from "@shorok/shared";
import { apiCall } from "./api-client";

export interface AuditPage {
  data: AuditLog[];
  nextCursor: string | null;
}

export interface AuditFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}

export const listAudit = (f: AuditFilters) => {
  const params = new URLSearchParams();
  params.set("limit", String(f.limit ?? 20));
  if (f.entityType) params.set("entityType", f.entityType);
  if (f.entityId) params.set("entityId", f.entityId);
  if (f.actorId) params.set("actorId", f.actorId);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.cursor) params.set("cursor", f.cursor);
  return apiCall<AuditPage>(`/audit?${params.toString()}`);
};
