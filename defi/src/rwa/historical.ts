import { getChainIdFromDisplayName } from "../utils/normalizeChain";
import { initPG, storeHistoricalPG, storeMetadataPG, fetchLatestRwaRowsForIds } from "./db";
import { protocolIdMap } from "./constants";
import { RWA_KEY_MAP } from "./metadataConstants";
import { sendThrottledRwaAlert } from "./alerting";
import {
  filterRwaAssetMoveGuardInserts,
  getRwaAssetMoveGuardOptionsFromEnv,
} from "./assetMoveGuard";

import * as sdk from '@defillama/sdk'
const { runInPromisePool } = sdk.util;

const inverseProtocolIdMap: { [name: string]: string } = Object.entries(protocolIdMap).reduce(
  (acc: { [name: string]: string }, [id, name]: [string, string]) => {
    acc[name] = id;
    return acc;
  },
  {}
);
export interface AtvlInsert {
  timestamp: number;
  id: string;
  defiactivetvl: string;
  mcap: string;
  activemcap: string;
  totalsupply: string;
  aggregatedefiactivetvl: number;
  aggregatemcap: number;
  aggregatedactivemcap: number;
}

export interface AtvlPerIdData {
  defiActiveTvl: { [chain: string]: { [name: string]: string } };
  onChainMcap: { [chain: string]: string };
  activeMcap: { [chain: string]: string };
  totalSupply?: { [chain: string]: number | string };
}

// Pure transform: atvl per-id output → DB insert row.
export function buildAtvlInsert(id: string, perId: AtvlPerIdData, timestamp: number): AtvlInsert {
  const { defiActiveTvl, onChainMcap, activeMcap, totalSupply } = perId;

  const defiactivetvl: { [chain: string]: { [id: string]: string } } = {};
  let aggregatedefiactivetvl = 0;
  Object.keys(defiActiveTvl ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    defiactivetvl[chainSlug] = {};
    Object.keys(defiActiveTvl[chain]).forEach((name) => {
      const protocolId = inverseProtocolIdMap[name];
      aggregatedefiactivetvl += Number(defiActiveTvl[chain][name]);
      defiactivetvl[chainSlug][protocolId] = defiActiveTvl[chain][name];
    });
  });

  const mcap: { [chain: string]: string } = {};
  let aggregatemcap = 0;
  Object.keys(onChainMcap ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    mcap[chainSlug] = onChainMcap[chain];
    aggregatemcap += Number(onChainMcap[chain]);
  });

  const activemcap: { [chain: string]: string } = {};
  let aggregatedactivemcap = 0;
  Object.keys(activeMcap ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    activemcap[chainSlug] = activeMcap[chain];
    aggregatedactivemcap += Number(activeMcap[chain]);
  });

  const totalsupply: { [chain: string]: string } = {};
  Object.keys(totalSupply ?? {}).forEach((chain) => {
    const chainSlug = getChainIdFromDisplayName(chain);
    totalsupply[chainSlug] = String(totalSupply![chain]);
  });

  return {
    timestamp,
    id,
    defiactivetvl: JSON.stringify(defiactivetvl),
    mcap: JSON.stringify(mcap),
    activemcap: JSON.stringify(activemcap),
    totalsupply: JSON.stringify(totalsupply),
    aggregatedefiactivetvl,
    aggregatemcap,
    aggregatedactivemcap,
  };
}

export type StoreHistoricalOptions = {
  skipAssetMoveGuard?: boolean;
};

function getRwaLabel(item: any, id: string): string {
  return item?.ticker || item?.canonicalMarketId || item?.name || id;
}

function shouldRunAssetMoveGuard(item: any): boolean {
  // Governance/protocol tokens can move >10% from ordinary market-price action.
  // The guard is meant for supply/metadata shocks in asset-style RWA rows.
  return item?.governance !== true;
}

function getErrorMessage(error: any): string {
  return error?.stack || error?.message || String(error);
}

// Store historical data
export async function storeHistorical(
  res: { data: { [id: string]: AtvlPerIdData }, timestamp: number },
  options: StoreHistoricalOptions = {}
): Promise<void> {
  const { data, timestamp } = res;
  if (Object.keys(data).length == 0) return;

  const inserts: AtvlInsert[] = [];
  await runInPromisePool({
    items: Object.keys(data),
    concurrency: 5,
    processor: async (id: any) => {
      const insert = buildAtvlInsert(id, data[id], timestamp);
      if (
        isNaN(insert.timestamp) || isNaN(Number(insert.id)) ||
        isNaN(insert.aggregatedefiactivetvl) || isNaN(insert.aggregatemcap) || isNaN(insert.aggregatedactivemcap)
      ) {
        try {
          await sendThrottledRwaAlert({
            alertKey: `historicalInvalidInsert:${id}`,
            message: `ERROR ON ID ${id}`,
            formatted: false,
          });
        } catch (alertError) {
          console.error('[RWA historical] Failed to send invalid insert alert:', (alertError as any)?.message);
        }
        throw new Error(`ERROR ON ID ${id}`);
      }
      inserts.push(insert);
    },
  });

  await initPG();

  let insertsToStore = inserts;
  const guardOptions = getRwaAssetMoveGuardOptionsFromEnv();
  if (!options.skipAssetMoveGuard && guardOptions.enabled) {
    try {
      const guardedInserts = inserts.filter((insert) => shouldRunAssetMoveGuard(data[insert.id]));
      const previousById = await fetchLatestRwaRowsForIds(guardedInserts.map((insert) => insert.id));
      const labelsById: { [id: string]: string } = {};
      for (const id of Object.keys(data)) labelsById[id] = getRwaLabel(data[id], id);
      const guardResult = await filterRwaAssetMoveGuardInserts({
        inserts: guardedInserts,
        previousById,
        labelsById,
        options: guardOptions,
      });
      insertsToStore = inserts.filter((insert) => !guardResult.blockedIds.has(insert.id));
      if (guardResult.blockedIds.size) {
        console.warn(
          `[RWA asset move guard] Blocked writes for ${guardResult.blockedIds.size} IDs: ${Array.from(guardResult.blockedIds).join(', ')}`
        );
      }
    } catch (error) {
      const message = `RWA asset move guard failed while evaluating historical rows; historical DB writes skipped. Error: ${getErrorMessage(error)}`;
      console.error(`[RWA asset move guard] ${message}`);
      try {
        await sendThrottledRwaAlert({
          alertKey: 'assetMoveGuardEvaluationFailure',
          message,
          formatted: false,
        });
      } catch (alertError) {
        console.error('[RWA asset move guard] Failed to send guard failure alert:', (alertError as any)?.message);
      }
      return;
    }
  }

  if (!insertsToStore.length) {
    console.warn('[RWA asset move guard] No RWA historical inserts left to store after guard filtering');
    return;
  }

  await storeHistoricalPG(insertsToStore, timestamp);
}

// Store metadata
export async function storeMetadata(res: { data: { [id: string]: { [key: string]: any } } }): Promise<void> {
  const { data } = res;
  if (Object.keys(data).length == 0) return;

  const inserts = Object.keys(data).map((id: any) => {
    const { [RWA_KEY_MAP.activeMcap]: activeMcap, [RWA_KEY_MAP.onChain]: onChain, [RWA_KEY_MAP.defiActive]: defiActive, ...rest } = data[id];
    return { id, data: JSON.stringify(rest) };
  });
  await initPG();
  await storeMetadataPG(inserts);
}
