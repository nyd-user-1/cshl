/**
 * Where /api lives when the site is a static bundle (AWS Amplify, 2026-10-01).
 *
 * On Vercel the functions under api/ shared the site's origin. On Amplify they
 * run as one Lambda behind CloudFront, a different origin, named at compile
 * time by VITE_API_ORIGIN. Rather than touch every call site, this wraps
 * `fetch` once: a request to `/api/...` is sent to that origin with the two
 * headers it requires. Unset, nothing is wrapped and calls stay relative.
 *
 *  - `x-site-key`: the API answers only a caller that holds it, and it ships
 *    only inside this bundle, which sits behind the site's password.
 *  - `x-amz-content-sha256`: CloudFront signs each request to the function,
 *    and a signed request with a body must carry the body's SHA-256.
 */
const ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");
const SITE_KEY = import.meta.env.VITE_SITE_KEY ?? "";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (bytes.byteLength === 0) return EMPTY_SHA256;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

if (ORIGIN) {
  const plain = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : url;
    if (!path.startsWith("/api/") && path !== "/api") return plain(input, init);

    // Read the body once, as bytes, so the hash and what is sent are the same.
    const request = new Request(input, init);
    const body = request.method === "GET" || request.method === "HEAD" ? new ArrayBuffer(0) : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    headers.set("x-site-key", SITE_KEY);
    headers.set("x-amz-content-sha256", await sha256Hex(body));
    return plain(`${ORIGIN}${path}`, {
      method: request.method,
      headers,
      body: body.byteLength ? body : undefined,
      signal: request.signal,
    });
  };
}

export {};
