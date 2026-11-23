"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseTxError } from "@/lib/errors";
import { explorerTx } from "@/lib/format";
import { parsePubkey } from "@/lib/program";
import { sendSandboxIxs, type SandboxTxStage } from "@/lib/sandbox-send";
import { ataOf, fetchMintMeta, unpackAmount } from "@/lib/tokens";
import { useT } from "@/i18n/provider";
import { useRefresh, useSettings, useToasts } from "./providers";

export const SANDBOX_STORAGE_KEY = "veritas.sandbox.v1";

export type SessionMode = "real" | "sandbox" | "none";

export type SandboxBalance = {
  solLamports: number;
  usdtAtoms: bigint;
  usdtDecimals: number;
};

type StoredSandbox = {
  keypair: Keypair;
  active: boolean;
};

type GuestSessionCtx = {
  hydrated: boolean;
  mode: SessionMode;
  isReal: boolean;
  isSandbox: boolean;
  hasSavedKey: boolean;
  storageAvailable: boolean;
  keypair: Keypair | null;
  sandboxPublicKey: PublicKey | null;
  effectivePublicKey: PublicKey | null;
  entering: boolean;
  txPending: boolean;
  locked: boolean;
  balance: SandboxBalance | null;
  balanceLoading: boolean;
  enterSandbox: () => Promise<boolean>;
  refillSandbox: () => Promise<boolean>;
  exitSandbox: () => void;
  resetSandbox: () => Promise<boolean>;
  runSandbox: (
    label: string,
    build: () => Promise<TransactionInstruction[]>
  ) => Promise<string | null>;
  beginTx: () => boolean;
  endTx: () => void;
};

const GuestSessionContext = createContext<GuestSessionCtx | null>(null);

function readStoredSandbox():
  | { status: "ok"; data: StoredSandbox | null }
  | { status: "unavailable" } {
  if (typeof window === "undefined") return { status: "ok", data: null };
  try {
    const storage = window.localStorage;
    if (!storage) return { status: "unavailable" };
    const raw = storage.getItem(SANDBOX_STORAGE_KEY);
    if (!raw) {
      const probeKey = "__veritas_sandbox_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return { status: "ok", data: null };
    }
    const parsed = JSON.parse(raw) as { secretKey?: unknown; active?: unknown };
    if (!Array.isArray(parsed?.secretKey) || parsed.secretKey.length !== 64) {
      return { status: "ok", data: null };
    }
    const kp = Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey as number[]));
    return { status: "ok", data: { keypair: kp, active: Boolean(parsed.active) } };
  } catch {
    return { status: "unavailable" };
  }
}

function writeStoredSandbox(kp: Keypair, active: boolean): boolean {
  if (typeof window === "undefined") return false;
  try {
    const storage = window.localStorage;
    if (!storage) return false;
    storage.setItem(
      SANDBOX_STORAGE_KEY,
      JSON.stringify({ secretKey: Array.from(kp.secretKey), active })
    );
    return true;
  } catch {
    return false;
  }
}

function faucetErrorKey(code: string | undefined): string {
  switch (code) {
    case "ip_limit":
      return "errors.sandboxIpLimit";
    case "daily_sol_cap":
      return "errors.sandboxDailyCap";
    case "locked":
      return "errors.sandboxLocked";
    case "empty":
      return "errors.sandboxEmpty";
    case "disabled":
      return "errors.sandboxDisabled";
    default:
      return "errors.sandboxFaucetFailed";
  }
}

const MIN_USABLE_SOL_LAMPORTS = 5_000_000;

export function GuestSessionProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const { publicKey: realPublicKey, connected: realConnected } = useWallet();
  const { settings } = useSettings();
  const { push, update } = useToasts();
  const { nonce, bump } = useRefresh();
  const queryClient = useQueryClient();
  const t = useT();

  const [hydrated, setHydrated] = useState(false);
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [active, setActive] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [entering, setEntering] = useState(false);
  const [txPending, setTxPending] = useState(false);

  const keypairRef = useRef<Keypair | null>(null);
  const activeRef = useRef(false);
  const enteringRef = useRef(false);
  const txPendingRef = useRef(false);

  const commitKeypair = useCallback((kp: Keypair | null) => {
    keypairRef.current = kp;
    setKeypair(kp);
  }, []);

  const commitActive = useCallback((next: boolean) => {
    activeRef.current = next;
    setActive(next);
  }, []);

  const persist = useCallback((kp: Keypair, isActive: boolean) => {
    const ok = writeStoredSandbox(kp, isActive);
    setStorageAvailable(ok);
  }, []);

  useEffect(() => {
    const res = readStoredSandbox();
    if (res.status === "unavailable") {
      setStorageAvailable(false);
    } else if (res.data) {
      commitKeypair(res.data.keypair);
      commitActive(res.data.active);
    }
    setHydrated(true);
  }, [commitActive, commitKeypair]);

  const isRealConnected = Boolean(realConnected && realPublicKey);

  // Mutual exclusion: connecting a real wallet immediately switches to real mode
  // and suspends sandbox active flag without deleting the stored keypair.
  useEffect(() => {
    if (!isRealConnected || txPending) return;
    if (activeRef.current) {
      commitActive(false);
      if (keypairRef.current) {
        persist(keypairRef.current, false);
      }
    }
  }, [commitActive, isRealConnected, persist, txPending]);

  const mode: SessionMode =
    isRealConnected && !txPending
      ? "real"
      : active && keypair
        ? "sandbox"
        : "none";

  const isReal = mode === "real";
  const isSandbox = mode === "sandbox";
  const locked = entering || txPending;
  const sandboxPublicKey = keypair ? keypair.publicKey : null;
  const effectivePublicKey =
    mode === "real"
      ? realPublicKey ?? null
      : mode === "sandbox"
        ? sandboxPublicKey
        : null;

  const sandboxAddr = sandboxPublicKey?.toBase58() ?? "";
  const mintValid = Boolean(parsePubkey(settings.collateralMint));

  const balanceKeyFor = useCallback(
    (addr: string) => [
      "sandbox-balance",
      connection?.rpcEndpoint ?? settings.rpcUrl,
      settings.collateralMint,
      addr,
    ],
    [connection?.rpcEndpoint, settings.collateralMint, settings.rpcUrl]
  );

  const seedBalanceFromFaucet = useCallback(
    (
      addr: string,
      data: {
        solLamports?: number;
        usdtAtoms?: string | number;
        usdtDecimals?: number;
      }
    ) => {
      if (
        typeof data.solLamports !== "number" ||
        data.usdtAtoms === undefined ||
        data.usdtAtoms === null
      ) {
        return;
      }
      try {
        queryClient.setQueryData<SandboxBalance>(balanceKeyFor(addr), {
          solLamports: data.solLamports,
          usdtAtoms: BigInt(data.usdtAtoms),
          usdtDecimals:
            typeof data.usdtDecimals === "number" ? data.usdtDecimals : 6,
        });
      } catch {
        // Fallback to live RPC query if response numeric fields cannot be coerced.
      }
    },
    [balanceKeyFor, queryClient]
  );

  const balanceQuery = useQuery<SandboxBalance>({
    queryKey: balanceKeyFor(sandboxAddr),
    queryFn: async () => {
      const pk = keypairRef.current!.publicKey;
      const mint = new PublicKey(settings.collateralMint.trim());
      const [solLamports, meta] = await Promise.all([
        connection.getBalance(pk, "confirmed"),
        fetchMintMeta(connection, mint),
      ]);
      const ata = ataOf(mint, pk, meta.tokenProgram);
      const ataInfo = await connection.getAccountInfo(ata, "confirmed");
      const usdtAtoms = unpackAmount(ata, ataInfo, meta.tokenProgram);
      return { solLamports, usdtAtoms, usdtDecimals: meta.decimals };
    },
    enabled: Boolean(isSandbox && keypair && mintValid),
    refetchInterval: isSandbox ? 15_000 : false,
  });

  const prevNonceRef = useRef(nonce);
  useEffect(() => {
    if (prevNonceRef.current === nonce) return;
    prevNonceRef.current = nonce;
    if (isSandbox && sandboxAddr) {
      void queryClient.invalidateQueries({ queryKey: balanceKeyFor(sandboxAddr) });
    }
  }, [balanceKeyFor, isSandbox, nonce, queryClient, sandboxAddr]);

  const inspectExistingFunds = useCallback(
    async (pk: PublicKey): Promise<SandboxBalance | null> => {
      try {
        if (!parsePubkey(settings.collateralMint)) return null;
        const mint = new PublicKey(settings.collateralMint.trim());
        const [solLamports, meta] = await Promise.all([
          connection.getBalance(pk, "confirmed"),
          fetchMintMeta(connection, mint),
        ]);
        if (solLamports < MIN_USABLE_SOL_LAMPORTS) return null;
        const ata = ataOf(mint, pk, meta.tokenProgram);
        const ataInfo = await connection.getAccountInfo(ata, "confirmed");
        const usdtAtoms = unpackAmount(ata, ataInfo, meta.tokenProgram);
        if (usdtAtoms <= 0n) return null;
        return { solLamports, usdtAtoms, usdtDecimals: meta.decimals };
      } catch {
        return null;
      }
    },
    [connection, settings.collateralMint]
  );

  const requestSandboxFaucet = useCallback(
    async (address: string) => {
      const res = await fetch("/api/faucet/sandbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        skipped?: boolean;
        signature?: string | null;
        solLamports?: number;
        usdtAtoms?: string;
        usdtDecimals?: number;
        error?: string;
      };
      return { ok: res.ok, data };
    },
    []
  );

  const enterSandbox = useCallback(async (): Promise<boolean> => {
    if (enteringRef.current || txPendingRef.current || isRealConnected) return false;
    enteringRef.current = true;
    setEntering(true);

    const hadExistingKey = Boolean(keypairRef.current);
    const kp = keypairRef.current ?? Keypair.generate();
    const addr = kp.publicKey.toBase58();
    commitKeypair(kp);
    persist(kp, false);

    const toastId = push(
      "info",
      t("sandbox.enteringTitle"),
      t("sandbox.enteringBody"),
      undefined,
      { sticky: true }
    );

    try {
      const { ok, data } = await requestSandboxFaucet(addr);
      if (ok) {
        seedBalanceFromFaucet(addr, data);
        commitActive(true);
        persist(kp, true);
        const link = data.signature ? explorerTx(data.signature, settings.cluster) : null;
        update(toastId, {
          kind: "ok",
          title: t("sandbox.readyTitle"),
          detail: link ? t("tx.view") : t("sandbox.readyReused"),
          href: link ?? undefined,
          sticky: false,
          durationMs: link ? 7500 : 5000,
        });
        bump();
        return true;
      }

      const existing = hadExistingKey ? await inspectExistingFunds(kp.publicKey) : null;
      if (existing) {
        queryClient.setQueryData<SandboxBalance>(balanceKeyFor(addr), existing);
        commitActive(true);
        persist(kp, true);
        update(toastId, {
          kind: "ok",
          title: t("sandbox.readyTitle"),
          detail: t("sandbox.readyReused"),
          href: undefined,
          sticky: false,
          durationMs: 5000,
        });
        bump();
        return true;
      }

      update(toastId, {
        kind: "err",
        title: t("sandbox.enterFailedTitle"),
        detail: faucetErrorKey(data.error),
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } catch {
      const existing = hadExistingKey ? await inspectExistingFunds(kp.publicKey) : null;
      if (existing) {
        queryClient.setQueryData<SandboxBalance>(balanceKeyFor(addr), existing);
        commitActive(true);
        persist(kp, true);
        update(toastId, {
          kind: "ok",
          title: t("sandbox.readyTitle"),
          detail: t("sandbox.readyReused"),
          href: undefined,
          sticky: false,
          durationMs: 5000,
        });
        bump();
        return true;
      }
      update(toastId, {
        kind: "err",
        title: t("sandbox.enterFailedTitle"),
        detail: "errors.sandboxFaucetFailed",
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } finally {
      enteringRef.current = false;
      setEntering(false);
    }
  }, [
    balanceKeyFor,
    bump,
    commitActive,
    commitKeypair,
    inspectExistingFunds,
    isRealConnected,
    persist,
    push,
    queryClient,
    requestSandboxFaucet,
    seedBalanceFromFaucet,
    settings.cluster,
    t,
    update,
  ]);

  const refillSandbox = useCallback(async (): Promise<boolean> => {
    if (
      enteringRef.current ||
      txPendingRef.current ||
      isRealConnected ||
      !activeRef.current ||
      !keypairRef.current
    ) {
      return false;
    }
    enteringRef.current = true;
    setEntering(true);
    const kp = keypairRef.current;
    const addr = kp.publicKey.toBase58();

    const toastId = push(
      "info",
      t("sandbox.refillPendingTitle"),
      t("sandbox.enteringBody"),
      undefined,
      { sticky: true }
    );

    try {
      const { ok, data } = await requestSandboxFaucet(addr);
      if (ok) {
        seedBalanceFromFaucet(addr, data);
        const link = data.signature ? explorerTx(data.signature, settings.cluster) : null;
        update(toastId, {
          kind: "ok",
          title: data.skipped ? t("sandbox.alreadyFundedTitle") : t("sandbox.refillOkTitle"),
          detail: link ? t("tx.view") : t("sandbox.alreadyFundedBody"),
          href: link ?? undefined,
          sticky: false,
          durationMs: link ? 7500 : 5000,
        });
        bump();
        return true;
      }
      update(toastId, {
        kind: "err",
        title: t("sandbox.refillFailedTitle"),
        detail: faucetErrorKey(data.error),
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } catch {
      update(toastId, {
        kind: "err",
        title: t("sandbox.refillFailedTitle"),
        detail: "errors.sandboxFaucetFailed",
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } finally {
      enteringRef.current = false;
      setEntering(false);
    }
  }, [bump, isRealConnected, push, requestSandboxFaucet, seedBalanceFromFaucet, settings.cluster, t, update]);

  const exitSandbox = useCallback(() => {
    if (enteringRef.current || txPendingRef.current) return;
    commitActive(false);
    if (keypairRef.current) {
      persist(keypairRef.current, false);
    }
  }, [commitActive, persist]);

  const resetSandbox = useCallback(async (): Promise<boolean> => {
    if (enteringRef.current || txPendingRef.current || isRealConnected) return false;
    enteringRef.current = true;
    setEntering(true);

    const nextKp = Keypair.generate();
    const nextAddr = nextKp.publicKey.toBase58();
    const toastId = push(
      "info",
      t("sandbox.resettingTitle"),
      t("sandbox.enteringBody"),
      undefined,
      { sticky: true }
    );

    try {
      const { ok, data } = await requestSandboxFaucet(nextAddr);
      if (ok) {
        seedBalanceFromFaucet(nextAddr, data);
        commitKeypair(nextKp);
        commitActive(true);
        persist(nextKp, true);
        const link = data.signature ? explorerTx(data.signature, settings.cluster) : null;
        update(toastId, {
          kind: "ok",
          title: t("sandbox.resetOkTitle"),
          detail: link ? t("tx.view") : t("sandbox.readyReused"),
          href: link ?? undefined,
          sticky: false,
          durationMs: link ? 7500 : 5000,
        });
        bump();
        return true;
      }

      update(toastId, {
        kind: "err",
        title: t("sandbox.resetFailedTitle"),
        detail: faucetErrorKey(data.error),
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } catch {
      update(toastId, {
        kind: "err",
        title: t("sandbox.resetFailedTitle"),
        detail: "errors.sandboxFaucetFailed",
        href: undefined,
        sticky: false,
        durationMs: 6500,
      });
      return false;
    } finally {
      enteringRef.current = false;
      setEntering(false);
    }
  }, [
    bump,
    commitActive,
    commitKeypair,
    isRealConnected,
    persist,
    push,
    requestSandboxFaucet,
    seedBalanceFromFaucet,
    settings.cluster,
    t,
    update,
  ]);

  const beginTx = useCallback((): boolean => {
    if (enteringRef.current || txPendingRef.current) return false;
    txPendingRef.current = true;
    setTxPending(true);
    return true;
  }, []);

  const endTx = useCallback(() => {
    txPendingRef.current = false;
    setTxPending(false);
  }, []);

  const runSandbox = useCallback(
    async (
      label: string,
      build: () => Promise<TransactionInstruction[]>
    ): Promise<string | null> => {
      const kp = keypairRef.current;
      if (isRealConnected || !activeRef.current || !kp) {
        push("err", t("tx.failed", { label }), "errors.connectWallet");
        return null;
      }
      if (!beginTx()) return null;

      const toastId = push(
        "info",
        t("sandbox.txSigningTitle", { label }),
        t("sandbox.txSigningBody"),
        undefined,
        { sticky: true }
      );

      const applyStage = (stage: SandboxTxStage) => {
        if (stage.stage === "signing") {
          update(toastId, {
            kind: "info",
            title: t("sandbox.txSigningTitle", { label }),
            detail: t("sandbox.txSigningBody"),
            href: undefined,
            sticky: true,
          });
        } else if (stage.stage === "broadcasted") {
          const link = explorerTx(stage.signature, settings.cluster);
          update(toastId, {
            kind: "info",
            title: t("sandbox.txBroadcastTitle", { label }),
            detail: t("sandbox.txBroadcastBody"),
            href: link ?? undefined,
            sticky: true,
          });
        } else if (stage.stage === "confirmed") {
          const link = explorerTx(stage.signature, settings.cluster);
          update(toastId, {
            kind: "ok",
            title: t("sandbox.txConfirmedTitle", { label }),
            detail: link ? t("tx.view") : t("tx.confirmed"),
            href: link ?? undefined,
            sticky: false,
            durationMs: 8000,
          });
        }
      };

      try {
        const ixs = await build();
        const sig = await sendSandboxIxs(connection, kp, ixs, {
          onStage: applyStage,
        });
        bump();
        return sig;
      } catch (err) {
        update(toastId, {
          kind: "err",
          title: t("tx.failed", { label }),
          detail: parseTxError(err),
          href: undefined,
          sticky: false,
          durationMs: 6500,
        });
        return null;
      } finally {
        endTx();
      }
    },
    [beginTx, bump, connection, endTx, isRealConnected, push, settings.cluster, t, update]
  );

  const value = useMemo<GuestSessionCtx>(
    () => ({
      hydrated,
      mode,
      isReal,
      isSandbox,
      hasSavedKey: Boolean(keypair),
      storageAvailable,
      keypair,
      sandboxPublicKey,
      effectivePublicKey,
      entering,
      txPending,
      locked,
      balance: balanceQuery.data ?? null,
      balanceLoading: isSandbox ? balanceQuery.isPending : false,
      enterSandbox,
      refillSandbox,
      exitSandbox,
      resetSandbox,
      runSandbox,
      beginTx,
      endTx,
    }),
    [
      hydrated,
      mode,
      isReal,
      isSandbox,
      keypair,
      storageAvailable,
      sandboxPublicKey,
      effectivePublicKey,
      entering,
      txPending,
      locked,
      balanceQuery.data,
      balanceQuery.isPending,
      enterSandbox,
      refillSandbox,
      exitSandbox,
      resetSandbox,
      runSandbox,
      beginTx,
      endTx,
    ]
  );

  return (
    <GuestSessionContext.Provider value={value}>
      {children}
    </GuestSessionContext.Provider>
  );
}

export function useGuestSession(): GuestSessionCtx {
  const ctx = useContext(GuestSessionContext);
  const { publicKey: realPublicKey, connected: realConnected } = useWallet();
  if (ctx) return ctx;
  const realPk = realConnected && realPublicKey ? realPublicKey : null;
  return {
    hydrated: true,
    mode: realPk ? "real" : "none",
    isReal: Boolean(realPk),
    isSandbox: false,
    hasSavedKey: false,
    storageAvailable: true,
    keypair: null,
    sandboxPublicKey: null,
    effectivePublicKey: realPk,
    entering: false,
    txPending: false,
    locked: false,
    balance: null,
    balanceLoading: false,
    enterSandbox: async () => false,
    refillSandbox: async () => false,
    exitSandbox: () => {},
    resetSandbox: async () => false,
    runSandbox: async () => null,
    beginTx: () => false,
    endTx: () => {},
  };
}

export function useEffectivePublicKey(): PublicKey | null {
  return useGuestSession().effectivePublicKey;
}

export function useSandboxTx() {
  const { txPending, runSandbox } = useGuestSession();
  return { busy: txPending, runSandbox };
}
