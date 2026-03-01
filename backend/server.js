#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT || 4123);
const DATA_FILE =
  process.env.GHOSTPAY_REQUEST_DB ||
  path.resolve(process.cwd(), "backend", "requests-store.json");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function parseRequestUrl(rawUrl = "") {
  const url = new URL(rawUrl, "http://localhost");
  return url;
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || ""));
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;

  const request = raw.request;
  const merchantAddress = normalizeAddress(raw.merchantAddress || raw.merchant);
  if (!isValidAddress(merchantAddress)) return null;
  if (!request || typeof request !== "object") return null;
  if (request.version !== 1) return null;
  if (request.chain !== "monad-testnet") return null;
  if (request.chainId !== 10143) return null;

  const requestId = request.requestId;
  if (typeof requestId !== "string" || !requestId.trim()) return null;
  if (!isValidAddress(request.recipient)) return null;
  if (typeof request.amount !== "string" || !/^\d+$/.test(request.amount)) return null;
  if (typeof request.createdAt !== "number" || typeof request.expiresAt !== "number")
    return null;

  return {
    merchantAddress,
    request,
    status:
      raw.status === "completed" || raw.status === "failed" || raw.status === "expired"
        ? raw.status
        : "pending",
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : request.createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    paidAt: typeof raw.paidAt === "number" ? raw.paidAt : undefined,
    paymentTxHash:
      typeof raw.paymentTxHash === "string" && raw.paymentTxHash.trim()
        ? raw.paymentTxHash.trim()
        : undefined,
  };
}

async function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

async function loadStore() {
  await ensureDataDir();
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.requests)) return parsed.requests;
  } catch {
    return [];
  }
  return [];
}

async function saveStore(records) {
  await ensureDataDir();
  await writeFile(DATA_FILE, JSON.stringify(records, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function pickMerchantRecords(records, merchantAddress) {
  const target = normalizeAddress(merchantAddress);
  return records
    .filter((entry) => entry?.merchantAddress === target)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function upsertRecord(record) {
  const records = await loadStore();
  const requestId = String(record.request.requestId);
  const index = records.findIndex(
    (entry) =>
      String(entry?.request?.requestId || "") === requestId &&
      normalizeAddress(entry?.merchantAddress) === record.merchantAddress
  );

  if (index >= 0) {
    records[index] = {
      ...records[index],
      ...record,
      updatedAt: Date.now(),
    };
  } else {
    records.push({
      ...record,
      updatedAt: Date.now(),
    });
  }

  await saveStore(records);
}

async function handleGetRequests(req, res, urlObj) {
  const merchantAddress = normalizeAddress(urlObj.searchParams.get("merchant"));
  if (!isValidAddress(merchantAddress)) {
    return jsonResponse(res, 400, {
      error: "merchant query parameter must be a valid 0x address",
    });
  }

  const records = await loadStore();
  const response = pickMerchantRecords(records, merchantAddress);
  return jsonResponse(res, 200, { requests: response });
}

async function handlePostRequests(req, res) {
  let payload;
  try {
    payload = await readBody(req);
  } catch {
    return jsonResponse(res, 400, { error: "Invalid JSON body." });
  }

  const normalized = normalizeRecord(payload);
  if (!normalized) {
    return jsonResponse(res, 400, { error: "Malformed request payload." });
  }
  if (typeof normalized.status !== "string") {
    normalized.status = "pending";
  }

  await upsertRecord(normalized);
  return jsonResponse(res, 201, { ok: true });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    const urlObj = parseRequestUrl(req.url);
    if (urlObj.pathname === "/requests" && req.method === "GET") {
      await handleGetRequests(req, res, urlObj);
      return;
    }

    if (urlObj.pathname === "/requests" && req.method === "POST") {
      await handlePostRequests(req, res);
      return;
    }

    if (urlObj.pathname === "/health" && req.method === "GET") {
      return jsonResponse(res, 200, { ok: true });
    }

    jsonResponse(res, 404, { error: "Not found" });
  } catch (error) {
    jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : "Server error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`GhostPay request backend listening on http://localhost:${PORT}`);
});
