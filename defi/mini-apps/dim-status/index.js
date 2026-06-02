const http = require('http');
const fs = require('fs');
const path = require('path');
const sdk = require('@defillama/sdk')

const runTypes = [
  'fees', 'dexs', 'derivatives', 'aggregators', 'options',
  // 'rest',
  'open-interest',
  'aggregator-derivatives', 'bridge-aggregators', 'normalized-volume',
  'nft-volume', 'active-users', 'new-users',
]

// make sure to update RUN_TYPES on index.html as well
const adapterTypes = [
  'fees', 'dexs', 'derivatives', 'aggregators', 'options', 'open-interest',
  'aggregator-derivatives', 'bridge-aggregators', 'normalized-volume',
  'nft-volume', 'active-users', 'new-users',
]

async function genCache() {
  fs.mkdirSync(path.join(__dirname, '.cache'), { recursive: true });

  for (const runType of runTypes)
    await storeRunStats(runType)

  await storeRunStats('globalRunStats')  // tvl run data

  for (const adapterType of adapterTypes)
    await storeDimData(adapterType)

  await storeTvlCacheUsageLogs()
  await storeCheckData('dimDetectDrops-latest', 'detect-drops')
  await storeCheckData('dimCheckResults-latest', 'check-results')
  await storeMissingMetrics()
  await storeStablecoinsRunStats()
}

genCache()
setInterval(genCache, 15 * 60 * 1000) // refresh every 15 minutes


const port = process.env.PORT || 5001;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  // Config
  if (url.pathname === '/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ runTypes, adapterTypes }));
  }

  // Cache data by key
  if (url.pathname.startsWith('/cache/') && req.method === 'GET') {
    const key = url.pathname.slice('/cache/'.length);
    if (!key || key.includes('..') || key.includes('/')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Invalid key');
    }
    const filePath = path.join(__dirname, '.cache', `${key}.json`);
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      stream.pipe(res);
    });
    stream.on('error', () => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
    return;
  }

  // Serve frontend
  if (url.pathname === '/' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      stream.pipe(res);
    });
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Error loading page');
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(port, () => {
  console.log(`Dim status server started on port ${port}`);
  console.log(`Open http://localhost:${port} in your browser`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});

async function storeRunStats(statsKey) {
  let cacheFileKey = `dimensionRunStats-latest-${statsKey}`
  try {
    if (statsKey === 'globalRunStats') cacheFileKey = statsKey

    let statsData = await sdk.cache.readCache(cacheFileKey, {
      skipCompression: true,
      readFromR2Cache: true,
    })

    if (statsKey === 'globalRunStats') {
      const protocols = await sdk.cache.cachedFetch({ key: 'protocols-data', endpoint: 'https://api.llama.fi/protocols' })
      const currentProtocolsMap = {}
      statsData.hourlyOutdatedProtocols.forEach(p => currentProtocolsMap[p.protocolName] = p)
      protocols.forEach(protocol => {
        const pMetadata = currentProtocolsMap[protocol.name]
        if (!pMetadata) return;

        pMetadata.slug = protocol.slug
        pMetadata.module = protocol.tvlCodePath


        const chainTvl = {}
        if (protocol.chainTvls) {
          Object.entries(protocol.chainTvls).forEach(([chain, tvl]) => {
            if (!chainTvl[chain]) chainTvl[chain] = 0
            chainTvl[chain] += tvl
          })
        }
        const topThreeChains = Object.entries(chainTvl)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([chain]) => chain)
        pMetadata.chains = topThreeChains

      })
    }

    fs.writeFileSync(path.join(__dirname, '.cache', `run-data-${statsKey}.json`), JSON.stringify(statsData))
  } catch (error) {
    console.error(`Error storing run stats for ${statsKey}:`, error)
  }
}

async function storeTvlCacheUsageLogs() {
  try {
    const esClient = sdk.elastic.getClient()
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000
    const { hits: { hits } } = await esClient.search({
      index: 'tvl-cache-used*',
      size: 9999,
      body: {
        query: {
          range: {
            timestamp: {
              gte: sixHoursAgo,
            }
          }
        },
        sort: [{ timestamp: { order: 'desc' } }],
      }
    })

    const logs = (hits ?? []).map(h => h._source)
    fs.writeFileSync(path.join(__dirname, '.cache', 'tvl-cache-usage.json'), JSON.stringify(logs))
  } catch (error) {
    console.error('Error storing TVL cache usage logs:', error)
  }
}

async function storeCheckData(cacheKey, fileKey) {
  try {
    const data = await sdk.cache.readCache(cacheKey, {
      skipCompression: true,
      readFromR2Cache: true,
    })
    fs.writeFileSync(path.join(__dirname, '.cache', `${fileKey}.json`), JSON.stringify(data))
  } catch (error) {
    console.error(`Error storing check data for ${cacheKey}:`, error)
  }
}

// Detect big protocols/chains that are missing metrics.
async function storeMissingMetrics() {
  const TVL_BIG = 1_000_000_000
  // Monthly values
  const FEES_BIG = 1_000_000
  const VOL_BIG = 100_000_000

  // Dims we care about flagging
  const TRACKED_DIMS = [
    'fees',
    'dexs', 
    'derivatives', 
    'options', 
    'aggregators',
    'aggregator-derivatives',
    'bridge-aggregators'   
  ]

  try {
    const protocols = await sdk.cache.cachedFetch({
      key: 'protocols-data',
      endpoint: 'https://api.llama.fi/protocols',
    })
    if (!Array.isArray(protocols) || !protocols.length) {
      console.error('Skipping missing metrics refresh: protocols data is empty or invalid')
      return
    }

    const dimByName = {}
    for (const dim of TRACKED_DIMS) {
      const filePath = path.join(__dirname, '.cache', `dim-data-${dim}.json`)
      try {
        const dimData = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        if (!dimData || typeof dimData !== 'object' || Array.isArray(dimData) || !Object.keys(dimData).length) {
          throw new Error(`Dim data cache is empty or invalid: ${filePath}`)
        }
        dimByName[dim] = dimData
      } catch (e) {
        console.error(`Skipping missing metrics refresh: unable to read valid dim data for ${dim}`, e)
        return
      }
    }

    const SKIP_CATEGORIES = ['cex']

    const VOLUME_DIM_BY_CATEGORY = {
      'dexs':             'dexs',
      'dex aggregator':   'aggregators',
      'yield aggregator': 'aggregators',
      'derivatives':      'derivatives',
      'perps':            'derivatives',
      'options':          'options',
      'options vault':    'options',
    }

    const protocolRows = []
    for (const p of protocols) {
      if (!p || !p.name) continue
      const category = (p.category || '').toLowerCase()
      if (SKIP_CATEGORIES.includes(category)) continue
      const tvl = Number(p.tvl) || 0

      const presentDims = {}
      for (const dim of TRACKED_DIMS) {
        const d = dimByName[dim][p.name]
        if (d && d.total30d != null) presentDims[dim] = d.total30d
      }

      const isMajorProtocol =
        tvl >= TVL_BIG ||
        (presentDims['fees'] || 0) >= FEES_BIG ||
        (presentDims['dexs'] || 0) >= VOL_BIG ||
        (presentDims['derivatives'] || 0) >= VOL_BIG ||
        (presentDims['options'] || 0) >= VOL_BIG
      if (!isMajorProtocol) continue

      const expected = ['fees']
      const volumeDim = VOLUME_DIM_BY_CATEGORY[category]
      if (volumeDim) expected.push(volumeDim)

      const missingDims = expected.filter(d => presentDims[d] == null)
      if (!missingDims.length) continue

      protocolRows.push({
        name: p.name,
        slug: p.slug || sluggify(p.name),
        category: p.category || '',
        tvl,
        chains: Array.isArray(p.chains) ? p.chains : [],
        presentDims,
        missingDims,
      })
    }

    // Chains

    const CHAIN_DIMS = ['fees', 'active-users', 'new-users']
    const chainRows = []
    const overviewByDim = {}
    const [chains, ...overviews] = await Promise.all([
      sdk.cache.cachedFetch({
        key: 'chains-tvl',
        endpoint: 'https://api.llama.fi/v2/chains',
      }),
      ...CHAIN_DIMS.map(dim => sdk.cache.cachedFetch({
        key: `overview-${dim}`,
        endpoint: `https://api.llama.fi/overview/${dim}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
      })),
    ])
    if (!Array.isArray(chains) || !chains.length) {
      console.error('Skipping missing metrics refresh: chains data is empty or invalid')
      return
    }
    CHAIN_DIMS.forEach((dim, i) => { overviewByDim[dim] = overviews[i] })
    for (const dim of CHAIN_DIMS) {
      if (!Array.isArray(overviewByDim[dim]?.allChains) || !overviewByDim[dim].allChains.length) {
        console.error(`Skipping missing metrics refresh: chain list is empty or invalid for ${dim}`)
        return
      }
    }

    // Lowercased chain-name sets per dim for presence checks
    const chainSet = (ov) => new Set(ov.allChains.map(c => String(c).toLowerCase()))
    const chainsByDim = Object.fromEntries(
      CHAIN_DIMS.map(dim => [dim, chainSet(overviewByDim[dim])])
    )

    for (const c of chains) {
      if (!c?.name) continue
      const tvl = Number(c.tvl) || 0
      if (tvl < TVL_BIG) continue
      const key = c.name.toLowerCase()
      const present = {}
      for (const dim of CHAIN_DIMS) present[dim] = chainsByDim[dim].has(key)
      const missing = Object.entries(present).filter(([, v]) => !v).map(([k]) => k)
      if (!missing.length) continue
      chainRows.push({
        name: c.name,
        tvl,
        presentDims: present,
        missingDims: missing,
      })
    }

    const out = {
      generationTime: new Date().toISOString(),
      protocols: protocolRows,
      chains: chainRows,
    }
    fs.writeFileSync(path.join(__dirname, '.cache', 'missing-metrics.json'), JSON.stringify(out))
  } catch (error) {
    console.error('Error storing missing metrics:', error)
  }
}

function sluggify(name) {
  return String(name || '').toLowerCase().split(' ').join('-').split("'").join('')
}

async function storeStablecoinsRunStats() {
  try {
    const esClient = sdk.elastic.getClient()
    const windows = [
      { key: '1h',  ms: 60 * 60 * 1000 },
      { key: '24h', ms: 24 * 60 * 60 * 1000 },
      { key: '7d',  ms: 7 * 24 * 60 * 60 * 1000 },
    ]

    const result = { generationTime: new Date().toISOString(), windows: {} }

    for (const win of windows) {
      const since = Date.now() - win.ms

      // Aggregate runtime logs
      const runtimeRes = await esClient.search({
        index: 'debug-runtime-logs*',
        size: 0,
        body: {
          query: {
            bool: {
              filter: [
                { match: { 'metadata.application.keyword': 'stablecoins' } },
                { range: { timestamp: { gte: since } } },
              ],
            },
          },
          aggs: {
            bySuccess: { terms: { field: 'success' } },
            byAsset: {
              terms: { field: 'metadata.assetId.keyword', size: 500 },
              aggs: {
                ok:         { filter: { match: { success: true } } },
                fail:       { filter: { match: { success: false } } },
                lastRun:    { max: { field: 'timestamp' } },
                avgRuntime: { avg: { field: 'runtime' } },
                name:       { terms: { field: 'metadata.name.keyword', size: 1 } },
              },
            },
          },
        },
      })

      // Recent failures: try error logs first (contain stack trace),
      // fall back to runtime logs with success=false if error logs are empty/missing
      let errorHits = []
      try {
        const errorRes = await esClient.search({
          index: 'error-logs*',
          size: 50,
          body: {
            sort: [{ timestamp: { order: 'desc' } }],
            query: {
              bool: {
                filter: [
                  { match: { 'metadata.application.keyword': 'stablecoins' } },
                  { range: { timestamp: { gte: since } } },
                ],
              },
            },
          },
        })
        errorHits = errorRes.hits.hits ?? []
      } catch (e) {
        console.error(`[stablecoins:${win.key}] error-logs* query threw:`, e?.message ?? e)
      }

      if (errorHits.length === 0) {
        const fallbackRes = await esClient.search({
          index: 'debug-runtime-logs*',
          size: 50,
          body: {
            sort: [{ timestamp: { order: 'desc' } }],
            query: {
              bool: {
                filter: [
                  { match: { 'metadata.application.keyword': 'stablecoins' } },
                  { match: { success: false } },
                  { range: { timestamp: { gte: since } } },
                ],
              },
            },
          },
        })
        errorHits = (fallbackRes.hits.hits ?? []).map(h => ({
          _source: {
            ...h._source,
            errorStringFull: '(see Jenkins build console for stack trace — error log not found in ES)',
          },
        }))
      }
      const errorRes = { hits: { hits: errorHits } }

      const successBuckets = runtimeRes.aggregations.bySuccess.buckets ?? []
      const successCount = (successBuckets.find(b => b.key_as_string === 'true' || b.key === 1)?.doc_count) ?? 0
      const failCount    = (successBuckets.find(b => b.key_as_string === 'false' || b.key === 0)?.doc_count) ?? 0
      const totalRuns    = successCount + failCount

      const byAsset = (runtimeRes.aggregations.byAsset.buckets ?? []).map(b => ({
        assetId:    b.key,
        name:       b.name.buckets[0]?.key ?? b.key,
        ok:         b.ok.doc_count,
        fail:       b.fail.doc_count,
        lastRun:    b.lastRun.value,
        avgRuntime: b.avgRuntime.value,
      }))

      const recentErrors = (errorRes.hits.hits ?? []).map(h => ({
        timestamp:   h._source.timestamp,
        assetId:     h._source.metadata?.assetId,
        name:        h._source.metadata?.name,
        errorString: h._source.errorStringFull,
      }))

      const okAssets     = byAsset.filter(a => a.fail === 0 && a.ok > 0).length
      const failedAssets = byAsset.filter(a => a.fail > 0).length
      const successRate  = totalRuns > 0 ? Number(((successCount / totalRuns) * 100).toFixed(2)) : null

      result.windows[win.key] = {
        totalRuns, successCount, failCount,
        uniqueAssets: byAsset.length, okAssets, failedAssets, successRate,
        byAsset, recentErrors,
      }
    }

    fs.writeFileSync(path.join(__dirname, '.cache', 'stablecoins-run-stats.json'), JSON.stringify(result))
  } catch (error) {
    console.error('Error storing stablecoins run stats:', error)
  }
}

async function storeDimData(adapterType) {
  try {
    const { protocols } = await sdk.cache.cachedFetch({ key: `dim-data-${adapterType}`, endpoint: `https://api.llama.fi/v2/metrics/${adapterType}` })
    const data = {}
    const interestedFields = ['id', 'name', 'total24h', 'total7d', 'total30d', 'totalAllTime', 'category', 'module']
    protocols.forEach(protocol => {
      data[protocol.name] = {}
      interestedFields.forEach(field => {
        data[protocol.name][field] = protocol[field]
      })
    })
    fs.writeFileSync(path.join(__dirname, '.cache', `dim-data-${adapterType}.json`), JSON.stringify(data))
  } catch (error) {
    console.error(`Error storing dim data for ${adapterType}:`, error)
  }
}