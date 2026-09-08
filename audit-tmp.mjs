/*
 * Unbiased audit: does the no-trace method produce the same collected fees the
 * contract actually paid?
 *
 * Deliberately independent of the indexer:
 *   - positions chosen at RANDOM (not by size, not by disagreement)
 *   - the set of ModifyLiquidity events comes from eth_getLogs on the CHAIN,
 *     not from Envio's own rows, so Envio cannot validate itself
 *   - the reference figure is the contract's `feesAccrued` return value read
 *     via debug_traceTransaction, summed over the position's whole lifetime
 *
 * Then compares that sum against Envio's stored totalFeesCollected0/1.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { decodeFunctionData, toFunctionSelector } from "viem";

const url = fs.readFileSync(".env", "utf8").split("\n")
  .find((l) => l.startsWith("ENVIO_AVALANCHE_RPC_URL")).split("=")[1].replace(/^"|"$/g, "");
const POOL_MANAGER = "0x06380c0e0912312b5150364b9dc4542ba0dbbc85";
const T_MODIFY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
const DEPLOY = 56195376;
const SAMPLE = Number(process.env.SAMPLE ?? 20);

const ABI = [{
  type: "function", name: "modifyLiquidity", stateMutability: "nonpayable",
  inputs: [
    { name: "key", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" }] },
    { name: "params", type: "tuple", components: [
      { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" },
      { name: "liquidityDelta", type: "int256" }, { name: "salt", type: "bytes32" }] },
    { name: "hookData", type: "bytes" }],
  outputs: [{ name: "callerDelta", type: "int256" }, { name: "feesAccrued", type: "int256" }],
}];
const SEL = toFunctionSelector(ABI[0]);
const sx = (v) => { v &= (1n << 128n) - 1n; return v >= 1n << 127n ? v - (1n << 128n) : v; };
const abs = (v) => (v < 0n ? -v : v);
const hex = (n) => "0x" + n.toString(16);

const rpc = async (m, p) => {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
        signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (j.error && /limit|429|too many/i.test(j.error.message || "")) throw new Error("rl");
      return j;
    } catch { await new Promise((r) => setTimeout(r, 800 * (a + 1))); }
  }
  return { error: { message: "exhausted" } };
};

// ── random sample straight from Postgres ────────────────────────────────────
const rows = execFileSync("docker", ["exec", "envio-postgres", "psql", "-U", "postgres", "-d",
  "envio-dev", "-t", "-A", "-F", "\t", "-c",
  `select p."tokenId", replace(p.pool,'43114_',''), t0.decimals, t1.decimals,
          p."totalFeesCollected0", p."totalFeesCollected1", p."feeBaselineValid"
   from avalanche."Position" p
   join avalanche."Pool" pl on pl.id=p.pool
   join avalanche."Token" t0 on t0.id=pl.token0
   join avalanche."Token" t1 on t1.id=pl.token1
   where p."isPriceable" order by random() limit ${SAMPLE};`],
  { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n").filter((l) => l.trim()).map((l) => {
    const f = l.split("\t");
    return { tokenId: f[0], poolId: f[1], d0: +f[2], d1: +f[3],
             envio0: +f[4], envio1: +f[5], baselineValid: f[6] === "t",
             fromBlock: Number(f[7]), toBlock: Number(f[8]) };
  });

console.log(`Auditing ${rows.length} RANDOMLY selected positions.\n`);
console.log("For each: every ModifyLiquidity for that pool is pulled from the chain,");
console.log("filtered to this tokenId's salt, traced, and feesAccrued summed.\n");

function collect(node, acc) {
  if (node && typeof node.to === "string" && node.to.toLowerCase() === POOL_MANAGER &&
      typeof node.input === "string" && node.input.toLowerCase().startsWith(SEL) &&
      typeof node.output === "string" && node.output.length >= 2 + 128) acc.push(node);
  for (const c of node?.calls ?? []) collect(c, acc);
}

// eth_getLogs for one pool, split on provider caps
async function poolLogs(poolId, from, to, depth = 0) {
  const r = await rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to),
    address: POOL_MANAGER, topics: [T_MODIFY, poolId] }]);
  if (r.error || (r.result?.length ?? 0) >= 9999) {
    if (from >= to || depth > 12) return [];
    const mid = Math.floor((from + to) / 2);
    return [...(await poolLogs(poolId, from, mid, depth + 1)),
            ...(await poolLogs(poolId, mid + 1, to, depth + 1))];
  }
  return r.result ?? [];
}

const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
let exact = 0, mismatch = 0, unverifiable = 0;
const problems = [];

for (const p of rows) {
  // Scan only this position's own lifetime. Its modifies are by definition
  // inside it, and this turns a 38.6M-block scan into a small one.
  const lo = Math.max(DEPLOY, p.fromBlock - 5);
  const hi = Math.min(head, Math.max(p.toBlock + 5, p.fromBlock + 5));
  const logs = await poolLogs(p.poolId, lo, hi);
  // salt is the 4th 32-byte word of the non-indexed data
  const mine = logs.filter((l) => {
    const d = l.data.slice(2);
    return d.length >= 256 && BigInt("0x" + d.slice(192, 256)) === BigInt(p.tokenId);
  });
  const txs = [...new Set(mine.map((l) => l.transactionHash))];

  let t0 = 0, t1 = 0, traced = 0, failed = 0;
  for (const tx of txs) {
    const t = await rpc("debug_traceTransaction", [tx, { tracer: "callTracer" }]);
    if (t.error || !t.result) { failed++; continue; }
    const calls = []; collect(t.result, calls);
    let hit = false;
    for (const c of calls) {
      let salt;
      try { salt = BigInt(decodeFunctionData({ abi: ABI, data: c.input }).args[1].salt); }
      catch { continue; }
      if (salt !== BigInt(p.tokenId)) continue;
      const u = BigInt("0x" + c.output.slice(66, 130));
      t0 += Number(abs(sx(u >> 128n))) / 10 ** p.d0;
      t1 += Number(abs(sx(u & ((1n << 128n) - 1n)))) / 10 ** p.d1;
      hit = true;
    }
    if (hit) traced++; else failed++;
  }

  const rel = (a, b) => { const m = Math.max(Math.abs(a), Math.abs(b));
    return m === 0 ? 0 : Math.abs(a - b) / m; };
  const r0 = rel(t0, p.envio0), r1 = rel(t1, p.envio1);
  const ok = r0 < 1e-6 && r1 < 1e-6;

  if (failed > 0 && !ok) { unverifiable++; }
  else if (ok) { exact++; }
  else { mismatch++; problems.push({ ...p, t0, t1, r0, r1, txs: txs.length, traced, failed }); }

  const tag = failed > 0 && !ok ? "UNVERIFIABLE" : ok ? "EXACT" : "MISMATCH";
  console.log(`  tokenId ${String(p.tokenId).padEnd(6)} modifies=${String(txs.length).padStart(3)} traced=${String(traced).padStart(3)}  ${tag}`);
  if (!ok) {
    console.log(`      envio  fee0=${p.envio0.toPrecision(10)}  fee1=${p.envio1.toPrecision(10)}`);
    console.log(`      trace  fee0=${t0.toPrecision(10)}  fee1=${t1.toPrecision(10)}   relDiff=${r0.toExponential(2)}/${r1.toExponential(2)}`);
  }
}

console.log(`\n================ RESULT ================`);
console.log(`  exact match to the trace : ${exact} / ${rows.length}`);
console.log(`  mismatch                 : ${mismatch}`);
console.log(`  unverifiable (no trace)  : ${unverifiable}`);
if (problems.length) {
  console.log(`\n  mismatched positions:`);
  for (const q of problems)
    console.log(`    tokenId ${q.tokenId} baselineValid=${q.baselineValid} txs=${q.txs} traced=${q.traced} failed=${q.failed}`);
}
