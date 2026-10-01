// The /api functions as one Lambda behind a function URL (2026-10-01), the
// from-sam pattern.
//
// The routes are Vercel-style (req, res) handlers; this adapter gives each the
// two objects from a function-URL event and streams what it writes straight
// back. Bedrock is reached on the function's execution role; no key is
// stored. CloudFront stands in front (the account does not allow public
// function URLs) and signs each request.
import chatSessions from "../../api/chat-sessions.ts"
import chat from "../../api/chat.ts"
import community from "../../api/community.ts"
import dict from "../../api/dict.ts"
import feed from "../../api/feed.ts"
import grounding from "../../api/grounding.ts"
import paper from "../../api/paper.ts"
import pdf from "../../api/pdf.ts"
import record from "../../api/record.ts"
import records from "../../api/records.ts"
import search from "../../api/search.ts"
import similar from "../../api/similar.ts"
import upload from "../../api/upload.ts"

const ROUTES = {
  "/api/chat-sessions": chatSessions,
  "/api/chat": chat,
  "/api/community": community,
  "/api/dict": dict,
  "/api/feed": feed,
  "/api/grounding": grounding,
  "/api/paper": paper,
  "/api/pdf": pdf,
  "/api/record": record,
  "/api/records": records,
  "/api/search": search,
  "/api/similar": similar,
  "/api/upload": upload,
}

// The site and the API are different origins when the browser calls this
// directly; the Amplify hostnames are the only callers allowed.
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*amplifyapp\.com$|^http:\/\/localhost(:\d+)?$/

/* global awslambda */
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const method = event.requestContext?.http?.method ?? "GET"
  const path = event.rawPath ?? "/"
  const origin = event.headers?.origin ?? ""
  const cors = ORIGIN_OK.test(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-amz-content-sha256, x-site-key",
        "access-control-max-age": "600",
        vary: "origin",
      }
    : {}

  let status = 200
  const headers = { ...cors }
  let stream = null
  // The handler must not return before the stream has flushed: a response
  // ended and returned in the same tick lost its body (and its headers)
  // on the way out. Every way of ending waits on the stream's own finish.
  let closing = null
  const begin = () => {
    if (stream) return
    stream = awslambda.HttpResponseStream.from(responseStream, { statusCode: status, headers })
  }
  const close = (chunk) => {
    begin()
    closing ??= new Promise((resolve) => {
      // Write, then end: the runtime sends the status and headers on the
      // first write, so an end() that carries the only chunk can go out
      // without them. A response with no body still needs one write.
      stream.write(chunk ?? "")
      stream.end(resolve)
    })
    return closing
  }

  const res = {
    get headersSent() {
      return stream !== null
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = String(value)
      return res
    },
    writeHead(code, extra) {
      status = code
      for (const [name, value] of Object.entries(extra ?? {})) headers[name.toLowerCase()] = String(value)
      begin()
      return res
    },
    status(code) {
      status = code
      return res
    },
    json(value) {
      headers["content-type"] = "application/json"
      void close(JSON.stringify(value))
      return res
    },
    send(text) {
      void close(String(text))
      return res
    },
    write(chunk) {
      begin()
      stream.write(chunk)
      return true
    },
    end(chunk) {
      void close(chunk)
      return res
    },
  }

  if (method === "OPTIONS") {
    res.status(204)
    return close()
  }

  // Only the password-protected site may call: its bundle carries the key.
  // Without one configured the API stays shut rather than open.
  const siteKey = process.env.SITE_KEY
  if (!siteKey || event.headers?.["x-site-key"] !== siteKey) {
    res.status(401).json({ error: "not allowed" })
    return closing
  }

  const route = ROUTES[path.replace(/\/+$/, "")]
  if (!route) {
    res.status(404).json({ error: "not here" })
    return closing
  }

  let raw = event.body ?? ""
  if (event.isBase64Encoded && raw) raw = Buffer.from(raw, "base64").toString("utf8")
  let body = {}
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    body = {}
  }

  const req = { method, headers: event.headers ?? {}, query: event.queryStringParameters ?? {}, body }

  try {
    await route(req, res)
  } catch (error) {
    if (!stream) res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    else res.end()
  }
  await close()
})
