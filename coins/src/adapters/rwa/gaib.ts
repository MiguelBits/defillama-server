import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";

// GAIB ecosystem:
//   AID  = a $1-pegged synthetic dollar. No reliable CoinGecko listing, so we peg it.
//   sAID = an ERC4626 vault over AID, so price = convertToAssets(1 share) (in AID) * AID.
//          (The `gaib-said` CG feed lags by hours; the on-chain rate is fresher/exact.)
//
// AID is deployed at the SAME address on ethereum/arbitrum/base/bsc. We write the price
// ONCE here (ethereum = canonical) and redirect the other chains via tokenMapping.json
// (`to: "asset#ethereum:0x18f5..."`) — NOT by iterating chains in this adapter. Single
// source of truth; the redirect resolution fans the price out to the duplicate addresses.
const AID = "0x18f52b3fb465118731d9e0d276d4eb3599d57596";
const SAID = "0xB3B3c527BA57cd61648e2EC2F5e006A0B390A9F8";
const AID_USD = 1;

export async function gaib(timestamp: number = 0): Promise<Write[]> {
  const writes: Write[] = [];
  const api = await getApi("ethereum", timestamp);

  const aidDecimals = Number(await api.call({ target: AID, abi: "erc20:decimals" }));

  // AID = $1 peg. Canonical write on ethereum; arbitrum/base/bsc redirect here via tokenMapping.json.
  addToDBWritesList(writes, "ethereum", AID, AID_USD, aidDecimals, "AID", timestamp, "gaib", 0.9);

  // sAID = convertToAssets(1 share) in AID terms * AID price
  try {
    const shareDecimals = Number(await api.call({ target: SAID, abi: "erc20:decimals" }));
    const oneShare = "1" + "0".repeat(shareDecimals);
    const assetsPerShare = await api.call({
      target: SAID,
      abi: "function convertToAssets(uint256) view returns (uint256)",
      params: [oneShare],
    });
    const sAidPrice = (Number(assetsPerShare) / 10 ** aidDecimals) * AID_USD;
    if (Number.isFinite(sAidPrice) && sAidPrice > 0) {
      addToDBWritesList(writes, "ethereum", SAID, sAidPrice, shareDecimals, "sAID", timestamp, "gaib", 0.9);
    } else {
      console.warn(`gaib: sAID price invalid (${sAidPrice}), skipping`);
    }
  } catch (e) {
    console.warn("gaib: sAID convertToAssets failed:", (e as any)?.message);
  }

  return writes;
}
