export type RwaCronAlertState = {
  [key: string]: {
    lastSentAt?: number;
  };
};

type ThrottledRwaCronAlertOptions = {
  alertKey: string;
  message: string;
  minIntervalMs: number;
  readState: () => Promise<any>;
  storeState: (state: RwaCronAlertState) => Promise<void>;
  sendAlert: (message: string) => Promise<void>;
  now?: () => number;
  onSuppress?: (throttleUntil: number) => void;
};

export type ThrottledRwaCronAlertResult =
  | { status: 'sent' }
  | { status: 'suppressed'; throttleUntil: number };

export function normalizeRwaCronAlertState(state: any): RwaCronAlertState {
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

export function getRwaCronAlertThrottleUntil(
  lastSentAt: number | undefined,
  now: number,
  minIntervalMs: number
): number | null {
  if (!Number.isFinite(lastSentAt) || !Number.isFinite(now) || !Number.isFinite(minIntervalMs)) return null;
  if (minIntervalMs <= 0) return null;
  const nextAllowedAt = Number(lastSentAt) + minIntervalMs;
  if (!Number.isFinite(nextAllowedAt)) return null;
  return now < nextAllowedAt ? nextAllowedAt : null;
}

export async function sendThrottledRwaCronAlert(
  options: ThrottledRwaCronAlertOptions
): Promise<ThrottledRwaCronAlertResult> {
  const now = options.now?.() ?? Date.now();
  const state = normalizeRwaCronAlertState(await options.readState());
  const throttleUntil = getRwaCronAlertThrottleUntil(
    state[options.alertKey]?.lastSentAt,
    now,
    options.minIntervalMs
  );

  if (throttleUntil !== null) {
    options.onSuppress?.(throttleUntil);
    return { status: 'suppressed', throttleUntil };
  }

  await options.sendAlert(options.message);
  await options.storeState({
    ...state,
    [options.alertKey]: { lastSentAt: now },
  });
  return { status: 'sent' };
}
