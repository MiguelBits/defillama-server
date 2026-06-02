require("dotenv").config();
import { errorResponse, successResponse, wrap, IResponse } from "./utils/shared";
import parseRequestBody from "./utils/shared/parseRequestBody";
import { quantisePeriod } from "./utils/timestampUtils";
import { fetchDBData } from "./getBatchHistoricalCoins";

const defaultSearchWidth = quantisePeriod("12h");

function parseSearchWidth(value: unknown): number | null | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return null;
  if (!value.trim()) return undefined;

  const seconds = quantisePeriod(value.toLowerCase());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

const handler = async (event: any): Promise<IResponse> => {
  const body = parseRequestBody(event.body);
  const coinsObj: { [coin: string]: number[] } = body.coins;
  const searchWidth = parseSearchWidth(body.searchWidth);
  if (searchWidth === null) {
    return errorResponse({ message: 'searchWidth must be a duration like "4h" or "12h"' });
  }
  const response = await fetchDBData(coinsObj, searchWidth ?? defaultSearchWidth);

  return successResponse({ coins: response });
};

export default wrap(handler);
