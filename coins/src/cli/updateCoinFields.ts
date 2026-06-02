import dynamodb from "../utils/shared/dynamodb";
import { dualWriteToChRedis } from "../adapters/utils/chRedisWrite";

// === EDIT THESE BEFORE RUNNING ===
// Set DRY_RUN=false in env to actually write. Default is dry-run.
const DRY_RUN = false // process.env.DRY_RUN !== "false";

const updates: Array<
  | { pk: string; field: "decimals"; value: number }
  | { pk: string; field: "redirect"; value: string }
> = [
  // Decimal corrections from PR #11944 (DefiLlama/defillama-server)
  { pk: "asset#berachain:0xecac9c5f704e954931349da37f60e39f515c11c1", field: "decimals", value: 8 },  // LBTC
  { pk: "asset#base:0x102d758f688a4c1c5a80b116bd945d4455460282", field: "decimals", value: 6 },      // USDT0
  { pk: "asset#mantle:0x93919784c523f39cacaa98ee0a9d96c3f32b593e", field: "decimals", value: 18 },   // brBTC
  { pk: "asset#zkfair:0x5d26dea980716e4aba19f5b73eb3dcce1889f042", field: "decimals", value: 18 },   // ZEEP
  { pk: "asset#wc:0x102d758f688a4c1c5a80b116bd945d4455460282", field: "decimals", value: 6 },        // USDT0 on World Chain
  { pk: "asset#spn:0x80efad50d395671c13c4b1fa2969f7a7aa9ef7b3", field: "decimals", value: 6 },       // FLY
  { pk: "asset#silicon_zk:0x1e4a5963abfd975d8c9021ce480b42188849d41d", field: "decimals", value: 6 },// USDT
];
// =================================

async function main() {
  if (!process.env.tableName) throw new Error("env tableName is required (e.g. tableName=prod-coins-table)");
  console.log(`[updateCoinFields] DRY_RUN=${DRY_RUN} table=${process.env.tableName}`);

  const updatedItems: any[] = [];

  for (const u of updates) {
    if (u.field === "redirect" && u.value === "REPLACE_ME") {
      throw new Error(`redirect target for ${u.pk} is not set — edit the script first`);
    }

    const res = await dynamodb.get({ PK: u.pk, SK: 0 });
    if (!res.Item) {
      console.error(`[skip] no SK=0 record for ${u.pk}`);
      continue;
    }
    const before = res.Item;
    const after = { ...before, [u.field]: u.value };

    console.log(`[${u.pk}] ${u.field}: ${JSON.stringify(before[u.field])} -> ${JSON.stringify(u.value)}`);
    console.log(`  full record after: ${JSON.stringify(after)}`);

    if (!DRY_RUN) {
      await dynamodb.put(after);
      updatedItems.push(after);
    }
  }

  if (DRY_RUN) {
    console.log("[updateCoinFields] DRY_RUN — no writes performed. Re-run with DRY_RUN=false to apply.");
    return;
  }

  if (updatedItems.length > 0) {
    console.log(`[updateCoinFields] DDB writes done, dual-writing ${updatedItems.length} items to CH + Redis`);
    await dualWriteToChRedis(updatedItems);
    console.log("[updateCoinFields] done");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Example (dry run):
//   tableName=prod-coins-table AWS_REGION=eu-central-1 npx ts-node coins/src/cli/updateCoinFields.ts
//
// Apply for real (also needs CH + Redis env to propagate to those stores):
//   DRY_RUN=false tableName=prod-coins-table AWS_REGION=eu-central-1 \
//     CH_WRITE_HOSTS=... CH_WRITE_USER=... CH_WRITE_PASSWORD=... \
//     REDIS_SENTINEL_CONFIG=... \
//     npx ts-node coins/src/cli/updateCoinFields.ts
