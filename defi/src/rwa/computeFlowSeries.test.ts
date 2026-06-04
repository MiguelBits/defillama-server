import { computeFlowSeries, FlowRow } from "./db";

// Locks in the net-flow methodology: flows are $-denominated (supplyΔ × price,
// price = mcap/supply) and UNPRICED chains (no mcap) are excluded entirely, so
// the flow series stays consistent with onChainMcap.
describe("computeFlowSeries", () => {
  it("first row has null flow", () => {
    const rows: FlowRow[] = [{ timestamp: 1, mcap: { ethereum: 100 }, totalsupply: { ethereum: 100 } }];
    expect(computeFlowSeries(rows)[0]).toEqual({ timestamp: 1, netFlowUsd: null, netFlowByChain: {} });
  });

  it("values a priced chain in USD (supplyΔ × price), not tokens", () => {
    // price = mcap/supply = 220/110 = 2; supplyΔ = 10 tokens => $20, not 10
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 200 }, totalsupply: { ethereum: 100 } },
      { timestamp: 2, mcap: { ethereum: 220 }, totalsupply: { ethereum: 110 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(20, 6);
    expect(out[1].netFlowByChain.ethereum).toBeCloseTo(20, 6);
  });

  it("excludes an unpriced chain (supply present, no mcap) from the flow", () => {
    // ethereum priced ($1, +10 => +$10); solana has supply but NO mcap => excluded
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 100 }, totalsupply: { ethereum: 100, solana: 50 } },
      { timestamp: 2, mcap: { ethereum: 110 }, totalsupply: { ethereum: 110, solana: 80 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(10, 6);          // solana's +30 tokens NOT counted
    expect(out[1].netFlowByChain.solana).toBeUndefined();
    expect(out[1].netFlowByChain.ethereum).toBeCloseTo(10, 6);
    // unpriced-but-present chain is not a supply "gap", so not flagged missing
    expect(out[1].missingChains ?? []).not.toContain("solana");
  });

  it("a day with only unpriced chains is a gap (null), not a fake $0", () => {
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: {}, totalsupply: { solana: 50 } },
      { timestamp: 2, mcap: {}, totalsupply: { solana: 80 } },
    ];
    expect(computeFlowSeries(rows)[1].netFlowUsd).toBeNull();
  });

  it("a chain missing supply on either side is flagged missing, not valued", () => {
    const rows: FlowRow[] = [
      { timestamp: 1, mcap: { ethereum: 100, base: 5 }, totalsupply: { ethereum: 100 } }, // base supply missing
      { timestamp: 2, mcap: { ethereum: 110, base: 5 }, totalsupply: { ethereum: 110, base: 5 } },
    ];
    const out = computeFlowSeries(rows);
    expect(out[1].netFlowUsd).toBeCloseTo(10, 6);          // only ethereum valued
    expect(out[1].missingChains).toContain("base");
  });
});
