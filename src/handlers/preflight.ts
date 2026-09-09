/*
 * Startup preflight: refuse to index without the RPC that fee tracking needs.
 *
 * Not an event handler. envio auto-imports every file under src/handlers/, so
 * the check below runs once, at process start, before the first block is
 * fetched.
 *
 * WHY THIS EXISTS
 * ---------------
 * `feeTrackingEnabled()` degrades to "no fees" when its chain has no RPC URL.
 * That is the right behaviour for a chain we deliberately index without fees,
 * but it is silent, and silence is expensive here: a deployment that is missing
 * ENVIO_AVALANCHE_RPC_URL still syncs to head and still looks healthy — 100%
 * synced, millions of events, every entity populated — while every fee column
 * is zero and every token falls back to 18 decimals.
 *
 * That is not hypothetical. Deployment c345ef5 did exactly this: 3.44M events
 * processed, 8,967 positions written, collected fees zero on all of them,
 * 1,331 of 1,333 tokens left as UNKNOWN/18, and USDC recorded with 18 decimals
 * instead of 6 — which scales every amount on those pools by 1e12. Nothing in
 * the logs or the dashboard distinguished it from a good run.
 *
 * On a metered plan a wasted sync is not free, so failing at second zero with
 * an actionable message beats discovering it after the events are spent.
 */
import { indexer } from "envio";
import {
  RPC_ENV_BY_CHAIN,
  STATE_VIEW_BY_CHAIN,
  rpcUrlFor,
} from "../utils/positionAddresses";

export interface PreflightReport {
  /** Chains that will produce real fee data. */
  ready: number[];
  /** Chains whose RPC variable is supported but unset — the fatal case. */
  missing: { chainId: number; envVar: string }[];
  /** Chains with no verified StateView: fees are impossible regardless. */
  unsupported: number[];
}

/**
 * Classify every configured chain. Pure: takes the chain list and reads only
 * through `rpcUrlFor`, so a test can drive it without booting an indexer.
 */
export function inspectChains(chainIds: readonly number[]): PreflightReport {
  const report: PreflightReport = { ready: [], missing: [], unsupported: [] };

  for (const chainId of chainIds) {
    // No verified StateView address means fee tracking cannot work on this
    // chain at all, with or without an RPC. Worth saying out loud, but it is
    // not a misconfiguration the operator can fix by setting a variable.
    if (!STATE_VIEW_BY_CHAIN[chainId]) {
      report.unsupported.push(chainId);
      continue;
    }
    if (rpcUrlFor(chainId)) report.ready.push(chainId);
    else
      report.missing.push({
        chainId,
        envVar: RPC_ENV_BY_CHAIN[chainId] ?? `<no ENVIO_ var mapped for ${chainId}>`,
      });
  }

  return report;
}

/** The operator-facing explanation of a failed preflight. */
export function explain(report: PreflightReport): string {
  const names = report.missing.map((m) => `${m.envVar} (chain ${m.chainId})`);
  return (
    `Fee tracking is supported on this chain but its RPC URL is not set.\n` +
    `  Missing: ${names.join(", ")}\n\n` +
    `  Set it in the Envio dashboard under Environment Variables (the name must\n` +
    `  keep its ENVIO_ prefix), then redeploy. A restart alone will not backfill:\n` +
    `  collected fees are read with eth_call at each historical ModifyLiquidity\n` +
    `  block, so already-written positions cannot be repaired in place.\n\n` +
    `  The endpoint must be an ARCHIVE node — it serves eth_call at blocks from\n` +
    `  the pool's whole history. It does NOT need debug or trace methods.\n\n` +
    `  To index positions without fees on purpose, set ENVIO_ALLOW_MISSING_RPC=true.`
  );
}

/**
 * Escape hatch for the legitimate case: indexing positions WITHOUT fees, on
 * purpose. Deliberately not the default — the whole point is that the degraded
 * mode must be chosen, not fallen into.
 */
export function allowMissingRpc(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.ENVIO_ALLOW_MISSING_RPC ?? "");
}

/** Throws when a supported chain has no RPC, unless explicitly allowed. */
export function runPreflight(chainIds: readonly number[]): PreflightReport {
  const report = inspectChains(chainIds);

  for (const chainId of report.unsupported) {
    console.warn(
      `[preflight] chain ${chainId} has no verified StateView address, so fee ` +
        `tracking is off for it. Positions and liquidity are still indexed; ` +
        `collected and uncollected fees will be zero.`,
    );
  }

  if (report.missing.length === 0) {
    if (report.ready.length > 0) {
      console.log(
        `[preflight] fee tracking enabled for chain(s) ${report.ready.join(", ")}.`,
      );
    }
    return report;
  }

  if (allowMissingRpc()) {
    console.warn(
      `[preflight] ${explain(report)}\n\n` +
        `  ENVIO_ALLOW_MISSING_RPC is set, so continuing anyway. Fees WILL be zero\n` +
        `  and token decimals will fall back to 18.`,
    );
    return report;
  }

  // Thrown, not process.exit(): envio surfaces the message in the deployment
  // log, where the operator will actually read it.
  throw new Error(`[preflight] refusing to start.\n\n${explain(report)}\n`);
}

/*
 * Under vitest the RPC URL is injected by a beforeAll hook (the integration
 * suite points it at a mock JSON-RPC server on a random port), so it is
 * legitimately absent at import time. Auto-running here would fail every suite
 * before it could set it — the exported functions above are what the tests
 * drive instead.
 */
if (!process.env.VITEST) runPreflight(indexer.chainIds);
