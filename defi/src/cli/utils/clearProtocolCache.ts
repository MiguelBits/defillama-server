import axios from 'axios'
import { deleteProtocolCache, getR2JSONString, storeR2JSONString } from '../../utils/r2'
import { deleteFromPGCache, getDailyTvlCacheId, } from '../../api2/db'
import path from 'path'

const TVL_CACHE_RESET_R2_KEY = 'config/tvl-cache-reset'

export async function clearProtocolCache(protocolName: string) {
  const { data: protocols } = await axios.get('https://api.llama.fi/protocols')
  protocolName = protocolName.toLowerCase().trim()
  const protocolId = protocols.find((p: any) => p.name.toLowerCase() === protocolName.toLowerCase())?.id
  if (protocolId === undefined) {
    return console.log("No protocol with that name!")
  }
  await deleteProtocolCache(protocolId)
  return console.log("Protocol cache deleted: ", protocolName)
}

export async function clearProtocolCacheById(protocolId: string) {
  // await initializeTVLCacheDB()
  // await deleteProtocolCache(protocolId)
  let { API2_SERVER_URL }: any = process.env
  if (!API2_SERVER_URL) throw new Error('Missing required env var: API2_SERVER_URL')
  const pgCaceId = getDailyTvlCacheId(protocolId)
  if (API2_SERVER_URL.includes(','))
    API2_SERVER_URL = API2_SERVER_URL.split(',')
  else
    API2_SERVER_URL = [API2_SERVER_URL]


  for (const url of API2_SERVER_URL) {
    // let endpoint = path.join(url, '_internal/debug-pg/', pgCaceId)
    let endpoint = path.join(url, 'debug-pg/', pgCaceId)
    await axios.delete(endpoint, {
      headers: {
        'x-internal-secret': process.env.LLAMA_INTERNAL_ROUTE_KEY ?? process.env.LLAMA_PRO_API2_SECRET_KEY ?? process.env.API2_SUBPATH
      }
    }).then(() => console.log(`Cache cleared for protocol ${protocolId}`))
      .catch(_e => console.log(`Failed to clear cache for protocol ${protocolId}`))
  }

  // await deleteFromPGCache(pgCaceId) // clear postgres cache as well
  // add command do it via discord bot
  // return console.log("Protocol cache deleted id: ", protocolId)
}


export async function queueProtocolCacheReset(protocolId: string | string[]) {
  if (typeof protocolId === 'string')
    protocolId = [protocolId]

  let current: Record<string, number> = {}
  try {
    current = (await getR2JSONString(TVL_CACHE_RESET_R2_KEY)) ?? {}
  } catch (e) {
    console.log(`No existing ${TVL_CACHE_RESET_R2_KEY} on R2, starting fresh`)
  }
  for (const id of protocolId)
    current[id] = Math.floor(Date.now() / 1000)

  await storeR2JSONString(TVL_CACHE_RESET_R2_KEY, JSON.stringify(current))
  console.log(`Queued protocols ${protocolId.join(', ')} for cache reset (${Object.keys(current).length} entries)`)
}

export async function processQueuedProtocolCacheResets() {
  let queued: Record<string, number> | null = null
  try {
    queued = await getR2JSONString(TVL_CACHE_RESET_R2_KEY)
  } catch (e) {
    console.log(`No ${TVL_CACHE_RESET_R2_KEY} on R2, skipping queued cache resets`)
    return
  }
  const ids = Object.keys(queued ?? {})
  if (!ids.length) {
    console.log('No queued protocol cache resets to process')
    return
  }
  console.log(`Processing ${ids.length} queued protocol cache resets`)
  for (const id of ids) {
    try {
      await deleteFromPGCache(getDailyTvlCacheId(id))
    } catch (e) {
      console.error(`Failed to delete pg-cache for protocol ${id}:`, (e as any)?.message ?? e)
    }
  }
  await storeR2JSONString(TVL_CACHE_RESET_R2_KEY, JSON.stringify({}))
  console.log(`Cleared ${TVL_CACHE_RESET_R2_KEY} on R2 after processing`)
}

export async function clearAllDimensionsCache() {
  const { API2_DIMENSIONS_SERVER_URL } = process.env
  if (!API2_DIMENSIONS_SERVER_URL) throw new Error('Missing required env var: API2_DIMENSIONS_SERVER_URL')
  await axios.delete(`${API2_DIMENSIONS_SERVER_URL}_internal/debug-pg/clear-dimensions-cache`)
  return console.log("All dimensions cache cleared")
}