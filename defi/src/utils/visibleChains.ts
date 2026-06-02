import { chainCoingeckoIds, getChainDisplayName, getChainKeyFromLabel } from "./normalizeChain";

type ChainTvls = Record<string, { tvl?: number | null }>;

export function hasDimensionsChainVisibility(chainAggData: any = {}) {
  if (typeof chainAggData !== "object" || chainAggData === null) return false;

  for (const adapterType in chainAggData) {
    const adapterAggData = chainAggData[adapterType];
    if (typeof adapterAggData !== "object" || adapterAggData === null) continue;

    for (const recordType in adapterAggData) {
      const recordTypeAggData = adapterAggData[recordType];
      if (typeof recordTypeAggData !== "object" || recordTypeAggData === null) continue;

      for (const _key in recordTypeAggData) {
        return true;
      }
    }
  }

  return false;
}

function getVisibleChainLabel(chain: string) {
  if (!chain) return null;

  return getChainDisplayName(getChainKeyFromLabel(chain), true);
}

export function addAdjustedChainTvls(
  protocolChainTvls: { [chain: string]: number },
  chainTvls: ChainTvls,
  chains: string[]
) {
  for (const chain of chains) {
    protocolChainTvls[chain] =
      (protocolChainTvls[chain] ?? 0) +
      (chainTvls[chain]?.tvl ?? 0) -
      (chainTvls[`${chain}-liquidstaking`]?.tvl ?? 0) -
      (chainTvls[`${chain}-doublecounted`]?.tvl ?? 0) +
      (chainTvls[`${chain}-dcAndLsOverlap`]?.tvl ?? 0);
  }

  return protocolChainTvls;
}

export function getVisibleChainLabels(
  protocolChainTvls: { [chain: string]: number },
  dimensionsChainAggData: any = {},
  fallbackChainLabels: string[] = []
) {
  const normalizedProtocolChainTvls = new Map<string, number>();
  for (const chain in protocolChainTvls) {
    const visibleChainLabel = getVisibleChainLabel(chain);
    if (!visibleChainLabel) continue;

    normalizedProtocolChainTvls.set(
      visibleChainLabel,
      (normalizedProtocolChainTvls.get(visibleChainLabel) ?? 0) + protocolChainTvls[chain]
    );
  }

  const protocolBackedChainEntries = Array.from(normalizedProtocolChainTvls.entries());
  protocolBackedChainEntries.sort((a, b) => b[1] - a[1]);
  const protocolBackedChains: string[] = [];
  for (const [chain] of protocolBackedChainEntries) {
    protocolBackedChains.push(chain);
  }

  const visibleChains = new Set(protocolBackedChains);
  const dimensionBackedChains: string[] = [];
  for (const chainKey in dimensionsChainAggData) {
    const chainAggData = dimensionsChainAggData[chainKey];
    if (!hasDimensionsChainVisibility(chainAggData)) continue;

    const chainLabel = getVisibleChainLabel(chainKey);
    if (!chainLabel || chainCoingeckoIds[chainLabel] === undefined || visibleChains.has(chainLabel)) continue;

    visibleChains.add(chainLabel);
    dimensionBackedChains.push(chainLabel);
  }
  dimensionBackedChains.sort((a, b) => a.localeCompare(b));

  const fallbackChains: string[] = [];
  for (const chain of fallbackChainLabels) {
    const chainLabel = getVisibleChainLabel(chain);
    if (!chainLabel || visibleChains.has(chainLabel)) continue;

    visibleChains.add(chainLabel);
    fallbackChains.push(chainLabel);
  }

  return protocolBackedChains.concat(dimensionBackedChains, fallbackChains);
}
