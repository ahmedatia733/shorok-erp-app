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

  const headers = new Headers(request.headers);
  headers.delete("host");
  // Ask the API for plain (uncompressed) data so Node's fetch doesn't
  // decode gzip while we simultaneously forward content-encoding: gzip,
  // which would cause the browser to double-decompress and get nothing.
  headers.set("accept-encoding", "identity");

  // Buffer the request body upfront — avoids ReadableStream/duplex
  // issues and correctly sends nothing for bodyless POSTs (logout, etc.).
  let reqBody: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 0) reqBody = buf;
  }

  const upstreamRes = await fetch(url, {
    method: request.method,
    headers,
    body: reqBody,
  });

  const responseHeaders = new Headers(upstreamRes.headers);
  responseHeaders.delete("transfer-encoding");
  responseHeaders.delete("content-encoding");

  // 204/304 must have no body — the Response constructor throws otherwise.
  if (upstreamRes.status === 204 || upstreamRes.status === 304) {
    return new NextResponse(null, { status: upstreamRes.status, headers: responseHeaders });
  }

  // Buffer the body so encoding quirks don't produce an empty response.
  const body = await upstreamRes.arrayBuffer();
  return new NextResponse(body, { status: upstreamRes.status, headers: responseHeaders });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
