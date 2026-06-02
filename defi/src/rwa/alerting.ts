import { sendMessage } from '../utils/discord';
import { readCronAlertState, storeCronAlertState } from './file-cache';
import { sendThrottledRwaCronAlert, ThrottledRwaCronAlertResult } from './cronAlerts';

export const DEFAULT_RWA_ALERT_MIN_INTERVAL_HOURS = 4;

export function getRwaAlertMinIntervalMs(): number {
  const hours = Number(
    process.env.RWA_ALERT_MIN_INTERVAL_HOURS ??
    process.env.RWA_CHART_ALERT_MIN_INTERVAL_HOURS ??
    DEFAULT_RWA_ALERT_MIN_INTERVAL_HOURS
  );
  const safeHours = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RWA_ALERT_MIN_INTERVAL_HOURS;
  return safeHours * 60 * 60 * 1000;
}

export async function sendRwaAlert(
  message: string,
  options: { formatted?: boolean; prefix?: string } = {}
): Promise<void> {
  const { formatted = true, prefix = '[RWA cron]' } = options;
  const fullMessage = prefix ? `${prefix} ${message}` : message;
  if (!process.env.RWA_WEBHOOK) {
    console.warn(fullMessage);
    return;
  }

  try {
    await sendMessage(fullMessage, process.env.RWA_WEBHOOK, formatted);
  } catch (e) {
    console.error('Failed to send RWA Discord alert:', (e as any)?.message);
    throw e;
  }
}

export async function sendThrottledRwaAlert(options: {
  alertKey: string;
  message: string;
  minIntervalMs?: number;
  formatted?: boolean;
  prefix?: string;
  onSuppress?: (throttleUntil: number) => void;
}): Promise<ThrottledRwaCronAlertResult> {
  return sendThrottledRwaCronAlert({
    alertKey: options.alertKey,
    message: options.message,
    minIntervalMs: options.minIntervalMs ?? getRwaAlertMinIntervalMs(),
    readState: readCronAlertState,
    storeState: storeCronAlertState,
    sendAlert: (message) => sendRwaAlert(message, {
      formatted: options.formatted,
      prefix: options.prefix,
    }),
    onSuppress: options.onSuppress ?? ((throttleUntil) => {
      console.warn(`[RWA alert] Suppressing repeated alert ${options.alertKey} until ${new Date(throttleUntil).toISOString()}`);
    }),
  });
}
