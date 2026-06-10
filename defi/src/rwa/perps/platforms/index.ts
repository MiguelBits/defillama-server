import type { PlatformAdapter } from "./types";
export type { PlatformAdapter, ParsedPerpsMarket, FundingEntry } from "./types";

import { hyperliquidAdapter } from "./adapters/hyperliquid";
import { gtradeAdapter } from "./adapters/gtrade";
import { ostiumAdapter } from "./adapters/ostium";
import { avantisAdapter } from "./adapters/avantis";
import { helixAdapter } from "./adapters/helix";
import { extendedAdapter } from "./adapters/extended";
import { lighterAdapter } from "./adapters/lighter";
import { edgexAdapter } from "./adapters/edgex";
import { asterAdapter } from "./adapters/aster";
import { apexAdapter } from "./adapters/apex";
import { gmtradeAdapter } from "./adapters/gmtrade";
import { variationalAdapter } from "./adapters/variational";
import { parclAdapter } from "./adapters/parcl";
import { ondoperpsAdapter } from "./adapters/ondoperps";

/** All implemented adapters — used by preview tooling and tests. */
const ALL_ADAPTERS: PlatformAdapter[] = [
  hyperliquidAdapter,
  gtradeAdapter,
  ostiumAdapter,
  avantisAdapter,
  helixAdapter,
  extendedAdapter,
  lighterAdapter,
  edgexAdapter,
  asterAdapter,
  apexAdapter,
  gmtradeAdapter,
  variationalAdapter,
  parclAdapter,
  ondoperpsAdapter,
];

/** Adapters that are live in the pipeline / cron / API. */
const PUBLISHED_ADAPTERS: PlatformAdapter[] = [
  hyperliquidAdapter,
  ostiumAdapter,
  gtradeAdapter,
  helixAdapter,
  extendedAdapter,
  lighterAdapter,
  edgexAdapter,
  asterAdapter,
  apexAdapter,
  gmtradeAdapter,
  variationalAdapter,
  parclAdapter,
  ondoperpsAdapter,
];

const ADAPTER_MAP = new Map<string, PlatformAdapter>(
  ALL_ADAPTERS.map((a) => [a.name, a]),
);

/** Returns only the adapters published to production. */
export function getAllAdapters(): PlatformAdapter[] {
  return PUBLISHED_ADAPTERS;
}

/** Returns every implemented adapter, including unpublished ones (for preview/testing). */
export function getAllAdaptersIncludingUnpublished(): PlatformAdapter[] {
  return ALL_ADAPTERS;
}

export function getAdapter(name: string): PlatformAdapter | undefined {
  return ADAPTER_MAP.get(name);
}
