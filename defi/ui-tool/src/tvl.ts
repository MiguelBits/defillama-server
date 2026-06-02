import protocols from '../../src/protocols/data'
import treasuries from '../../src/protocols/treasury'
import entities from '../../src/protocols/entities'
import { IProtocol } from '../../src/types';
import { clearAllDimensionsCache, queueProtocolCacheReset } from '../../src/cli/utils/clearProtocolCache';
import { storeTvl2, storeTvl2Options } from '../../src/storeTvlInterval/getAndStoreTvl';
import { humanizeNumber } from '@defillama/sdk';
import evmChainProvidersList from '@defillama/sdk/build/providers.json';
import PromisePool from '@supercharge/promise-pool';
import { deleteProtocolItems, getProtocolItems, initializeTVLCacheDB } from '../../src/api2/db';
import dynamodb from '../../src/utils/shared/dynamodb';
import { dailyTokensTvl, dailyTvl, dailyUsdTokensTvl, dailyRawTokensTvl, } from '../../src/utils/getLastRecord';
import { importAdapterDynamic } from '../../src/utils/imports/importAdapter';
import * as sdk from '@defillama/sdk';
import { getUnixTimeNow } from '../../src/api2/utils/time';
import BigNumber from 'bignumber.js';

const chainFailedCallsSets: any = {}

const tvlNameMap: Record<string, IProtocol> = {}
const allItems = [...protocols, ...treasuries, ...entities]

allItems.forEach((protocol: any) => tvlNameMap[protocol.name] = protocol)
export const tvlProtocolList = allItems
  // .filter(i => i.module !== 'dummy.js')
  .map(i => i.name)


export async function runTvlAction(ws: any, data: any) {
  const { action, protocolName, ...options } = data;
  const protocol = tvlNameMap[protocolName];

  if (!protocol) {
    console.error('Unknown protocol name:', protocolName);
    return;
  }
  console.log('Running TVL action:', action, 'for protocol:', protocol.name);
  switch (action) {
    case 'tvl-delete-get-list':
      await tvlDeleteGetList(ws, protocol, options)
      await queueProtocolCacheReset(protocol.id)
      break;
    case 'clear-cache':
      await queueProtocolCacheReset(protocol.id)
      console.log('Cache reset queued for protocol:', protocol.name);
      break;
    case 'clear-all-dimensions-cache':
      await clearAllDimensionsCache()
      break;
    case 'refill-last':
      await fillLast(ws, protocol, options)
      break;
    case 'refill':
      await fillOld(ws, protocol, options)
      break;
    default: console.error('Unknown tvl action:', action); break;
  }
}

async function fillLast(ws: any, protocol: IProtocol, _options: any) {
  const response: any = await storeTvl2({
    unixTimestamp: Math.round(Date.now() / 1000),
    protocol,
    maxRetries: 1,
    useCurrentPrices: true,
    fetchCurrentBlockData: true,
    isRunFromUITool: true,
    breakIfTvlIsZero: false,
  })
  const id = `${protocol.id}-${response.unixTimestamp}`
  recordItems[id] = { id, ...response }
  sendTvlStoreWaitingRecords(ws)
}


async function fillOld(ws: any, protocol: IProtocol, options: any) {
  let { chains, skipBlockFetch, dateFrom, dateTo, parallelCount, maxRetries = 3, breakIfTvlIsZero = false, removeTokenTvl = false, removeTokenTvlSymbols = '', skipMissingChains = false } = options;


  // if (removeTokenTvl) chains = ''

  const debugStart = +new Date()
  let i = 0
  console.log('Filling last TVL for protocol:', protocol.name)
  let needToRsetHistorical = false
  const rawRecords: any = {}
  const usdTvlRecords: any = {}
  const tokenSymbolRecords: any = {}
  const tokenUsdRecords: any = {}
  const aggTvlData: any = {} // overall protocol tvl with chain breakdown
  let refillWithCachedData = chains?.length || removeTokenTvl
  const tokenRemovalChainsSet = new Set()
  const skipSKs: Set<number> = new Set()
  const timeFilter = {
    timestampTo: options.dateTo + 86400 * 2,
    timestampFrom: options.dateFrom - 86400 * 2,
  }


  // fetch the final data for comparison
  const aggCachedRecords = await getProtocolItems(dailyTvl, protocol.id, timeFilter)

  console.log('Pulled ', aggCachedRecords.length, 'agg tvl records for protocol:', protocol.name, 'from:', new Date(options.dateFrom * 1000).toDateString(), 'to:', new Date(options.dateTo * 1000).toDateString())
  aggCachedRecords.forEach((data: any) => aggTvlData[data.SK] = data)

  if (!process.env.HISTORICAL) {
    needToRsetHistorical = true
    process.env.HISTORICAL = 'true'
  }

  if (refillWithCachedData) {
    chains = chains?.split(',').filter((c: string) => c.trim()) || []
    const rawTokenTvlRecords = await getProtocolItems(dailyRawTokensTvl, protocol.id, timeFilter)
    const tokenUsdRecordsFromDB = await getProtocolItems(dailyUsdTokensTvl, protocol.id, timeFilter)
    const tokenSymbolRecordsFromDB = await getProtocolItems(dailyTokensTvl, protocol.id, timeFilter)

    console.log('Pulled ', rawTokenTvlRecords.length, 'raw records for protocol:', protocol.name, 'from:', new Date(options.dateFrom * 1000).toDateString(), 'to:', new Date(options.dateTo * 1000).toDateString())
    rawTokenTvlRecords.forEach((data: any) => rawRecords[data.SK] = data)

    console.log('Pulled ', tokenUsdRecordsFromDB.length, 'token usd tvl records for protocol:', protocol.name, 'from:', new Date(options.dateFrom * 1000).toDateString(), 'to:', new Date(options.dateTo * 1000).toDateString())
    tokenUsdRecordsFromDB.forEach((data: any) => tokenUsdRecords[data.SK] = data)

    console.log('Pulled ', tokenSymbolRecordsFromDB.length, 'token symbol records for protocol:', protocol.name, 'from:', new Date(options.dateFrom * 1000).toDateString(), 'to:', new Date(options.dateTo * 1000).toDateString())
    tokenSymbolRecordsFromDB.forEach((data: any) => tokenSymbolRecords[data.SK] = data)

    if (removeTokenTvl) {

      if (typeof removeTokenTvlSymbols !== 'string' || !removeTokenTvlSymbols.length) {
        console.error('No token symbols provided to remove token tvl');
        return;
      }
      const addressesToRemove: Set<string> = new Set(removeTokenTvlSymbols.split(',').filter((s: string) => s.includes(':')).map((s: string) => s.replace('address:', '').trim().toLowerCase()))
      const symbolsToRemove = removeTokenTvlSymbols.split(',').filter((s: string) => !s.includes(':')).map((s: string) => s.trim().toLowerCase())

      const usdTvlRecordsFromDB = await getProtocolItems(dailyUsdTokensTvl, protocol.id, {
        timestampTo: options.dateTo + 86400,
        timestampFrom: options.dateFrom - 86400,
      })
      console.log('Pulled ', usdTvlRecordsFromDB.length, 'usd tvl records for protocol:', protocol.name, 'from:', new Date(options.dateFrom * 1000).toDateString(), 'to:', new Date(options.dateTo * 1000).toDateString())
      usdTvlRecordsFromDB.forEach((data: any) => usdTvlRecords[data.SK] = data)


      // build symbol mapping
      const tokenInfoMap = await buildTokenSymbolMapping({ usdTvlRecords, rawRecords, symbolsToRemove, addressesToRemove, chains })

      console.log('Removing token tvl for symbols:', symbolsToRemove.join(', '), 'and addresses:', Array.from(addressesToRemove).join(', '))


      // go through raw records and remove undesired tokens
      for (let [sk, record] of Object.entries(rawRecords)) {
        const rawRecordClone = JSON.parse(JSON.stringify(record))
        const date = new Date(Number(sk) * 1000).toLocaleDateString()
        let tokensRemoved = false
        const removalRows: any[] = []
        for (const chain of Object.keys(record as any)) {
          for (const addr of Object.keys((record as any)[chain])) {
            let checkAddr = addr.toLowerCase()
            if (addressesToRemove.has(checkAddr)) {
              const value = (record as any)[chain][addr]
              delete (record as any)[chain][addr]
              tokensRemoved = true
              const bareAddr = checkAddr.startsWith(chain + ':') ? checkAddr.slice(chain.length + 1) : checkAddr
              const info = tokenInfoMap[chain]?.[bareAddr]
              const decimals = info?.decimals
              const symbol = info?.symbol
              let normalized: string | number = ''
              if (typeof decimals === 'number' && value != null) {
                try {
                  normalized = new BigNumber(value as any).div(10 ** decimals).toNumber()
                } catch { /* leave blank */ }
              }
              removalRows.push({ chain, address: addr, symbol: symbol ?? '', decimals: decimals ?? '', rawValue: value, normalizedBalance: normalized })
              tokenRemovalChainsSet.add(chain)
              continue;
            }
          }
        }
        if (removalRows.length) {
          console.log(`Removed tokens for date ${date} (sk=${sk}):`)
          console.table(removalRows)
        }

        if (!tokensRemoved) {  // couldnt find any token to remove
          skipSKs.add(Number(sk))
          delete rawRecords[sk]
          continue;
        } else {

          // save original raw record if ever we need it
          const eventItem: any = {
            PK: 'delete#' + dailyRawTokensTvl(protocol.id),
            SK: getUnixTimeNow(),
            SK_ORIG: Number(sk),
            data: rawRecordClone,
            source: 'tvl-adapter-token-removal',
          }

          await dynamodb.putEventData(eventItem)
        }



      }


    }

  }

  try {

    const adapter = await importAdapterDynamic(protocol);
    const start = adapter.start ? Math.round(+new Date(adapter.start) / 1000) : 0;
    dateFrom = dateFrom < start ? start : dateFrom;
    const currentUnixTs = Math.round(Date.now() / 1000);
    dateTo = getClosestDayStartTimestamp(dateTo > currentUnixTs ? currentUnixTs : dateTo);
    const secondsInDay = 24 * 3600;


    if (!skipBlockFetch) {

      if (adapter.timetravel === false && !refillWithCachedData) {  // if we are deliberately passing chains, we assume user knows what they are doing
        console.error("Adapter doesn't support refilling");
        return;
      }

      const moduleKeys = Object.keys(adapter.module || {});
      let hasNonEvmChain = false;
      for (const key of moduleKeys) {
        // check if chain has tvl function and we have chain rpc
        if (typeof adapter[key] === 'object' && typeof adapter[key].tvl === 'function' && !(evmChainProvidersList as any)[key]) {
          hasNonEvmChain = true;
          break;
        }
      }
      if (hasNonEvmChain && !refillWithCachedData) {  // if it is not partial refill and there are non-evm chains in the adapter, we throw an error
        console.error("Adapter has non-EVM chains, enable skipBlockFetch flag if it supports refilling or provide list of chains to refill");
        return;
      }

    }


    const dates: number[] = []
    while (dateFrom < dateTo) {
      dates.push(dateTo)
      dateTo -= secondsInDay;
    }



    const { errors } = await PromisePool
      .withConcurrency(parallelCount)
      .for(dates)
      .process(async (unixTimestamp: any) => {
        console.log(++i, 'refilling data on', new Date((unixTimestamp) * 1000).toLocaleDateString())
        const options: storeTvl2Options = {
          unixTimestamp,
          protocol,
          maxRetries,
          useCurrentPrices: false,
          isRunFromUITool: true,
          skipMissingChains,
          breakIfTvlIsZero,
          skipBlockData: skipBlockFetch,
          overwriteExistingData: true,
          isTokenRemovalFlow: removeTokenTvl,
        }

        if (removeTokenTvl) {
          const aggTvlRecord = aggTvlData[unixTimestamp]

          if (skipSKs.has(unixTimestamp)) {
            console.log('Skipping timestamp:', unixTimestamp, 'as no tokens were removed for protocol:', protocol.name);
            return;
          }

          if (!aggTvlRecord) {
            console.error('No agg tvl data found for timestamp:', unixTimestamp, 'in protocol:', protocol.name, `date: ${new Date(unixTimestamp * 1000).toLocaleDateString()}`);
            return;
          }
          options.skipChainsCheck = true
        }

        if (refillWithCachedData) {
          let refillingChains = chains
          if (refillingChains.length === 0)
            refillingChains = [...tokenRemovalChainsSet]

          options.chainsToRefill = refillingChains
          options.partialRefill = true
          const cacheData = rawRecords[unixTimestamp]
          if (!cacheData) {
            console.error('No cache data found for timestamp:', unixTimestamp, 'in protocol:', protocol.name, `date: ${new Date(unixTimestamp * 1000).toLocaleDateString()}`);
            return;
          }

          cacheData.preComputedTvlData = {
            tokenUsdData: tokenUsdRecords[unixTimestamp],
            tokenSymbolData: tokenSymbolRecords[unixTimestamp],
            tvlData: aggTvlData[unixTimestamp],
          }

          options.cacheData = cacheData
        }



        const response: any = await storeTvl2(options)
        const id = `${protocol.id}-${response.unixTimestamp}`
        recordItems[id] = { id, ...response }

        recordItems[id].existingTvlRecord = aggTvlData[response.unixTimestamp]

        sendTvlStoreWaitingRecords(ws)
      })

    const runTime = ((+(new Date) - debugStart) / 1e3).toFixed(1)
    console.log(`[Done] | runtime: ${runTime}s  `)
    if (errors.length > 0) {
      console.log('Errors:', errors.length)
      console.error(errors)
    }

    console.log('Dry run, no data was inserted')
    sendTvlStoreWaitingRecords(ws)



  } catch (e) {
    console.error('Error setting HISTORICAL to true:', (e as any).message || e);
  }

  if (needToRsetHistorical)
    delete process.env.HISTORICAL
}


const recordItems: any = {}


export async function tvlStoreAllWaitingRecords(ws: any) {
  const allRecords = Object.entries(recordItems)
  // randomize the order of the records
  allRecords.sort(() => Math.random() - 0.5)
  const updateProtocolSet = new Set<string>()

  const { errors } = await PromisePool
    .withConcurrency(11)
    .for(allRecords)
    .process(async ([id, record]: any) => {
      // if (recordItems[id]) delete recordItems[id]  // sometimes users double click or the can trigger this multiple times
      const { storeFn } = record as any
      await storeFn()
      updateProtocolSet.add(record.protocol.id)
      delete recordItems[id]
    })

  if (errors.length > 0) {
    console.log('Errors storing tvl data in db:', errors.length)
    console.error(errors)
  }
  console.log('all tvl records are stored');
  sendTvlStoreWaitingRecords(ws)

  // Reset protocol cache for updated protocols
  await queueProtocolCacheReset(Array.from(updateProtocolSet))
}

export function sendTvlStoreWaitingRecords(ws: any) {
  ws.send(JSON.stringify({
    type: 'tvl-store-waiting-records',
    data: Object.values(recordItems).map(getRecordItem),
  }))
}

export function removeTvlStoreWaitingRecords(ws: any, ids: any) {
  if (Array.isArray(ids))
    ids.forEach((id: any) => delete recordItems[id])
  sendTvlStoreWaitingRecords(ws)
}



function getRecordItem(record: any) {
  const { id, protocol, usdTvls, unixTimestamp, existingTvlRecord } = record
  const res: any = {
    id,
    protocolName: protocol.name,
    unixTimestamp,
    timeS: new Date(unixTimestamp * 1000).toISOString(),
  }
  try {
    // so, this shows up first
    res.tvl = humanizeNumber(usdTvls.tvl)
    res._tvl = +usdTvls.tvl


    Object.entries(usdTvls).forEach(([key, data]: any) => {
      res[key] = humanizeNumber(data)
      res['_' + key] = +data
    })
  } catch (e) {
    console.error('Error parsing record data', e)
  }

  if (existingTvlRecord) {
    try {
      // so, this shows up first
      res.pre_tvl = humanizeNumber(existingTvlRecord.tvl)
      res._pre_tvl = +existingTvlRecord.tvl


      Object.entries(existingTvlRecord).forEach(([key, data]: any) => {
        if (key === 'SK') return;

        res['pre_' + key] = humanizeNumber(data)
        res['_pre_' + key] = +data
      })
    } catch (e) {
      console.error('Error parsing record data', e)
    }
  }


  return res
}

const deleteRecordsList: any = {}

async function tvlDeleteGetList(ws: any, protocol: IProtocol, data: any) {
  await initializeTVLCacheDB()


  const usdTvlRecords = await getProtocolItems(dailyTvl, protocol.id, {
    timestampFrom: data.dateFrom - 86400,
    timestampTo: data.dateTo + 86400,
  })

  console.log('Pulled ', usdTvlRecords.length || 0, 'tvl records for protocol:', protocol.name, 'from:', new Date(data.dateFrom * 1000).toDateString(), 'to:', new Date(data.dateTo * 1000).toDateString())


  usdTvlRecords.forEach((item: any) => {
    const id = `${protocol.id}-${item.SK}`
    const res = { id, protocol, usdTvls: item, unixTimestamp: item.SK }
    delete item.PK
    delete item.SK
    deleteRecordsList[id] = res
  })

  sendTvlDeleteWaitingRecords(ws)
}

export async function tvlDeleteSelectedRecords(ws: any, data: any) {
  await _deleteTvlRecords(ws, data)
}

export async function tvlDeleteAllRecords(ws: any) {
  await _deleteTvlRecords(ws)
}

async function _deleteTvlRecords(ws: any, ids?: any) {
  if (!ids) ids = Object.keys(deleteRecordsList)
  let protocolIdList = ids.map((p: any) => deleteRecordsList[p]?.protocol?.id)

  // randomize the order of the records
  ids.sort(() => Math.random() - 0.5)
  await initializeTVLCacheDB()

  const { errors } = await PromisePool
    .withConcurrency(7)
    .for(ids)
    .process(async (id: any) => {
      const data = deleteRecordsList[id]
      if (!data)
        return;
      const { protocol, unixTimestamp } = data
      const deleteFrom = unixTimestamp - 1 // -1 to include the from date
      const deleteTo = unixTimestamp + 1 // +1 to include the to date

      for (const tvlFunc of [dailyUsdTokensTvl, dailyTokensTvl, dailyTvl,
        // hourlyTvl, // - we retain hourly in case we want to refill using it for some reason
        // hourlyTokensTvl, hourlyUsdTokensTvl, hourlyTvl
      ]) {

        try {

          await deleteProtocolItems(tvlFunc, { id: protocol.id, timestamp: unixTimestamp })
          console.log('Deleting data for protocol:', protocol.name, 'from:', new Date(deleteFrom * 1000).toDateString(), deleteFrom, 'to:', new Date(deleteTo * 1000).toDateString(), deleteTo, tvlFunc(protocol.id))
          const data = await dynamodb.query({
            ExpressionAttributeValues: {
              ":pk": tvlFunc(protocol.id),
              ":from": deleteFrom,
              ":to": deleteTo,
            },
            KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
          });

          const items = data.Items ?? []
          for (const d of items) {
            await dynamodb.delete({
              Key: {
                PK: d.PK,
                SK: d.SK,
              },
            });
          }

        } catch (e) {
          console.error('Error deleting tvl data for protocol:', protocol.name, 'from:', new Date(deleteFrom * 1000).toDateString(), 'to:', new Date(deleteTo * 1000).toDateString(), e);
          console.error((e as any)?.message || e);
          throw e;
        }
      }

      delete deleteRecordsList[id]
    })

  if (errors.length > 0) {
    console.log('Errors deleting tvl data in db:', errors.length)
    // console.error(errors)
    console.error(errors.map((e: any) => e.message || e))
  }
  console.log('deleted tvl records:', ids.length);


  protocolIdList = [...new Set(protocolIdList)]
  for (const protocolId of protocolIdList) {
    try {
      await queueProtocolCacheReset(protocolId)
    } catch (e) {
      console.error('Error queuing cache reset for protocol:', protocolId, (e as any)?.message);
    }
  }

  sendTvlDeleteWaitingRecords(ws)
}

export async function tvlDeleteClearList(ws: any) {
  console.log('Clearing delete records list', Object.keys(deleteRecordsList).length)
  Object.keys(deleteRecordsList).forEach((id) => delete deleteRecordsList[id])

  sendTvlDeleteWaitingRecords(ws)
}


export function sendTvlDeleteWaitingRecords(ws: any) {
  ws.send(JSON.stringify({
    type: 'tvl-delete-waiting-records',
    data: Object.values(deleteRecordsList).map(getRecordItem),
  }))
}


function toUNIXTimestamp(ms: number) {
  return Math.round(ms / 1000);
}

function getClosestDayStartTimestamp(timestamp: number) {
  const dt = new Date(timestamp * 1000);
  dt.setUTCHours(0, 0, 0, 0);
  const prevDayTimestamp = toUNIXTimestamp(dt.getTime());
  dt.setUTCHours(24);
  const nextDayTimestamp = toUNIXTimestamp(dt.getTime());
  if (
    Math.abs(prevDayTimestamp - timestamp) <
    Math.abs(nextDayTimestamp - timestamp)
  ) {
    return prevDayTimestamp;
  } else {
    return nextDayTimestamp;
  }
}

// atm, this works only for evm chains
async function buildTokenSymbolMapping(params: {
  usdTvlRecords: Record<string, any>,
  rawRecords: Record<string, any>,
  symbolsToRemove: string[],
  addressesToRemove: Set<string>,
  chains?: string[],
}) {
  const { usdTvlRecords, rawRecords, symbolsToRemove, addressesToRemove, chains = [] } = params
  const filterByChains = chains.length > 0
  const chainsSet = new Set(chains)

  const symbolsToRemoveSet: Set<string> = new Set(symbolsToRemove.map(s => s.toLowerCase()))
  const processedChainSymbols: Set<string> = new Set()
  // chainSymbolMapping[chain][addr] = { symbol, decimals }; also chainSymbolMapping[chain][symbol] = `chain:addr`
  const chainSymbolMapping: Record<string, Record<string, any>> = {}
  const failedChains: Set<string> = new Set()

  for (const [sk, usdTokenRecord] of Object.entries(usdTvlRecords)) {
    const rawRecord = rawRecords[sk]
    if (!rawRecord) {
      console.log('No raw record found for timestamp:', new Date(Number(sk) * 1000), 'skipping symbol mapping for this timestamp');
      continue;
    }

    const recordRows: any[] = []

    for (const key of Object.keys(usdTokenRecord)) {
      if (['tvl', 'pool2', 'staking', 'SK'].includes(key) || key.includes('-')) continue;  // we are looking for chains
      const chain = key
      if (filterByChains && !chainsSet.has(chain)) continue;
      if (failedChains.has(chain)) continue;
      const chainData = usdTokenRecord[chain]
      if (!chainSymbolMapping[chain]) chainSymbolMapping[chain] = {}

      for (let symbol of Object.keys(chainData)) {
        symbol = symbol.toLowerCase()
        if (!symbolsToRemoveSet.has(symbol)) continue;
        const chainSymbolKey = `${chain}:${symbol}`
        if (processedChainSymbols.has(chainSymbolKey)) continue;

        if (chainSymbolMapping[chain].hasOwnProperty(symbol)) {
          const fullAddr = chainSymbolMapping[chain][symbol]
          addressesToRemove.add(fullAddr);
          processedChainSymbols.add(chainSymbolKey)
          const bareAddr = fullAddr.startsWith(chain + ':') ? fullAddr.slice(chain.length + 1) : fullAddr
          const info = chainSymbolMapping[chain][bareAddr] ?? {}
          recordRows.push({ chain, symbol, address: fullAddr, resolvedSymbol: info.symbol ?? '', decimals: info.decimals ?? '', source: 'cached' })
          continue;
        }

        let failedChainTokenSet = chainFailedCallsSets[chain]
        let rawRecordTokens = Object.keys(rawRecord[chain] ?? {}).map((addr) => {
          if (chain === 'ethereum' && addr.startsWith('0x')) return addr.toLowerCase()
          if (addr.startsWith(chain + ':0x')) {
            addr = addr.slice(chain.length + 1).toLowerCase()

            if (failedChainTokenSet && failedChainTokenSet.has(addr)) return false
            if (chainSymbolMapping[chain].hasOwnProperty(addr)) return false

            return addr
          }
          return false
        }).filter(Boolean) as string[]

        if (rawRecordTokens.length === 0) continue;

        let symbols: any[] | undefined
        let decimalsList: any[] | undefined
        try {
          [symbols, decimalsList] = await Promise.all([
            sdk.api2.abi.multiCall({ calls: rawRecordTokens as any, abi: 'erc20:symbol', chain, permitFailure: true, block: undefined }),
            sdk.api2.abi.multiCall({ calls: rawRecordTokens as any, abi: 'erc20:decimals', chain, permitFailure: true, block: undefined }),
          ])
        } catch (e) {
          console.error('Error fetching token symbols/decimals for chain:', chain, '- marking chain failed, will not retry', (e as any)?.message || e);
          failedChains.add(chain)
          if (!chainFailedCallsSets[chain]) chainFailedCallsSets[chain] = new Set()
          rawRecordTokens.forEach((addr) => chainFailedCallsSets[chain].add(addr))
          break;  // stop processing this chain for this record; outer loop also skips via failedChains
        }
        if (!symbols || symbols.length === 0) continue;

        rawRecordTokens.forEach((addr, idx) => {
          let tokenSymbol = symbols![idx]
          const rawDecimals = decimalsList?.[idx]
          const decimals = typeof rawDecimals === 'string' ? Number(rawDecimals) : (typeof rawDecimals === 'number' ? rawDecimals : undefined)
          chainSymbolMapping[chain][addr] = { symbol: tokenSymbol, decimals }
          if (typeof tokenSymbol === 'string') {
            const lowerSymbol = tokenSymbol.toLowerCase()
            chainSymbolMapping[chain][lowerSymbol] = `${chain}:${addr}`.toLowerCase()
            if (lowerSymbol === symbol) {
              const fullAddr = chainSymbolMapping[chain][lowerSymbol]
              addressesToRemove.add(fullAddr)
              processedChainSymbols.add(chainSymbolKey)
              recordRows.push({ chain, symbol, address: fullAddr, resolvedSymbol: tokenSymbol, decimals: decimals ?? '', source: 'resolved' })
            }
          }
        })
      }
    }

    if (recordRows.length) {
      console.log(`Symbol mapping resolved for sk=${sk} (${new Date(Number(sk) * 1000).toDateString()}):`)
      console.table(recordRows)
    }
  }

  return chainSymbolMapping
}