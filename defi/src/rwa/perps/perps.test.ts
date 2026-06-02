jest.mock("../spreadsheet", () => ({
  getCsvData: jest.fn(),
}));

import { toFiniteNumberOrZero, getPercentChangeOrNull, perpsSlug, computeProtocolFees, groupBy } from "./utils";
import { fileNameNormalizer, mergeHistoricalData } from "./file-cache";
import { buildPerpsList } from "./list";
import {
  buildContractBreakdownCharts,
  buildCategoryHistoricalCharts,
  buildOverviewBreakdownCharts,
  buildPerpsIdMap,
  buildVenueHistoricalCharts,
} from "./aggregate";
import {
  getContractId,
  getContractMetadata,
  hasContractMetadata,
  loadContractMetadataFromAirtable,
  normalizePerpsMetadataInPlace,
  PERPS_ALWAYS_STRING_ARRAY_FIELDS,
  PERPS_STRING_OR_NULL_FIELDS,
  resolveContractKey,
  resetContractMetadataStore,
  setContractMetadata,
  type PerpsContractMetadata,
} from "./constants";
import {
  findMarketById,
  findMarketsByAssetGroup,
  findMarketsByCategory,
  findMarketsByContract,
  findMarketsByVenue,
  getPerpsContractBreakdownFilePath,
  getPerpsOverviewBreakdownFilePath,
  normalizePerpsAssetGroup,
  parsePerpsChartTarget,
  resolvePerpsLookupId,
  sortPerpsMarketsByOpenInterest,
} from "./server-helpers";
import { HYPERLIQUID_MAKER_FEE, HYPERLIQUID_TAKER_FEE, HYPERLIQUID_DEPLOYER_SHARE } from "./platforms/adapters/hyperliquid";
import {
  parseMetaAndAssetCtxs,
  parseFundingHistory,
  type MetaAndAssetCtxsResponse,
  type FundingHistoryEntry,
} from "./platforms/adapters/hyperliquid";
import { parseApexMarkets, type ApexContract, type ApexTicker, type ApexUiTicker } from "./platforms/adapters/apex";
import { isGtradeRwaGroupName, toGtradePythPairKey } from "./platforms/adapters/gtrade";
import {
  parseVariationalMarkets,
  VARIATIONAL_MAX_LEVERAGE,
  VARIATIONAL_MAKER_FEE,
  VARIATIONAL_TAKER_FEE,
  type VariationalListing,
} from "./platforms/adapters/variational";
import { getCsvData } from "../spreadsheet";

// ── utils.ts ──────────────────────────────────────────────────────────────────

describe("toFiniteNumberOrZero", () => {
  it("returns number as-is", () => {
    expect(toFiniteNumberOrZero(42)).toBe(42);
    expect(toFiniteNumberOrZero(0)).toBe(0);
    expect(toFiniteNumberOrZero(-3.14)).toBe(-3.14);
  });

  it("parses numeric strings", () => {
    expect(toFiniteNumberOrZero("100")).toBe(100);
    expect(toFiniteNumberOrZero("3.14")).toBe(3.14);
  });

  it("returns 0 for non-finite values", () => {
    expect(toFiniteNumberOrZero(NaN)).toBe(0);
    expect(toFiniteNumberOrZero(Infinity)).toBe(0);
    expect(toFiniteNumberOrZero(-Infinity)).toBe(0);
    expect(toFiniteNumberOrZero(undefined)).toBe(0);
    expect(toFiniteNumberOrZero(null)).toBe(0);
    expect(toFiniteNumberOrZero("abc")).toBe(0);
    expect(toFiniteNumberOrZero("")).toBe(0);
  });
});

describe("getPercentChangeOrNull", () => {
  it("computes percent change from the previous value", () => {
    expect(getPercentChangeOrNull(120, 100)).toBe(20);
    expect(getPercentChangeOrNull(80, 100)).toBe(-20);
  });

  it("returns null when the previous value is missing or zero", () => {
    expect(getPercentChangeOrNull(120, 0)).toBeNull();
    expect(getPercentChangeOrNull(120, null)).toBeNull();
    expect(getPercentChangeOrNull(120, undefined)).toBeNull();
  });
});

describe("perpsSlug", () => {
  it("lowercases and slugifies", () => {
    expect(perpsSlug("Hyperliquid")).toBe("hyperliquid");
    expect(perpsSlug("My Venue Name")).toBe("my-venue-name");
  });

  it("strips special chars", () => {
    expect(perpsSlug("trade[XYZ]")).toBe("trade-xyz");
    expect(perpsSlug("foo---bar")).toBe("foo-bar");
  });

  it("handles empty/undefined", () => {
    expect(perpsSlug("")).toBe("");
    expect(perpsSlug()).toBe("");
  });

  it("decodes URI components", () => {
    expect(perpsSlug("hello%20world")).toBe("hello-world");
  });
});

describe("computeProtocolFees", () => {
  it("computes volume * takerFee * deployerShare", () => {
    expect(computeProtocolFees(1_000_000, 0.0005, 0.5)).toBe(250);
    expect(computeProtocolFees(0, 0.0005, 0.5)).toBe(0);
  });
});

describe("gTrade adapter helpers", () => {
  it("treats gTrade forex groups as RWA perps groups", () => {
    expect(isGtradeRwaGroupName("stocks-1")).toBe(true);
    expect(isGtradeRwaGroupName("indices")).toBe(true);
    expect(isGtradeRwaGroupName("commodities-2")).toBe(true);
    expect(isGtradeRwaGroupName("forex")).toBe(true);
    expect(isGtradeRwaGroupName("forex-minor")).toBe(true);
    expect(isGtradeRwaGroupName("forex-exotic")).toBe(true);
    expect(isGtradeRwaGroupName("crypto")).toBe(false);
    expect(isGtradeRwaGroupName("altcoins")).toBe(false);
  });

  it("builds exact Pyth pair keys from gTrade contracts", () => {
    expect(toGtradePythPairKey("gtrade:USD-JPY")).toEqual({ base: "USD", quote: "JPY", key: "USD/JPY" });
    expect(toGtradePythPairKey("gtrade:GOOGL_1-USD")).toEqual({ base: "GOOGL", quote: "USD", key: "GOOGL/USD" });
    expect(toGtradePythPairKey("gtrade:FB-USD")).toEqual({ base: "META", quote: "USD", key: "META/USD" });
    expect(toGtradePythPairKey("bad-contract")).toBeNull();
  });
});

describe("groupBy", () => {
  it("groups items by key function", () => {
    const items = [
      { venue: "a", contract: "BTC" },
      { venue: "a", contract: "ETH" },
      { venue: "b", contract: "SOL" },
    ];
    const grouped = groupBy(items, (i) => i.venue);
    expect(Object.keys(grouped)).toEqual(["a", "b"]);
    expect(grouped["a"]).toHaveLength(2);
    expect(grouped["b"]).toHaveLength(1);
  });

  it("returns empty object for empty array", () => {
    expect(groupBy([], () => "x")).toEqual({});
  });
});

// ── constants.ts ──────────────────────────────────────────────────────────────

describe("market metadata store", () => {
  const meta: PerpsContractMetadata = {
    referenceAsset: "Tesla",
    referenceAssetGroup: "US Equities",
    assetClass: ["Single stock synthetic perp"],
    parentPlatform: "Hyperliquid",
    pair: "TSLA/USD",
    marginAsset: "USDC",
    settlementAsset: "USDC",
    category: ["Equity"],
    issuer: null,
    website: null,
    oracleProvider: "Pyth",
    description: null,
    accessModel: "Permissionless",
    rwaClassification: "Programmable Finance",
    makerFeeRate: HYPERLIQUID_MAKER_FEE,
    takerFeeRate: HYPERLIQUID_TAKER_FEE,
    deployerFeeShare: HYPERLIQUID_DEPLOYER_SHARE,
  };

  beforeEach(() => {
    resetContractMetadataStore();
  });

  it("set/get/has round-trips", () => {
    setContractMetadata("TSLA", meta);
    expect(hasContractMetadata("TSLA")).toBe(true);
    expect(hasContractMetadata("tsla")).toBe(true);
    expect(getContractMetadata("TSLA")).toEqual(meta);
    expect(getContractMetadata("tsla")).toEqual(meta);
  });

  it("returns null for unknown contract", () => {
    expect(getContractMetadata("DOESNOTEXIST")).toBeNull();
    expect(hasContractMetadata("DOESNOTEXIST")).toBe(false);
  });

  it("resolves live gTrade pair IDs to Airtable canonical IDs", () => {
    setContractMetadata("gtrade:USDMXN", meta);
    setContractMetadata("gtrade:JPY", meta);
    setContractMetadata("gtrade:AMZN-USD", meta);
    setContractMetadata("gtrade:GOOGL", meta);

    expect(resolveContractKey("gtrade:USD-MXN")).toBe("gtrade:usdmxn");
    expect(resolveContractKey("gtrade:USD-JPY")).toBe("gtrade:jpy");
    expect(resolveContractKey("gtrade:AMZN-USD")).toBe("gtrade:amzn-usd");
    expect(resolveContractKey("gtrade:GOOGL-USD")).toBe("gtrade:googl");
    expect(resolveContractKey("gtrade:AMZN_1-USD")).toBeUndefined();
  });

  it("does not resolve ambiguous generated aliases", () => {
    setContractMetadata("cash:HOOD-USDT", meta);
    setContractMetadata("cash:HOOD-USDC", meta);

    expect(resolveContractKey("cash:HOOD")).toBeUndefined();
    expect(resolveContractKey("cash:HOOD-USDT")).toBe("cash:hood-usdt");
    expect(resolveContractKey("cash:HOOD-USDC")).toBe("cash:hood-usdc");
  });
});

describe("getContractId", () => {
  it("lowercases contract name", () => {
    expect(getContractId("TSLA")).toBe("tsla");
    expect(getContractId("aapl")).toBe("aapl");
  });
});

describe("loadContractMetadataFromAirtable", () => {
  const mockGetCsvData = getCsvData as jest.MockedFunction<typeof getCsvData>;

  beforeEach(() => {
    mockGetCsvData.mockReset();
    resetContractMetadataStore();
  });

  it("normalizes Airtable rows with shared string helpers and keeps accessModel direct", async () => {
    mockGetCsvData.mockResolvedValue([
      {
        "Canonical Market ID": "  xyz:META  ",
        "Reference Asset": "  Meta\n  Platforms  ",
        "Reference Asset Group": "  US   Equities ",
        "Asset Class": [" Single stock synthetic perp ", "Single stock   synthetic perp"],
        "Parent Platform": " Hyperliquid ",
        "Pair": " META / USD ",
        "Margin Asset": " USDC ",
        "Settlement Asset": "USDC",
        "Category": [" Equities ", "Equities", " RWA Perpetuals "],
        "Issuer": "-",
        "Website": " https://example.com \n",
        "Oracle Provider": "  Pyth  ",
        "Description": "  Synthetic   META contract ",
        "Access Model": " Permissionless ",
        "RWA Classification": " Programmable  Finance ",
        "Maker Fee Rate": "0.001",
        "Taker Fee Rate": "0.002",
        "Deployer Fee Share": "0.25",
      },
    ]);

    await expect(loadContractMetadataFromAirtable()).resolves.toBe(1);
    expect(getContractMetadata("xyz:META")).toEqual({
      referenceAsset: "Meta Platforms",
      referenceAssetGroup: "US Equities",
      assetClass: ["Single stock synthetic perp"],
      parentPlatform: "Hyperliquid",
      pair: "META / USD",
      marginAsset: "USDC",
      settlementAsset: "USDC",
      category: ["Equities", "RWA Perpetuals"],
      issuer: null,
      website: ["https://example.com"],
      oracleProvider: "Pyth",
      description: "Synthetic META contract",
      accessModel: "Permissionless",
      rwaClassification: "Programmable Finance",
      makerFeeRate: 0.001,
      takerFeeRate: 0.002,
      deployerFeeShare: 0.25,
    });
  });

  it("skips rows without a canonical contract id", async () => {
    mockGetCsvData.mockResolvedValue([
      { "Reference Asset": "Missing contract" },
      { "Canonical Market ID": "   " },
    ]);

    await expect(loadContractMetadataFromAirtable()).resolves.toBe(0);
    expect(getContractMetadata("missing")).toBeNull();
  });

  it("falls back to default fee values for blank Airtable fee cells", async () => {
    mockGetCsvData.mockResolvedValue([
      {
        "Canonical Market ID": "xyz:META",
        "Maker Fee Rate": "   ",
        "Taker Fee Rate": "",
        "Deployer Fee Share": "\n\t",
      },
    ]);

    await expect(loadContractMetadataFromAirtable()).resolves.toBe(1);
    expect(getContractMetadata("xyz:META")).toMatchObject({
      makerFeeRate: HYPERLIQUID_MAKER_FEE,
      takerFeeRate: HYPERLIQUID_TAKER_FEE,
      deployerFeeShare: HYPERLIQUID_DEPLOYER_SHARE,
    });
  });
});

describe("normalizePerpsMetadataInPlace", () => {
  it("coerces legacy current-payload metadata into the normalized perps API shape", () => {
    const payload: any = {
      coin: "xyz:META",
      assetClass: "Single stock synthetic perp",
      category: "RWA Perpetuals",
      website: "https://trade.xyz/",
      referenceAssetGroup: "",
      pair: "",
      marginAsset: "",
      settlementAsset: "",
    };

    expect(normalizePerpsMetadataInPlace(payload)).toEqual({
      contract: "xyz:META",
      assetClass: ["Single stock synthetic perp"],
      category: ["RWA Perpetuals"],
      website: ["https://trade.xyz/"],
      referenceAssetGroup: null,
      pair: null,
      marginAsset: null,
      settlementAsset: null,
    });
  });

  it("exposes perps normalization field sets explicitly", () => {
    expect(PERPS_ALWAYS_STRING_ARRAY_FIELDS).toEqual(new Set(["assetClass", "category", "website"]));
    expect(PERPS_STRING_OR_NULL_FIELDS.has("referenceAsset")).toBe(true);
    expect(PERPS_STRING_OR_NULL_FIELDS.has("accessModel")).toBe(true);
  });
});

// ── hyperliquid.ts parsers ────────────────────────────────────────────────────

describe("parseMetaAndAssetCtxs", () => {
  const response: MetaAndAssetCtxsResponse = {
    meta: {
      universe: [
        { name: "TSLA", szDecimals: 2, maxLeverage: 5 },
        { name: "AAPL", szDecimals: 3, maxLeverage: 10 },
      ],
    },
    assetCtxs: [
      {
        dayNtlVlm: "5000000",
        funding: "0.0001",
        impactPxs: [],
        markPx: "250.5",
        midPx: "250.4",
        openInterest: "1000",
        oraclePx: "250.3",
        premium: "0.0002",
        prevDayPx: "245.0",
      },
      {
        dayNtlVlm: "3000000",
        funding: "-0.00005",
        impactPxs: [],
        markPx: "190.0",
        midPx: "189.9",
        openInterest: "500",
        oraclePx: "189.8",
        premium: "-0.0001",
        prevDayPx: "190.0",
      },
    ],
  };

  it("parses all markets from response", () => {
    const markets = parseMetaAndAssetCtxs(response, "TestVenue");
    expect(markets).toHaveLength(2);
  });

  it("maps fields correctly", () => {
    const [tsla] = parseMetaAndAssetCtxs(response, "TestVenue");
    expect(tsla.contract).toBe("TSLA");
    expect(tsla.venue).toBe("TestVenue");
    expect(tsla.markPx).toBe(250.5);
    expect(tsla.oraclePx).toBe(250.3);
    expect(tsla.midPx).toBe(250.4);
    expect(tsla.prevDayPx).toBe(245.0);
    expect(tsla.openInterest).toBe(1000);
    expect(tsla.volume24h).toBe(5_000_000);
    expect(tsla.fundingRate).toBe(0.0001);
    expect(tsla.premium).toBe(0.0002);
    expect(tsla.maxLeverage).toBe(5);
    expect(tsla.szDecimals).toBe(2);
  });

  it("computes priceChange24h correctly", () => {
    const [tsla, aapl] = parseMetaAndAssetCtxs(response, "TestVenue");
    // (250.5 - 245) / 245 * 100 ≈ 2.2449%
    expect(tsla.priceChange24h).toBeCloseTo(2.2449, 3);
    // (190 - 190) / 190 * 100 = 0
    expect(aapl.priceChange24h).toBe(0);
  });

  it("handles prevDayPx of 0 without division error", () => {
    const zeroPrev: MetaAndAssetCtxsResponse = {
      meta: { universe: [{ name: "X", szDecimals: 0, maxLeverage: 1 }] },
      assetCtxs: [{
        dayNtlVlm: "0", funding: "0", impactPxs: [], markPx: "10",
        midPx: "10", openInterest: "0", oraclePx: "10", premium: "0", prevDayPx: "0",
      }],
    };
    const [m] = parseMetaAndAssetCtxs(zeroPrev, "v");
    expect(m.priceChange24h).toBe(0);
  });

  it("handles empty universe", () => {
    const empty: MetaAndAssetCtxsResponse = {
      meta: { universe: [] },
      assetCtxs: [],
    };
    expect(parseMetaAndAssetCtxs(empty, "v")).toEqual([]);
  });

  it("handles mismatched universe/assetCtxs lengths (takes shorter)", () => {
    const mismatched: MetaAndAssetCtxsResponse = {
      meta: {
        universe: [
          { name: "A", szDecimals: 0, maxLeverage: 1 },
          { name: "B", szDecimals: 0, maxLeverage: 1 },
        ],
      },
      assetCtxs: [{
        dayNtlVlm: "0", funding: "0", impactPxs: [], markPx: "1",
        midPx: "1", openInterest: "0", oraclePx: "1", premium: "0", prevDayPx: "1",
      }],
    };
    expect(parseMetaAndAssetCtxs(mismatched, "v")).toHaveLength(1);
  });
});

describe("parseFundingHistory", () => {
  const entries: FundingHistoryEntry[] = [
    { coin: "TSLA", fundingRate: "0.0001", premium: "0.00005", time: 1700000000000 },
    { coin: "TSLA", fundingRate: "-0.0002", premium: "-0.0001", time: 1700003600000 },
  ];

  it("parses entries and computes funding payment", () => {
    const parsed = parseFundingHistory(entries, "TestVenue", 50000);
    expect(parsed).toHaveLength(2);

    expect(parsed[0].contract).toBe("TSLA");
    expect(parsed[0].venue).toBe("TestVenue");
    expect(parsed[0].fundingRate).toBe(0.0001);
    expect(parsed[0].premium).toBe(0.00005);
    expect(parsed[0].fundingPayment).toBeCloseTo(0.0001 * 50000);
    // timestamp converted from ms to seconds
    expect(parsed[0].timestamp).toBe(1700000000);
  });

  it("returns empty array for empty input", () => {
    expect(parseFundingHistory([], "v", 100)).toEqual([]);
  });
});

// ── apex.ts parsers ──────────────────────────────────────────────────────────

describe("parseApexMarkets", () => {
  const contracts: ApexContract[] = [
    {
      baseTokenId: "USO",
      category: "COMMODITY",
      contractType: "STOCK_CONTRACT",
      displayMaxLeverage: "50",
      enableDisplay: true,
      enableOpenPosition: true,
      enableTrade: true,
      settleAssetId: "USDT",
      stepSize: "0.01",
      symbol: "USO-USDT",
      symbolDisplayName: "USOUSDT",
      tokenName: "United States Oil Fund",
    },
    {
      baseTokenId: "AAPL",
      category: "STOCK",
      contractType: "STOCK_CONTRACT",
      displayMaxLeverage: "50",
      enableDisplay: true,
      enableOpenPosition: false,
      enableTrade: true,
      settleAssetId: "USDT",
      stepSize: "0.01",
      symbol: "AAPL-USDT",
      symbolDisplayName: "AAPLUSDT",
    },
    {
      baseTokenId: "BTC",
      category: "L1",
      contractType: "UNKNOWN_CONTRACT_TYPE",
      displayMaxLeverage: "100",
      enableDisplay: true,
      enableOpenPosition: true,
      enableTrade: true,
      settleAssetId: "USDT",
      stepSize: "0.001",
      symbol: "BTC-USDT",
      symbolDisplayName: "BTCUSDT",
    },
  ];

  const tickers: ApexTicker[] = [
    {
      ticker_id: "USOUSDT",
      funding_rate: "0.0000125",
      open_interest: "323.64",
      open_interest_usd: "48371.2344",
      index_price: "149.46",
      last_price: "149.27",
      usd_volume: "220646.3854",
      maker_fee: 0.0002,
      taker_fee: 0.0005,
      bid: "149.27",
      ask: "149.52",
    },
    {
      ticker_id: "AAPLUSDT",
      open_interest_usd: "1",
      index_price: "200",
      last_price: "200",
      usd_volume: "1",
    },
    {
      ticker_id: "BTCUSDT",
      open_interest_usd: "100",
      index_price: "100000",
      last_price: "100000",
      usd_volume: "100",
    },
  ];

  const uiTickers: ApexUiTicker[] = [
    {
      symbol: "USOUSDT",
      fundingRate: "0.0000125",
      indexPrice: "149.50",
      lastPrice: "149.80",
      markPrice: "149.48",
      openInterest: "323.64",
      price24hPcnt: "0.0125",
      turnover24h: "221000.12",
      volume24h: "1476.2",
    },
  ];

  it("filters enabled Apex stock-contract RWA categories", () => {
    const parsed = parseApexMarkets(contracts, tickers);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].contract).toBe("apex:USO");
    expect(parsed[0].venue).toBe("apex");
    expect(parsed[0].platform).toBe("apex");
  });

  it("maps ticker and symbol config fields", () => {
    const [uso] = parseApexMarkets(contracts, tickers, uiTickers);
    expect(uso.openInterest).toBe(48371.2344);
    expect(uso.volume24h).toBe(221000.12);
    expect(uso.markPx).toBe(149.48);
    expect(uso.oraclePx).toBe(149.5);
    expect(uso.midPx).toBeCloseTo((149.27 + 149.52) / 2);
    expect(uso.fundingRate).toBe(0.0000125);
    expect(uso.prevDayPx).toBeCloseTo(149.8 / 1.0125);
    expect(uso.priceChange24h).toBe(1.25);
    expect(uso.premium).toBeCloseTo((149.48 - 149.5) / 149.5);
    expect(uso.maxLeverage).toBe(50);
    expect(uso.szDecimals).toBe(2);
    expect(uso.makerFeeRate).toBe(0.0002);
    expect(uso.takerFeeRate).toBe(0.0005);
  });

  it("skips enabled contracts when no matching ticker is present", () => {
    expect(parseApexMarkets([contracts[0]], [])).toEqual([]);
  });
});

// ── variational.ts parsers ───────────────────────────────────────────────────

describe("parseVariationalMarkets", () => {
  const listings: VariationalListing[] = [
    {
      ticker: "XAU",
      name: "Gold",
      mark_price: "4497.97",
      volume_24h: "23277904.91",
      open_interest: {
        long_open_interest: "3000000.5",
        short_open_interest: "2693491.25",
      },
      funding_rate: "0.084694",
      funding_interval_s: 14400,
      base_spread_bps: "6.43",
      quotes: {
        base: { bid: "4497.50", ask: "4498.50" },
      },
    },
    {
      ticker: "BTC",
      name: "Bitcoin",
      mark_price: "77308.63",
      volume_24h: "318320282.07",
      open_interest: {
        long_open_interest: "100",
        short_open_interest: "200",
      },
    },
  ];

  it("keeps only Variational RWA tickers", () => {
    const parsed = parseVariationalMarkets(listings);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].contract).toBe("variational:XAU");
    expect(parsed[0].venue).toBe("variational");
    expect(parsed[0].platform).toBe("variational");
  });

  it("maps notional market fields from the stats listing", () => {
    const [xau] = parseVariationalMarkets(listings);
    expect(xau.openInterest).toBe(11386983.5);
    expect(xau.volume24h).toBe(23277904.91);
    expect(xau.markPx).toBe(4497.97);
    expect(xau.oraclePx).toBe(0);
    expect(xau.midPx).toBe(4498);
    expect(xau.fundingRate).toBeCloseTo(0.084694 / 2190);
    expect(xau.maxLeverage).toBe(VARIATIONAL_MAX_LEVERAGE);
    expect(xau.makerFeeRate).toBe(VARIATIONAL_MAKER_FEE);
    expect(xau.takerFeeRate).toBe(VARIATIONAL_TAKER_FEE);
  });
});

// ── file-cache.ts ─────────────────────────────────────────────────────────────

describe("fileNameNormalizer", () => {
  it("lowercases and strips non-alphanumeric chars", () => {
    expect(fileNameNormalizer("Build/Current.JSON")).toBe("build/current.json");
  });

  it("keeps slashes, dots, hyphens, underscores", () => {
    expect(fileNameNormalizer("charts/venue/my-venue_1.json")).toBe("charts/venue/my-venue_1.json");
  });

  it("strips special characters", () => {
    expect(fileNameNormalizer("foo[bar].json")).toBe("foobar.json");
  });

  it("decodes URI components", () => {
    expect(fileNameNormalizer("hello%20world.json")).toBe("helloworld.json");
  });
});

describe("mergeHistoricalData", () => {
  it("returns new records when existing is null", () => {
    const records = [{ timestamp: 1, value: "a" }];
    expect(mergeHistoricalData(null, records)).toEqual(records);
  });

  it("returns new records when existing is empty", () => {
    const records = [{ timestamp: 1, value: "a" }];
    expect(mergeHistoricalData([], records)).toEqual(records);
  });

  it("merges and deduplicates by timestamp", () => {
    const existing = [
      { timestamp: 1, value: "old1" },
      { timestamp: 2, value: "old2" },
    ];
    const newRec = [
      { timestamp: 2, value: "new2" },
      { timestamp: 3, value: "new3" },
    ];
    const merged = mergeHistoricalData(existing, newRec);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ timestamp: 1, value: "old1" });
    expect(merged[1]).toEqual({ timestamp: 2, value: "new2" }); // new overwrites old
    expect(merged[2]).toEqual({ timestamp: 3, value: "new3" });
  });

  it("returns sorted by timestamp", () => {
    const existing = [{ timestamp: 3 }];
    const newRec = [{ timestamp: 1 }, { timestamp: 2 }];
    const merged = mergeHistoricalData(existing, newRec);
    expect(merged.map((r) => r.timestamp)).toEqual([1, 2, 3]);
  });
});

// ── aggregate.ts ──────────────────────────────────────────────────────────────

describe("buildPerpsIdMap", () => {
  it("preserves bare contract, id, and venue-prefixed aliases without duplicating the venue prefix", () => {
    expect(
      buildPerpsIdMap([
        { id: "tsla", data: { contract: "TSLA", venue: "hyperliquid" } },
        { id: "xyz:meta", data: { contract: "xyz:META", venue: "xyz" } },
      ])
    ).toEqual({
      "tsla": "tsla",
      "hyperliquid-tsla": "tsla",
      "hyperliquid:tsla": "tsla",
      "xyz:meta": "xyz:meta",
      "xyz-meta": "xyz:meta",
    });
  });
});

describe("buildVenueHistoricalCharts", () => {
  it("builds lean historical constituent rows grouped by venue slug", () => {
    const result = buildVenueHistoricalCharts(
      [
        { id: "xyz:meta", timestamp: 100, open_interest: "10", volume_24h: "3" },
        { id: "xyz:meta", timestamp: 200, open_interest: "12", volume_24h: "4" },
        { id: "flx:gold", timestamp: 200, open_interest: "7", volume_24h: "2" },
      ],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAsset: "Meta",
            referenceAssetGroup: "US Equities",
            assetClass: ["Single stock synthetic perp"],
            category: ["RWA Perpetuals"],
          },
        },
        {
          id: "flx:gold",
          data: {
            contract: "flx:GOLD",
            venue: "flx",
            referenceAsset: "Gold",
            referenceAssetGroup: "Commodities",
            assetClass: ["Commodity synthetic perp"],
            category: ["Commodities"],
          },
        },
      ]
    );

    expect(result).toEqual({
      xyz: [
        {
          timestamp: 100,
          id: "xyz:meta",
          contract: "xyz:META",
          venue: "xyz",
          referenceAsset: "Meta",
          referenceAssetGroup: "US Equities",
          assetClass: ["Single stock synthetic perp"],
          category: ["RWA Perpetuals"],
          openInterest: 10,
          volume24h: 3,
        },
        {
          timestamp: 200,
          id: "xyz:meta",
          contract: "xyz:META",
          venue: "xyz",
          referenceAsset: "Meta",
          referenceAssetGroup: "US Equities",
          assetClass: ["Single stock synthetic perp"],
          category: ["RWA Perpetuals"],
          openInterest: 12,
          volume24h: 4,
        },
      ],
      flx: [
        {
          timestamp: 200,
          id: "flx:gold",
          contract: "flx:GOLD",
          venue: "flx",
          referenceAsset: "Gold",
          referenceAssetGroup: "Commodities",
          assetClass: ["Commodity synthetic perp"],
          category: ["Commodities"],
          openInterest: 7,
          volume24h: 2,
        },
      ],
    });
  });
});

describe("buildCategoryHistoricalCharts", () => {
  it("duplicates rows per category and narrows each row to the requested category", () => {
    const result = buildCategoryHistoricalCharts(
      [{ id: "xyz:meta", timestamp: 100, open_interest: "10", volume_24h: "3" }],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAsset: "Meta",
            referenceAssetGroup: "US Equities",
            assetClass: ["Single stock synthetic perp"],
            category: ["RWA Perpetuals", "Equities"],
          },
        },
      ]
    );

    expect(result["rwa-perpetuals"]).toEqual([
      {
        timestamp: 100,
        id: "xyz:meta",
        contract: "xyz:META",
        venue: "xyz",
        referenceAsset: "Meta",
        referenceAssetGroup: "US Equities",
        assetClass: ["Single stock synthetic perp"],
        category: ["RWA Perpetuals"],
        openInterest: 10,
        volume24h: 3,
      },
    ]);
    expect(result["equities"]).toEqual([
      {
        timestamp: 100,
        id: "xyz:meta",
        contract: "xyz:META",
        venue: "xyz",
        referenceAsset: "Meta",
        referenceAssetGroup: "US Equities",
        assetClass: ["Single stock synthetic perp"],
        category: ["Equities"],
        openInterest: 10,
        volume24h: 3,
      },
    ]);
  });
});

describe("buildOverviewBreakdownCharts", () => {
  it("precomputes overview, venue, and asset-group breakdown datasets for each supported metric", () => {
    const result = buildOverviewBreakdownCharts(
      [
        { id: "xyz:meta", timestamp: 100, open_interest: "10", volume_24h: "3" },
        { id: "xyz:meta", timestamp: 200, open_interest: "12", volume_24h: "4" },
        { id: "flx:gold", timestamp: 200, open_interest: "7", volume_24h: "2" },
        { id: "km:bond", timestamp: 200, open_interest: "5", volume_24h: "1" },
      ],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAsset: "Meta",
            referenceAssetGroup: "US Equities",
            assetClass: ["Single stock synthetic perp"],
          },
        },
        {
          id: "flx:gold",
          data: {
            contract: "flx:GOLD",
            venue: "flx",
            referenceAsset: "Gold",
            referenceAssetGroup: "Commodities",
            assetClass: ["Commodity synthetic perp"],
          },
        },
        {
          id: "km:bond",
          data: {
            contract: "km:BOND",
            venue: "km",
            referenceAsset: "Bond",
            assetClass: ["Fixed income synthetic perp"],
          },
        },
      ]
    );

    expect(result["overview-breakdown/all/openinterest/assetgroup.json"]).toEqual([
      { timestamp: 100, "US Equities": 10 },
      { timestamp: 200, "US Equities": 12, Commodities: 7, Unknown: 5 },
    ]);
    expect(result["overview-breakdown/venue/xyz/markets/baseasset.json"]).toEqual([
      { timestamp: 100, Meta: 1 },
      { timestamp: 200, Meta: 1 },
    ]);
    expect(result["overview-breakdown/assetgroup/us-equities/volume24h/venue.json"]).toEqual([
      { timestamp: 100, xyz: 3 },
      { timestamp: 200, xyz: 4 },
    ]);
    expect(result["overview-breakdown/assetgroup/unknown/openinterest/baseasset.json"]).toEqual([
      { timestamp: 200, Bond: 5 },
    ]);
    expect(result["overview-breakdown/assetclass/single-stock-synthetic-perp/openinterest/venue.json"]).toEqual([
      { timestamp: 100, xyz: 10 },
      { timestamp: 200, xyz: 12 },
    ]);
    expect(result["overview-breakdown/excludeassetclass/single-stock-synthetic-perp/openinterest/assetgroup.json"]).toEqual([
      { timestamp: 200, Commodities: 7, Unknown: 5 },
    ]);
  });

  it("drops historical rows without metadata while preserving real Unknown asset-group buckets", () => {
    const result = buildOverviewBreakdownCharts(
      [
        { id: "cash:hood", timestamp: 100, open_interest: "10", volume_24h: "3" },
        { id: "xyz:meta", timestamp: 100, open_interest: "5", volume_24h: "2" },
        { id: "legacy:unmapped", timestamp: 100, open_interest: "99", volume_24h: "88" },
      ],
      [
        {
          id: "cash:hood-usdt",
          data: {
            contract: "cash:HOOD-USDT",
            venue: "cash",
            referenceAsset: "Robinhood",
            referenceAssetGroup: "Public Equities",
            assetClass: ["Stock Perp"],
          },
        },
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAsset: "Meta",
            assetClass: ["Stock Perp"],
          },
        },
      ]
    );

    expect(result["overview-breakdown/all/openinterest/assetgroup.json"]).toEqual([
      { timestamp: 100, "Public Equities": 10, Unknown: 5 },
    ]);
    expect(result["overview-breakdown/all/openinterest/venue.json"]).toEqual([
      { timestamp: 100, cash: 10, xyz: 5 },
    ]);
    expect(result["overview-breakdown/assetgroup/public-equities/openinterest/baseasset.json"]).toEqual([
      { timestamp: 100, Robinhood: 10 },
    ]);
    expect(result["overview-breakdown/assetgroup/unknown/openinterest/baseasset.json"]).toEqual([
      { timestamp: 100, Meta: 5 },
    ]);
  });

  it("does not resolve stripped stable-quote aliases when multiple metadata rows collide", () => {
    const result = buildOverviewBreakdownCharts(
      [
        { id: "cash:hood", timestamp: 100, open_interest: "10", volume_24h: "3" },
        { id: "cash:hood-usdt", timestamp: 100, open_interest: "7", volume_24h: "2" },
      ],
      [
        {
          id: "cash:hood-usdt",
          data: {
            contract: "cash:HOOD-USDT",
            venue: "cash",
            referenceAsset: "Robinhood USDT",
            referenceAssetGroup: "Public Equities",
            assetClass: ["Stock Perp"],
          },
        },
        {
          id: "cash:hood-usdc",
          data: {
            contract: "cash:HOOD-USDC",
            venue: "cash",
            referenceAsset: "Robinhood USDC",
            referenceAssetGroup: "Public Equities",
            assetClass: ["Stock Perp"],
          },
        },
      ]
    );

    expect(result["overview-breakdown/all/openinterest/venue.json"]).toEqual([{ timestamp: 100, cash: 7 }]);
    expect(result["overview-breakdown/all/openinterest/baseasset.json"]).toEqual([
      { timestamp: 100, "Robinhood USDT": 7 },
    ]);
  });

  it("omits zero-only pre-launch breakdown keys and keeps post-start zeroes", () => {
    const result = buildOverviewBreakdownCharts(
      [
        { id: "xyz:meta", timestamp: 100, open_interest: "0", volume_24h: "0" },
        { id: "flx:gold", timestamp: 100, open_interest: "7", volume_24h: "2" },
        { id: "xyz:meta", timestamp: 150, open_interest: "5", volume_24h: "0" },
        { id: "xyz:meta", timestamp: 200, open_interest: "12", volume_24h: "4" },
        { id: "xyz:meta", timestamp: 300, open_interest: "0", volume_24h: "0" },
      ],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAsset: "Meta",
            referenceAssetGroup: "US Equities",
          },
        },
        {
          id: "flx:gold",
          data: {
            contract: "flx:GOLD",
            venue: "flx",
            referenceAsset: "Gold",
            referenceAssetGroup: "Commodities",
          },
        },
      ]
    );

    expect(result["overview-breakdown/all/openinterest/baseasset.json"]).toEqual([
      { timestamp: 100, Gold: 7 },
      { timestamp: 150, Meta: 5 },
      { timestamp: 200, Meta: 12 },
      { timestamp: 300, Meta: 0 },
    ]);
    expect(result["overview-breakdown/all/volume24h/baseasset.json"]).toEqual([
      { timestamp: 100, Gold: 2 },
      { timestamp: 150, Meta: 0 },
      { timestamp: 200, Meta: 4 },
      { timestamp: 300, Meta: 0 },
    ]);
    expect(result["overview-breakdown/all/markets/baseasset.json"]).toEqual([
      { timestamp: 100, Meta: 1, Gold: 1 },
      { timestamp: 150, Meta: 1 },
      { timestamp: 200, Meta: 1 },
      { timestamp: 300, Meta: 1 },
    ]);
  });
});

describe("buildContractBreakdownCharts", () => {
  it("precomputes contract-level datasets for overview, venue, and asset-group targets", () => {
    const result = buildContractBreakdownCharts(
      [
        { id: "xyz:meta", timestamp: 100, open_interest: "10", volume_24h: "3" },
        { id: "xyz:meta", timestamp: 200, open_interest: "12", volume_24h: "4" },
        { id: "flx:gold", timestamp: 200, open_interest: "7", volume_24h: "2" },
      ],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAssetGroup: "US Equities",
            assetClass: ["Single stock synthetic perp"],
          },
        },
        {
          id: "flx:gold",
          data: {
            contract: "flx:GOLD",
            venue: "flx",
            referenceAssetGroup: "Commodities",
            assetClass: ["Commodity synthetic perp"],
          },
        },
      ]
    );

    expect(result["contract-breakdown/all/openinterest.json"]).toEqual([
      { timestamp: 100, "xyz:META": 10 },
      { timestamp: 200, "xyz:META": 12, "flx:GOLD": 7 },
    ]);
    expect(result["contract-breakdown/venue/xyz/markets.json"]).toEqual([
      { timestamp: 100, "xyz:META": 1 },
      { timestamp: 200, "xyz:META": 1 },
    ]);
    expect(result["contract-breakdown/assetgroup/commodities/volume24h.json"]).toEqual([
      { timestamp: 200, "flx:GOLD": 2 },
    ]);
    expect(result["contract-breakdown/assetclass/single-stock-synthetic-perp/openinterest.json"]).toEqual([
      { timestamp: 100, "xyz:META": 10 },
      { timestamp: 200, "xyz:META": 12 },
    ]);
    expect(result["contract-breakdown/excludeassetclass/single-stock-synthetic-perp/openinterest.json"]).toEqual([
      { timestamp: 200, "flx:GOLD": 7 },
    ]);
  });

  it("omits zero-only pre-launch contract keys and keeps post-start zeroes", () => {
    const result = buildContractBreakdownCharts(
      [
        { id: "xyz:meta", timestamp: 100, open_interest: "0", volume_24h: "0" },
        { id: "flx:gold", timestamp: 100, open_interest: "7", volume_24h: "2" },
        { id: "xyz:meta", timestamp: 150, open_interest: "5", volume_24h: "0" },
        { id: "xyz:meta", timestamp: 200, open_interest: "12", volume_24h: "4" },
        { id: "xyz:meta", timestamp: 300, open_interest: "0", volume_24h: "0" },
      ],
      [
        {
          id: "xyz:meta",
          data: {
            contract: "xyz:META",
            venue: "xyz",
            referenceAssetGroup: "US Equities",
          },
        },
        {
          id: "flx:gold",
          data: {
            contract: "flx:GOLD",
            venue: "flx",
            referenceAssetGroup: "Commodities",
          },
        },
      ]
    );

    expect(result["contract-breakdown/all/openinterest.json"]).toEqual([
      { timestamp: 100, "flx:GOLD": 7 },
      { timestamp: 150, "xyz:META": 5 },
      { timestamp: 200, "xyz:META": 12 },
      { timestamp: 300, "xyz:META": 0 },
    ]);
    expect(result["contract-breakdown/all/volume24h.json"]).toEqual([
      { timestamp: 100, "flx:GOLD": 2 },
      { timestamp: 150, "xyz:META": 0 },
      { timestamp: 200, "xyz:META": 4 },
      { timestamp: 300, "xyz:META": 0 },
    ]);
    expect(result["contract-breakdown/all/markets.json"]).toEqual([
      { timestamp: 100, "xyz:META": 1, "flx:GOLD": 1 },
      { timestamp: 150, "xyz:META": 1 },
      { timestamp: 200, "xyz:META": 1 },
      { timestamp: 300, "xyz:META": 1 },
    ]);
  });
});

describe("server route helpers", () => {
  const currentData = [
    { id: "tsla", contract: "TSLA", venue: "Hyperliquid", category: ["Equities"], referenceAssetGroup: null },
    { id: "xyz:meta", contract: "xyz:META", venue: "XYZ", category: ["RWA Perpetuals", "Equities"], referenceAssetGroup: "US Equities" },
  ];

  it("finds a market by id case-insensitively", () => {
    expect(findMarketById(currentData, "XYZ:META")).toEqual(currentData[1]);
  });

  it("finds markets by canonical contract key", () => {
    expect(findMarketsByContract(currentData, "xyz:META")).toEqual([currentData[1]]);
    expect(findMarketsByContract(currentData, "xyz-meta")).toEqual([currentData[1]]);
  });

  it("filters markets by venue slug", () => {
    expect(findMarketsByVenue(currentData, "hyperliquid")).toEqual([currentData[0]]);
  });

  it("filters markets by category", () => {
    expect(findMarketsByCategory(currentData, "Equities")).toEqual(currentData);
  });

  it("filters markets by slugged category routes", () => {
    expect(findMarketsByCategory(currentData, "rwa-perpetuals")).toEqual([currentData[1]]);
  });

  it("filters markets by asset group and buckets missing values into Unknown", () => {
    expect(findMarketsByAssetGroup(currentData, "us-equities")).toEqual([currentData[1]]);
    expect(findMarketsByAssetGroup(currentData, "unknown")).toEqual([currentData[0]]);
  });

  it("resolves lowercase and slugged aliases through id-map entries", () => {
    const idMap = {
      "xyz:meta": "xyz:meta",
      "xyz-meta": "xyz:meta",
      "hyperliquid:tsla": "tsla",
      "hyperliquid-tsla": "tsla",
    };

    expect(resolvePerpsLookupId(idMap, "xyz:META")).toBe("xyz:meta");
    expect(resolvePerpsLookupId(idMap, "xyz-meta")).toBe("xyz:meta");
    expect(resolvePerpsLookupId(idMap, "hyperliquid:TSLA")).toBe("tsla");
    expect(resolvePerpsLookupId(idMap, "hyperliquid-tsla")).toBe("tsla");
  });

  it("normalizes missing asset groups and parses valid chart targets", () => {
    expect(normalizePerpsAssetGroup("  ")).toBe("Unknown");
    expect(parsePerpsChartTarget({})).toEqual({ kind: "all" });
    expect(parsePerpsChartTarget({ venue: " XYZ " })).toEqual({ kind: "venue", slug: "xyz" });
    expect(parsePerpsChartTarget({ assetGroup: "US Equities" })).toEqual({ kind: "assetGroup", slug: "us-equities" });
    expect(parsePerpsChartTarget({ assetClass: "Forex Perps" })).toEqual({ kind: "assetClass", slug: "forex-perps" });
    expect(parsePerpsChartTarget({ excludeAssetClass: "Forex Perps" })).toEqual({
      kind: "excludeAssetClass",
      slug: "forex-perps",
    });
    expect(parsePerpsChartTarget({ venue: "xyz", assetGroup: "us-equities" })).toBeNull();
    expect(parsePerpsChartTarget({ venue: "xyz", assetClass: "forex-perps" })).toBeNull();
    expect(parsePerpsChartTarget({ assetClass: "forex-perps", excludeAssetClass: "forex-perps" })).toBeNull();
  });

  it("builds cached breakdown file paths and rejects invalid combinations", () => {
    expect(
      getPerpsOverviewBreakdownFilePath({
        target: { kind: "all" },
        key: "openInterest",
        breakdown: "assetGroup",
      })
    ).toBe("charts/overview-breakdown/all/openinterest/assetgroup.json");

    expect(
      getPerpsOverviewBreakdownFilePath({
        target: { kind: "venue", slug: "xyz" },
        key: "markets",
        breakdown: "venue",
      })
    ).toBeNull();

    expect(
      getPerpsContractBreakdownFilePath({
        target: { kind: "assetGroup", slug: "us-equities" },
        key: "volume24h",
      })
    ).toBe("charts/contract-breakdown/assetgroup/us-equities/volume24h.json");

    expect(
      getPerpsOverviewBreakdownFilePath({
        target: { kind: "assetClass", slug: "forex-perps" },
        key: "openInterest",
        breakdown: "assetGroup",
      })
    ).toBe("charts/overview-breakdown/assetclass/forex-perps/openinterest/assetgroup.json");

    expect(
      getPerpsOverviewBreakdownFilePath({
        target: { kind: "assetClass", slug: "forex-perps" },
        key: "openInterest",
        breakdown: "assetClass",
      })
    ).toBe("charts/overview-breakdown/assetclass/forex-perps/openinterest/assetclass.json");

    expect(
      getPerpsContractBreakdownFilePath({
        target: { kind: "assetClass", slug: "forex-perps" },
        key: "markets",
      })
    ).toBe("charts/contract-breakdown/assetclass/forex-perps/markets.json");

    expect(
      getPerpsOverviewBreakdownFilePath({
        target: { kind: "excludeAssetClass", slug: "forex-perps" },
        key: "openInterest",
        breakdown: "assetGroup",
      })
    ).toBe("charts/overview-breakdown/excludeassetclass/forex-perps/openinterest/assetgroup.json");

    expect(
      getPerpsContractBreakdownFilePath({
        target: { kind: "excludeAssetClass", slug: "forex-perps" },
        key: "markets",
      })
    ).toBe("charts/contract-breakdown/excludeassetclass/forex-perps/markets.json");

    expect(
      getPerpsContractBreakdownFilePath({
        target: { kind: "all" },
        key: "activeMcap",
      })
    ).toBeNull();
  });

  it("sorts market arrays by descending open interest with deterministic tie-breakers", () => {
    expect(
      sortPerpsMarketsByOpenInterest([
        { id: "beta:meta", contract: "META", venue: "Beta", openInterest: 8 },
        { id: "alpha:tsla", contract: "TSLA", venue: "Alpha", openInterest: 12 },
        { id: "alpha:meta", contract: "META", venue: "Alpha", openInterest: 8 },
        { id: "gamma:aapl", contract: "AAPL", venue: "Gamma", openInterest: 8 },
      ])
    ).toEqual([
      { id: "alpha:tsla", contract: "TSLA", venue: "Alpha", openInterest: 12 },
      { id: "gamma:aapl", contract: "AAPL", venue: "Gamma", openInterest: 8 },
      { id: "alpha:meta", contract: "META", venue: "Alpha", openInterest: 8 },
      { id: "beta:meta", contract: "META", venue: "Beta", openInterest: 8 },
    ]);
  });
});

describe("buildPerpsList", () => {
  it("sorts all list facets by descending open interest with alphabetical tie-breakers", () => {
    expect(
      buildPerpsList([
        {
          contract: "xyz:META",
          venue: "Beta",
          category: ["Equities", "RWA Perpetuals"],
          referenceAssetGroup: "US Equities",
          openInterest: 20,
        },
        {
          contract: "TSLA",
          venue: "Alpha",
          category: ["Equities"],
          referenceAssetGroup: "US Equities",
          openInterest: 15,
        },
        {
          contract: "GOLD",
          venue: "Alpha",
          category: ["Commodities"],
          referenceAssetGroup: "Commodities",
          openInterest: 15,
        },
        {
          contract: "xyz:META",
          venue: "Alpha",
          category: null,
          referenceAssetGroup: " ",
          openInterest: 10,
        },
        {
          contract: "AAPL",
          venue: "",
          category: ["Equities"],
          referenceAssetGroup: null,
          openInterest: 5,
        },
      ])
    ).toEqual({
      contracts: ["xyz:META", "GOLD", "TSLA", "AAPL"],
      venues: ["Alpha", "Beta", "unknown"],
      categories: ["Equities", "RWA Perpetuals", "Commodities", "Other"],
      assetGroups: ["US Equities", "Commodities", "Unknown"],
      total: 5,
    });
  });

  it("skips empty contracts but still counts the row toward fallback group totals", () => {
    expect(
      buildPerpsList([
        {
          contract: "",
          venue: undefined,
          category: undefined,
          referenceAssetGroup: undefined,
          openInterest: 7,
        },
      ])
    ).toEqual({
      contracts: [],
      venues: ["unknown"],
      categories: ["Other"],
      assetGroups: ["Unknown"],
      total: 1,
    });
  });
});
