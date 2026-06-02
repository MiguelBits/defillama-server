import { prepareAtvlContext, runAtvlForTimestamp } from "./atvlRefill";
import { sendThrottledRwaAlert } from "./alerting";

export default async function main(ts: number = 0) {
  const t0 = performance.now();

  const context = await prepareAtvlContext();
  console.log(`[timer] prepareAtvlContext: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  const t1 = performance.now();
  const finalData = await runAtvlForTimestamp(ts, context, { storeResults: true });
  console.log(`[timer] runAtvlForTimestamp: ${((performance.now() - t1) / 1000).toFixed(1)}s`);

  console.log(`[timer] TOTAL: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`Exitting atvl.ts`);
  return finalData;
}

main().then(() => process.exit(0)).catch(async (error) => {
  console.error('Error running the script: ', error);
  try {
    await sendThrottledRwaAlert({
      alertKey: 'atvlTopLevelError',
      message: `Error running the script: ${error}`,
      formatted: false,
    });
  } catch (alertError) {
    console.error('Failed to send RWA top-level error alert:', (alertError as any)?.message);
  } finally {
    process.exit(1);
  }
}); // ts-node defi/src/rwa/atvl.ts
