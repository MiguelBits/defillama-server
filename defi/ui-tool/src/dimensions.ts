import loadAdaptorsData from "../../src/adaptors/data"
import { AdapterType, AdaptorRecordType, ACCOMULATIVE_ADAPTOR_TYPE } from "../../src/adaptors/data/types";
import { getAllDimensionsRecordsTimeS, getDimensionsRecordsInRange, storeAdapterRecord } from "../../src/adaptors/db-utils/db2";
import { AdapterRecord2 } from "../../src/adaptors/db-utils/AdapterRecord2";
import { getTimestampString } from "../../src/api2/utils";
import { handler2, DimensionRunOptions } from "../../src/adaptors/handlers/storeAdaptorData";
import PromisePool from '@supercharge/promise-pool';
import { humanizeNumber } from "@defillama/sdk";
import { ADAPTER_TYPES } from "../../src/adaptors/data/types";
import sleep from "../../src/utils/shared/sleep";
import { getTimestampAtStartOfDayUTC } from "../../src/utils/date";

const ONE_DAY_IN_SECONDS = 24 * 60 * 60

const recordItems: any = {}

export const dimensionFormChoices: any = {
  adapterTypes: ADAPTER_TYPES,
  adapterTypeChoices: {},
}

ADAPTER_TYPES.forEach((adapterType: any) => {
  const { protocolAdaptors } = loadAdaptorsData(adapterType)
  dimensionFormChoices.adapterTypeChoices[adapterType] = protocolAdaptors.map((p: any) => p.displayName)
})

export async function runDimensionsRefill(ws: any, args: any) {
  const start = +new Date()
  process.env.AWS_REGION = process.env.AWS_REGION || 'eu-central-1'
  process.env.tableName = process.env.tableName || 'prod-table'

  let fromTimestamp = args.dateFrom
  let toTimestamp = args.dateTo
  const adapterType = args.adapterType
  const protocolToRun = args.protocol
  const checkBeforeInsert = args.checkBeforeInsert
  const delayBetweenRuns = args.delayBetweenRuns ?? 0
  const parallelHourlyProcessCount = args.parallelHourlyProcessCount ?? 1
  const skipHourlyCache = !!args.skipHourlyCache
  const protocolNames = new Set([protocolToRun])
  if (checkBeforeInsert) args.dryRun = true

  if (delayBetweenRuns)
    console.log(`Delay between runs is set to ${delayBetweenRuns} seconds`)

  // const endOfToday = getTimestampAtStartOfDayUTC(Math.floor(Date.now() / 1000)) + ONE_DAY_IN_SECONDS - 1
  // // skip if end date is in the future
  // if (toTimestamp > endOfToday)
  //   toTimestamp = endOfToday

  const { protocolAdaptors, } = loadAdaptorsData(adapterType as AdapterType)
  let protocol = protocolAdaptors.find(p => p.displayName === protocolToRun || p.module === protocolToRun || p.id === protocolToRun)

  if (!protocol) {
    throw new Error(`Protocol "${protocolToRun}" not found for adapter type "${adapterType}"`)
  }

  // CSV loading mode: build records directly from a pasted CSV instead of running the adapter's fetch functions
  if (args.loadFromCsv) {
    await loadRecordsFromCsv(ws, { csvText: args.csvText, adapterType: adapterType as AdapterType, protocol })
    return
  }

  if (fromTimestamp > toTimestamp) {
    console.error('Invalid date range. Start date should be less than end date.')
    return;
  }

  let i = 0
  let items: DimensionRunOptions[] = []
  let timeSWithData = new Set()
  let days = getDaysBetweenTimestamps(fromTimestamp, toTimestamp)

  if (args.onlyMissing) {
    const allTimeSData = await getAllDimensionsRecordsTimeS({ adapterType: adapterType as any, id: protocol.id2 })
    console.log('existing records in db:', allTimeSData.length)
    timeSWithData = new Set(allTimeSData.map((d: any) => d.timeS))
    allTimeSData.sort((a: any, b: any) => a.timestamp - b.timestamp)
    let firstTimestamp = allTimeSData[0]?.timestamp
    let lastTimestamp = allTimeSData[allTimeSData.length - 1]?.timestamp

    if (allTimeSData.length < 3) return;
    do {
      const currentTimeS = getTimestampString(lastTimestamp)
      if (!timeSWithData.has(currentTimeS)) {
        console.log('missing data on', new Date((lastTimestamp) * 1000).toLocaleDateString())
        const eventObj: DimensionRunOptions = {
          timestamp: lastTimestamp,
          adapterType: adapterType as any,
          isDryRun: args.dryRun,
          protocolNames,
          isRunFromRefillScript: true,
          checkBeforeInsert,
          skipHourlyCache,
          parallelHourlyProcessCount,
        }
        items.push(eventObj)
      }
      lastTimestamp -= ONE_DAY_IN_SECONDS
    } while (lastTimestamp > firstTimestamp)
  } else {
    let currentDayEndTimestamp = toTimestamp

    while (days >= 0) {
      const eventObj: DimensionRunOptions = {
        timestamp: currentDayEndTimestamp,
        adapterType: adapterType as any,
        isDryRun: args.dryRun,
        protocolNames,
        isRunFromRefillScript: true,
        checkBeforeInsert,
        skipHourlyCache,
        parallelHourlyProcessCount,
      }
      items.push(eventObj)

      days--
      currentDayEndTimestamp -= ONE_DAY_IN_SECONDS
    }
  }
  let consoleDelayCounter = 0

  const { errors } = await PromisePool
    .withConcurrency(args.parallelCount)
    .for(items)
    .process(async (eventObj: any) => {
      console.log(++i, 'refilling data on', new Date((eventObj.timestamp) * 1000).toLocaleDateString())
      const response = await handler2(eventObj)
      if (delayBetweenRuns > 0) {
        consoleDelayCounter++
        if (consoleDelayCounter < 3)
          console.log(`Waiting for ${delayBetweenRuns} seconds before next run...`)
        await sleep(delayBetweenRuns * 1000)
      }
      if (checkBeforeInsert && response?.length)
        response.forEach((r: any) => {
          if (!r) return;
          recordItems[r.id] = r
        })
      sendWaitingRecords(ws)
    })

  const runTime = ((+(new Date) - start) / 1e3).toFixed(1)
  console.log(`[Done] | runtime: ${runTime}s  `)
  if (errors.length > 0) {
    console.log('Errors:', errors.length)
    console.error(errors)
  }

  if (checkBeforeInsert) {
    console.log('Dry run, no data was inserted')
    sendWaitingRecords(ws)
  }
}

function getDaysBetweenTimestamps(from: number, to: number): number {
  return Math.round((to - from) / ONE_DAY_IN_SECONDS)
}

type CsvAggregated = { [shortKey: string]: { value: number, chains: { [chain: string]: number } } }
type CsvLog = { level: 'log' | 'error', text: string }
type CsvBuildResult = { records: AdapterRecord2[], logs: CsvLog[], skippedRows: number }

// Parse a pasted CSV into dimension records, WITHOUT touching the DB or websocket - pure and testable.
// The records produced are identical in shape to what the normal adapter-fetch path stages, so the
// existing "Save All" flow stores them the same way (see loadRecordsFromCsv / storeAllWaitingRecords).
//
// Expected CSV shape (headers are case-insensitive, order does not matter):
//   - a date column: one of `date`, `timestamp`, `time`, `day` (YYYY-MM-DD, ISO, or unix seconds/ms)
//   - an optional `chain` column - when present, multiple rows per date (one per chain) are aggregated
//     into a single record with a per-chain breakdown; when absent the protocol's first chain is used
//   - one or more dimension columns, named either long (`dailyVolume`) or short (`dv`); only columns valid
//     for the adapter type (its KEYS_TO_STORE) are kept, everything else is ignored
export function buildRecordsFromCsv({ csvText, adapterType, protocol }: { csvText: string, adapterType: AdapterType, protocol: any }): CsvBuildResult {
  const logs: CsvLog[] = []
  const log = (text: string) => logs.push({ level: 'log', text })
  const err = (text: string) => logs.push({ level: 'error', text })
  const records: AdapterRecord2[] = []
  let skippedRows = 0
  const done = () => ({ records, logs, skippedRows })

  if (!csvText || !csvText.trim()) {
    err('CSV is empty - nothing to load')
    return done()
  }

  const { KEYS_TO_STORE } = loadAdaptorsData(adapterType)
  const allowedShortKeys = new Set(Object.keys(KEYS_TO_STORE || {}))
  if (!allowedShortKeys.size) {
    err(`No KEYS_TO_STORE found for adapter type "${adapterType}", cannot load CSV`)
    return done()
  }

  // accept both long names ('dailyVolume') and short keys ('dv'), plus a short -> long map for messages
  const longToShort: { [k: string]: string } = {}
  const shortToLong: { [k: string]: string } = {}
  const shortKeys = new Set<string>()
  Object.entries(AdaptorRecordType).forEach(([longName, shortKey]: any) => {
    longToShort[longName.toLowerCase()] = shortKey
    shortToLong[shortKey] = longName
    shortKeys.add(shortKey)
  })
  const resolveDimensionKey = (header: string): string | null => {
    const h = header.trim()
    if (shortKeys.has(h)) return h
    return longToShort[h.toLowerCase()] ?? null
  }

  const defaultChain = (protocol.chains && protocol.chains[0]) || 'unknown'

  const rows = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length && !l.startsWith('#'))
  if (rows.length < 2) {
    err('CSV needs a header row and at least one data row')
    return done()
  }

  const splitRow = (line: string) => line.split(',').map(c => c.trim())
  const headers = splitRow(rows[0])

  const dateColIdx = headers.findIndex(h => /^(date|timestamp|time|day|ts)$/i.test(h))
  if (dateColIdx === -1) {
    err(`CSV must have a date column (date, timestamp, time, or day). Found headers: ${headers.join(', ')}`)
    return done()
  }
  const chainColIdx = headers.findIndex(h => /^chain$/i.test(h))

  // Keep only columns whose dimension exists in the adapter type's KEYS_TO_STORE; ignore the rest.
  const dimensionCols: { idx: number, shortKey: string, header: string }[] = []
  headers.forEach((header, idx) => {
    if (idx === dateColIdx || idx === chainColIdx) return
    const shortKey = resolveDimensionKey(header)
    if (!shortKey) {
      err(`Ignoring unknown column "${header}" - not a recognised dimension`)
      return
    }
    if (!allowedShortKeys.has(shortKey)) {
      err(`Ignoring column "${header}" (${shortKey}) - not stored for adapter type "${adapterType}"`)
      return
    }
    dimensionCols.push({ idx, shortKey, header })
  })

  if (!dimensionCols.length) {
    err(`No valid dimension columns found for "${adapterType}". Allowed keys: ${[...allowedShortKeys].join(', ')}`)
    return done()
  }

  // Warnings computed once, up front, from the adapter config (no DB call). Informational only - they
  // never skip records.

  // 1. CSV stores raw USD numbers only; token-level breakdowns are not produced from a CSV
  log(`ℹ️ CSV loading stores raw USD numbers only. Token-breakdown adapters are not yet supported - only aggregated USD values (per chain) will be saved.`)

  // 2. Protocol spans multiple chains but the CSV has no chain column - everything lands on one chain
  if (chainColIdx === -1 && Array.isArray(protocol.chains) && protocol.chains.length > 1) {
    err(`⚠️ CSV has no "chain" column, but ${protocol.displayName} has ${protocol.chains.length} chains (${protocol.chains.join(', ')}). All values will be attributed to "${defaultChain}". Add a "chain" column to split values per chain.`)
  }

  // 3. Dimensions this adapter type supports that the CSV omits - if the adapter normally returns them,
  //    saving overwrites the record and drops them (e.g. a fees CSV with only dailyFees wipes dailyRevenue).
  //    Cumulative `total*` types are excluded: they are derived running totals, not CSV inputs.
  const accumulativeKeys = new Set<string>(Object.values(ACCOMULATIVE_ADAPTOR_TYPE) as string[])
  const providedShortKeys = new Set(dimensionCols.map((d) => d.shortKey))
  const missingForType = [...allowedShortKeys].filter((k) => !providedShortKeys.has(k) && !accumulativeKeys.has(k))
  if (missingForType.length) {
    const labels = missingForType.map((k) => `${shortToLong[k] ?? k} (${k})`).join(', ')
    err(`⚠️ "${adapterType}" also supports these dimensions not in your CSV: ${labels}. Saving OVERWRITES the whole record, so any of these the adapter normally returns will be dropped. Add them as columns to keep them.`)
  }

  const parseNumber = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === null) return null
    const cleaned = String(raw).replace(/[$,\s]/g, '')
    if (cleaned === '') return null
    return Number(cleaned) // may be NaN, caller checks
  }

  const parseDate = (raw: string | undefined): number | null => {
    const v = (raw ?? '').trim()
    if (!v) return null
    if (/^\d+$/.test(v)) { // unix seconds or ms
      let n = Number(v)
      if (n > 1e12) n = Math.floor(n / 1000)
      return getTimestampAtStartOfDayUTC(n)
    }
    const ms = Date.parse(v.includes('T') ? v : v + 'T00:00:00Z')
    if (Number.isNaN(ms)) return null
    return getTimestampAtStartOfDayUTC(Math.floor(ms / 1000))
  }

  // group rows by start-of-day UTC, summing per chain and across chains
  const byDate: { [ts: number]: CsvAggregated } = {}
  for (let r = 1; r < rows.length; r++) {
    const cols = splitRow(rows[r])
    const ts = parseDate(cols[dateColIdx])
    if (ts === null) {
      err(`Row ${r + 1}: invalid date "${cols[dateColIdx]}", skipping row`)
      skippedRows++
      continue
    }
    const chain = (chainColIdx !== -1 && cols[chainColIdx]) ? cols[chainColIdx] : defaultChain
    const agg = byDate[ts] ?? (byDate[ts] = {})

    for (const { idx, shortKey, header } of dimensionCols) {
      const value = parseNumber(cols[idx])
      if (value === null) continue // empty cell
      if (Number.isNaN(value)) {
        err(`Row ${r + 1}: non-numeric value "${cols[idx]}" for column "${header}", skipping cell`)
        continue
      }
      const record = agg[shortKey] ?? (agg[shortKey] = { value: 0, chains: {} })
      record.chains[chain] = (record.chains[chain] || 0) + value
      record.value += value
    }
  }

  const dateKeys = Object.keys(byDate).map(Number).sort((a, b) => a - b)
  for (const ts of dateKeys) {
    const aggregated = byDate[ts]
    if (!Object.keys(aggregated).length) continue

    const adapterRecord = AdapterRecord2.formAdaptarRecord2({
      jsonData: { timestamp: ts, aggregated: aggregated as any },
      protocolType: protocol.protocolType,
      adapterType,
      protocol,
    })
    if (!adapterRecord) {
      err(`Could not build a valid record for ${new Date(ts * 1000).toISOString().slice(0, 10)} - skipping`)
      continue
    }
    records.push(adapterRecord)
  }

  return done()
}

// Build records from the CSV and stage them in recordItems for review, so the existing "Save All" flow
// stores them - exactly the same store path used by the normal adapter-fetch flow.
async function loadRecordsFromCsv(ws: any, { csvText, adapterType, protocol }: { csvText: string, adapterType: AdapterType, protocol: any }) {
  const { records, logs, skippedRows } = buildRecordsFromCsv({ csvText, adapterType, protocol })

  logs.forEach(({ level, text }) => level === 'error' ? console.error(text) : console.log(text))

  for (const record of records) {
    const id = record.getUniqueKey()
    recordItems[id] = {
      id,
      recordV2: record,
      adapterType,
      protocolName: protocol.displayName,
      timeS: record.timeS,
      storeFunctions: [async () => storeAdapterRecord(record)],
    }
  }

  console.log(`Loaded ${records.length} record(s) from CSV for ${protocol.displayName} (${adapterType})${skippedRows ? `, skipped ${skippedRows} invalid row(s)` : ''}. Review below and click "Save All" to store.`)
  sendWaitingRecords(ws)
}

export function removeWaitingRecords(ws: any, ids: any) {
  if (Array.isArray(ids))
    ids.forEach((id: any) => delete recordItems[id])
  sendWaitingRecords(ws)
}

export async function storeAllWaitingRecords(ws: any) {
  const allRecords = Object.entries(recordItems)
  // randomize the order of the records
  allRecords.sort(() => Math.random() - 0.5)

  const { errors } = await PromisePool
    .withConcurrency(11)
    .for(allRecords)
    .process(async ([id, record]: any) => {
      // if (recordItems[id]) delete recordItems[id]  // sometimes users double click or the can trigger this multiple times
      const { storeFunctions } = record as any
      if (storeFunctions?.length) await Promise.all(storeFunctions.map((f: any) => f()))
      delete recordItems[id]
    })

  if (errors.length > 0) {
    console.log('Errors storing data in db:', errors.length)
    console.error(errors)
  }
  console.log('all records are stored');
  sendWaitingRecords(ws)
}

export function sendWaitingRecords(ws: any) {
  ws.send(JSON.stringify({
    type: 'waiting-records',
    data: Object.values(recordItems).map(getRecordItem),
  }))
}

function getRecordItem(record: any) {
  const { id, protocolName, timeS, recordV2, adapterType } = record
  const res: any = {
    id,
    protocolName,
    timeS,
    adapterType,
  }
  try {
    Object.entries(recordV2.data.aggregated).forEach(([key, data]: any) => {
      res[key] = humanizeNumber(data.value)
      res['_' + key] = +data.value
      if (data.chains) {
        Object.entries(data.chains).forEach(([chain, value]: any) => {
          res[`${key}_${chain}`] = humanizeNumber(value)
          res[`_${key}_${chain}`] = value
        })
      }
    })
  } catch (e) {
    console.error('Error parsing record data', e)
  }
  return res
}

// --- Dimension Delete Functionality ---

const deleteRecordsList: any = {}

export async function dimensionsDeleteGetList(ws: any, args: any) {
  const adapterType = args.adapterType as AdapterType
  const protocolToRun = args.protocol
  const fromTimestamp = Number(args.dateFrom)
  const toTimestamp = Number(args.dateTo)

  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp)) {
    console.error('Invalid timestamp range: fromTimestamp and toTimestamp must be finite numbers')
    return
  }

  if (fromTimestamp > toTimestamp) {
    console.error('Invalid timestamp range: fromTimestamp must be <= toTimestamp')
    return
  }

  const { protocolAdaptors } = loadAdaptorsData(adapterType)
  const protocol = protocolAdaptors.find((p: any) => p.displayName === protocolToRun || p.module === protocolToRun || p.id === protocolToRun)

  if (!protocol) {
    console.error(`Protocol "${protocolToRun}" not found for adapter type "${adapterType}"`)
    return
  }

  const records = await getDimensionsRecordsInRange({ adapterType, id: protocol.id2, fromTimestamp, toTimestamp })

  console.log('Pulled', records.length, 'dimension records for protocol:', protocol.displayName, 'type:', adapterType, 'from:', new Date(fromTimestamp * 1000).toDateString(), 'to:', new Date(toTimestamp * 1000).toDateString())

  records.forEach((record: any) => {
    const uniqueId = `${adapterType}#${record.id}#${record.timeS}`
    deleteRecordsList[uniqueId] = {
      id: uniqueId,
      protocolId: record.id,
      protocolName: protocol.displayName,
      adapterType,
      timeS: record.timeS,
      timestamp: record.timestamp,
      data: record.data,
    }
  })

  sendDimensionsDeleteWaitingRecords(ws)
}

export async function dimensionsDeleteSelectedRecords(ws: any, ids: any) {
  await _deleteDimensionRecords(ws, ids)
}

export async function dimensionsDeleteAllRecords(ws: any) {
  await _deleteDimensionRecords(ws)
}

async function _deleteDimensionRecords(ws: any, ids?: any) {
  if (!ids) ids = Object.keys(deleteRecordsList)
  if (!ids.length) return

  const validIds = ids.filter((id: string) => deleteRecordsList[id])
  if (validIds.length === 0) {
    console.error('No valid records found for deletion')
    return
  }

  if (validIds.length !== ids.length) {
    console.error(`Warning: ${ids.length - validIds.length} invalid IDs were filtered out`)
  }

  validIds.sort(() => Math.random() - 0.5)

  const { errors } = await PromisePool
    .withConcurrency(7)
    .for(validIds)
    .process(async (id: any) => {
      const record = deleteRecordsList[id]
      if (!record) {
        console.error('Record not found in deleteRecordsList:', id)
        return
      }

      const { protocolId, adapterType, timeS, timestamp, data, bl, blc } = record

      try {
        // TODO: uncomment to enable actual deletion
        await AdapterRecord2.deleteFromDB({ adapterType, id: protocolId, timeS, timestamp, data, bl, blc })
        // console.log('[DRY RUN] Would delete dimension record:', adapterType, protocolId, timeS, 'data:', JSON.stringify(record.data?.aggregated ?? {}))
        delete deleteRecordsList[id]
      } catch (e) {
        console.error('Error deleting dimension record:', id, (e as any)?.message || e)
        throw e
      }
    })

  if (errors.length > 0) {
    console.error('Errors deleting dimension records:', errors.length, errors.map((e: any) => e.message || e))
  }

  sendDimensionsDeleteWaitingRecords(ws)
}

export function dimensionsDeleteClearList(ws: any) {
  console.log('Clearing dimension delete records list', Object.keys(deleteRecordsList).length)
  Object.keys(deleteRecordsList).forEach((id) => delete deleteRecordsList[id])
  sendDimensionsDeleteWaitingRecords(ws)
}

export function sendDimensionsDeleteWaitingRecords(ws: any) {
  ws.send(JSON.stringify({
    type: 'dimensions-delete-waiting-records',
    data: Object.values(deleteRecordsList).map(getDeleteRecordItem),
  }))
}

function getDeleteRecordItem(record: any) {
  const { id, protocolName, timeS, adapterType, data } = record
  const res: any = {
    id,
    protocolName,
    timeS,
    adapterType,
  }
  try {
    if (data?.aggregated) {
      Object.entries(data.aggregated).forEach(([key, d]: any) => {
        res[key] = humanizeNumber(d.value)
        res['_' + key] = +d.value
        if (d.chains) {
          Object.entries(d.chains).forEach(([chain, value]: any) => {
            res[`${key}_${chain}`] = humanizeNumber(value)
            res[`_${key}_${chain}`] = value
          })
        }
      })
    }
  } catch (e) {
    console.error('Error parsing delete record data', e)
  }
  return res
}