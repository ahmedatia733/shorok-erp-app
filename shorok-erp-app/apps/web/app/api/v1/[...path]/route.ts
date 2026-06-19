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

  const hasBody =
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.body !== null;

  const upstreamRes = await fetch(url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    // duplex required when body is a ReadableStream (Node 18+)
    // @ts-expect-error — duplex is valid but not yet in TS lib
    ...(hasBody ? { duplex: "half" } : {}),
  });

  // Buffer the body so transfer-encoding / content-encoding quirks don't
  // produce an empty response when the client reads it.
  const body = await upstreamRes.arrayBuffer();

  const responseHeaders = new Headers(upstreamRes.headers);
  responseHeaders.delete("transfer-encoding");
  responseHeaders.delete("content-encoding");

  return new NextResponse(body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
