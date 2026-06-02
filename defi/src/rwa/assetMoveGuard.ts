import { formatUsd } from './chartGuards';
import { sendThrottledRwaAlert } from './alerting';

type AssetMoveMetric = 'onChainMcap' | 'activeMcap';

type MetricConfig = {
  name: AssetMoveMetric;
  aggregateField: 'aggregatemcap' | 'aggregatedactivemcap';
  breakdownField: 'mcap' | 'activemcap';
};

const METRICS: MetricConfig[] = [
  { name: 'onChainMcap', aggregateField: 'aggregatemcap', breakdownField: 'mcap' },
  { name: 'activeMcap', aggregateField: 'aggregatedactivemcap', breakdownField: 'activemcap' },
];

export type RwaAssetMoveGuardOptions = {
  enabled: boolean;
  blockWrites: boolean;
  minDelta: number;
  minRatio: number;
  maxContributors: number;
  minIntervalMs: number;
};

export type RwaAssetMoveGuardInsert = {
  id: string;
  timestamp?: number;
  aggregatemcap: number;
  aggregatedactivemcap: number;
  mcap?: any;
  activemcap?: any;
};

export type RwaAssetMoveGuardPreviousRow = {
  id: string;
  timestamp?: number;
  aggregatemcap: number | string;
  aggregatedactivemcap: number | string;
  mcap?: any;
  activemcap?: any;
};

export type RwaAssetMoveTripContributor = {
  chain: string;
  previous: number;
  current: number;
  delta: number;
};

export type RwaAssetMoveTrip = {
  id: string;
  label: string;
  metric: AssetMoveMetric;
  previous: number;
  current: number;
  delta: number;
  ratio: number;
  direction: 'up' | 'down';
  contributors: RwaAssetMoveTripContributor[];
};

export type RwaAssetMoveGuardResult<T extends RwaAssetMoveGuardInsert> = {
  allowedInserts: T[];
  blockedIds: Set<string>;
  trips: RwaAssetMoveTrip[];
};

export function getRwaAssetMoveGuardOptionsFromEnv(): RwaAssetMoveGuardOptions {
  const minIntervalHours = Number(
    process.env.RWA_ASSET_MOVE_GUARD_MIN_INTERVAL_HOURS ??
    process.env.RWA_ALERT_MIN_INTERVAL_HOURS ??
    4
  );
  const minDelta = Number(process.env.RWA_ASSET_MOVE_GUARD_MIN_DELTA ?? 5_000_000);
  const minRatio = Number(process.env.RWA_ASSET_MOVE_GUARD_MIN_RATIO ?? 0.10);
  const maxContributors = Number(process.env.RWA_ASSET_MOVE_GUARD_MAX_CONTRIBUTORS ?? 5);

  return {
    enabled: process.env.RWA_ASSET_MOVE_GUARD_ENABLED !== 'false',
    blockWrites: process.env.RWA_ASSET_MOVE_GUARD_BLOCK_WRITES !== 'false',
    minDelta: Number.isFinite(minDelta) && minDelta >= 0 ? minDelta : 5_000_000,
    minRatio: Number.isFinite(minRatio) && minRatio >= 0 ? minRatio : 0.10,
    maxContributors: Number.isFinite(maxContributors) && maxContributors >= 0 ? maxContributors : 5,
    minIntervalMs: (Number.isFinite(minIntervalHours) && minIntervalHours >= 0 ? minIntervalHours : 4) * 60 * 60 * 1000,
  };
}

function toFiniteNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseMap(value: any): { [key: string]: number } {
  if (!value) return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: { [key: string]: number } = {};
  for (const [key, raw] of Object.entries(parsed)) out[key] = toFiniteNumber(raw);
  return out;
}

function buildContributors(
  previous: any,
  current: any,
  direction: 'up' | 'down',
  maxContributors: number
): RwaAssetMoveTripContributor[] {
  const prevMap = parseMap(previous);
  const currentMap = parseMap(current);
  const keys = new Set([...Object.keys(prevMap), ...Object.keys(currentMap)]);
  return Array.from(keys)
    .map((chain) => {
      const prev = prevMap[chain] || 0;
      const cur = currentMap[chain] || 0;
      return { chain, previous: prev, current: cur, delta: cur - prev };
    })
    .filter((item) => direction === 'up' ? item.delta > 0 : item.delta < 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, Math.max(0, maxContributors));
}

export function findRwaAssetMoveTrips<T extends RwaAssetMoveGuardInsert>(
  inserts: T[],
  previousById: { [id: string]: RwaAssetMoveGuardPreviousRow | undefined },
  labelsById: { [id: string]: string | undefined },
  options: RwaAssetMoveGuardOptions
): RwaAssetMoveTrip[] {
  if (!options.enabled) return [];

  const trips: RwaAssetMoveTrip[] = [];
  for (const insert of inserts) {
    const previous = previousById[insert.id];
    if (!previous) continue;

    for (const metric of METRICS) {
      const prev = toFiniteNumber(previous[metric.aggregateField]);
      const cur = toFiniteNumber(insert[metric.aggregateField]);
      if (prev <= 0) continue;

      const delta = cur - prev;
      const absDelta = Math.abs(delta);
      const ratio = delta / prev;
      if (absDelta < options.minDelta || Math.abs(ratio) < options.minRatio) continue;

      const direction = delta > 0 ? 'up' : 'down';
      trips.push({
        id: insert.id,
        label: labelsById[insert.id] || insert.id,
        metric: metric.name,
        previous: prev,
        current: cur,
        delta,
        ratio,
        direction,
        contributors: buildContributors(
          previous[metric.breakdownField],
          insert[metric.breakdownField],
          direction,
          options.maxContributors
        ),
      });
    }
  }
  return trips;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatRwaAssetMoveGuardMessage(
  id: string,
  trips: RwaAssetMoveTrip[],
  options: RwaAssetMoveGuardOptions
): string {
  const action = options.blockWrites ? 'WRITE BLOCKED' : 'alert only';
  const label = trips[0]?.label || id;
  const lines = [
    `Suspicious RWA asset move detected for ${label}#${id} - ${action}.`,
    `Thresholds: move >= ${formatUsd(options.minDelta)} and ${(options.minRatio * 100).toFixed(1)}%; repeats throttled for ${(options.minIntervalMs / 3600000).toFixed(1)}h.`,
  ];

  for (const trip of trips) {
    lines.push(
      `- ${trip.metric} ${trip.direction.toUpperCase()}: ` +
      `${formatUsd(trip.previous)} -> ${formatUsd(trip.current)} ` +
      `(${formatUsd(trip.delta)}, ${formatPercent(trip.ratio)})`
    );
    if (trip.contributors.length) {
      for (const contributor of trip.contributors) {
        lines.push(
          `  - ${contributor.chain}: ${formatUsd(contributor.previous)} -> ${formatUsd(contributor.current)} (${formatUsd(contributor.delta)})`
        );
      }
    }
  }

  return lines.join('\n');
}

function groupTripsById(trips: RwaAssetMoveTrip[]): { [id: string]: RwaAssetMoveTrip[] } {
  const byId: { [id: string]: RwaAssetMoveTrip[] } = {};
  for (const trip of trips) {
    if (!byId[trip.id]) byId[trip.id] = [];
    byId[trip.id].push(trip);
  }
  return byId;
}

function getAssetMoveAlertKey(id: string, trips: RwaAssetMoveTrip[]): string {
  const signature = trips
    .map((trip) => `${trip.metric}:${trip.direction}`)
    .sort()
    .join(',');
  return `assetMoveGuard:${id}:${signature}`;
}

export async function filterRwaAssetMoveGuardInserts<T extends RwaAssetMoveGuardInsert>(params: {
  inserts: T[];
  previousById: { [id: string]: RwaAssetMoveGuardPreviousRow | undefined };
  labelsById?: { [id: string]: string | undefined };
  options?: RwaAssetMoveGuardOptions;
  sendAlert?: (alertKey: string, message: string) => Promise<void>;
}): Promise<RwaAssetMoveGuardResult<T>> {
  const options = params.options ?? getRwaAssetMoveGuardOptionsFromEnv();
  const labelsById = params.labelsById ?? {};
  const trips = findRwaAssetMoveTrips(params.inserts, params.previousById, labelsById, options);
  const tripsById = groupTripsById(trips);
  const blockedIds = new Set(options.blockWrites ? Object.keys(tripsById) : []);
  const sendAlert = params.sendAlert ?? ((alertKey, message) =>
    sendThrottledRwaAlert({
      alertKey,
      message,
      minIntervalMs: options.minIntervalMs,
      formatted: true,
      onSuppress: (throttleUntil) => {
        console.warn(
          `[RWA asset move guard] Suppressing repeated alert ${alertKey} until ${new Date(throttleUntil).toISOString()}`
        );
      },
    }).then(() => undefined));

  for (const [id, idTrips] of Object.entries(tripsById)) {
    const alertKey = getAssetMoveAlertKey(id, idTrips);
    const message = formatRwaAssetMoveGuardMessage(id, idTrips, options);
    try {
      await sendAlert(alertKey, message);
    } catch (e) {
      console.error(`[RWA asset move guard] Failed to send alert for ${id}:`, (e as any)?.message);
    }
  }

  return {
    allowedInserts: options.blockWrites ? params.inserts.filter((insert) => !blockedIds.has(insert.id)) : params.inserts,
    blockedIds,
    trips,
  };
}
