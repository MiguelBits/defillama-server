import { excludeProtocolInCharts } from "../../utils/excludeProtocols";
import { getChainDisplayName, getChainKeyFromLabel } from "../../utils/normalizeChain";
import { addAdjustedChainTvls, getVisibleChainLabels } from "../../utils/visibleChains";

type MetadataProtocol = {
  category?: string;
  chains?: string[];
  chainTvls?: Record<string, { tvl?: number | null }>;
};

export function getVisibleChainsForAppMetadata(
  protocols: MetadataProtocol[],
  dimensionsChainAggData: any = {}
) {
  const protocolChainTvls: Record<string, number> = {};
  for (const protocol of protocols) {
    if (!protocol.category || excludeProtocolInCharts(protocol.category)) continue;

    addAdjustedChainTvls(protocolChainTvls, protocol.chainTvls ?? {}, protocol.chains ?? []);
  }

  return getVisibleChainLabels(protocolChainTvls, dimensionsChainAggData);
}

const slug = (chain: string) => chain.toLowerCase().split(" ").join("-").split("'").join("");

function getCanonicalChainMetadata(chain: string) {
  const chainName = getChainDisplayName(getChainKeyFromLabel(chain), true);

  return { name: chainName, slug: slug(chainName) };
}

export function removeHiddenChainMetadata<T extends { name: string; id: string }>(
  finalChains: Record<string, T>,
  visibleChainSlugs: Set<string>
) {
  for (const chain in finalChains) {
    const canonicalChain = getCanonicalChainMetadata(chain);
    if (canonicalChain.slug !== chain && visibleChainSlugs.has(canonicalChain.slug)) {
      finalChains[canonicalChain.slug] = {
        ...finalChains[chain],
        ...finalChains[canonicalChain.slug],
        name: canonicalChain.name,
        id: canonicalChain.name,
      } as T;
      delete finalChains[chain];
      continue;
    }

    if (!visibleChainSlugs.has(chain)) delete finalChains[chain];
  }
}

export function getVisibleChainMetadataEntry(
  chain: string,
  visibleChainSlugs: Set<string>,
  slug: (chain: string) => string
) {
  const canonicalChain = getCanonicalChainMetadata(chain);
  const chainSlug = slug(canonicalChain.name);
  if (!visibleChainSlugs.has(chainSlug)) return null;

  return { name: canonicalChain.name, slug: chainSlug };
}
