import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";

const chain = "pharos";
const projectName = "r25";

const tokens = [
  {
    address: "0x1c2bc8b553d9a7e61f7531a3a4bf2162f4569268",
    symbol: "VRPCW",
  },
  {
    address: "0xee26bb0989691735c997dfdc49a4a607f75e190b",
    symbol: "VRPCS",
  },
  {
    address: "0x94f7ebc6ae0819a4b4e231ae6ddaaf9bfd2a1a86",
    symbol: "VRPCQ",
  },
];

export async function r25(timestamp: number = 0): Promise<Write[]> {
  const api = await getApi(chain, timestamp);
  const addresses = tokens.map((token) => token.address);

  const [latestNavs, navPrecisions, decimals, symbols] = await Promise.all([
    api.multiCall({ abi: "uint256:latestNav", calls: addresses }),
    api.multiCall({ abi: "uint256:NAV_PRECISION", calls: addresses }),
    api.multiCall({ abi: "erc20:decimals", calls: addresses }),
    api.multiCall({ abi: "erc20:symbol", calls: addresses }),
  ]);

  const writes: Write[] = [];
  tokens.forEach((token, i) => {
    const latestNav = Number(latestNavs[i]);
    const navPrecision = Number(navPrecisions[i]);
    if (!latestNav || !navPrecision) return;

    addToDBWritesList(
      writes,
      chain,
      token.address,
      latestNav / navPrecision,
      Number(decimals[i]),
      symbols[i] ?? token.symbol,
      timestamp,
      projectName,
      0.9
    );
  });

  return writes;
}
