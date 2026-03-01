import {
  formatAmount,
  parseAmount,
  useDeposit,
  useSend,
  useTxStatus,
  useUnlink,
  useUnlinkBalances,
  useUnlinkHistory,
  useWithdraw,
} from "@unlink-xyz/react";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type Mode = "merchant" | "payer" | "withdraw";

type RequestStatus = "pending" | "processing" | "completed" | "expired" | "failed";

type TokenMetadata = {
  address: string;
  symbol: string;
  decimals: number;
  label?: string;
  isCustom?: boolean;
};

type PaymentRequest = {
  version: 1;
  chain: "monad-testnet";
  chainId: number;
  recipient: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  settlementToken: string;
  settlementTokenSymbol: string;
  settlementTokenDecimals: number;
  amount: string;
  memo: string;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  singleUse: boolean;
  merchantName?: string;
  exchangeRequested?: boolean;
  requestSignature?: string;
  requestSigner?: string;
};

type RequestRecord = {
  request: PaymentRequest;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  lockedBy?: string;
  lockedUntil?: number;
  claimId?: string;
  paidAt?: number;
  paymentTxHash?: string;
  signatureVerified?: boolean;
};

type PayerRequestClaimMap = Record<string, number>;

type MinimalHistoryEntry = {
  kind: "Deposit" | "Receive" | "Send" | "SelfSend" | "Withdraw";
  status: "confirmed" | "pending" | "failed";
  txHash?: string;
  timestamp?: number;
  amounts: {
    token: string;
    delta: string;
  }[];
};

const CHAIN_ID = 10143;
const CHAIN_NAME = "monad-testnet";
const CHARGE_ROUTE = "/charge";
const PAY_ROUTE = "/pay";
const WITHDRAW_ROUTE = "/withdraw";
const STORAGE_KEY = "ghostpay:requests:v2";
const PAYER_CLAIM_KEY = "ghostpay:payer-consumptions:v1";
const SETTINGS_KEY = "ghostpay:settings:v1";
const MONAD_EXPLORER = "https://testnet.monadexplorer.com";
const MONAD_FAUCET = "https://faucet.monad.xyz/";
const MONAD_RPC_CHAIN_ID_HEX = "0x279f";
const REQUEST_POLL_INTERVAL = 5_000;
const REQUEST_EXPIRY_MINUTES = 60;
const DEFAULT_BACKEND_REQUEST_URL = import.meta.env.DEV ? "http://localhost:4123" : "/api/ghostpay";
const BACKEND_REQUEST_URL = (import.meta.env.VITE_GHOSTPAY_REQUEST_BACKEND || DEFAULT_BACKEND_REQUEST_URL).trim();
const BACKEND_REQUEST_ADMIN_TOKEN = (import.meta.env.VITE_GHOSTPAY_ADMIN_TOKEN || "").trim();
const REQUIRE_REQUEST_SIGNATURE = /^(true|1|yes|on)$/i.test(
  (import.meta.env.VITE_GHOSTPAY_REQUIRE_REQUEST_SIGNATURE || "").trim()
);

const MON_TOKEN = "0x0000000000000000000000000000000000000000";
const USDC_TOKEN = "0xc4fb617e4e4cfbdeb07216dff62b4e46a2d6fdf6";
const USDC_ALT_TOKEN = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const USDT_TOKEN = "0x86b6341d3c56bc379697d247fc080f5f2c8eed7b";
const ULNK_TOKEN = "0xaaa4e95d4da878baf8e10745fdf26e196918df6b";
const CUSTOM_TOKEN_KEY = "__custom__";

const PAYMENT_TOKENS: TokenMetadata[] = [
  {
    address: MON_TOKEN,
    symbol: "MON",
    decimals: 18,
    label: "MON (native)",
  },
  {
    address: USDC_TOKEN,
    symbol: "USDC",
    decimals: 6,
    label: "USDC",
  },
  {
    address: USDC_ALT_TOKEN,
    symbol: "USDCV2",
    decimals: 6,
    label: "USDC (Alt)",
  },
  {
    address: USDT_TOKEN,
    symbol: "USDT",
    decimals: 6,
    label: "USDT",
  },
  {
    address: ULNK_TOKEN,
    symbol: "ULNK",
    decimals: 18,
    label: "ULNK",
  },
  {
    address: CUSTOM_TOKEN_KEY,
    symbol: "Custom",
    decimals: 18,
    label: "Custom token",
    isCustom: true,
  },
];

const PREVIEW_TOKENS = PAYMENT_TOKENS.filter((token) => !token.isCustom);
const DEFAULT_PAYMENT_TOKEN = USDC_TOKEN;
const PAYMENT_TOKEN_OPTIONS = PREVIEW_TOKENS;

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function isSupportedTokenOption(address: string) {
  return PAYMENT_TOKEN_OPTIONS.some(
    (token) => normalizeAddress(token.address) === normalizeAddress(address)
  );
}

function loadSettlementTokenPreference() {
  if (typeof window === "undefined") return DEFAULT_PAYMENT_TOKEN;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_PAYMENT_TOKEN;
    const parsed = JSON.parse(raw) as { settlementTokenAddress?: string } | null;
    if (parsed?.settlementTokenAddress && isSupportedTokenOption(parsed.settlementTokenAddress)) {
      return parsed.settlementTokenAddress;
    }
  } catch {
    // use default
  }
  return DEFAULT_PAYMENT_TOKEN;
}

function saveSettlementTokenPreference(settlementTokenAddress: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ settlementTokenAddress })
    );
  } catch {
    // best-effort local preference
  }
}

function normalizeMnemonicPhrase(value: string) {
  return value.trim().replace(/\s+/g, " ").trim().toLowerCase();
}

function compactAddress(value: string, leadingChars = 8, trailingChars = 5) {
  const normalized = value.trim();
  if (!normalized) return "";
  const minLength = leadingChars + trailingChars + 3;
  if (normalized.length <= minLength) {
    return normalized;
  }
  return `${normalized.slice(0, leadingChars)}...${normalized.slice(-trailingChars)}`;
}

function hasValidMnemonicWordCount(value: string) {
  const words = value.split(" ").filter(Boolean);
  return words.length === 12 || words.length === 15 || words.length === 18 || words.length === 21 || words.length === 24;
}

function isValidAddress(address: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

function toBase64Url(payload: string) {
  const bytes = new TextEncoder().encode(payload);
  const binary = Array.from(bytes)
    .map((value) => String.fromCodePoint(value))
    .join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringToHex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

function decodeBase64Url(payload: string) {
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  const bytes = Uint8Array.from(decoded, (char) => char.codePointAt(0)!);
  return new TextDecoder().decode(bytes);
}

function encodeRequest(request: PaymentRequest) {
  return toBase64Url(JSON.stringify(request));
}

function normalizePaymentRequest(parsed: Partial<PaymentRequest> | null | undefined): PaymentRequest | null {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== 1 || parsed.chain !== CHAIN_NAME || parsed.chainId !== CHAIN_ID) {
    return null;
  }

  if (typeof parsed.requestId !== "string" || !parsed.requestId) return null;
  if (typeof parsed.recipient !== "string" || !parsed.recipient) return null;
  if (typeof parsed.token !== "string" || !parsed.token) return null;
  if (typeof parsed.amount !== "string" || !/^\d+$/.test(parsed.amount)) return null;
  if (typeof parsed.createdAt !== "number" || typeof parsed.expiresAt !== "number") return null;

  const requestTokenMeta = metadataForAddress(parsed.token);
  const settlementToken =
    typeof parsed.settlementToken === "string" && parsed.settlementToken.trim()
      ? parsed.settlementToken.trim()
      : parsed.token;
  const settlementMeta = metadataForAddress(settlementToken);

  return {
    version: 1,
    chain: CHAIN_NAME,
    chainId: CHAIN_ID,
    recipient: parsed.recipient,
    token: parsed.token,
    amount: parsed.amount,
    memo: parsed.memo || "",
    requestId: parsed.requestId,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    singleUse: Boolean(parsed.singleUse),
    merchantName:
      typeof parsed.merchantName === "string" && parsed.merchantName.trim() ? parsed.merchantName : "Merchant",
    tokenSymbol:
      typeof parsed.tokenSymbol === "string" && parsed.tokenSymbol.trim()
        ? parsed.tokenSymbol.trim()
        : requestTokenMeta.symbol,
    tokenDecimals: clampDecimals(parsed.tokenDecimals, requestTokenMeta.decimals),
    settlementToken,
    settlementTokenSymbol:
      typeof parsed.settlementTokenSymbol === "string" && parsed.settlementTokenSymbol.trim()
        ? parsed.settlementTokenSymbol.trim()
        : settlementMeta.symbol,
    settlementTokenDecimals: clampDecimals(parsed.settlementTokenDecimals, settlementMeta.decimals),
    exchangeRequested:
      typeof parsed.exchangeRequested === "boolean" ? parsed.exchangeRequested : false,
    requestSignature:
      typeof parsed.requestSignature === "string" && parsed.requestSignature ? parsed.requestSignature : undefined,
    requestSigner:
      typeof parsed.requestSigner === "string" && parsed.requestSigner ? parsed.requestSigner : undefined,
  };
}

function clampDecimals(raw: unknown, fallback: number) {
  const asNumber = Number(raw);
  if (!Number.isFinite(asNumber)) return fallback;
  const parsed = Math.trunc(asNumber);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 255) return fallback;
  return parsed;
}

function normalizeRequestStatus(status: unknown): RequestStatus {
  if (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "processing" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

function metadataForAddress(address: string): TokenMetadata {
  const direct = PAYMENT_TOKENS.find(
    (token) => !token.isCustom && normalizeAddress(token.address) === normalizeAddress(address)
  );
  return direct ?? {
    address,
    symbol: "Token",
    decimals: 18,
  };
}

function metadataForSelection(
  selected: string,
  customAddress: string,
  customSymbol: string,
  customDecimals: number
): TokenMetadata {
  if (selected === CUSTOM_TOKEN_KEY) {
    return {
      address: customAddress.trim() || CUSTOM_TOKEN_KEY,
      symbol: customSymbol.trim() || "CUSTOM",
      decimals: clampDecimals(customDecimals, 18),
      isCustom: true,
    };
  }

  return metadataForAddress(selected);
}

function decodeRequest(raw: string): PaymentRequest | null {
  const decoded = decodeBase64Url(raw);
  const parsed = JSON.parse(decoded) as Partial<PaymentRequest>;
  return normalizePaymentRequest(parsed);
}

function toPayerRequestUrl(requestPayload: string) {
  return `${PAY_ROUTE}?request=${encodeURIComponent(requestPayload)}`;
}

function resolveScannedRequestUrl(scanText: string) {
  const cleaned = scanText.trim();
  if (!cleaned) return null;

  try {
    const parsed = new URL(cleaned);
    const requestParam = parsed.searchParams.get("request");
    if (requestParam) {
      return toPayerRequestUrl(requestParam);
    }
  } catch {
    // Handle payload-only requests below.
  }

  try {
    const maybeRequest = decodeRequest(cleaned);
    if (maybeRequest) {
      return toPayerRequestUrl(encodeRequest(maybeRequest));
    }
  } catch {
    // Not a valid request payload.
  }
  return null;
}

function loadRequestRecords(): RequestRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RequestRecord[];
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map((entry): RequestRecord | null => {
        const candidate = entry as Partial<RequestRecord>;
        const request = normalizePaymentRequest(candidate.request as Partial<PaymentRequest>);
        if (!request) return null;

        const normalizedRecord: RequestRecord = {
          request,
          status: normalizeRequestStatus(candidate.status),
          createdAt:
            typeof candidate.createdAt === "number"
              ? candidate.createdAt
              : request.createdAt,
          updatedAt:
            typeof candidate.updatedAt === "number"
              ? candidate.updatedAt
              : request.createdAt,
        };
        if (typeof candidate.paidAt === "number") {
          normalizedRecord.paidAt = candidate.paidAt;
        }
        if (typeof candidate.paymentTxHash === "string") {
          normalizedRecord.paymentTxHash = candidate.paymentTxHash;
        }
        return normalizedRecord;
      })
      .filter((entry): entry is RequestRecord => entry !== null);
    return normalized.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function mergeRequestRecords(local: RequestRecord[], remote: RequestRecord[]) {
  const merged = new Map<string, RequestRecord>();
  local.forEach((entry) => {
    merged.set(entry.request.requestId, entry);
  });
  remote.forEach((remoteEntry) => {
    const current = merged.get(remoteEntry.request.requestId);
    if (!current || remoteEntry.updatedAt >= current.updatedAt) {
      merged.set(remoteEntry.request.requestId, remoteEntry);
    }
  });
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeRequestRecord(raw: unknown): RequestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<RequestRecord>;
  const candidateRequest = candidate.request as Partial<PaymentRequest> | undefined;
  const request = normalizePaymentRequest(candidateRequest);
  if (!request) return null;

  const normalizedRecord: RequestRecord = {
    request,
    status: normalizeRequestStatus(candidate.status),
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : request.createdAt,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : request.createdAt,
  };
  if (typeof candidate.lockedBy === "string" && isValidAddress(candidate.lockedBy)) {
    normalizedRecord.lockedBy = normalizeAddress(candidate.lockedBy);
  }
  if (typeof candidate.lockedUntil === "number" && Number.isFinite(candidate.lockedUntil)) {
    normalizedRecord.lockedUntil = candidate.lockedUntil;
  }
  if (typeof candidate.claimId === "string" && candidate.claimId) {
    normalizedRecord.claimId = candidate.claimId;
  }
  if (typeof candidateRequest?.requestSignature === "string" && candidateRequest.requestSignature) {
    request.requestSignature = candidateRequest.requestSignature;
  }
  if (typeof candidateRequest?.requestSigner === "string" && candidateRequest.requestSigner) {
    request.requestSigner = candidateRequest.requestSigner;
  }

  if (typeof candidate.paidAt === "number") {
    normalizedRecord.paidAt = candidate.paidAt;
  }
  if (typeof candidate.paymentTxHash === "string") {
    normalizedRecord.paymentTxHash = candidate.paymentTxHash;
  }
  if (typeof candidate.signatureVerified === "boolean") {
    normalizedRecord.signatureVerified = candidate.signatureVerified;
  }
  return normalizedRecord;
}

function parseRequestHistoryResponse(payload: unknown): RequestRecord[] {
  const wrapped = typeof payload === "object" && payload !== null ? payload : null;
  const requestList = Array.isArray(wrapped)
    ? wrapped
    : wrapped && Array.isArray((wrapped as { requests?: unknown[] }).requests)
      ? (wrapped as { requests?: unknown[] }).requests ?? []
      : [];

  return requestList
    .map((entry) => normalizeRequestRecord(entry))
    .filter((entry): entry is RequestRecord => !!entry);
}

async function fetchRequestRecordsFromBackend(merchantAddress: string): Promise<RequestRecord[]> {
  const base = BACKEND_REQUEST_URL;
  if (!base) return [];

  const url = `${base.replace(/\/$/, "")}/requests?merchant=${encodeURIComponent(
    merchantAddress
  )}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...requestBackendHeaders(),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = parseBackendError(payload, `Backend request sync failed (${response.status})`);
    throw new Error(message);
  }
  const payload = await response.json();
  return parseRequestHistoryResponse(payload);
}

function requestBackendHeaders(): Record<string, string> {
  if (!BACKEND_REQUEST_ADMIN_TOKEN) {
    return {};
  }
  return {
    Authorization: `Bearer ${BACKEND_REQUEST_ADMIN_TOKEN}`,
    "X-Admin-Key": BACKEND_REQUEST_ADMIN_TOKEN,
  };
}

function parseBackendError(payload: unknown, fallback: string) {
  const raw = typeof payload === "object" && payload !== null ? payload : null;
  const details = raw ? (raw as Record<string, unknown>).details : undefined;
  const errorMessage = raw ? (raw as Record<string, unknown>).error : null;
  if (Array.isArray(details)) {
    const joined = details.filter((entry) => typeof entry === "string").join(" | ");
    if (joined) {
      const message = typeof errorMessage === "string" ? errorMessage : "Malformed backend error.";
      return `${message}. ${joined}`;
    }
  }
  if (typeof details === "string" && details) {
    const message = typeof errorMessage === "string" ? errorMessage : "Malformed backend error.";
    return `${message}. ${details}`;
  }
  return typeof errorMessage === "string" ? errorMessage : fallback;
}

function paymentRequestSignatureMessage(request: PaymentRequest) {
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

async function signPaymentRequest(request: Omit<PaymentRequest, "requestSignature" | "requestSigner">) {
  if (!window.ethereum) {
    throw new Error("No browser wallet detected.");
  }

  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  const signer = accounts?.[0];
  if (!signer) {
    throw new Error("No browser account selected.");
  }

  const message = paymentRequestSignatureMessage(request);
  const signature = (await window.ethereum.request({
    method: "personal_sign",
    params: [stringToHex(message), signer],
  })) as string;

  return {
    requestSignature: signature,
    requestSigner: normalizeAddress(signer),
  };
}

async function fetchRequestRecordFromBackend(requestId: string): Promise<RequestRecord | null> {
  if (!BACKEND_REQUEST_URL) {
    return null;
  }
  const url = `${BACKEND_REQUEST_URL.replace(/\/$/, "")}/requests?requestId=${encodeURIComponent(requestId)}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...requestBackendHeaders(),
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = parseBackendError(payload, `Request lookup failed (${response.status})`);
    throw new Error(message);
  }
  const payload = await response.json();
  return normalizeRequestRecord(payload?.request);
}

async function postRequestAction(
  requestId: string,
  action: "claim" | "complete" | "fail",
  body: {
    claimant?: string;
    claimId?: string;
    paymentTxHash?: string;
  } = {}
) {
  if (!BACKEND_REQUEST_URL) {
    throw new Error("Request backend unavailable.");
  }
  const response = await fetch(`${BACKEND_REQUEST_URL.replace(/\/$/, "")}/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...requestBackendHeaders(),
    },
    body: JSON.stringify({
      requestId,
      action,
      ...body,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = parseBackendError(payload, `Request action failed (${response.status})`);
    throw new Error(message);
  }
  const requestRecord = normalizeRequestRecord(payload?.request);
  if (!requestRecord) {
    throw new Error("Request action returned no request record.");
  }
  return requestRecord;
}

async function upsertRequestRecord(record: RequestRecord, merchantAddress: string) {
  const base = BACKEND_REQUEST_URL;
  if (!base) {
    throw new Error("Request backend unavailable.");
  }

  const response = await fetch(`${base.replace(/\/$/, "")}/requests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...requestBackendHeaders(),
    },
    body: JSON.stringify({
      merchantAddress,
      ...record,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = parseBackendError(payload, `Backend request save failed (${response.status})`);
    throw new Error(message);
  }
}

async function persistRequestRecord(
  record: RequestRecord,
  merchantAddress: string | undefined,
  setRequestSyncError?: (error: string | null) => void
) {
  if (!merchantAddress) return false;
  try {
    await upsertRequestRecord(record, merchantAddress);
    setRequestSyncError?.(null);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sync request to backend.";
    setRequestSyncError?.(message);
    return false;
  }
}

function loadPayerConsumedMap(): PayerRequestClaimMap {
  try {
    const raw = window.localStorage.getItem(PAYER_CLAIM_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry) => typeof entry[0] === "string" && Number.isFinite(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function savePayerConsumedMap(map: PayerRequestClaimMap) {
  try {
    window.localStorage.setItem(PAYER_CLAIM_KEY, JSON.stringify(map));
  } catch {
    // Keep going for browser-limited contexts.
  }
}

function saveRequestRecords(records: RequestRecord[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Keep going in browser-limited contexts.
  }
}

function requestStatusLabel(status: RequestStatus) {
  if (status === "pending") return "Pending";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Succeeded";
  if (status === "expired") return "Expired";
  return "Failed";
}

function formatMoney(value: string | bigint, token: TokenMetadata) {
  return `${formatAmount(typeof value === "string" ? BigInt(value) : value, token.decimals)} ${token.symbol}`;
}

function txPhase(state: string | null, isLoading: boolean) {
  if (!isLoading && !state) return 0;
  if (state === null || state === "pending") return 0;
  if (state === "broadcasting" || state === "submitted") return 1;
  if (state === "succeeded") return 2;
  return 3;
}

function isFinalizedTxState(state: string | null) {
  return state === "succeeded" || state === "failed" || state === "reverted" || state === "dead";
}

function txStatusText(state: string | null) {
  if (state === null || state === "pending") return "Preparing proof";
  if (state === "broadcasting") return "Relaying";
  if (state === "submitted") return "Confirming";
  if (state === "succeeded") return "Confirmed";
  if (state === "failed" || state === "reverted" || state === "dead") return "Failed";
  return "Processing";
}

function historyMatchesRequest(
  request: PaymentRequest,
  history: MinimalHistoryEntry[],
  usedTxHashes: Set<string>
) {
  const target = BigInt(request.amount);
  return history.find((entry) => {
    if (entry.kind !== "Receive") return false;
    if (entry.status !== "confirmed") return false;
    if (!entry.txHash || usedTxHashes.has(entry.txHash)) return false;
    if (entry.timestamp && request.expiresAt && entry.timestamp > request.expiresAt) return false;
    if (entry.timestamp && entry.timestamp < request.createdAt - 60_000) return false;
    return entry.amounts.some(
      (amount) =>
        amount.token.toLowerCase() === request.token.toLowerCase() && BigInt(amount.delta) === target
    );
  });
}

function formatRelativeTime(timestamp: number | undefined) {
  if (!timestamp) return "—";
  const elapsed = Math.floor((Date.now() - timestamp) / 1000);
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  return `${Math.floor(elapsed / 3600)}h ago`;
}

function tokenBalanceFor(balances: Record<string, bigint> | undefined, tokenAddress: string) {
  if (!balances) return 0n;
  return (
    balances[tokenAddress] ??
    balances[normalizeAddress(tokenAddress)] ??
    balances[tokenAddress.toUpperCase()] ??
    0n
  );
}

function requestExchangeNeeded(request: PaymentRequest) {
  return normalizeAddress(request.token) !== normalizeAddress(request.settlementToken);
}

async function connectToBrowserWallet(requireMonadChain = true): Promise<string> {
  if (!window.ethereum) {
    throw new Error("No browser wallet detected.");
  }

  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  const address = accounts?.[0];
  if (!address) {
    throw new Error("No wallet account selected.");
  }

  if (requireMonadChain) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_RPC_CHAIN_ID_HEX }],
      });
    } catch {
      // Continue; switch prompt is optional for this demo.
    }
  }

  return address;
}

function tokenPreviewTokenRows(allBalances: Record<string, bigint> | undefined) {
  return PREVIEW_TOKENS.map((token) => ({
    token,
    balance: tokenBalanceFor(allBalances, token.address),
  }));
}

function tokenBrand(address: string, symbol: string) {
  const normalized = normalizeAddress(address);
  if (normalized === normalizeAddress(MON_TOKEN)) return { tone: "mon", mark: "M" };
  if (normalized === normalizeAddress(USDC_TOKEN)) return { tone: "usdc", mark: "U" };
  if (normalized === normalizeAddress(USDC_ALT_TOKEN)) return { tone: "usdc-alt", mark: "U2" };
  if (normalized === normalizeAddress(USDT_TOKEN)) return { tone: "usdt", mark: "T" };
  if (normalized === normalizeAddress(ULNK_TOKEN)) return { tone: "ulnk", mark: "UL" };
  return { tone: "default", mark: symbol.slice(0, 2).toUpperCase() };
}

function tokenIconUrl(address: string) {
  const normalized = normalizeAddress(address);
  if (normalized === normalizeAddress(MON_TOKEN)) return "https://www.google.com/s2/favicons?domain=monad.xyz&sz=128";
  if (normalized === normalizeAddress(USDC_TOKEN))
    return "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/usdc.png";
  if (normalized === normalizeAddress(USDC_ALT_TOKEN))
    return "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/usdc.png";
  if (normalized === normalizeAddress(USDT_TOKEN))
    return "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/usdt.png";
  if (normalized === normalizeAddress(ULNK_TOKEN))
    return "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/link.png";
  return null;
}

function TokenMark({
  address,
  symbol,
}: {
  address: string;
  symbol: string;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const logo = tokenIconUrl(address);

  if (logo && !logoFailed) {
    return (
      <img
        className="token-logo"
        src={logo}
        alt={`${symbol} logo`}
        loading="lazy"
        onError={() => setLogoFailed(true)}
      />
    );
  }
  const brand = tokenBrand(address, symbol);
  return <span className={`token-mark token-mark-${brand.tone}`}>{brand.mark}</span>;
}

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "merchant") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden focusable="false">
        <path d="M4 8h16M4 12h16M4 16h10" />
      </svg>
    );
  }
  if (mode === "payer") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden focusable="false">
        <path d="M4 7h16v10H4zM8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M12 4v11M8 8l4-4 4 4M5 20h14" />
    </svg>
  );
}

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [search, setSearch] = useState(() => window.location.search);

  const {
    walletExists,
    accounts,
    activeAccount,
    createWallet,
    createAccount,
    refresh,
    ready,
    error: unlinkError,
    busy,
    status: syncStatus,
    importWallet,
    waitForConfirmation,
  } = useUnlink();
  const { history, refresh: refreshHistory } = useUnlinkHistory({ includeSelfSends: false });
  const { balances: allBalances } = useUnlinkBalances();

  const {
    send: triggerSend,
    isPending: sendPending,
    error: sendHookError,
    reset: resetSend,
  } = useSend();
  const {
    deposit: triggerDeposit,
    isPending: depositPending,
    error: depositHookError,
    reset: resetDeposit,
  } = useDeposit();
  const {
    withdraw: triggerWithdraw,
    isPending: withdrawPending,
    error: withdrawHookError,
    reset: resetWithdraw,
  } = useWithdraw();

  const [sendTxId, setSendTxId] = useState<string | null>(null);
  const [withdrawTxId, setWithdrawTxId] = useState<string | null>(null);
  const [depositTxId, setDepositTxId] = useState<string | null>(null);
  const sendTxStatus = useTxStatus(sendTxId);
  const withdrawTxStatus = useTxStatus(withdrawTxId);
  const depositTxStatus = useTxStatus(depositTxId);

  const [mode, setMode] = useState<Mode>("merchant");
  const [records, setRecords] = useState<RequestRecord[]>(() => loadRequestRecords());
  const [payerConsumedMap, setPayerConsumedMap] = useState<PayerRequestClaimMap>(() =>
    loadPayerConsumedMap()
  );

  const [seedPhrase, setSeedPhrase] = useState("");
  const [seedAcknowledged, setSeedAcknowledged] = useState(false);
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [showWalletSetupModal, setShowWalletSetupModal] = useState(false);
  const [importSeedPhrase, setImportSeedPhrase] = useState("");
  const [isImportingWallet, setIsImportingWallet] = useState(false);
  const [awaitingAccountCreation, setAwaitingAccountCreation] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);
  const [walletImportError, setWalletImportError] = useState<string | null>(null);
  const [requestSyncError, setRequestSyncError] = useState<string | null>(null);
  const [requestSignatureWarning, setRequestSignatureWarning] = useState<string | null>(null);
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [isQrFullscreen, setIsQrFullscreen] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const requestAmountInputRef = useRef<HTMLInputElement | null>(null);
  const [walletSummaryExpanded, setWalletSummaryExpanded] = useState(false);

  const [requestAmountInput, setRequestAmountInput] = useState("");
  const [withdrawAmountInput, setWithdrawAmountInput] = useState("1.00");
  const [memo, setMemo] = useState("");
  const merchantName = "GhostPay";
  const [singleUse, setSingleUse] = useState(true);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const [withdrawTo, setWithdrawTo] = useState("");

  const [settlementTokenAddress, setSettlementTokenAddress] = useState<string>(() =>
    loadSettlementTokenPreference()
  );
  const [requestTokenAddress, setRequestTokenAddress] = useState<string>(() =>
    loadSettlementTokenPreference()
  );
  const [withdrawTokenAddress, setWithdrawTokenAddress] = useState<string>(DEFAULT_PAYMENT_TOKEN);

  const [sendErrorMessage, setSendErrorMessage] = useState<string | null>(null);
  const [withdrawErrorMessage, setWithdrawErrorMessage] = useState<string | null>(null);
  const [depositErrorMessage, setDepositErrorMessage] = useState<string | null>(null);
  const [payerRequestRecordError, setPayerRequestRecordError] = useState<string | null>(null);
  const [payerRequestIntegrityWarning, setPayerRequestIntegrityWarning] = useState<string | null>(null);
  const [payerRequestRecord, setPayerRequestRecord] = useState<RequestRecord | null>(null);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(null);

  const [receiptOpen, setReceiptOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<
    | {
        memo: string;
        amount: bigint;
        tokenSymbol: string;
        tokenDecimals: number;
        txHash?: string;
      }
    | null
  >(null);
  const hasRequestBackend = Boolean(BACKEND_REQUEST_URL);
  const [requestBackendReachable, setRequestBackendReachable] = useState(false);

  const requestTokenMeta = useMemo(() => metadataForAddress(requestTokenAddress), [requestTokenAddress]);
  const settlementTokenMeta = useMemo(() => metadataForAddress(settlementTokenAddress), [settlementTokenAddress]);
  const withdrawTokenMeta = useMemo(() => metadataForAddress(withdrawTokenAddress), [withdrawTokenAddress]);

  useEffect(() => {
    const listener = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setRecords(loadRequestRecords());
      }
      if (event.key === PAYER_CLAIM_KEY) {
        setPayerConsumedMap(loadPayerConsumedMap());
      }
    };
    window.addEventListener("storage", listener);
    return () => window.removeEventListener("storage", listener);
  }, []);

  useEffect(() => {
    const listener = () => {
      setPath(window.location.pathname);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  useEffect(() => {
    saveRequestRecords(records);
  }, [records]);

  useEffect(() => {
    saveSettlementTokenPreference(settlementTokenAddress);
  }, [settlementTokenAddress]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const hasRequest = Boolean(params.get("request"));
    const wantsPayerMode = params.get("mode") === "payer";
    const wantsWithdrawMode = params.get("mode") === "withdraw";

    if (hasRequest && path !== PAY_ROUTE) {
      const nextPath = `${PAY_ROUTE}${search || ""}`;
      window.history.replaceState({}, "", nextPath);
      setPath(PAY_ROUTE);
      return;
    }

    if (wantsPayerMode && path !== PAY_ROUTE) {
      const nextPath = `${PAY_ROUTE}${search || ""}`;
      window.history.replaceState({}, "", nextPath);
      setPath(PAY_ROUTE);
      return;
    }

    if (wantsWithdrawMode && path !== WITHDRAW_ROUTE) {
      const nextPath = `${WITHDRAW_ROUTE}${search || ""}`;
      window.history.replaceState({}, "", nextPath);
      setPath(WITHDRAW_ROUTE);
      return;
    }

    if (path !== CHARGE_ROUTE && path !== PAY_ROUTE && path !== WITHDRAW_ROUTE) {
      const fallbackPath = hasRequest || wantsPayerMode ? PAY_ROUTE : wantsWithdrawMode ? WITHDRAW_ROUTE : CHARGE_ROUTE;
      const nextPath = `${fallbackPath}${search || ""}`;
      window.history.replaceState({}, "", nextPath);
      setPath(fallbackPath);
      return;
    }

    setMode(path === PAY_ROUTE ? "payer" : path === WITHDRAW_ROUTE ? "withdraw" : "merchant");
  }, [path, search]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setRecords((current) =>
        current.map((entry) => {
          if (entry.status !== "pending") return entry;
          if (entry.request.expiresAt <= now) {
            return {
              ...entry,
              status: "expired",
              updatedAt: now,
            };
          }
          return entry;
        })
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeAccount || !hasRequestBackend) return;
    let ignore = false;

    const sync = async () => {
      try {
        const remoteRecords = await fetchRequestRecordsFromBackend(activeAccount.address);
        setRequestBackendReachable(true);
        setRecords((current) => mergeRequestRecords(current, remoteRecords));
        setRequestSyncError(null);
      } catch (error) {
        if (!ignore) {
          setRequestBackendReachable(false);
        }
      }
    };

    sync();
    const timer = setInterval(() => {
      if (!ignore) {
        sync();
      }
    }, REQUEST_POLL_INTERVAL);

    return () => {
      ignore = true;
      clearInterval(timer);
    };
  }, [activeAccount?.address, hasRequestBackend]);

  useEffect(() => {
    if (!walletExists) return;
    const timer = setInterval(() => {
      void refresh();
      void refreshHistory();
    }, REQUEST_POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [walletExists, refresh, refreshHistory]);

  useEffect(() => {
    setRecords((current) => {
      const usedTxHashes = new Set<string>();
      let mutated = false;
      const updates: Array<{ requestId: string; paymentTxHash?: string }> = [];

      const next = current.map((entry) => {
        if (entry.status !== "pending") return entry;
        const match = historyMatchesRequest(
          entry.request,
          history as MinimalHistoryEntry[],
          usedTxHashes
        );
        if (!match?.txHash) return entry;
        usedTxHashes.add(match.txHash);
        mutated = true;
        updates.push({
          requestId: entry.request.requestId,
          paymentTxHash: match.txHash,
        });
        return {
          ...entry,
          status: "completed" as const,
          paidAt: match.timestamp ?? Date.now(),
          paymentTxHash: match.txHash,
          updatedAt: Date.now(),
        };
      });

      if (mutated && activeAccount && hasRequestBackend && requestBackendReachable) {
        updates.forEach((entry) => {
          const requestRecord = next.find((record) => record.request.requestId === entry.requestId);
          if (requestRecord) {
            void persistRequestRecord({
              ...requestRecord,
              status: "completed" as RequestStatus,
              paymentTxHash: entry.paymentTxHash ?? requestRecord.paymentTxHash,
            }, activeAccount.address);
          }
        });
      }
      return mutated ? next : current;
    });
  }, [history, activeAccount?.address]);

  const requestFromLink = useMemo(() => {
    const payload = new URLSearchParams(search).get("request");
    if (!payload) return null;
    try {
      return decodeRequest(payload);
    } catch {
      return null;
    }
  }, [search]);

  useEffect(() => {
    let ignored = false;

    const resolveRequest = async () => {
      if (!requestFromLink) {
        setPayerRequestRecord(null);
        setPayerRequestRecordError(null);
        setPayerRequestIntegrityWarning(null);
        return;
      }

      try {
        const resolved = await fetchRequestRecordFromBackend(requestFromLink.requestId);
        if (!resolved) {
          throw new Error("This request was not found on the backend.");
        }
        setRequestBackendReachable(true);
        if (!resolved.request.requestSignature && REQUIRE_REQUEST_SIGNATURE) {
          throw new Error("This request is missing a signature and cannot be used.");
        }
        if ((resolved.request.requestSignature || resolved.request.requestSigner) && !resolved.signatureVerified) {
          throw new Error("The request signature could not be verified.");
        }
        if (!resolved.request.requestSignature && !resolved.request.requestSigner) {
          setPayerRequestIntegrityWarning("This request is unsigned. Verify merchant or link origin before paying.");
        } else {
          setPayerRequestIntegrityWarning(null);
        }
        if (resolved.status === "expired") {
          throw new Error("Request has expired.");
        }
        if (resolved.request.singleUse && resolved.status !== "pending" && resolved.status !== "processing") {
          throw new Error("This request is no longer available.");
        }
        if (!ignored) {
          setPayerRequestRecord(resolved);
          setPayerRequestRecordError(null);
          setRequestSyncError(null);
        }
      } catch (error) {
        if (!ignored) {
          setRequestBackendReachable(false);
          setPayerRequestRecord(null);
          setPayerRequestIntegrityWarning(null);
          if (error instanceof Error) {
            setPayerRequestRecordError(error.message);
          } else {
            setPayerRequestRecordError("Unable to load this request from backend.");
          }
        }
      }
    };

    void resolveRequest();

    return () => {
      ignored = true;
    };
  }, [requestFromLink, hasRequestBackend]);

  const activeRequest = useMemo(() => {
    if (activeRequestId) {
      return records.find((entry) => entry.request.requestId === activeRequestId) ?? records[0] ?? null;
    }
    return records[0] ?? null;
  }, [activeRequestId, records]);

  const payerRequest = payerRequestRecord?.request ?? requestFromLink;
  const payerTokenMeta: TokenMetadata | null = payerRequest
    ? {
        address: payerRequest.token,
        symbol: payerRequest.tokenSymbol,
        decimals: payerRequest.tokenDecimals,
      }
    : null;
  const payerSettlementMeta: TokenMetadata | null = payerRequest
    ? {
        address: payerRequest.settlementToken,
        symbol: payerRequest.settlementTokenSymbol,
        decimals: payerRequest.settlementTokenDecimals,
      }
    : null;

  const stopScanner = () => {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;
    setCameraOpen(false);
  };

  const routeToScannedRequest = (scanText: string) => {
    const nextPath = resolveScannedRequestUrl(scanText);
    if (!nextPath) {
      setScanError("QR code found, but it is not a valid GhostPay payment request.");
      return false;
    }

    stopScanner();
    const nextUrl = new URL(nextPath, window.location.origin);
    window.history.pushState({}, "", nextPath);
    setPath(nextUrl.pathname);
    setSearch(nextUrl.search || "");
    setMode("payer");
    return true;
  };

  useEffect(() => {
    if (mode === "merchant" && !showSeedModal) {
      requestAmountInputRef.current?.focus();
      requestAmountInputRef.current?.select();
    }
  }, [mode, showSeedModal]);

  useEffect(() => {
    if (!walletExists || !activeAccount) return;
    if (mode !== "payer" || payerRequest) return;
    setCameraOpen(true);
  }, [walletExists, activeAccount, mode, payerRequest]);

  useEffect(() => {
    if (!cameraOpen || mode !== "payer" || payerRequest) return;
    const videoElement = scannerVideoRef.current;
    if (!videoElement) return;

    let cancelled = false;
    const reader = new BrowserQRCodeReader(undefined, {
      delayBetweenScanAttempts: 240,
      delayBetweenScanSuccess: 1000,
    });

    setScanError(null);

    void reader
      .decodeFromVideoDevice(undefined, videoElement, (result, error, controls) => {
        scannerControlsRef.current = controls;

        if (result) {
          routeToScannedRequest(result.getText());
          return;
        }

        if (!error || error.name === "NotFoundException") {
          return;
        }

        if (error.name === "NotAllowedError" || error.name === "NotAllowedException") {
          setScanError("Camera access is blocked. Enable permission and retry.");
          return;
        }
        if (error.name === "NotReadableError") {
          setScanError("Camera is already in use by another app.");
          return;
        }
        setScanError("Unable to scan right now. Reposition the QR and try again.");
      })
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        scannerControlsRef.current = controls;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Unable to open camera scanner.";
        setScanError(message);
      });

    return () => {
      cancelled = true;
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
    };
  }, [cameraOpen, mode, payerRequest]);

  useEffect(() => {
    if ((mode !== "payer" || payerRequest) && cameraOpen) {
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
      setCameraOpen(false);
    }
  }, [cameraOpen, mode, payerRequest]);

  const payerBalance = payerRequest ? tokenBalanceFor(allBalances, payerRequest.token) : 0n;
  const payerAmount = payerRequest ? BigInt(payerRequest.amount) : 0n;
  const payerRecord = payerRequest
    ? payerRequestRecord ?? records.find((entry) => entry.request.requestId === payerRequest.requestId) ?? null
    : null;

  const requestExpired = payerRequest ? payerRequest.expiresAt <= Date.now() : true;
  const requestSingleUseConsumed =
    !!payerRequest &&
    payerRequest.singleUse &&
    (payerRecord?.status === "processing" ||
      payerRecord?.status === "completed" ||
      payerRecord?.status === "expired" ||
      (payerConsumedMap[payerRequest.requestId] ? true : false));
  const requestNeedsExchange =
    payerRequest && payerSettlementMeta
      ? normalizeAddress(payerRequest.token) !== normalizeAddress(payerSettlementMeta.address)
      : false;

  const canPay =
    Boolean(
      payerRequest &&
        !payerRequestRecordError &&
        !requestExpired &&
        payerRecord?.status !== "processing" &&
        !requestSingleUseConsumed &&
        activeAccount &&
        walletExists &&
        payerBalance >= payerAmount
    );

  const requestShareLink = useMemo(() => {
    if (!activeRequest) return "";
    const encoded = encodeRequest(activeRequest.request);
    return `${window.location.origin}${toPayerRequestUrl(encoded)}`;
  }, [activeRequest]);
  const sendPhase = Math.min(txPhase(sendTxStatus.state, sendTxStatus.isLoading), 2);
  const depositPhase = Math.min(txPhase(depositTxStatus.state, depositTxStatus.isLoading), 2);
  const withdrawPhase = Math.min(txPhase(withdrawTxStatus.state, withdrawTxStatus.isLoading), 2);
  const showSendProgress = sendPending || (sendTxStatus.state !== null && !isFinalizedTxState(sendTxStatus.state));
  const showDepositProgress = depositPending || (depositTxStatus.state !== null && !isFinalizedTxState(depositTxStatus.state));
  const showWithdrawProgress =
    withdrawPending || (withdrawTxStatus.state !== null && !isFinalizedTxState(withdrawTxStatus.state));
  const merchantRecentRequests = useMemo(() => records.slice(0, 6), [records]);

  const payerStatusHint = useMemo(() => {
    if (!payerRequest) return "";
    if (payerRequestRecordError) return payerRequestRecordError;
    if (requestExpired) return "Request expired. Ask merchant for a new one.";
    if (payerRecord?.status === "processing") return "This request is currently processing.";
    if (requestSingleUseConsumed) return "This single-use request was already paid.";
    if (!walletExists || !activeAccount) return "Create/open your private wallet to continue.";
    if (!payerTokenMeta) return "Invalid token in request.";
    if (payerTokenMeta.isCustom && !isValidAddress(payerTokenMeta.address))
      return "Custom payment token address is not valid.";
    if (payerBalance < payerAmount) {
      const token = payerTokenMeta;
      return `Insufficient ${token.symbol} in private balance.`;
    }
    return "";
  }, [
    payerRequest,
    payerRequestRecordError,
    requestExpired,
    payerRecord?.status,
    requestSingleUseConsumed,
    walletExists,
    activeAccount,
    payerTokenMeta,
    payerBalance,
    payerAmount,
  ]);

  const addRequestRecord = (request: PaymentRequest) => {
    const record: RequestRecord = {
      request,
      status: "pending",
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    };
    setRecords((current) => {
      const filtered = current.filter((entry) => entry.request.requestId !== request.requestId);
      return [
        record,
        ...filtered,
      ];
    });
  };

  const markRequestCompleted = (requestId: string, txHash?: string) => {
    setRecords((current) =>
      current.map((entry) =>
        entry.request.requestId === requestId
          ? {
              ...entry,
              status: "completed",
              paidAt: Date.now(),
              paymentTxHash: txHash,
              updatedAt: Date.now(),
            }
          : entry
      )
    );
  };

  const markRequestProcessing = (requestId: string, claimId?: string) => {
    setRecords((current) =>
      current.map((entry) =>
        entry.request.requestId === requestId
          ? {
              ...entry,
              status: "processing",
              claimId,
              updatedAt: Date.now(),
            }
          : entry
      )
    );
  };

  const markRequestFailed = (requestId: string) => {
    setRecords((current) =>
      current.map((entry) =>
        entry.request.requestId === requestId
          ? {
              ...entry,
              status: "failed",
              updatedAt: Date.now(),
            }
          : entry
      )
    );
    setPayerRequestRecord((current) =>
      current?.request.requestId === requestId
        ? {
            ...current,
            status: "failed",
            updatedAt: Date.now(),
          }
        : current
    );
  };

  const markRequestPending = (requestId: string) => {
    setRecords((current) =>
      current.map((entry) =>
        entry.request.requestId === requestId
          ? {
              ...entry,
              status: "pending",
              updatedAt: Date.now(),
            }
          : entry
      )
    );
  };

  const markRequestConsumedByPayer = (requestId: string) => {
    setPayerConsumedMap((current) => {
      if (current[requestId]) return current;
      const next = {
        ...current,
        [requestId]: Date.now(),
      };
      savePayerConsumedMap(next);
      return next;
    });
  };

  const openMode = (next: Mode) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("request");
    url.searchParams.delete("mode");
    url.pathname = next === "merchant" ? CHARGE_ROUTE : next === "payer" ? PAY_ROUTE : WITHDRAW_ROUTE;
    const nextSearch = `${url.pathname}${url.search}`;
    window.history.pushState({}, "", nextSearch);
    setPath(url.pathname);
    setSearch(url.search || "");
    setMode(next);
    if (next === "payer") {
      setScanError(null);
    }
  };

  const createWalletAndAccount = async () => {
    setWalletActionError(null);
    setWalletImportError(null);
    setIsImportingWallet(true);
    try {
      const result = await createWallet();
      setSeedPhrase(result.mnemonic);
      setSeedAcknowledged(false);
      setShowWalletSetupModal(false);
      setShowSeedModal(true);
      setAwaitingAccountCreation(true);
    } catch (err) {
      setWalletImportError((err as Error).message || "Wallet creation failed.");
      setShowWalletSetupModal(true);
    } finally {
      setIsImportingWallet(false);
    }
  };

  const openWalletSetup = () => {
    setWalletActionError(null);
    setWalletImportError(null);
    setImportSeedPhrase("");
    setShowSeedModal(false);
    setShowWalletSetupModal(true);
  };

  const closeWalletSetup = () => {
    setShowWalletSetupModal(false);
    setWalletImportError(null);
    setImportSeedPhrase("");
    setIsImportingWallet(false);
  };

  const restoreWalletFromSeed = async () => {
    const normalized = normalizeMnemonicPhrase(importSeedPhrase);
    if (!normalized) {
      setWalletImportError("Enter your 12/15/18/21/24-word recovery phrase.");
      return;
    }
    if (!hasValidMnemonicWordCount(normalized)) {
      setWalletImportError("Invalid recovery phrase length. Expected 12, 15, 18, 21, or 24 words.");
      return;
    }

    setWalletImportError(null);
    setWalletActionError(null);
    setIsImportingWallet(true);
    try {
      await importWallet(normalized);
      setShowWalletSetupModal(false);
      setImportSeedPhrase("");
      if (accounts.length === 0) {
        await createAccount();
      }
    } catch (err) {
      setWalletImportError((err as Error).message || "Could not restore this wallet. Check your recovery phrase.");
    } finally {
      setIsImportingWallet(false);
    }
  };

  const continueAfterSeed = async () => {
    if (!seedAcknowledged) return;
    setShowSeedModal(false);
    if (!awaitingAccountCreation) return;
    try {
      await createAccount();
      setAwaitingAccountCreation(false);
    } catch (err) {
      setWalletActionError((err as Error).message || "Account creation failed.");
    }
  };

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showSeedModal) {
        setShowSeedModal(false);
        setAwaitingAccountCreation(false);
        return;
      }
      if (showWalletSetupModal) {
        setShowWalletSetupModal(false);
        setWalletImportError(null);
        setImportSeedPhrase("");
        setIsImportingWallet(false);
        return;
      }
      if (receiptOpen) {
        setReceiptOpen(false);
        return;
      }
      if (isQrFullscreen) {
        setIsQrFullscreen(false);
      }
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [showSeedModal, showWalletSetupModal, receiptOpen, isQrFullscreen]);

  const validateCustomToken = (token: TokenMetadata) => {
    if (token.isCustom && token.address === CUSTOM_TOKEN_KEY) {
      return "Set a custom token address before proceeding.";
    }
    if (token.isCustom && !isValidAddress(token.address)) {
      return "Custom token address must be a valid 0x Ethereum address.";
    }
    if (token.decimals < 0 || token.decimals > 255) {
      return "Token decimals must be between 0 and 255.";
    }
    if (token.symbol.trim().length < 1) {
      return "Custom token symbol is required.";
    }
    return null;
  };

  const createNewRequest = async () => {
    if (!hasRequestBackend) {
      setWalletActionError(
        "Payment request backend is not configured. Set VITE_GHOSTPAY_REQUEST_BACKEND to a reachable request service."
      );
      return;
    }

    if (!activeAccount) {
      setWalletActionError("Create or select a private account first.");
      return;
    }

    const tokenError =
      validateCustomToken(requestTokenMeta) || validateCustomToken(settlementTokenMeta);

    if (tokenError) {
      setWalletActionError(tokenError);
      return;
    }

    setIsCreatingRequest(true);
    setWalletActionError(null);
    setRequestSyncError(null);
    setRequestSignatureWarning(null);
    try {
      const now = Date.now();
      const amount = parseAmount(requestAmountInput, requestTokenMeta.decimals);
      if (amount <= 0n) {
        setWalletActionError("Amount must be greater than zero.");
        return;
      }

      const unsignedRequest: Omit<PaymentRequest, "requestSignature" | "requestSigner"> = {
        version: 1,
        chain: CHAIN_NAME,
        chainId: CHAIN_ID,
        recipient: activeAccount.address,
        token: requestTokenMeta.address,
        tokenSymbol: requestTokenMeta.symbol,
        tokenDecimals: requestTokenMeta.decimals,
        settlementToken: settlementTokenMeta.address,
        settlementTokenSymbol: settlementTokenMeta.symbol,
        settlementTokenDecimals: settlementTokenMeta.decimals,
        amount: amount.toString(),
        memo: memo.trim(),
        requestId: crypto.randomUUID(),
        createdAt: now,
        expiresAt: now + REQUEST_EXPIRY_MINUTES * 60_000,
        singleUse,
        merchantName: merchantName.trim() || "Merchant",
        exchangeRequested: requestTokenMeta.address.toLowerCase() !== settlementTokenMeta.address.toLowerCase(),
      };

      let signed: { requestSignature: string; requestSigner: string } | null = null;
      if (window.ethereum) {
        try {
          signed = await signPaymentRequest(unsignedRequest);
        } catch (error) {
          if (REQUIRE_REQUEST_SIGNATURE) {
            throw error;
          }
          setRequestSignatureWarning("Request created without a signature. Continue only with trusted merchants.");
        }
      } else if (REQUIRE_REQUEST_SIGNATURE) {
        throw new Error("No browser wallet detected for request signing.");
      }

      const request: PaymentRequest = {
        ...unsignedRequest,
        ...(signed ?? {}),
      };

      const requestRecord: RequestRecord = {
        request,
        status: "pending",
        createdAt: now,
        updatedAt: Date.now(),
        signatureVerified: Boolean(request.requestSignature && request.requestSigner),
      };
      const generatedRequestLink = `${window.location.origin}${toPayerRequestUrl(encodeRequest(request))}`;

      const persisted = await persistRequestRecord(requestRecord, activeAccount.address, setRequestSyncError);
      if (!persisted) {
        throw new Error(requestSyncError ?? "Request sync unavailable. Unable to publish this request.");
      }

      addRequestRecord(request);
      setActiveRequestId(request.requestId);
      setIsQrFullscreen(true);
      setRequestBackendReachable(true);

      if (navigator.share) {
        void navigator
          .share({
            title: "GhostPay request",
            text: request.memo || "Pay this request",
            url: generatedRequestLink,
          })
          .catch(() => {
            // Ignore dismissed share sheets.
          });
      }
      await refreshHistory();
      await refresh();
    } catch (err) {
      setWalletActionError((err as Error).message || "Failed to create request.");
    } finally {
      setIsCreatingRequest(false);
    }
  };

  const payWithPrivateTransfer = async () => {
    if (!payerRequest || !payerTokenMeta) return;
    if (payerTokenMeta.isCustom && !isValidAddress(payerTokenMeta.address)) {
      setSendErrorMessage("Cannot pay with unresolved custom token.");
      return;
    }
    if (!activeAccount || !walletExists) {
      setSendErrorMessage("Create/open your private wallet to continue.");
      return;
    }

    resetSend();
    setSendErrorMessage(null);
    setActiveClaimId(null);
    let claimId: string | null = null;
    let paymentTxHash: string | undefined;
    let transferSucceeded = false;
    try {
      claimId = crypto.randomUUID();
      const claimed = await postRequestAction(payerRequest.requestId, "claim", {
        claimant: activeAccount?.address,
        claimId,
      });
      claimId = claimed.claimId ?? claimId;
      setPayerRequestRecord(claimed);
      setActiveClaimId(claimId);
      markRequestProcessing(payerRequest.requestId, claimId);

      const result = await triggerSend([
        {
          token: payerRequest.token,
          recipient: payerRequest.recipient,
          amount: BigInt(payerRequest.amount),
        },
      ]);
      setSendTxId(result.relayId);

      const status = await waitForConfirmation(result.relayId, { timeout: 300_000 });
      if (status.state !== "succeeded") {
        throw new Error(`Payment ended as ${status.state}`);
      }
      transferSucceeded = true;
      paymentTxHash = status.txHash;

      const completedEntry = {
        request: payerRequest,
        status: "completed" as RequestStatus,
        createdAt: payerRecord?.createdAt || Date.now(),
        updatedAt: Date.now(),
        paidAt: Date.now(),
        paymentTxHash,
      } as RequestRecord;

      const completed = await postRequestAction(payerRequest.requestId, "complete", {
        claimId: claimId || undefined,
        paymentTxHash,
        claimant: activeAccount?.address,
      });
      setPayerRequestRecord(completed);
      await persistRequestRecord(completedEntry, payerRequest.recipient);

      markRequestCompleted(payerRequest.requestId, paymentTxHash);

      if (payerRequest.singleUse) {
        markRequestConsumedByPayer(payerRequest.requestId);
      }

      setLastReceipt({
        memo: payerRequest.memo,
        amount: BigInt(payerRequest.amount),
        tokenSymbol: payerTokenMeta.symbol,
        tokenDecimals: payerTokenMeta.decimals,
        txHash: status.txHash,
      });
      setReceiptOpen(true);
      setActiveClaimId(null);
    } catch (err) {
      if (claimId && !transferSucceeded) {
        markRequestFailed(payerRequest.requestId);
        try {
          const restored = await postRequestAction(payerRequest.requestId, "fail", {
            claimId,
            claimant: activeAccount?.address,
          });
          setPayerRequestRecord(restored);
          markRequestPending(payerRequest.requestId);
        } catch {
          setPayerRequestRecord((current) =>
            current?.request.requestId === payerRequest.requestId
              ? {
                  ...current,
                  status: "failed",
                  updatedAt: Date.now(),
                }
              : current
          );
        }
        setSendErrorMessage((err as Error).message || "Payment failed.");
      } else if (transferSucceeded) {
        markRequestCompleted(payerRequest.requestId, paymentTxHash);
        setLastReceipt({
          memo: payerRequest.memo,
          amount: BigInt(payerRequest.amount),
          tokenSymbol: payerTokenMeta.symbol,
          tokenDecimals: payerTokenMeta.decimals,
          txHash: paymentTxHash,
        });
        setReceiptOpen(true);
        setSendErrorMessage("Payment was sent, but request completion could not be confirmed. Try refreshing.");
      } else {
        markRequestFailed(payerRequest.requestId);
        const errorMessage = err instanceof Error ? err.message : "Payment failed.";
        setSendErrorMessage(errorMessage);
      }
      setActiveClaimId(null);
    }
  };

  const doDeposit = async () => {
    if (!payerRequest || !payerTokenMeta) return;
    if (payerTokenMeta.isCustom && !isValidAddress(payerTokenMeta.address)) {
      setDepositErrorMessage("Cannot deposit with unresolved custom token.");
      return;
    }

    resetDeposit();
    setDepositErrorMessage(null);
    try {
      const depositor = await connectToBrowserWallet();
      const result = await triggerDeposit([
        {
          token: payerRequest.token,
          amount: BigInt(payerRequest.amount),
          depositor,
        },
      ]);
      setDepositTxId(result.relayId);

      const txHash = await window.ethereum!.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: depositor,
            to: result.to,
            data: result.calldata,
            value: `0x${result.value.toString(16)}`,
          },
        ],
      });

      if (!txHash || typeof txHash !== "string") {
        throw new Error("Wallet did not return a transaction hash.");
      }

      const status = await waitForConfirmation(result.relayId, { timeout: 300_000 });
      if (status.state !== "succeeded") {
        throw new Error(`Deposit ended as ${status.state}`);
      }
      await refresh();
      await refreshHistory();
    } catch (err) {
      setDepositErrorMessage((err as Error).message || "Deposit failed.");
    }
  };

  const doWithdraw = async () => {
    resetWithdraw();
    setWithdrawErrorMessage(null);

    if (!activeAccount) {
      setWithdrawErrorMessage("Create/select a private account first.");
      return;
    }

    if (withdrawTokenMeta.isCustom && !isValidAddress(withdrawTokenMeta.address)) {
      setWithdrawErrorMessage("Set a valid custom withdrawal token address first.");
      return;
    }

    if (!withdrawTo) {
      setWithdrawErrorMessage("Set a recipient EOA first.");
      return;
    }

    const token = withdrawTokenMeta;
    try {
      const amount = parseAmount(withdrawAmountInput, token.decimals);
      if (amount <= 0n) {
        setWithdrawErrorMessage("Amount must be greater than 0.");
        return;
      }
      const walletBalance = tokenBalanceFor(allBalances, token.address);
      if (amount > walletBalance) {
        setWithdrawErrorMessage(`Insufficient private balance for ${token.symbol}.`);
        return;
      }

      const result = await triggerWithdraw([
        {
          token: token.address,
          amount,
          recipient: withdrawTo,
        },
      ]);
      setWithdrawTxId(result.relayId);
      const status = await waitForConfirmation(result.relayId, { timeout: 300_000 });
      if (status.state !== "succeeded") {
        throw new Error(`Withdrawal ended as ${status.state}`);
      }
      await refresh();
      await refreshHistory();
    } catch (err) {
      setWithdrawErrorMessage((err as Error).message || "Withdraw failed.");
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyHint("Copied to clipboard");
      window.setTimeout(() => setCopyHint(null), 1200);
    } catch {
      // no-op
    }
  };

  const shareRequest = async () => {
    if (!requestShareLink) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "GhostPay request",
          text: activeRequest?.request.memo || "Pay this request",
          url: requestShareLink,
        });
        return;
      } catch {
        // Fallback to copy for rejected shares.
      }
    }
    await copy(requestShareLink);
  };

  const modeTitle = mode === "merchant" ? "Charge" : mode === "payer" ? "Scan & Pay" : "Withdraw";
  const modeSubtitle =
    mode === "merchant"
      ? "Create a payment request"
      : mode === "payer"
        ? "Scan and complete payment"
        : "Move funds to your public wallet";
  const walletRows = tokenPreviewTokenRows(allBalances);
  const walletPrimaryBalance =
    walletRows.find((entry) => entry.balance > 0n) ??
    walletRows.find((entry) => entry.token.address === DEFAULT_PAYMENT_TOKEN) ??
    walletRows[0];
  const topBalanceSummary = walletPrimaryBalance
    ? `${formatAmount(walletPrimaryBalance.balance, walletPrimaryBalance.token.decimals)} ${walletPrimaryBalance.token.symbol}`
    : "No balance yet";
  const walletExpandedSummary = walletRows
    .map((entry) => `${entry.token.symbol} ${formatAmount(entry.balance, entry.token.decimals)}`)
    .join(" · ");

  return (
    <div className="app-shell">
      <div className="app-card">
        <header className="app-header">
          <div>
            <p className="eyebrow">Tap2Pay</p>
            <h1>{modeTitle}</h1>
            <p className="subtle">{modeSubtitle}</p>
          </div>
        </header>

        <section className="wallet-pill">
          <div className="wallet-topline">
            <p className="subtle wallet-status-line">
              {!ready ? (
                "Preparing private wallet..."
              ) : walletExists ? (
                <>
                  <span>Wallet ready</span>
                  {activeAccount ? <span>·</span> : null}
                  <span className="wallet-address-pill">{activeAccount ? `(${compactAddress(activeAccount.address)})` : ""}</span>
                  {activeAccount ? <span>·</span> : null}
                  <span className="wallet-balance-pill">{topBalanceSummary}</span>
                </>
              ) : (
                "Wallet setup required"
              )}
            </p>
            {ready && !walletExists && (
              <button onClick={openWalletSetup} disabled={busy}>
                Set up wallet
              </button>
            )}
            {ready && walletExists && (
              <button
                className="ghost wallet-collapse-toggle"
                onClick={() => setWalletSummaryExpanded((current) => !current)}
                title={walletSummaryExpanded ? "Hide wallet details" : "Show wallet details"}
              >
                {walletSummaryExpanded ? "Less" : "Details"}
              </button>
            )}
          </div>

          {ready && walletExists && walletSummaryExpanded && (
            <div className="wallet-details">
              <div className="wallet-compact">
                <p className="subtle">{walletExpandedSummary}</p>
                <label className="wallet-setting-row">
                  <span>Settlement token</span>
                  <div className="token-select-shell token-select-shell-settings">
                    <TokenMark address={settlementTokenMeta.address} symbol={settlementTokenMeta.symbol} />
                    <select
                      value={settlementTokenAddress}
                      onChange={(event) => setSettlementTokenAddress(event.target.value)}
                      aria-label="Default settlement token"
                    >
                      {PAYMENT_TOKEN_OPTIONS.map((token) => (
                        <option key={`${token.address}-settings-settlement`} value={token.address}>
                          {token.label || token.symbol}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
                <div className="inline-actions">
                  {accounts.length === 0 && <button onClick={() => createAccount()}>Create account</button>}
                  <button className="ghost" onClick={() => refresh()}>
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          )}
          {walletActionError && <p className="error">{walletActionError}</p>}
          {unlinkError && <p className="error">{unlinkError.message}</p>}
          {mode === "merchant" && requestSyncError && <p className="subtle">{requestSyncError}</p>}
        </section>

        {mode === "merchant" && (
          <section className="flow-card">
            <h2>Amount</h2>

            <div className="amount-field amount-field-tokenized">
              <input
                ref={requestAmountInputRef}
                value={requestAmountInput}
                onChange={(event) => setRequestAmountInput(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
              <div className="token-select-shell">
                <TokenMark address={requestTokenMeta.address} symbol={requestTokenMeta.symbol} />
                <select
                  value={requestTokenAddress}
                  onChange={(event) => setRequestTokenAddress(event.target.value)}
                  aria-label="Payment token"
                >
                  {PAYMENT_TOKEN_OPTIONS.map((token) => (
                    <option key={`${token.address}-request`} value={token.address}>
                      {token.label || token.symbol}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label>
              What is this for? (optional)
              <input
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                placeholder="Coffee, haircut, ticket, etc."
              />
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={singleUse}
                onChange={(event) => setSingleUse(event.target.checked)}
              />
              Allow this request for one payment only
            </label>

            <button
              onClick={createNewRequest}
              disabled={!activeAccount || !requestAmountInput || isCreatingRequest}
              title={
                requestBackendReachable
                  ? "Create a request and keep it live for the payer."
                  : "Create a request and share it directly. Backend sync will update merchant history when available."
              }
            >
              {isCreatingRequest ? "Creating request..." : "Request money"}
            </button>
            {requestSignatureWarning && <p className="subtle">{requestSignatureWarning}</p>}

            {activeRequest && (
              <>
                <div className="qr-card">
                  <p className="strong">
                    {formatMoney(activeRequest.request.amount, {
                      address: activeRequest.request.token,
                      symbol: activeRequest.request.tokenSymbol,
                      decimals: activeRequest.request.tokenDecimals,
                    })}
                  </p>
                  <p className="subtle">{activeRequest.request.memo || "No description"}</p>
                  <div className="qr-wrap">
                    <QRCodeSVG
                      value={requestShareLink}
                      size={248}
                      level="H"
                      includeMargin
                      bgColor="#ffffff"
                      fgColor="#0f172a"
                    />
                  </div>
                  <div className="inline-actions">
                    <button className="ghost" onClick={() => copy(requestShareLink)}>
                      Copy link
                    </button>
                    <button className="ghost" onClick={shareRequest}>Share</button>
                    <button className="ghost" onClick={() => setIsQrFullscreen(true)}>QR</button>
                  </div>
                </div>
              <section className="history">
                <p className="section-tag">Recent payment requests</p>
                {merchantRecentRequests.length === 0 ? (
                  <p className="empty">No requests yet.</p>
                ) : (
                  <ul>
                    {merchantRecentRequests.map((entry) => {
                      const label = formatMoney(entry.request.amount, {
                        address: entry.request.token,
                        symbol: entry.request.tokenSymbol,
                        decimals: entry.request.tokenDecimals,
                      });
                      return (
                        <li key={entry.request.requestId}>
                          <div>{label}</div>
                          <div className="status-line">
                            <span>{requestStatusLabel(entry.status)}</span>
                            <span>·</span>
                            <span>{formatRelativeTime(entry.updatedAt)}</span>
                            <span>·</span>
                            <span>{entry.request.memo || "No memo"}</span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              </>
            )}
            {copyHint && <p className="subtle">{copyHint}</p>}
          </section>
        )}

        {mode === "payer" && (
          <section className="flow-card">
            {!payerRequest ? (
              <>
                <p className="section-tag">Scan</p>
                <h2>Point camera at QR</h2>

                {!walletExists ? (
                  <div className="details-card">
                    <p>Set up your private wallet once, then scanning and payment is instant.</p>
                    <button onClick={openWalletSetup} disabled={busy}>
                      Set up wallet
                    </button>
                  </div>
                ) : !activeAccount ? (
                  <div className="details-card">
                    <p>Create a private account before scanning a payment code.</p>
                    <button onClick={() => createAccount()} disabled={busy}>
                      Create account
                    </button>
                  </div>
                ) : (
                  <>
                    <div className={`scanner-card ${cameraOpen ? "live" : ""}`}>
                      {cameraOpen ? (
                        <video ref={scannerVideoRef} className="scanner-video" autoPlay muted playsInline />
                      ) : (
                        <div className="scanner-placeholder">Opening camera</div>
                      )}
                    </div>

                    <p className="subtle">Align the code in the camera frame to continue.</p>
                  </>
                )}

                {scanError && <p className="error">{scanError}</p>}
                {payerRequestRecordError && <p className="error">{payerRequestRecordError}</p>}
              </>
            ) : (
              <>
                <p className="section-tag">Pay</p>
                <h2>{payerRequest.merchantName || "Merchant"}</h2>
                <p className="checkout-amount">
                  {payerTokenMeta ? formatMoney(payerRequest.amount, payerTokenMeta) : payerRequest.amount}
                </p>
                {payerRequest.memo && <p className="checkout-note">{payerRequest.memo}</p>}

                <p className="subtle">Wallet balance: {payerTokenMeta ? formatMoney(payerBalance, payerTokenMeta) : "0"}</p>
                {payerStatusHint && <p className="subtle">{payerStatusHint}</p>}
                {payerRequestIntegrityWarning && <p className="subtle">{payerRequestIntegrityWarning}</p>}

                {!requestExpired && payerBalance < payerAmount && (
                  <div className="details-card">
                    <p>Not enough balance.</p>
                    <button onClick={doDeposit} disabled={depositPending || !walletExists}>
                      {depositPending ? "Depositing..." : "Add funds"}
                    </button>
                    {depositTxStatus.txHash && (
                      <a href={`${MONAD_EXPLORER}/tx/${depositTxStatus.txHash}`} target="_blank" rel="noreferrer">
                        View deposit tx
                      </a>
                    )}
                    {showDepositProgress && (
                      <div className="stepper" role="status" aria-live="polite">
                        <span className={`dot ${depositPhase >= 0 ? "on" : ""}`}>Preparing proof</span>
                        <span className={`dot ${depositPhase >= 1 ? "on" : ""}`}>Relaying</span>
                        <span className={`dot ${depositPhase >= 2 ? "on" : ""}`}>Confirmed</span>
                      </div>
                    )}
                    <a href={MONAD_FAUCET} target="_blank" rel="noreferrer">
                      Monad faucet
                    </a>
                    {depositErrorMessage && <p className="error">{depositErrorMessage}</p>}
                    {depositHookError && <p className="error">{depositHookError.message}</p>}
                  </div>
                )}

                {requestNeedsExchange && (
                  <p className="subtle">
                    Request asks for {payerRequest.tokenSymbol} and prefers settlement as {payerRequest.settlementTokenSymbol}.
                  </p>
                )}

                <button
                  onClick={payWithPrivateTransfer}
                  disabled={!canPay || sendPending || txPhase(sendTxStatus.state, sendTxStatus.isLoading) > 0}
                  title={payerStatusHint || "Pay from your private wallet."}
                  className="payment-primary"
                >
                  {sendPending || txPhase(sendTxStatus.state, sendTxStatus.isLoading) > 0
                    ? "Processing payment..."
                    : `Pay ${payerTokenMeta ? formatMoney(payerRequest.amount, payerTokenMeta) : ""}`}
                </button>
                {showSendProgress && (
                  <div className="stepper" role="status" aria-live="polite">
                    <span className={`dot ${sendPhase >= 0 ? "on" : ""}`}>Preparing proof</span>
                    <span className={`dot ${sendPhase >= 1 ? "on" : ""}`}>Relaying</span>
                    <span className={`dot ${sendPhase >= 2 ? "on" : ""}`}>Confirmed</span>
                  </div>
                )}
                {sendTxStatus.txHash && (
                  <a href={`${MONAD_EXPLORER}/tx/${sendTxStatus.txHash}`} target="_blank" rel="noreferrer">
                    View payment tx
                  </a>
                )}
                {sendErrorMessage && <p className="error">{sendErrorMessage}</p>}
                {sendHookError && <p className="error">{sendHookError.message}</p>}

                <div className="inline-actions">
                  <button
                    className="ghost"
                    onClick={() => {
                      openMode("payer");
                      setPayerRequestRecord(null);
                      setPayerRequestRecordError(null);
                    }}
                  >
                    Scan another code
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {mode === "withdraw" && (
          <section className="flow-card">
            <p className="section-tag">Withdraw</p>
            <h2>Send to public wallet</h2>

            {!walletExists ? (
              <div className="details-card">
                <p>Create a private wallet before withdrawing funds.</p>
                <button onClick={openWalletSetup} disabled={busy}>
                  Set up wallet
                </button>
              </div>
            ) : !activeAccount ? (
              <div className="details-card">
                <p>Create a private account before withdrawing.</p>
                <button onClick={() => createAccount()} disabled={busy}>
                  Create account
                </button>
              </div>
            ) : (
              <>
                <label>
                  Recipient address
                  <input value={withdrawTo} onChange={(event) => setWithdrawTo(event.target.value)} placeholder="0x..." />
                </label>

                <label>
                  Amount ({withdrawTokenMeta.symbol})
                  <input
                    value={withdrawAmountInput}
                    onChange={(event) => setWithdrawAmountInput(event.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </label>

                <label>
                  Token
                  <select value={withdrawTokenAddress} onChange={(event) => setWithdrawTokenAddress(event.target.value)}>
                    {PREVIEW_TOKENS.map((token) => (
                      <option key={`${token.address}-withdraw`} value={token.address}>
                        {token.label || token.symbol}
                      </option>
                    ))}
                  </select>
                </label>

                <button onClick={doWithdraw} disabled={withdrawPending || !withdrawTo || !withdrawAmountInput}>
                  {withdrawPending ? "Withdrawing..." : "Withdraw"}
                </button>
                {showWithdrawProgress && (
                  <div className="stepper" role="status" aria-live="polite">
                    <span className={`dot ${withdrawPhase >= 0 ? "on" : ""}`}>Preparing proof</span>
                    <span className={`dot ${withdrawPhase >= 1 ? "on" : ""}`}>Relaying</span>
                    <span className={`dot ${withdrawPhase >= 2 ? "on" : ""}`}>Confirmed</span>
                  </div>
                )}
              </>
            )}

            {withdrawTxStatus.txHash && (
              <a href={`${MONAD_EXPLORER}/tx/${withdrawTxStatus.txHash}`} target="_blank" rel="noreferrer">
                View withdrawal tx
              </a>
            )}
            {withdrawErrorMessage && <p className="error">{withdrawErrorMessage}</p>}
            {withdrawHookError && <p className="error">{withdrawHookError.message}</p>}
          </section>
        )}

        <nav className="mode-dock" aria-label="Primary actions">
          {(
            [
              ["merchant", "Charge"],
              ["payer", "Scan & Pay"],
              ["withdraw", "Withdraw"],
            ] as const
          ).map(([dockMode, label]) => (
            <button
              key={dockMode}
              className={`dock-btn ${mode === dockMode ? "active" : ""}`}
              onClick={() => openMode(dockMode)}
              aria-current={mode === dockMode ? "page" : undefined}
            >
              <span className="dock-icon">
                <ModeIcon mode={dockMode} />
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>

      {isQrFullscreen && activeRequest && requestShareLink && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setIsQrFullscreen(false);
            }
          }}
        >
          <div className="modal qr-fullscreen">
            <h2>Scan to pay</h2>
            <p className="subtle">
              {activeRequest.request.memo || activeRequest.request.requestId} ·{" "}
              {formatMoney(activeRequest.request.amount, {
                address: activeRequest.request.token,
                symbol: activeRequest.request.tokenSymbol,
                decimals: activeRequest.request.tokenDecimals,
              })}
            </p>
            <div className="qr-wrap">
              <QRCodeSVG value={requestShareLink} size={460} level="H" includeMargin bgColor="#ffffff" fgColor="#0f172a" />
            </div>
            <div className="inline-actions">
              <button className="ghost" onClick={() => copy(requestShareLink)}>
                Copy link
              </button>
              <button onClick={() => setIsQrFullscreen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {showSeedModal && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setShowSeedModal(false);
              setAwaitingAccountCreation(false);
            }
          }}
        >
          <div className="modal">
            <h3>Save your seed phrase</h3>
            <p>Keep this offline and safe. This is your recovery path.</p>
            <textarea rows={4} readOnly value={seedPhrase} />
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={seedAcknowledged}
                onChange={(event) => setSeedAcknowledged(event.target.checked)}
              />
              I saved it
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowSeedModal(false)}>Close</button>
              <button onClick={continueAfterSeed} disabled={!seedAcknowledged}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {showWalletSetupModal && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              closeWalletSetup();
            }
          }}
        >
          <div className="modal">
            <h3>Wallet setup</h3>
            <p className="subtle">Create a fresh private wallet or restore one with your recovery phrase.</p>

            <div className="wallet-setup-actions">
              <button onClick={createWalletAndAccount} disabled={busy || isImportingWallet}>
                Create fresh wallet
              </button>
            </div>

            <label>
              Restore with recovery phrase
              <textarea
                rows={4}
                value={importSeedPhrase}
                onChange={(event) => setImportSeedPhrase(event.target.value)}
                placeholder="word1 word2 word3 ..."
              />
            </label>
            <button
              className="ghost"
              onClick={restoreWalletFromSeed}
              disabled={busy || isImportingWallet || !importSeedPhrase.trim()}
            >
              {isImportingWallet ? "Restoring..." : "Restore from phrase"}
            </button>
            {walletImportError && <p className="error">{walletImportError}</p>}
            <p className="wallet-setup-note">
              Recovery phrase restore is available through Unlink in this version.
            </p>

            <div className="modal-actions">
              <button className="ghost" onClick={closeWalletSetup}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {receiptOpen && lastReceipt && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.currentTarget === event.target) {
              setReceiptOpen(false);
            }
          }}
        >
          <div className="modal receipt">
            <h3>Paid privately</h3>
            <p>
              You paid{" "}
              <strong>
                {formatMoney(lastReceipt.amount, {
                  address: "",
                  symbol: lastReceipt.tokenSymbol,
                  decimals: lastReceipt.tokenDecimals,
                })}
              </strong>
            </p>
            <p>Memo: {lastReceipt.memo || "—"}</p>
            <p className="subtle">Private transfer is complete.</p>
            {lastReceipt.txHash && (
              <a href={`${MONAD_EXPLORER}/tx/${lastReceipt.txHash}`} target="_blank" rel="noreferrer">
                View on explorer
              </a>
            )}
            <div className="modal-actions">
              <button
                className="ghost"
                onClick={() =>
                  copy(
                    `GhostPay Receipt: ${lastReceipt.memo || "Payment"} — ${formatMoney(lastReceipt.amount, {
                      address: "",
                      symbol: lastReceipt.tokenSymbol,
                      decimals: lastReceipt.tokenDecimals,
                    })} • ${lastReceipt.txHash || "private transfer pending"}`
                  )
                }
              >
                Copy receipt
              </button>
              <button onClick={() => setReceiptOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
