import { handleGhostpayRequest } from "../../backend/server.js";

const BACKEND_URL = (process.env.GHOSTPAY_BACKEND_URL || "").trim();
const ADMIN_TOKEN = (process.env.GHOSTPAY_ADMIN_TOKEN || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.GHOSTPAY_REQUEST_TIMEOUT_MS || "10000");

function sendJsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function buildHeaders() {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };

  if (ADMIN_TOKEN) {
    headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
    headers["X-Admin-Key"] = ADMIN_TOKEN;
  }

  return headers;
}

async function readRawBody(req) {
  if (req.body === undefined) {
    return await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", () => resolve(""));
    });
  }

  if (typeof req.body === "string") {
    return req.body;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }

  if (typeof req.body === "object") {
    return JSON.stringify(req.body);
  }

  return "";
}

export default async function handler(req, res) {
  try {
    if (!BACKEND_URL) {
      const incoming = new URL(req.url || "", "https://ghostpay.local");
      const mappedPath = incoming.pathname.replace(/^\/api\/ghostpay(?:\/|$)/, "/");
      const localReq = Object.create(req);
      Object.defineProperty(localReq, "url", {
        configurable: true,
        value: `${mappedPath}${incoming.search}`,
      });
      return handleGhostpayRequest(localReq, res);
    }

    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      return sendJsonResponse(res, 405, { error: "Only GET and POST are supported." });
    }

    const incoming = new URL(req.url || "", "https://ghostpay.local");
    const target = new URL("/requests", BACKEND_URL);
    target.search = incoming.search;

    const payload =
      method === "POST" ? await readRawBody(req) : "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(REQUEST_TIMEOUT_MS) ? REQUEST_TIMEOUT_MS : 10000);

    try {
      const upstream = await fetch(target.toString(), {
        method,
        headers: buildHeaders(),
        body: payload || undefined,
        signal: controller.signal,
      });
      const body = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
      res.end(body || "");
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DOMException && error.name === "AbortError") {
        return sendJsonResponse(res, 504, { error: "Backend request timed out." });
      }
      return sendJsonResponse(res, 502, {
        error: "Unable to reach backend request service.",
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return sendJsonResponse(res, 500, { error: "Unexpected proxy failure." });
  }
}
