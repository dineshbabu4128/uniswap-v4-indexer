/*
 * The preflight is the guard against the failure that already cost a full
 * deployment: syncing 3.44M events to head with no RPC configured, producing
 * zero fees and 18-decimal USDC while reporting 100% synced.
 *
 * These tests drive the exported helpers directly rather than the module's
 * auto-run, which is suppressed under vitest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  inspectChains,
  runPreflight,
  allowMissingRpc,
  explain,
} from "../src/handlers/preflight";

const AVALANCHE = 43114;
const RPC_VAR = "ENVIO_AVALANCHE_RPC_URL";
// No verified StateView address, so fee tracking is impossible with or without
// an RPC — this must warn, never throw.
const NO_STATE_VIEW = 137;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    [RPC_VAR]: process.env[RPC_VAR],
    ENVIO_ALLOW_MISSING_RPC: process.env.ENVIO_ALLOW_MISSING_RPC,
  };
  delete process.env[RPC_VAR];
  delete process.env.ENVIO_ALLOW_MISSING_RPC;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("preflight RPC check", () => {
  it("classifies a supported chain with no RPC as missing", () => {
    const r = inspectChains([AVALANCHE]);
    expect(r.missing).toEqual([{ chainId: AVALANCHE, envVar: RPC_VAR }]);
    expect(r.ready).toEqual([]);
  });

  it("classifies a supported chain with an RPC as ready", () => {
    process.env[RPC_VAR] = "https://example-archive.invalid";
    const r = inspectChains([AVALANCHE]);
    expect(r.ready).toEqual([AVALANCHE]);
    expect(r.missing).toEqual([]);
  });

  it("treats an empty-string RPC as missing, not as configured", () => {
    // A dashboard variable saved with no value is the likeliest near-miss.
    process.env[RPC_VAR] = "";
    expect(inspectChains([AVALANCHE]).missing).toHaveLength(1);
  });

  it("throws with an actionable message when the RPC is absent", () => {
    expect(() => runPreflight([AVALANCHE])).toThrow(/refusing to start/);
    expect(() => runPreflight([AVALANCHE])).toThrow(new RegExp(RPC_VAR));
  });

  it("names the archive requirement and the no-backfill consequence", () => {
    const message = explain(inspectChains([AVALANCHE]));
    expect(message).toMatch(/ARCHIVE/);
    expect(message).toMatch(/cannot be repaired in place/);
    // The point of the port is that traces are unnecessary; say so where the
    // operator is choosing an RPC tier.
    expect(message).toMatch(/does NOT need debug or trace/i);
  });

  it("does not throw once the RPC is set", () => {
    process.env[RPC_VAR] = "https://example-archive.invalid";
    expect(() => runPreflight([AVALANCHE])).not.toThrow();
  });

  it("downgrades to a warning when ENVIO_ALLOW_MISSING_RPC is set", () => {
    process.env.ENVIO_ALLOW_MISSING_RPC = "true";
    expect(allowMissingRpc()).toBe(true);
    expect(() => runPreflight([AVALANCHE])).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });

  it("ignores a non-truthy ENVIO_ALLOW_MISSING_RPC", () => {
    // "false" must not read as opt-in just by being present.
    process.env.ENVIO_ALLOW_MISSING_RPC = "false";
    expect(allowMissingRpc()).toBe(false);
    expect(() => runPreflight([AVALANCHE])).toThrow();
  });

  it("is fatal for the chains this build actually indexes", async () => {
    // The cases above pass a hand-written chain list. This one uses the real
    // one from the active codegen, so the guard cannot silently stop applying
    // to the deployment if config.yaml changes.
    const { indexer } = await import("envio");
    expect(indexer.chainIds).toContain(AVALANCHE);
    expect(() => runPreflight(indexer.chainIds)).toThrow(/refusing to start/);

    process.env[RPC_VAR] = "https://example-archive.invalid";
    expect(() => runPreflight(indexer.chainIds)).not.toThrow();
  });

  it("warns but never throws for a chain that cannot do fees at all", () => {
    const r = inspectChains([NO_STATE_VIEW]);
    expect(r.unsupported).toEqual([NO_STATE_VIEW]);
    expect(r.missing).toEqual([]);
    expect(() => runPreflight([NO_STATE_VIEW])).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });
});
