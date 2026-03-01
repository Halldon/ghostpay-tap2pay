#!/usr/bin/env node
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import path from "node:path";
import { verifyMessage } from "ethers";

function parseIntegerEnv(name, fallback, minimum = Number.NEGATIVE_INFINITY) {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim();
  if (!normalized) return fallback;
  if (!/^-?\d+$/.test(normalized)) return fallback;

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (Number.isFinite(minimum) && parsed < minimum) return fallback;
  return parsed;
}

const PORT = Number(process.env.PORT || 4123);
const DEFAULT_DATA_FILE = process.env.VERCEL
  ? "/tmp/ghostpay-requests-store.json"
  : path.resolve(process.cwd(), "backend", "requests-store.json");
const DATA_FILE = process.env.GHOSTPAY_REQUEST_DB || DEFAULT_DATA_FILE;
const ADMIN_TOKEN = (process.env.GHOSTPAY_ADMIN_TOKEN || "").trim();
const REQUIRE_REQUEST_SIGNATURE = /^(1|true|yes|on)$/i.test(
  (process.env.GHOSTPAY_REQUIRE_REQUEST_SIGNATURE || "false").trim()
);
const CLAIM_LOCK_MS = Math.max(
  10_000,
  parseIntegerEnv("GHOSTPAY_CLAIM_LOCK_MS", 60_000, 5_000)
);
const CLAIM_LOCK_TTL_MS = Math.max(
  CLAIM_LOCK_MS,
  parseIntegerEnv("GHOSTPAY_CLAIM_LOCK_TTL_MS", CLAIM_LOCK_MS, CLAIM_LOCK_MS)
);
const REQUEST_TTL_MS = Math.max(
  60_000,
  parseIntegerEnv("GHOSTPAY_REQUEST_TTL_MS", 86_400_000, 60_000)
);
const REQUEST_STORE_RETENTION_MS = Math.max(
  24 * 60 * 60_000,
  parseIntegerEnv("GHOSTPAY_REQUEST_STORE_RETENTION_DAYS", 7, 1) * 24 * 60 * 60_000
);
const REQUESTS_PER_MERCHANT_MAX = Math.max(
  25,
  parseIntegerEnv("GHOSTPAY_MAX_REQUESTS_PER_MERCHANT", 500, 10)
);
const MAX_BODY_BYTES = Math.max(
  16_384,
  parseIntegerEnv("GHOSTPAY_MAX_BODY_BYTES", 65_536, 8_192)
);
const POST_RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  parseIntegerEnv("GHOSTPAY_POST_RATE_LIMIT_WINDOW_MS", 60_000, 1_000)
);
const POST_RATE_LIMIT_MAX = Math.max(
  1,
  parseIntegerEnv("GHOSTPAY_POST_RATE_LIMIT_MAX", 120, 1)
);
const GET_RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  parseIntegerEnv("GHOSTPAY_GET_RATE_LIMIT_WINDOW_MS", 60_000, 1_000)
);
const GET_RATE_LIMIT_MAX = Math.max(
  1,
  parseIntegerEnv("GHOSTPAY_GET_RATE_LIMIT_MAX", 900, 1)
);
const CLEANUP_INTERVAL_MS = Math.max(
  5_000,
  parseIntegerEnv("GHOSTPAY_CLEANUP_INTERVAL_MS", 60_000, 5_000)
);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};

const postRequestIpBuckets = new Map();
const getRequestIpBuckets = new Map();
let lastCleanupAt = 0;

let storeMutex = Promise.resolve();

function withStoreLock(callback) {
  const task = storeMutex.catch(() => null).then(callback);
  storeMutex = task.then(() => null).catch(() => null);
  return task;
}

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function parseClientIp(req) {
  const raw = req.headers["x-forwarded-for"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function enforceRateLimit(map, key, windowMs, max) {
  const now = Date.now();
  const bucket = map.get(key) || [];
  const cutoff = now - windowMs;
  let start = 0;
  while (start < bucket.length && bucket[start] <= cutoff) {
    start += 1;
  }

  const active = start > 0 ? bucket.slice(start) : bucket;

  if (active.length >= max) {
    const resetAt = active[0] + windowMs;
    map.set(key, active);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      remaining: 0,
      max,
    };
  }

  active.push(now);
  map.set(key, active);
  return {
    ok: true,
    retryAfterSeconds: Math.max(1, Math.ceil((active[0] + windowMs - now) / 1000)),
    remaining: max - active.length,
    max,
  };
}

function isAdminRequestAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  const rawAuth = req.headers.authorization;
  const rawAdminKey = req.headers["x-admin-key"];
  const provided =
    typeof rawAuth === "string" && rawAuth.toLowerCase().startsWith("bearer ")
      ? rawAuth.slice(7).trim()
      : typeof rawAdminKey === "string"
      ? rawAdminKey.trim()
      : "";

  return provided === ADMIN_TOKEN;
}

function parseRequestUrl(rawUrl = "") {
  const url = new URL(rawUrl, "http://localhost");
  return url;
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function isValidHexAddress(address, length = 40) {
  const normalized = String(address || "").trim();
  if (!/^0x[a-fA-F0-9]+$/.test(normalized)) {
    return false;
  }

  return normalized.length === length + 2 && /^[a-fA-F0-9]+$/.test(normalized.slice(2));
}

function isValidNonEvmAddress(address) {
  const normalized = String(address || "").trim();
  return /^(?:link|unlink)1[02-9ac-hj-np-z]+$/i.test(normalized);
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidAddress(address) {
  return isValidHexAddress(address, 40) || isValidHexAddress(address, 64) || isValidNonEvmAddress(address);
}

function isValidRequestId(requestId) {
  const normalized = safeTrim(requestId);
  return (
    normalized.length >= 8 &&
    normalized.length <= 128 &&
    /^[a-zA-Z0-9._-]+$/.test(normalized)
  );
}

function isValidTxHash(txHash) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(txHash || ""));
}

function clampTokenDecimals(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < 0 || parsed > 255) return fallback;
  return parsed;
}

function normalizeSymbol(value, fallback) {
  const normalized = safeTrim(value);
  if (!normalized) return fallback;
  return normalized.slice(0, 24);
}

function buildSignatureMessage(request) {
  const payload = {
    version: request.version,
    chain: request.chain,
    chainId: request.chainId,
    recipient: request.recipient,
    token: request.token,
    tokenSymbol: request.tokenSymbol,
    tokenDecimals: request.tokenDecimals,
    settlementToken: request.settlementToken,
    settlementTokenSymbol: request.settlementTokenSymbol,
    settlementTokenDecimals: request.settlementTokenDecimals,
    amount: request.amount,
    memo: request.memo,
    requestId: request.requestId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    singleUse: Boolean(request.singleUse),
    merchantName: request.merchantName || "",
    exchangeRequested: Boolean(request.exchangeRequested),
  };

  return `GhostPay Payment Request\n${JSON.stringify(payload)}`;
}

function normalizeRequestStatus(raw) {
  if (
    raw === "pending" ||
    raw === "processing" ||
    raw === "completed" ||
    raw === "failed" ||
    raw === "expired"
  ) {
    return raw;
  }
  return "pending";
}

function isValidRequestPayload(raw) {
  return getRequestPayloadValidationErrors(raw).length === 0;
}

function getRequestPayloadValidationErrors(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object") {
    errors.push("Request payload must be an object.");
    return errors;
  }

  if (raw.version !== 1) {
    errors.push("version must be 1.");
  }
  if (raw.chain !== "monad-testnet") {
    errors.push("chain must be monad-testnet.");
  }
  if (Number(raw.chainId) !== 10143) {
    errors.push("chainId must be 10143.");
  }
  if (!isValidRequestId(raw.requestId)) {
    errors.push("requestId format is invalid.");
  }
  if (!isValidAddress(raw.recipient)) {
    errors.push("recipient is not a valid address.");
  }
  if (typeof raw.amount !== "string" || !/^\d+$/.test(raw.amount)) {
    errors.push("amount must be an integer string.");
  } else {
    try {
      if (BigInt(raw.amount) <= 0n) {
        errors.push("amount must be greater than zero.");
      }
    } catch {
      errors.push("amount must be parseable.");
    }
  }

  const createdAt = Number(raw.createdAt);
  const expiresAt = Number(raw.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    errors.push("createdAt and expiresAt must be valid timestamps.");
  } else {
    const now = Date.now();
    if (createdAt > now + 10 * 60_000) {
      errors.push("createdAt is too far in the future.");
    }
    if (expiresAt <= createdAt) {
      errors.push("expiresAt must be after createdAt.");
    }
    if (expiresAt < now - REQUEST_TTL_MS) {
      errors.push("expiresAt is too old.");
    }
    if (expiresAt - createdAt > REQUEST_TTL_MS) {
      errors.push("request duration exceeds max TTL.");
    }
  }

  if (typeof raw.token !== "string" || !isValidAddress(raw.token)) {
    errors.push("token is invalid.");
  }

  const settlementToken =
    typeof raw.settlementToken === "string" && raw.settlementToken.trim()
      ? raw.settlementToken.trim()
      : raw.token;
  if (!isValidAddress(settlementToken)) {
    errors.push("settlementToken is invalid.");
  }

  if (clampTokenDecimals(raw.tokenDecimals, -1) < 0) {
    errors.push("tokenDecimals is invalid.");
  }
  if (clampTokenDecimals(raw.settlementTokenDecimals, clampTokenDecimals(raw.tokenDecimals, 18)) < 0) {
    errors.push("settlementTokenDecimals is invalid.");
  }

  if (typeof raw.tokenSymbol === "string" && raw.tokenSymbol.length > 24) {
    errors.push("tokenSymbol must be 24 chars or fewer.");
  }
  if (typeof raw.settlementTokenSymbol === "string" && raw.settlementTokenSymbol.length > 24) {
    errors.push("settlementTokenSymbol must be 24 chars or fewer.");
  }
  if (typeof raw.merchantName === "string" && raw.merchantName.length > 64) {
    errors.push("merchantName must be 64 chars or fewer.");
  }
  if (typeof raw.memo === "string" && raw.memo.length > 256) {
    errors.push("memo must be 256 chars or fewer.");
  }

  const signature = typeof raw.requestSignature === "string" ? raw.requestSignature.trim() : "";
  const signer = normalizeAddress(raw.requestSigner || "");
  if (!!signature !== !!signer) {
    errors.push("requestSignature and requestSigner must both be present or absent together.");
  }

  return errors;
}

function isRequestLockExpired(record, now = Date.now()) {
  if (record.status !== "processing") return false;
  const lockExpiredByWindow = !Number.isFinite(record.lockedUntil) || record.lockedUntil <= now;
  const lockClaimedAt = Number.isFinite(record.claimedAt) ? record.claimedAt : record.lockedUntil;
  const lockExpiredByTTL =
    !Number.isFinite(lockClaimedAt) || now - lockClaimedAt > CLAIM_LOCK_TTL_MS;
  return lockExpiredByWindow || lockExpiredByTTL;
}

function verifySignedRequest(raw) {
  const request = raw?.request;
  if (!request) return false;

  const requestSigner = normalizeAddress(request.requestSigner);
  const requestSignature = String(request.requestSignature || "").trim();
  if (!requestSigner || !isValidAddress(requestSigner)) return false;
  if (!requestSignature) return false;

  const message = buildSignatureMessage(request);

  try {
    const recovered = verifyMessage(message, requestSignature);
    return normalizeAddress(recovered) === requestSigner;
  } catch {
    return false;
  }
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;

  const request = raw.request;
  const requestRecipient = normalizeAddress(request?.recipient);
  const merchantAddress = normalizeAddress(raw.merchantAddress || raw.merchant || requestRecipient);
  if (!isValidAddress(merchantAddress)) return null;
  if (!isValidRequestPayload(request)) return null;
  if (requestRecipient !== merchantAddress) return null;

  const normalized = {
    merchantAddress,
    request: {
      ...request,
      chainId: 10143,
      requestId: safeTrim(request.requestId),
      recipient: normalizeAddress(request.recipient),
      token: normalizeAddress(request.token),
      tokenSymbol:
        typeof request.tokenSymbol === "string" && request.tokenSymbol.trim()
          ? normalizeSymbol(request.tokenSymbol, "Token")
          : "Token",
      settlementToken:
        typeof request.settlementToken === "string" && request.settlementToken.trim()
          ? normalizeAddress(request.settlementToken)
          : normalizeAddress(request.token),
      tokenDecimals: clampTokenDecimals(request.tokenDecimals, 18),
      settlementTokenDecimals:
        clampTokenDecimals(
          request.settlementTokenDecimals,
          clampTokenDecimals(request.tokenDecimals, 18)
        ),
      memo: typeof request.memo === "string" ? request.memo.trim().slice(0, 256) : "",
      merchantName:
        typeof request.merchantName === "string" && request.merchantName.trim()
          ? request.merchantName.trim().slice(0, 64)
          : "Merchant",
      exchangeRequested: Boolean(request.exchangeRequested),
      singleUse: Boolean(request.singleUse),
      settlementTokenSymbol:
        typeof request.settlementTokenSymbol === "string" && request.settlementTokenSymbol.trim()
          ? normalizeSymbol(request.settlementTokenSymbol, raw.settlementTokenSymbol || "Token")
          : normalizeSymbol(request.tokenSymbol || "Token", "Token"),
    },
    status: normalizeRequestStatus(raw.status),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Number(request.createdAt),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
    paidAt: typeof raw.paidAt === "number" ? raw.paidAt : undefined,
    paymentTxHash:
      typeof raw.paymentTxHash === "string" && raw.paymentTxHash.trim() ? raw.paymentTxHash.trim() : undefined,
    lockedUntil: typeof raw.lockedUntil === "number" ? raw.lockedUntil : undefined,
    lockedBy:
      typeof raw.lockedBy === "string" && isValidAddress(raw.lockedBy) ? normalizeAddress(raw.lockedBy) : undefined,
    claimId: typeof raw.claimId === "string" && raw.claimId ? raw.claimId : undefined,
    claimedAt: typeof raw.claimedAt === "number" ? raw.claimedAt : undefined,
    signatureVerified: Boolean(raw.signatureVerified ?? verifySignedRequest(raw)),
  };

  return normalized;
}

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  return access(dir).catch(() => mkdir(dir, { recursive: true }));
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

function pruneAndNormalizeRecords(records, now = Date.now()) {
  const normalizedByKey = new Map();
  const merchantMap = new Map();
  let changed = false;
  const retentionCutoff = now - REQUEST_STORE_RETENTION_MS;

  records.forEach((entry) => {
    const normalized = normalizeRecord(entry);
    if (!normalized) {
      changed = true;
      return;
    }

    const { next, changed: changedByLifecycle } = applyRequestLifecycle(normalized, now);
    if (changedByLifecycle) {
      changed = true;
    }

    const requestKey = `${next.merchantAddress}:${next.request.requestId}`;
    const existing = normalizedByKey.get(requestKey);
    if (!existing || next.updatedAt > existing.updatedAt) {
      if (existing) {
        changed = true;
      }
      normalizedByKey.set(requestKey, next);
    }
  });

  for (const next of normalizedByKey.values()) {
    if (
      (next.status === "completed" || next.status === "failed" || next.status === "expired") &&
      next.updatedAt < retentionCutoff
    ) {
      changed = true;
      continue;
    }

    const merchantRecords = merchantMap.get(next.merchantAddress) ?? [];
    merchantRecords.push(next);
    merchantMap.set(next.merchantAddress, merchantRecords);
  }

  const next = [];
  for (const [merchantAddress, merchantRecords] of merchantMap) {
    const sorted = merchantRecords.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const limited = sorted.slice(0, REQUESTS_PER_MERCHANT_MAX);
    if (limited.length !== sorted.length) {
      changed = true;
    }
    merchantMap.set(merchantAddress, limited);
    next.push(...limited);
  }

  next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { next, changed };
}

async function loadStoreWithMaintenance() {
  const now = Date.now();
  const loadedRecords = await loadStore();
  const records = Array.isArray(loadedRecords) ? loadedRecords : [];
  const isDueForCleanup = now - lastCleanupAt >= CLEANUP_INTERVAL_MS;

  if (!isDueForCleanup) {
    return { records, changed: false };
  }

  const normalized = pruneAndNormalizeRecords(records, now);
  if (normalized.changed) {
    await saveStore(normalized.records);
  }
  lastCleanupAt = now;
  return { records: normalized.records, changed: normalized.changed };
}

async function saveStore(records) {
  await ensureDataDir();
  const tempFile = `${DATA_FILE}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  await writeFile(tempFile, JSON.stringify(records, null, 2));
  await rename(tempFile, DATA_FILE);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytesReceived = 0;
    req.on("data", (chunk) => {
      const chunkBytes = Buffer.isBuffer(chunk) ? chunk.byteLength : String(chunk).length;
      const candidateLength = bytesReceived + chunkBytes;
      if (candidateLength > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      bytesReceived = candidateLength;
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

function applyRequestLifecycle(record, now = Date.now()) {
  let next = { ...record };
  let changed = false;

  if ((next.status === "pending" || next.status === "processing") && next.request.expiresAt <= now) {
    next.status = "expired";
    next.lockedBy = undefined;
    next.lockedUntil = undefined;
    next.claimId = undefined;
    next.updatedAt = now;
    changed = true;
  }

  if (next.status === "processing") {
    if (isRequestLockExpired(next, now)) {
      next.status = "pending";
      next.lockedBy = undefined;
      next.lockedUntil = undefined;
      next.claimId = undefined;
      next.claimedAt = undefined;
      next.updatedAt = now;
      changed = true;
    }
  }

  return { next, changed };
}

function pickMerchantRecords(records, merchantAddress) {
  const safeRecords = Array.isArray(records) ? records : [];
  const target = normalizeAddress(merchantAddress);
  const now = Date.now();
  let mutated = false;

  const next = safeRecords
    .filter((entry) => entry?.merchantAddress === target)
    .map((entry) => {
      const normalized = normalizeRecord(entry);
      if (!normalized) return null;
      const { next, changed } = applyRequestLifecycle(normalized, now);
      if (changed) {
        mutated = true;
      }
      return next;
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return { next, mutated };
}

function pickRequestById(records, requestId) {
  const safeRecords = Array.isArray(records) ? records : [];
  const target = String(requestId || "").trim();
  if (!target) return null;
  const now = Date.now();
  let index = -1;
  let normalizedMatch = null;

  safeRecords.forEach((entry, entryIndex) => {
    const normalized = normalizeRecord(entry);
    if (!normalized) return;
    if (normalized.request.requestId !== target) return;
    if (!normalizedMatch || normalized.updatedAt > normalizedMatch.updatedAt) {
      normalizedMatch = normalized;
      index = entryIndex;
    }
  });

  if (index < 0 || !normalizedMatch) return null;

  const normalized = normalizedMatch;
  if (!normalized) return null;

  const { next, changed } = applyRequestLifecycle(normalized, now);
  return { index, record: next, changed };
}

function writeIfChanged(records, normalized, index) {
  if (!Array.isArray(records) || index < 0) return records;
  if (!normalized.changed) return records;
  const nextRecords = [...records];
  nextRecords[index] = normalized.record;
  return nextRecords;
}

async function upsertRecord(record) {
  const { records: loadedRecords = [] } = await loadStoreWithMaintenance();
  const records = Array.isArray(loadedRecords) ? loadedRecords : [];

  if (!record || !record.request) {
    return;
  }

  const requestId = safeTrim(record.request.requestId);
  const now = Date.now();
  let index = -1;
  records.forEach((entry, entryIndex) => {
    const normalized = normalizeRecord(entry);
    if (!normalized) return;
    if (normalized.merchantAddress !== record.merchantAddress) return;
    if (normalized.request.requestId !== requestId) return;
    if (index < 0) {
      index = entryIndex;
      return;
    }
    const existing = normalizeRecord(records[index]);
    if (!existing || normalized.updatedAt > existing.updatedAt) {
      index = entryIndex;
    }
  });

  if (index >= 0) {
    const target = normalizeRecord(records[index]);

    if (!target) {
      records[index] = {
        ...record,
        updatedAt: Date.now(),
      };
      await saveStore(records);
      return;
    }

    const { next: stableTarget } = applyRequestLifecycle(target, now);

    const isCompletedOrTerminal =
      stableTarget.status === "completed" || stableTarget.status === "failed" || stableTarget.status === "expired";

    const next = {
      ...stableTarget,
      ...record,
      updatedAt: Date.now(),
    };

    if (isCompletedOrTerminal && next.status !== stableTarget.status) {
      return;
    }

    records[index] = next;
    const normalized = pruneAndNormalizeRecords(records, now);
    await saveStore(normalized.next);
    return;
  }

  const normalized = pruneAndNormalizeRecords([...records, { ...record, updatedAt: Date.now() }], now);
  await saveStore(normalized.next);
}

async function handleGetRequests(req, res, urlObj) {
  const clientIp = parseClientIp(req);
  const rate = enforceRateLimit(getRequestIpBuckets, clientIp, GET_RATE_LIMIT_WINDOW_MS, GET_RATE_LIMIT_MAX);
  if (!rate.ok) {
    res.writeHead(429, {
      ...CORS_HEADERS,
      "Retry-After": String(rate.retryAfterSeconds),
    });
    res.end(
      JSON.stringify({
        error: "Too many requests",
        retryAfterSeconds: rate.retryAfterSeconds,
      })
    );
    return;
  }

  const requestId = urlObj.searchParams.get("requestId");
  const merchantAddress = normalizeAddress(urlObj.searchParams.get("merchant"));

  return withStoreLock(async () => {
    const { records: rawRecords = [], changed: maintenanceChanged } = await loadStoreWithMaintenance();
    const requestRecords = Array.isArray(rawRecords) ? rawRecords : [];

    if (requestId) {
      if (!isValidRequestId(requestId)) {
        return jsonResponse(res, 400, { error: "Invalid requestId format." });
      }

      const selected = pickRequestById(requestRecords, requestId);
      if (!selected) {
        return jsonResponse(res, 404, { error: "Request not found" });
      }

      const maybeUpdated = writeIfChanged(requestRecords, selected, selected.index);
      if (maybeUpdated !== requestRecords || maintenanceChanged) {
        await saveStore(maybeUpdated);
      }

      const responseRecord = maybeUpdated[selected.index] ? maybeUpdated[selected.index] : selected.record;
      return jsonResponse(res, 200, { request: responseRecord });
    }

    if (!isValidAddress(merchantAddress)) {
      return jsonResponse(res, 400, {
        error: "merchant query parameter must be a valid address",
      });
    }

    const { next, mutated } = pickMerchantRecords(requestRecords, merchantAddress);
    if (mutated || maintenanceChanged) {
      await saveStore(next);
    }

    return jsonResponse(res, 200, { requests: next });
  });
}

async function handlePostRequests(req, res) {
  const clientIp = parseClientIp(req);
  const rate = enforceRateLimit(
    postRequestIpBuckets,
    clientIp,
    POST_RATE_LIMIT_WINDOW_MS,
    POST_RATE_LIMIT_MAX
  );
  if (!rate.ok) {
    res.writeHead(429, {
      ...CORS_HEADERS,
      "Retry-After": String(rate.retryAfterSeconds),
    });
    res.end(
      JSON.stringify({
        error: "Too many requests",
        retryAfterSeconds: rate.retryAfterSeconds,
      })
    );
    return;
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (error) {
    if (error instanceof Error && error.message === "Request body too large") {
      return jsonResponse(res, 413, { error: "Request body exceeds maximum size." });
    }
    return jsonResponse(res, 400, { error: "Invalid JSON body." });
  }

  const now = Date.now();
  const action = String(payload?.action || "");
  const requestId = String(payload?.requestId || "").trim();

  if (action) {
    if (!["claim", "complete", "fail"].includes(action)) {
      return jsonResponse(res, 400, { error: `Unsupported action: ${action}` });
    }

    if (!requestId) {
      return jsonResponse(res, 400, {
        error: "requestId is required for request actions.",
      });
    }
    if (!isValidRequestId(requestId)) {
      return jsonResponse(res, 400, { error: "Invalid requestId format." });
    }

    return withStoreLock(async () => {
      const { records: rawRecords = [] } = await loadStoreWithMaintenance();
      const records = Array.isArray(rawRecords) ? rawRecords : [];
      const resolved = pickRequestById(records, requestId);

      if (!resolved) {
        return jsonResponse(res, 404, { error: "Request not found." });
      }

      const targetIndex = resolved.index;
      const targetRecord = resolved.record;
      const maybeSave = writeIfChanged(records, resolved, targetIndex);

      if (resolved.changed && records !== maybeSave) {
        await saveStore(maybeSave);
      }

      if (action === "claim") {
        const claimantInput = payload?.claimant;
        if (typeof claimantInput !== "string" || !isValidAddress(claimantInput)) {
          return jsonResponse(res, 400, {
            error: "claimant must be a valid address.",
            request: targetRecord,
          });
        }

        const claimant = normalizeAddress(claimantInput || "");
        const requestedClaimId =
          typeof payload?.claimId === "string" && payload.claimId.trim()
            ? payload.claimId.trim()
            : "";
        const claimId = requestedClaimId || targetRecord.claimId || randomUUID();

        if (targetRecord.status === "processing") {
          const lockWindowActive = !isRequestLockExpired(targetRecord, now);
          const sameClaim =
            !targetRecord.claimId || !requestedClaimId || targetRecord.claimId === requestedClaimId;
          const claimantMatchesLock =
            !isValidAddress(targetRecord.lockedBy) || targetRecord.lockedBy === claimant;

          if (!lockWindowActive || !sameClaim || !claimantMatchesLock) {
            return jsonResponse(res, 409, {
              error: "Request is not available for payment.",
              request: targetRecord,
            });
          }

          return jsonResponse(res, 200, { request: targetRecord, claimId: targetRecord.claimId });
        }

        if (targetRecord.status !== "pending") {
          return jsonResponse(res, 409, {
            error: "Request is not available for payment.",
            request: targetRecord,
          });
        }

        const nextRecord = {
          ...targetRecord,
          status: "processing",
          lockedBy: claimant,
          claimId,
          claimedAt: now,
          lockedUntil: now + Math.min(CLAIM_LOCK_MS, CLAIM_LOCK_TTL_MS),
          updatedAt: now,
        };
        records[targetIndex] = nextRecord;
        await saveStore(records);
        return jsonResponse(res, 200, { request: nextRecord, claimId });
      }

      if (action === "complete") {
        const incomingClaimId =
          typeof payload?.claimId === "string" && payload?.claimId.trim()
            ? payload.claimId.trim()
            : "";
        const claimantInput = payload?.claimant;
        const hasLockedBy = isValidAddress(targetRecord.lockedBy);

        if (hasLockedBy && (typeof claimantInput !== "string" || !isValidAddress(claimantInput))) {
          return jsonResponse(res, 400, {
            error: "claimant must be a valid address.",
            request: targetRecord,
          });
        }

        const claimant = hasLockedBy ? normalizeAddress(claimantInput) : "";

        if (!incomingClaimId) {
          return jsonResponse(res, 400, {
            error: "claimId is required to complete a request.",
            request: targetRecord,
          });
        }

        if (targetRecord.status === "completed") {
          return jsonResponse(res, 200, { request: targetRecord });
        }

        if (targetRecord.status !== "processing") {
          return jsonResponse(res, 409, {
            error: "Request was not claimed before completion.",
            request: targetRecord,
          });
        }

        if (isRequestLockExpired(targetRecord, now)) {
          const nextRecord = {
            ...targetRecord,
            status: "pending",
            lockedBy: undefined,
            lockedUntil: undefined,
            claimId: undefined,
            claimedAt: undefined,
            updatedAt: now,
          };
          records[targetIndex] = nextRecord;
          await saveStore(records);
          return jsonResponse(res, 409, {
            error: "Payment lock has expired.",
            request: nextRecord,
          });
        }

        if (!targetRecord.claimId || targetRecord.claimId !== incomingClaimId) {
          return jsonResponse(res, 409, {
            error: "Claim token does not match this payment lock.",
            request: targetRecord,
          });
        }

        if (hasLockedBy && targetRecord.lockedBy !== claimant) {
          return jsonResponse(res, 409, {
            error: "Claimant does not match the current payment lock.",
            request: targetRecord,
          });
        }

        const paymentTxHash =
          typeof payload?.paymentTxHash === "string" && payload.paymentTxHash.trim()
            ? payload.paymentTxHash.trim()
            : targetRecord.paymentTxHash;

        if (!isValidTxHash(paymentTxHash)) {
          return jsonResponse(res, 400, {
            error: "Invalid paymentTxHash provided.",
            request: targetRecord,
          });
        }

        const nextRecord = {
          ...targetRecord,
          status: "completed",
          paymentTxHash,
          paidAt: now,
          lockedBy: undefined,
          lockedUntil: undefined,
          claimId: undefined,
          claimedAt: undefined,
          updatedAt: now,
        };
        records[targetIndex] = nextRecord;
        await saveStore(records);
        return jsonResponse(res, 200, { request: nextRecord });
      }

      if (action === "fail") {
        const incomingClaimId =
          typeof payload?.claimId === "string" && payload.claimId.trim()
            ? payload.claimId.trim()
            : "";
        const claimantInput = payload?.claimant;
        const hasLockedBy = isValidAddress(targetRecord.lockedBy);

        if (hasLockedBy && (typeof claimantInput !== "string" || !isValidAddress(claimantInput))) {
          return jsonResponse(res, 400, {
            error: "claimant must be a valid address.",
            request: targetRecord,
          });
        }

        const claimant = hasLockedBy ? normalizeAddress(claimantInput) : "";

        if (targetRecord.status !== "processing") {
          return jsonResponse(res, 409, {
            error: "Request is not currently being processed.",
            request: targetRecord,
          });
        }

        if (isRequestLockExpired(targetRecord, now)) {
          const nextRecord = {
            ...targetRecord,
            status: "pending",
            lockedBy: undefined,
            lockedUntil: undefined,
            claimId: undefined,
            claimedAt: undefined,
            updatedAt: now,
          };
          records[targetIndex] = nextRecord;
          await saveStore(records);
          return jsonResponse(res, 409, {
            error: "Payment lock has expired.",
            request: nextRecord,
          });
        }

        if (!incomingClaimId) {
          return jsonResponse(res, 400, {
            error: "claimId is required to release a claimed request.",
            request: targetRecord,
          });
        }

        if (targetRecord.claimId && targetRecord.claimId !== incomingClaimId) {
          return jsonResponse(res, 409, {
            error: "Claim token does not match this payment lock.",
            request: targetRecord,
          });
        }

        if (hasLockedBy && targetRecord.lockedBy !== claimant) {
          return jsonResponse(res, 409, {
            error: "Claimant does not match the current payment lock.",
            request: targetRecord,
          });
        }

        const nextRecord = {
          ...targetRecord,
          status: "pending",
          lockedBy: undefined,
          lockedUntil: undefined,
          claimId: undefined,
          claimedAt: undefined,
          updatedAt: now,
        };
        records[targetIndex] = nextRecord;
        await saveStore(records);
        return jsonResponse(res, 200, { request: nextRecord });
      }

      return jsonResponse(res, 400, { error: `Unsupported action: ${action}` });
    });
  }

  const normalized = normalizeRecord(payload);
  if (!normalized) {
    return jsonResponse(res, 400, {
      error: "Malformed request payload.",
      details: getRequestPayloadValidationErrors(payload.request),
    });
  }
  const hasRequestSignature =
    typeof normalized.request.requestSignature === "string" && normalized.request.requestSignature.trim();
  const hasRequestSigner =
    typeof normalized.request.requestSigner === "string" && normalized.request.requestSigner.trim();

  if ((hasRequestSignature || hasRequestSigner) && !normalized.signatureVerified) {
    return jsonResponse(res, 400, { error: "Request signature is invalid." });
  }

  if (REQUIRE_REQUEST_SIGNATURE && !hasRequestSignature && !hasRequestSigner) {
    return jsonResponse(res, 400, { error: "Unsigned request payloads are disabled on this backend." });
  }

  if (!hasRequestSignature && !hasRequestSigner && ADMIN_TOKEN && !isAdminRequestAuthorized(req)) {
    return jsonResponse(res, 401, {
      error: "Unauthorized: missing or invalid admin token for unsigned request.",
    });
  }

  await withStoreLock(() => upsertRecord(normalized));
  return jsonResponse(res, 201, { ok: true, request: normalized });
}

const requestHandler = async (req, res) => {
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
    console.error(error);
    jsonResponse(res, 500, {
      error: error instanceof Error ? error.message : "Server error",
    });
  }
};

export async function handleGhostpayRequest(req, res) {
  return requestHandler(req, res);
}

if (!process.env.VERCEL) {
  const server = createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`GhostPay request backend listening on http://localhost:${PORT}`);
  });
}
