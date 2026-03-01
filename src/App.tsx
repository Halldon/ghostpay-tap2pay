import {
  formatAmount,
  parseAmount,
  shortenHex,
  useDeposit,
  useSend,
  useTxStatus,
  useUnlink,
  useUnlinkBalances,
  useUnlinkHistory,
  useWithdraw,
} from "@unlink-xyz/react";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type Mode = "merchant" | "payer";

type RequestStatus = "pending" | "completed" | "expired" | "failed";

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
};

type RequestRecord = {
  request: PaymentRequest;
  status: RequestStatus;
  createdAt: number;
  updatedAt: number;
  paidAt?: number;
  paymentTxHash?: string;
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
const STORAGE_KEY = "ghostpay:requests:v2";
const PAYER_CLAIM_KEY = "ghostpay:payer-consumptions:v1";
const MONAD_EXPLORER = "https://testnet.monadexplorer.com";
const MONAD_FAUCET = "https://faucet.monad.xyz/";
const MONAD_RPC_CHAIN_ID_HEX = "0x279f";
const REQUEST_POLL_INTERVAL = 5_000;
const BACKEND_REQUEST_URL = (import.meta.env.VITE_GHOSTPAY_REQUEST_BACKEND || "").trim();

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

const DEFAULT_PAYMENT_TOKEN = USDC_TOKEN;

const PREVIEW_TOKENS = PAYMENT_TOKENS.filter((token) => !token.isCustom);

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
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
  const request = normalizePaymentRequest(candidate.request as Partial<PaymentRequest>);
  if (!request) return null;

  const normalizedRecord: RequestRecord = {
    request,
    status: normalizeRequestStatus(candidate.status),
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : request.createdAt,
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : request.createdAt,
  };

  if (typeof candidate.paidAt === "number") {
    normalizedRecord.paidAt = candidate.paidAt;
  }
  if (typeof candidate.paymentTxHash === "string") {
    normalizedRecord.paymentTxHash = candidate.paymentTxHash;
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
    },
  });
  if (!response.ok) {
    throw new Error(`Backend request sync failed (${response.status})`);
  }
  const payload = await response.json();
  return parseRequestHistoryResponse(payload);
}

async function upsertRequestRecord(record: RequestRecord, merchantAddress: string) {
  const base = BACKEND_REQUEST_URL;
  if (!base) return;
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        merchantAddress,
        ...record,
      }),
    });
    if (!response.ok) {
      throw new Error(`Backend request save failed (${response.status})`);
    }
  } catch {
    // Keep request flow resilient; sync may catch up once backend reconnects.
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

export default function App() {
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
  const [awaitingAccountCreation, setAwaitingAccountCreation] = useState(false);
  const [walletActionError, setWalletActionError] = useState<string | null>(null);
  const [requestSyncError, setRequestSyncError] = useState<string | null>(
    BACKEND_REQUEST_URL
      ? null
      : "Backend sync not configured. Requests can still be shared by link, but public multi-device refresh needs VITE_GHOSTPAY_REQUEST_BACKEND."
  );
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [isQrFullscreen, setIsQrFullscreen] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const [requestAmountInput, setRequestAmountInput] = useState("1.00");
  const [withdrawAmountInput, setWithdrawAmountInput] = useState("1.00");
  const [memo, setMemo] = useState("Coffee");
  const [merchantName, setMerchantName] = useState("Coffee Shop");
  const [expiryMinutes, setExpiryMinutes] = useState(10);
  const [singleUse, setSingleUse] = useState(true);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const [withdrawTo, setWithdrawTo] = useState("");

  const [requestTokenAddress, setRequestTokenAddress] = useState<string>(DEFAULT_PAYMENT_TOKEN);
  const [settlementTokenAddress, setSettlementTokenAddress] = useState<string>(DEFAULT_PAYMENT_TOKEN);
  const [withdrawTokenAddress, setWithdrawTokenAddress] = useState<string>(DEFAULT_PAYMENT_TOKEN);
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const [customTokenSymbol, setCustomTokenSymbol] = useState("USDCX");
  const [customTokenDecimals, setCustomTokenDecimals] = useState(6);

  const [sendErrorMessage, setSendErrorMessage] = useState<string | null>(null);
  const [withdrawErrorMessage, setWithdrawErrorMessage] = useState<string | null>(null);
  const [depositErrorMessage, setDepositErrorMessage] = useState<string | null>(null);

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

  const requestTokenMeta = useMemo(
    () => metadataForSelection(requestTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals),
    [requestTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals]
  );
  const settlementTokenMeta = useMemo(
    () => metadataForSelection(settlementTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals),
    [settlementTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals]
  );
  const withdrawTokenMeta = useMemo(
    () => metadataForSelection(withdrawTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals),
    [withdrawTokenAddress, customTokenAddress, customTokenSymbol, customTokenDecimals]
  );

  const showCustomTokenPanel = useMemo(
    () =>
      requestTokenAddress === CUSTOM_TOKEN_KEY ||
      settlementTokenAddress === CUSTOM_TOKEN_KEY ||
      withdrawTokenAddress === CUSTOM_TOKEN_KEY,
    [requestTokenAddress, settlementTokenAddress, withdrawTokenAddress]
  );

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
    const listener = () => setSearch(window.location.search);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  useEffect(() => {
    saveRequestRecords(records);
  }, [records]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const hasRequest = !!params.get("request");
    const requestedMode = params.get("mode");
    if (hasRequest || requestedMode === "payer") {
      setMode("payer");
    } else {
      setMode("merchant");
    }
  }, [search]);

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
        setRecords((current) => mergeRequestRecords(current, remoteRecords));
        setRequestSyncError(null);
      } catch (error) {
        if (!ignore) {
          setRequestSyncError("Request sync unavailable; retrying.");
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

      if (mutated && activeAccount) {
        updates.forEach((entry) => {
          const requestRecord = next.find((record) => record.request.requestId === entry.requestId);
          if (requestRecord) {
            void upsertRequestRecord(
              {
                ...requestRecord,
                status: "completed" as RequestStatus,
                paymentTxHash: entry.paymentTxHash ?? requestRecord.paymentTxHash,
              },
              activeAccount.address
            );
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

  const activeRequest = useMemo(() => {
    if (activeRequestId) {
      return records.find((entry) => entry.request.requestId === activeRequestId) ?? records[0] ?? null;
    }
    return records[0] ?? null;
  }, [activeRequestId, records]);

  const payerRequest = requestFromLink;
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

  const payerBalance = payerRequest ? tokenBalanceFor(allBalances, payerRequest.token) : 0n;
  const payerAmount = payerRequest ? BigInt(payerRequest.amount) : 0n;
  const payerRecord = payerRequest
    ? records.find((entry) => entry.request.requestId === payerRequest.requestId)
    : null;

  const requestExpired = payerRequest ? payerRequest.expiresAt <= Date.now() : true;
  const requestSingleUseConsumed =
    !!payerRequest &&
    payerRequest.singleUse &&
    (payerRecord?.status === "completed" ||
      (payerConsumedMap[payerRequest.requestId] ? true : false));
  const requestNeedsExchange =
    payerRequest && payerSettlementMeta
      ? normalizeAddress(payerRequest.token) !== normalizeAddress(payerSettlementMeta.address)
      : false;

  const canPay =
    Boolean(
      payerRequest &&
        !requestExpired &&
        !requestSingleUseConsumed &&
        activeAccount &&
        walletExists &&
        payerBalance >= payerAmount
    );

  const requestShareLink = useMemo(() => {
    if (!activeRequest) return "";
    const encoded = encodeRequest(activeRequest.request);
    return `${window.location.origin}${window.location.pathname}?mode=payer&request=${encodeURIComponent(encoded)}`;
  }, [activeRequest]);

  const payerRequestLink = useMemo(() => {
    if (!payerRequest) return "";
    const encoded = encodeRequest(payerRequest);
    return `${window.location.origin}${window.location.pathname}?mode=payer&request=${encodeURIComponent(encoded)}`;
  }, [payerRequest]);

  const canPayerCopy = Boolean(payerRequest);
  const payerStatusHint = useMemo(() => {
    if (!payerRequest) return "";
    if (requestExpired) return "Request expired. Ask merchant for a new one.";
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
  }, [payerRequest, requestExpired, requestSingleUseConsumed, walletExists, activeAccount, payerTokenMeta, payerBalance, payerAmount]);

  const counts = useMemo(
    () => ({
      completed: records.filter((entry) => entry.status === "completed").length,
      pending: records.filter((entry) => entry.status === "pending").length,
      expired: records.filter((entry) => entry.status === "expired").length,
      failed: records.filter((entry) => entry.status === "failed").length,
    }),
    [records]
  );

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
    if (activeAccount) {
      void upsertRequestRecord(record, activeAccount.address);
    }
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

  const persistRequestRecord = (record: RequestRecord, merchantAddress?: string) => {
    if (!merchantAddress) return;
    void upsertRequestRecord(record, merchantAddress);
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
    url.searchParams.set("mode", next);
    const nextSearch = `${url.pathname}${url.search}`;
    window.history.pushState({}, "", nextSearch);
    setSearch(url.search || "");
    setMode(next);
  };

  const createWalletAndAccount = async () => {
    setWalletActionError(null);
    try {
      const result = await createWallet();
      setSeedPhrase(result.mnemonic);
      setSeedAcknowledged(false);
      setShowSeedModal(true);
      setAwaitingAccountCreation(true);
    } catch (err) {
      setWalletActionError((err as Error).message || "Wallet creation failed.");
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
    try {
      const now = Date.now();
      const amount = parseAmount(requestAmountInput, requestTokenMeta.decimals);
      if (amount <= 0n) {
        setWalletActionError("Amount must be greater than zero.");
        return;
      }
      const request: PaymentRequest = {
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
        expiresAt: now + expiryMinutes * 60_000,
        singleUse,
        merchantName: merchantName.trim() || "Merchant",
        exchangeRequested: requestTokenMeta.address.toLowerCase() !== settlementTokenMeta.address.toLowerCase(),
      };

      const requestRecord: RequestRecord = {
        request,
        status: "pending",
        createdAt: now,
        updatedAt: Date.now(),
      };

      addRequestRecord(request);
      setActiveRequestId(request.requestId);
      persistRequestRecord(requestRecord, activeAccount.address);
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

    resetSend();
    setSendErrorMessage(null);
    try {
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

      markRequestCompleted(payerRequest.requestId, status.txHash);
      persistRequestRecord(
        {
          request: payerRequest,
          status: "completed" as RequestStatus,
          createdAt: payerRecord?.createdAt || Date.now(),
          updatedAt: Date.now(),
          paidAt: Date.now(),
          paymentTxHash: status.txHash,
        },
        payerRequest.recipient
      );
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
    } catch (err) {
      setSendErrorMessage((err as Error).message || "Payment failed.");
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

  return (
    <div className="shell">
      <header className="header">
        <h1>GhostPay</h1>
        <p>Private tap-to-pay on Monad Testnet with Unlink</p>
        <div className="chips">
          <button className={`chip ${mode === "merchant" ? "active" : ""}`} onClick={() => openMode("merchant")}>
            Merchant
          </button>
          <button className={`chip ${mode === "payer" ? "active" : ""}`} onClick={() => openMode("payer")}>
            Payer
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="card wallet-card">
          <h2>Wallet onboarding</h2>
          {!ready && <p>Starting Unlink provider…</p>}
          {ready && !walletExists && (
            <>
              <p>No private wallet found.</p>
              <button onClick={createWalletAndAccount} disabled={busy}>
                Create private wallet
              </button>
            </>
          )}
          {ready && walletExists && (
            <>
              <p>
                Private account: <strong>{activeAccount ? activeAccount.address : "none"}</strong>
              </p>
              <p className="subtle">Accounts on device: {accounts.length}</p>
              {accounts.length === 0 && <button onClick={() => createAccount()}>Create first account</button>}
              <div className="panel">
                <h3>Private balances</h3>
                <ul className="balance-list">
                  {tokenPreviewTokenRows(allBalances).map((entry) => (
                    <li key={entry.token.address}>
                      {entry.token.symbol}: {formatMoney(entry.balance, entry.token)}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="subtle">Private Unlink sync status: {syncStatus || "idle"}</p>
              <p className="subtle">
                Deposits/withdrawals are public onchain. Unlink payment transfer stays private (amount/counterparty hidden).
              </p>
              <button className="ghost" onClick={() => refresh()}>
                Refresh balances
              </button>
            </>
          )}
          {walletActionError && <p className="error">{walletActionError}</p>}
          {unlinkError && <p className="error">{unlinkError.message}</p>}
          {requestSyncError && <p className="error">{requestSyncError}</p>}
        </section>

        {mode === "merchant" && (
          <section className="card create-card">
            <h2>Merchant Console</h2>

            <div className="row">
              <label>
                Amount ({requestTokenMeta.symbol})
                <input
                  value={requestAmountInput}
                  onChange={(e) => setRequestAmountInput(e.target.value)}
                />
              </label>
              <label>
                Pay token
                <select
                  value={requestTokenAddress}
                  onChange={(e) => setRequestTokenAddress(e.target.value)}
                >
                  {PAYMENT_TOKENS.map((token) => (
                    <option key={`${token.address}-request`} value={token.address}>
                      {token.label || token.symbol}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Settle to token
                <select
                  value={settlementTokenAddress}
                  onChange={(e) => setSettlementTokenAddress(e.target.value)}
                >
                  {PAYMENT_TOKENS.map((token) => (
                    <option key={`${token.address}-settlement`} value={token.address}>
                      {token.label || token.symbol}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {showCustomTokenPanel && (
              <div className="panel custom-token-panel">
                <h3>Custom token metadata</h3>
                <div className="row">
                  <label>
                    Address
                    <input
                      value={customTokenAddress}
                      onChange={(e) => setCustomTokenAddress(e.target.value)}
                      placeholder="0x..."
                    />
                  </label>
                  <label>
                    Symbol
                    <input
                      value={customTokenSymbol}
                      onChange={(e) => setCustomTokenSymbol(e.target.value)}
                      placeholder="CUSTOM"
                    />
                  </label>
                  <label>
                    Decimals
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={customTokenDecimals}
                      onChange={(e) => setCustomTokenDecimals(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="row">
              <label>
                Memo
                <input value={memo} onChange={(e) => setMemo(e.target.value)} />
              </label>
              <label>
                Merchant Name
                <input value={merchantName} onChange={(e) => setMerchantName(e.target.value)} />
              </label>
              <label>
                Expiry (minutes)
                <input
                  type="number"
                  min={1}
                  max={360}
                  value={expiryMinutes}
                  onChange={(e) => setExpiryMinutes(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            </div>

            <div className="toggles">
              <label>
                <input type="checkbox" checked={singleUse} onChange={(e) => setSingleUse(e.target.checked)} />
                Single-use request
              </label>
            </div>

            {requestTokenMeta.address !== settlementTokenMeta.address && (
              <p className="status">
                {requestTokenMeta.symbol} payment will be sent privately. Settlement preference is {settlementTokenMeta.symbol};
                auto-swap is not enabled in this MVP.
              </p>
            )}

            <button
              onClick={createNewRequest}
              disabled={!activeAccount || !requestAmountInput || isCreatingRequest}
              title={
                hasRequestBackend
                  ? "Create a request and keep it live for the payer."
                  : "Backend sync is currently unavailable. The request link will still work, but cross-device live updates require a backend URL."
              }
            >
              {isCreatingRequest ? "Creating request..." : "Create Request"}
            </button>
            <p className="subtle">
              Request sync: {hasRequestBackend ? "live backend sync enabled" : "local-only mode (copy/share request link manually)."}
            </p>
            {copyHint && <p className="subtle">{copyHint}</p>}

            <div className="request-meta">
              <h3>Request card</h3>
              {activeRequest ? (
                <>
                  <p>
                    Amount: {formatMoney(activeRequest.request.amount, {
                      address: activeRequest.request.token,
                      symbol: activeRequest.request.tokenSymbol,
                      decimals: activeRequest.request.tokenDecimals,
                    })}
                  </p>
                  <p>Pay token: {activeRequest.request.tokenSymbol}</p>
                  <p>
                    Settlement: {activeRequest.request.settlementTokenSymbol}
                    {activeRequest.request.exchangeRequested ? " (manual exchange required)" : ""}
                  </p>
                  <p>Memo: {activeRequest.request.memo || "—"}</p>
                  <p>Recipient: {shortenHex(activeRequest.request.recipient, 10)}</p>
                  <p>
                    Expires in: {Math.max(0, Math.floor((activeRequest.request.expiresAt - Date.now()) / 1000))}s
                  </p>
                </>
              ) : (
                <p>No active request.</p>
              )}
              <p className="link-line">
                Shareable link: <span>{requestShareLink || "—"}</span>
                <button className="xs" onClick={() => copy(requestShareLink)}>
                  Copy
                </button>
              </p>
            </div>

            <div className="qr-wrap">
              {activeRequest ? (
                <QRCodeSVG
                  value={requestShareLink}
                  size={240}
                  level="H"
                  includeMargin
                  bgColor="#101828"
                  fgColor="#f8fafc"
                />
              ) : (
                <div className="qr-placeholder">Create a request to generate a QR</div>
              )}
            </div>
            <div className="action-row">
              <button
                className="ghost"
                onClick={() => copy(requestShareLink)}
                disabled={!activeRequest}
              >
                Copy request link
              </button>
              <button
                className="ghost"
                onClick={() => setIsQrFullscreen(true)}
                disabled={!activeRequest}
              >
                Open QR fullscreen
              </button>
            </div>

            <div className="status">
              <div className="status-title">Payments Received</div>
              <p>
                {counts.completed} succeeded · {counts.pending} pending · {counts.expired} expired
              </p>
            </div>

            <section className="history">
              <h3>Private activity</h3>
              <ul>
                {records.map((entry) => {
                  const meta = {
                    address: entry.request.token,
                    symbol: entry.request.tokenSymbol,
                    decimals: entry.request.tokenDecimals,
                  };
                  return (
                    <li key={entry.request.requestId}>
                      <span>{entry.request.memo || "Request"}</span>
                      <span>{formatMoney(entry.request.amount, meta)}</span>
                      <span>{requestStatusLabel(entry.status)}</span>
                      <span>{formatRelativeTime(entry.createdAt)}</span>
                      <span>
                        {requestExchangeNeeded(entry.request)
                          ? `Settles in ${entry.request.settlementTokenSymbol}`
                          : ""}
                      </span>
                      {entry.paymentTxHash && (
                        <a
                          href={`${MONAD_EXPLORER}/tx/${entry.paymentTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          explorer
                        </a>
                      )}
                    </li>
                  );
                })}
                {records.length === 0 && <li className="empty">No requests yet.</li>}
              </ul>
            </section>
          </section>
        )}

      {mode === "payer" && (
          <section className="card payer-card">
            <h2>Payer Checkout</h2>
            {!payerRequest ? (
              <>
                <p>No valid request in URL.</p>
                <p>Use the payer mode link from merchant or ask them to show QR.</p>
                <p className="subtle">Example link: {payerRequestLink || "—"}</p>
              </>
            ) : (
              <>
                <div className="request-meta">
                  <h3>{payerRequest.merchantName || "Merchant"}</h3>
                  <p>
                    Amount: {payerTokenMeta ? formatMoney(payerRequest.amount, payerTokenMeta) : payerRequest.amount}
                  </p>
                  <p>Token: {payerRequest.tokenSymbol}</p>
                  <p>Settlement token: {payerRequest.settlementTokenSymbol}</p>
                  <p>Memo: {payerRequest.memo || "—"}</p>
                  <p>Recipient: {shortenHex(payerRequest.recipient, 10)}</p>
                  <p>Expires: {new Date(payerRequest.expiresAt).toLocaleString()}</p>
                  <p className={requestExpired ? "error" : "subtle"}>
                    {requestExpired ? "Request expired" : "Request active"}
                  </p>
                  {payerStatusHint && <p className={requestExpired ? "error" : "subtle"}>{payerStatusHint}</p>}
                  <p>Private balance: {payerTokenMeta ? formatMoney(payerBalance, payerTokenMeta) : "0"}</p>
                  {requestNeedsExchange && (
                    <p className="status">
                      This request pays in {payerRequest.tokenSymbol} but prefers {payerRequest.settlementTokenSymbol}. Automatic
                      exchange is not available in this MVP.
                    </p>
                  )}
                  {requestSingleUseConsumed && (
                    <p className="success">This single-use request was already paid.</p>
                  )}
                </div>

                {requestExpired && (
                  <p className="error">Payment request expired. Ask merchant for a new request.</p>
                )}

                {!requestExpired && payerBalance < payerAmount && (
                  <div className="panel">
                    <p>Insufficient private balance.</p>
                    <p>
                      1) {payerTokenMeta?.symbol === "MON" ? "Get MON" : "Get testnet funds"} from faucet: {" "}
                      <a href={MONAD_FAUCET} target="_blank" rel="noreferrer">
                        faucet.monad.xyz
                      </a>
                    </p>
                    <p>2) Deposit into private wallet with matching token</p>
                    <button onClick={doDeposit} disabled={depositPending || !walletExists}>
                      {depositPending ? "Submitting deposit" : "Deposit into private wallet"}
                    </button>
                    <p className="status-mini">{txStatusText(depositTxStatus.state)}</p>
                    {depositTxStatus.txHash && (
                      <a href={`${MONAD_EXPLORER}/tx/${depositTxStatus.txHash}`} target="_blank" rel="noreferrer">
                        Deposit tx
                      </a>
                    )}
                    {depositErrorMessage && <p className="error">{depositErrorMessage}</p>}
                    {depositHookError && <p className="error">{depositHookError.message}</p>}
                  </div>
                )}

                <div className="stepper">
                  <div className={`dot ${txPhase(sendTxStatus.state, sendTxStatus.isLoading) >= 0 ? "on" : ""}`}>
                    Preparing proof
                  </div>
                  <div className={`dot ${txPhase(sendTxStatus.state, sendTxStatus.isLoading) >= 1 ? "on" : ""}`}>
                    Relaying
                  </div>
                  <div className={`dot ${txPhase(sendTxStatus.state, sendTxStatus.isLoading) >= 2 ? "on" : ""}`}>
                    Confirmed
                  </div>
                </div>

                <button
                  onClick={payWithPrivateTransfer}
                  disabled={!canPay || sendPending || txPhase(sendTxStatus.state, sendTxStatus.isLoading) > 0}
                  title={payerStatusHint || "Execute private transfer."}
                >
                  {sendPending || txPhase(sendTxStatus.state, sendTxStatus.isLoading) > 0
                    ? "Preparing private proof..."
                    : "Pay Privately"}
                </button>
                <p className="status-mini">{txStatusText(sendTxStatus.state)}</p>
                {sendTxStatus.txHash && (
                  <a href={`${MONAD_EXPLORER}/tx/${sendTxStatus.txHash}`} target="_blank" rel="noreferrer">
                    Private transfer tx
                  </a>
                )}
                {sendErrorMessage && <p className="error">{sendErrorMessage}</p>}
                {sendHookError && <p className="error">{sendHookError.message}</p>}
              </>
            )}
          </section>
        )}

        {isQrFullscreen && activeRequest && requestShareLink && (
          <div className="modal-backdrop">
            <div className="modal qr-fullscreen">
              <h2>Scan to Pay</h2>
              <p className="subtle">
                {activeRequest.request.memo || activeRequest.request.requestId} ·{" "}
                {formatMoney(activeRequest.request.amount, {
                  address: activeRequest.request.token,
                  symbol: activeRequest.request.tokenSymbol,
                  decimals: activeRequest.request.tokenDecimals,
                })}
              </p>
              <div className="qr-wrap">
                <QRCodeSVG
                  value={requestShareLink}
                  size={460}
                  level="H"
                  includeMargin
                  bgColor="#101828"
                  fgColor="#f8fafc"
                />
              </div>
              <div className="action-row">
                <button className="ghost" onClick={() => copy(requestShareLink)}>
                  Copy request link
                </button>
                <button onClick={() => setIsQrFullscreen(false)}>Done</button>
              </div>
            </div>
          </div>
        )}

        <section className="card withdraw-card">
          <h2>Withdraw to public address</h2>
          <p className="subtle">Dramatic end-point for demos: convert back to public chain balance.</p>
          <label>
            Recipient EOA
            <input
              value={withdrawTo}
              onChange={(e) => setWithdrawTo(e.target.value)}
              placeholder="0x..."
            />
          </label>
          <label>
            Token
            <select value={withdrawTokenAddress} onChange={(e) => setWithdrawTokenAddress(e.target.value)}>
              {PAYMENT_TOKENS.map((token) => (
                <option key={`${token.address}-withdraw`} value={token.address}>
                  {token.label || token.symbol}
                </option>
              ))}
            </select>
          </label>

          <label>
            Amount ({withdrawTokenMeta.symbol})
            <input
              value={withdrawAmountInput}
              onChange={(e) => setWithdrawAmountInput(e.target.value)}
              placeholder="0.00"
            />
          </label>

          {withdrawTokenAddress === CUSTOM_TOKEN_KEY && (
            <div className="panel">
              <h3>Custom token metadata</h3>
              <div className="row">
                <label>
                  Address
                  <input
                    value={customTokenAddress}
                    onChange={(e) => setCustomTokenAddress(e.target.value)}
                    placeholder="0x..."
                  />
                </label>
                <label>
                  Symbol
                  <input
                    value={customTokenSymbol}
                    onChange={(e) => setCustomTokenSymbol(e.target.value)}
                    placeholder="CUSTOM"
                  />
                </label>
                <label>
                  Decimals
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={customTokenDecimals}
                    onChange={(e) => setCustomTokenDecimals(Math.max(0, Number(e.target.value) || 0))}
                  />
                </label>
              </div>
            </div>
          )}

          <button onClick={doWithdraw} disabled={withdrawPending || !withdrawTo || !activeAccount}>
            {withdrawPending ? "Preparing proof" : "Withdraw"}
          </button>
          <p className="status-mini">{txStatusText(withdrawTxStatus.state)}</p>
          {withdrawTxStatus.txHash && (
            <a href={`${MONAD_EXPLORER}/tx/${withdrawTxStatus.txHash}`} target="_blank" rel="noreferrer">
              Withdrawal tx
            </a>
          )}
          {withdrawErrorMessage && <p className="error">{withdrawErrorMessage}</p>}
          {withdrawHookError && <p className="error">{withdrawHookError.message}</p>}
        </section>
      </main>

      {showSeedModal && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Save your seed phrase</h3>
            <p>Keep this offline and safe. This is your recovery path.</p>
            <textarea rows={4} readOnly value={seedPhrase} />
            <label>
              <input
                type="checkbox"
                checked={seedAcknowledged}
                onChange={(e) => setSeedAcknowledged(e.target.checked)}
              />
              I saved it
            </label>
            <div className="modal-actions">
              <button onClick={() => setShowSeedModal(false)}>Keep open</button>
              <button onClick={continueAfterSeed} disabled={!seedAcknowledged}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {receiptOpen && lastReceipt && (
        <div className="modal-backdrop">
          <div className="modal receipt">
            <h3>Paid privately</h3>
            <p>
              You paid <strong>{formatMoney(lastReceipt.amount, { address: "", symbol: lastReceipt.tokenSymbol, decimals: lastReceipt.tokenDecimals })}</strong>
            </p>
            <p>Memo: {lastReceipt.memo || "—"}</p>
            <p className="subtle">
              Deposits and withdrawals are onchain, but this transfer amount/counterparty is private.
            </p>
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
                    `GhostPay Receipt: ${lastReceipt.memo || "Payment"} — ${formatMoney(
                      lastReceipt.amount,
                      {
                        address: "",
                        symbol: lastReceipt.tokenSymbol,
                        decimals: lastReceipt.tokenDecimals,
                      }
                    )} • ${lastReceipt.txHash || "private transfer pending"}`
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
