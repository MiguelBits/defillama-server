import postHistoricalCoinsHandler from "./postHistoricalCoins";
import { fetchDBData } from "./getBatchHistoricalCoins";

jest.mock("./getBatchHistoricalCoins", () => ({
  fetchDBData: jest.fn(),
}));

const fetchDBDataMock = fetchDBData as jest.MockedFunction<typeof fetchDBData>;

function parseResponse(raw: any) {
  return {
    ...raw,
    body: JSON.parse(raw.body),
  };
}

describe("postHistoricalCoins", () => {
  beforeEach(() => {
    fetchDBDataMock.mockReset();
  });

  it("uses the default 12h search width", async () => {
    fetchDBDataMock.mockResolvedValue({
      "coingecko:ethereum": {
        symbol: "ETH",
        prices: [{ timestamp: 1, price: 2 }],
      },
    });

    const coins = { "coingecko:ethereum": [1] };
    const response = parseResponse(
      await postHistoricalCoinsHandler({
        body: JSON.stringify({ coins }),
      } as any),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      coins: {
        "coingecko:ethereum": {
          symbol: "ETH",
          prices: [{ timestamp: 1, price: 2 }],
        },
      },
    });
    expect(fetchDBDataMock).toHaveBeenCalledWith(coins, 12 * 60 * 60);
  });

  it("accepts a 6h search width from the JSON body", async () => {
    fetchDBDataMock.mockResolvedValue({});

    const coins = { "coingecko:ethereum": [1] };
    const response = parseResponse(
      await postHistoricalCoinsHandler({
        body: JSON.stringify({ coins, searchWidth: "6h" }),
      } as any),
    );

    expect(response.statusCode).toBe(200);
    expect(fetchDBDataMock).toHaveBeenCalledWith(coins, 6 * 60 * 60);
  });

  it("rejects malformed searchWidth values", async () => {
    const response = parseResponse(
      await postHistoricalCoinsHandler({
        body: JSON.stringify({ coins: { "coingecko:ethereum": [1] }, searchWidth: "garbage" }),
      } as any),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ message: 'searchWidth must be a duration like "4h" or "12h"' });
    expect(fetchDBDataMock).not.toHaveBeenCalled();
  });
});
