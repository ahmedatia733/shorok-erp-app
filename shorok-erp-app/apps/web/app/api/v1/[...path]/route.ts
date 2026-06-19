import { NextRequest, NextResponse } from "next/server";

// Read at request time — no build-time baking needed.
const API_ORIGIN = () => process.env.API_BASE_URL ?? "http://localhost:3001";

async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const search = request.nextUrl.search;
  const url = `${API_ORIGIN()}/api/v1/${path.join("/")}${search}`;

  // Forward all request headers except host (Next.js sets it for us).
  const headers = new Headers(request.headers);
  headers.delete("host");

  const upstreamRes = await fetch(url, {
    method: request.method,
    headers,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    // Required for streaming body forwarding in Node 18+
    // @ts-expect-error — duplex is valid but not yet in TS lib
    duplex: "half",
  });

  // Forward the response including Set-Cookie (refresh token).
  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: upstreamRes.headers,
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
