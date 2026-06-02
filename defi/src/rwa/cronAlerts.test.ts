import { getRwaCronAlertThrottleUntil, RwaCronAlertState, sendThrottledRwaCronAlert } from './cronAlerts';

describe('rwa cron alerts', () => {
  describe('getRwaCronAlertThrottleUntil', () => {
    it('returns the next allowed send time when inside the throttle window', () => {
      expect(getRwaCronAlertThrottleUntil(1_000, 2_000, 4_000)).toBe(5_000);
    });

    it('does not throttle when the interval has elapsed', () => {
      expect(getRwaCronAlertThrottleUntil(1_000, 5_000, 4_000)).toBeNull();
    });

    it('does not throttle when the interval is disabled or invalid', () => {
      expect(getRwaCronAlertThrottleUntil(1_000, 2_000, 0)).toBeNull();
      expect(getRwaCronAlertThrottleUntil(undefined, 2_000, 4_000)).toBeNull();
    });
  });

  it('persists alert state and suppresses repeat alerts until the throttle window expires', async () => {
    const alertKey = 'historicalChartGuard';
    const intervalMs = 4 * 60 * 60 * 1000;
    let now = 1_000;
    let state: RwaCronAlertState = {};
    const readState = jest.fn(async () => state);
    const storeState = jest.fn(async (nextState: RwaCronAlertState) => {
      state = nextState;
    });
    const sendAlert = jest.fn(async () => {});
    const onSuppress = jest.fn();

    await expect(sendThrottledRwaCronAlert({
      alertKey,
      message: 'alert',
      minIntervalMs: intervalMs,
      readState,
      storeState,
      sendAlert,
      now: () => now,
      onSuppress,
    })).resolves.toEqual({ status: 'sent' });

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(storeState).toHaveBeenCalledTimes(1);
    expect(state[alertKey]).toEqual({ lastSentAt: now });

    now += 2 * 60 * 60 * 1000;
    await expect(sendThrottledRwaCronAlert({
      alertKey,
      message: 'alert',
      minIntervalMs: intervalMs,
      readState,
      storeState,
      sendAlert,
      now: () => now,
      onSuppress,
    })).resolves.toEqual({ status: 'suppressed', throttleUntil: 1_000 + intervalMs });

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(storeState).toHaveBeenCalledTimes(1);
    expect(onSuppress).toHaveBeenCalledWith(1_000 + intervalMs);

    now = 1_000 + intervalMs;
    await expect(sendThrottledRwaCronAlert({
      alertKey,
      message: 'alert',
      minIntervalMs: intervalMs,
      readState,
      storeState,
      sendAlert,
      now: () => now,
      onSuppress,
    })).resolves.toEqual({ status: 'sent' });

    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(storeState).toHaveBeenCalledTimes(2);
    expect(state[alertKey]).toEqual({ lastSentAt: now });
  });
});
