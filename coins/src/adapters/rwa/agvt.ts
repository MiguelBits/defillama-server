import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import rpcProxy from "../utils/rpcProxy";

const ADAPTER = "agvt";
const AGVT_CONTRACT =
  "CDQDXYC42G4ODKZA7B3RARH6VEOGCCQAX2UXOZLDYBNGDEOWODTSQYAZ";
const EXCHANGE_CONTRACT =
  "CATKU4CKIUVPTNTLBHUFWIE5NOXO6CUW7EZGJLNAOZBKTQGXFHFIRN5N";
const RATE_SCALE = 10_000_000;

async function getRate(): Promise<number> {
  const rate = Number(
    await rpcProxy.stellar.contractCall(EXCHANGE_CONTRACT, "get_rate")
  );
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Invalid AGVT rate: ${rate}`);
  }

  return rate;
}

export async function agvt(timestamp: number = 0): Promise<Write[]> {
  if (timestamp != 0) throw new Error(`AGVT adapter only works for current`);

  const rate = await getRate();
  // The exchange contract redeems agvt_amount * 10_000_000 / rate USDC.
  const price = RATE_SCALE / rate;
  const writes: Write[] = [];

  addToDBWritesList(
    writes,
    "stellar",
    AGVT_CONTRACT,
    price,
    7,
    "AGVT",
    timestamp,
    ADAPTER,
    0.9
  );

  return writes;
}
