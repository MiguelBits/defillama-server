import { useEffect, useState } from 'react';
import {
    Form, Select, DatePicker, InputNumber, Switch, Button, Input, Divider,
    Tabs, Modal, Flex, Typography, Alert, Space, AutoComplete,
} from 'antd';
import { PlayCircleOutlined, StopOutlined, LineChartOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const Option = Select.Option as any;
const { Text, Paragraph } = Typography;

interface RwaAsset {
    id: string; ticker: string; symbol: string; name: string;
    contracts: Record<string, string[]>;
    parentPlatform: string;
}
interface RwaChoices {
    assets: RwaAsset[];
    solanaNamedTargets: string[];
    hasDuneKey: boolean;
    hasAlchemyKey: boolean;
    hasStellarDuneQuery?: boolean;
}
interface Preview { label: string; url: string; }

interface RwaTabProps {
    wsRef: { current: WebSocket | null };
    isConnected: boolean;
    rwaChoices: RwaChoices;
    rwaRunning: boolean;
    rwaPreviews: Preview[];
    previewBaseUrl: string;
    setRwaRunning: (running: boolean) => void;
    rwaPreflight: { hits: { id: string; ticker: string; chains: string[] }[]; idCount: number; error?: string } | null;
}

export function RwaTab({
    wsRef, isConnected, rwaChoices, rwaRunning, rwaPreviews, previewBaseUrl,
    setRwaRunning, rwaPreflight,
}: RwaTabProps) {
    const [subTab, setSubTab] = useState('parallel');
    const [confirm, setConfirm] = useState<{ open: boolean; text: string; payload: any; summary: string }>({
        open: false, text: '', payload: null, summary: '',
    });

    // Ask the server for asset list + key availability when the tab connects.
    useEffect(() => {
        if (isConnected && wsRef.current?.readyState === WebSocket.OPEN && !rwaChoices.assets.length) {
            wsRef.current.send(JSON.stringify({ type: 'rwa-get-choices' }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isConnected]);

    function send(payload: any) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            setRwaRunning(true);
            wsRef.current.send(JSON.stringify({ type: 'rwa-runCommand', data: payload }));
        }
    }

    // For write runs, require typing WRITE first.
    function run(operation: string, options: any, isWrite: boolean, summary: string) {
        const payload = { operation, options };
        if (isWrite) {
            setConfirm({ open: true, text: '', payload, summary });
        } else {
            send(payload);
        }
    }

    function stop() {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'rwa-stop' }));
        }
        setRwaRunning(false);
    }

    const assetOptions = rwaChoices.assets.map((a) => ({
        value: a.id,
        label: `${a.ticker || a.symbol || a.name || a.id} (${a.id})`,
        search: `${a.id} ${a.ticker} ${a.symbol} ${a.name}`.toLowerCase(),
    }));

    return (
        <div style={{ maxWidth: 460 }}>
            <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Every run defaults to dry-run"
                description="Nothing is written to the database unless you tick a commit option, which then requires a typed confirmation."
            />

            {rwaRunning && (
                <Button danger icon={<StopOutlined />} onClick={stop} style={{ marginBottom: 12 }}>
                    Stop running refill
                </Button>
            )}

            <Tabs
                activeKey={subTab}
                size="small"
                onChange={setSubTab}
                items={[
                    { label: 'Parallel refill', key: 'parallel', children: <ParallelRefillForm run={run} isConnected={isConnected} assetOptions={assetOptions} rwaRunning={rwaRunning} wsRef={wsRef} rwaPreflight={rwaPreflight} /> },
                    { label: 'Combined preview', key: 'combined', children: <CombinedPreviewForm run={run} isConnected={isConnected} choices={rwaChoices} rwaRunning={rwaRunning} /> },
                    { label: 'Total supply', key: 'totalSupply', children: <TotalSupplyForm run={run} isConnected={isConnected} rwaRunning={rwaRunning} /> },
                    { label: 'Solana batch', key: 'solanaBatch', children: <SolanaBatchForm run={run} isConnected={isConnected} rwaRunning={rwaRunning} choices={rwaChoices} /> },
                    { label: 'Solana / Stellar (single)', key: 'single', children: <SingleAssetForms run={run} isConnected={isConnected} rwaRunning={rwaRunning} choices={rwaChoices} /> },
                    { label: 'xStock excluded', key: 'xstock', children: <XstockExcludedForm run={run} isConnected={isConnected} rwaRunning={rwaRunning} choices={rwaChoices} /> },
                ]}
            />

            {rwaPreviews.length > 0 && (
                <>
                    <Divider><LineChartOutlined /> Previews</Divider>
                    <Space direction="vertical">
                        {rwaPreviews.map((p) => (
                            <a key={p.url} href={previewBaseUrl + p.url} target="_blank" rel="noreferrer">
                                {p.label}
                            </a>
                        ))}
                    </Space>
                </>
            )}

            <Modal
                title={<span><WarningOutlined style={{ color: '#ff4d4f' }} /> Confirm DB write</span>}
                open={confirm.open}
                okText="Run with writes"
                okType="danger"
                okButtonProps={{ disabled: confirm.text !== 'WRITE' }}
                onOk={() => { send(confirm.payload); setConfirm({ open: false, text: '', payload: null, summary: '' }); }}
                onCancel={() => setConfirm({ open: false, text: '', payload: null, summary: '' })}
                width={560}
            >
                <Paragraph><Text strong type="danger">This run will write to the production RWA database.</Text></Paragraph>
                <Paragraph>{confirm.summary}</Paragraph>
                <Paragraph>Type <Text strong>WRITE</Text> to confirm:</Paragraph>
                <Input
                    value={confirm.text}
                    onChange={(e) => setConfirm((c) => ({ ...c, text: e.target.value }))}
                    placeholder="Type WRITE"
                    onPressEnter={() => { if (confirm.text === 'WRITE') { send(confirm.payload); setConfirm({ open: false, text: '', payload: null, summary: '' }); } }}
                />
            </Modal>
        </div>
    );
}

function runButton(isConnected: boolean, rwaRunning: boolean, label = 'Run') {
    return (
        <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} disabled={!isConnected || rwaRunning}>
            {label}
        </Button>
    );
}

function PreflightWarning({ rwaPreflight }: any) {
    if (rwaPreflight.error) {
        return <Alert type="error" showIcon style={{ marginBottom: 12 }} message="Pre-flight check failed" description={rwaPreflight.error} />;
    }
    if (!rwaPreflight.hits?.length) {
        return <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`No throw-on-historical chains in the ${rwaPreflight.idCount} checked asset(s).`} />;
    }
    return (
        <Alert
            type="warning" showIcon style={{ marginBottom: 12 }}
            message={`${rwaPreflight.hits.length} asset(s) have chains that will be dropped to $0`}
            description={
                <div>
                    <Paragraph style={{ marginBottom: 6 }}>Back these up via the Solana/Stellar tabs <em>before</em> committing a refill:</Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {rwaPreflight.hits.map((h: any) => (
                            <li key={h.id}><Text strong>{h.ticker}</Text> <Text type="secondary">(id {h.id})</Text> — {h.chains.join(', ')}</li>
                        ))}
                    </ul>
                </div>
            }
        />
    );
}

// ── Parallel refill ─────────────────────────────────────────────────────
function ParallelRefillForm({ run, isConnected, assetOptions, rwaRunning, wsRef, rwaPreflight }: any) {
    const [form] = Form.useForm();
    const selectedIds = Form.useWatch('ids', form);
    const [preflightLoading, setPreflightLoading] = useState(false);

    // Clear the loading spinner once a result arrives.
    useEffect(() => { setPreflightLoading(false); }, [rwaPreflight]);

    const checkChains = () => {
        if (wsRef?.current?.readyState === WebSocket.OPEN) {
            setPreflightLoading(true);
            wsRef.current.send(JSON.stringify({ type: 'rwa-get-preflight', data: { ids: selectedIds || [] } }));
        }
    };

    const onFinish = (v: any) => {
        const options: any = {
            startDate: v.dateRange?.[0] ? dayjs(v.dateRange[0]).format('YYYY-MM-DD') : undefined,
            endDate: v.dateRange?.[1] ? dayjs(v.dateRange[1]).format('YYYY-MM-DD') : undefined,
            ids: v.ids || [],
            backfillConcurrency: v.backfillConcurrency,
            idConcurrency: v.idConcurrency,
            priceConcurrency: v.priceConcurrency,
            resetCache: v.resetCache || false,
            commitCleanup: v.commitCleanup || false,
        };
        const isWrite = options.commitCleanup;
        const idScope = options.ids.length ? `${options.ids.length} selected ID(s)` : "the script's default ID(s)";
        run('parallel-refill', options, isWrite, `Parallel refill over ${idScope}, ${options.startDate || 'default'} → ${options.endDate || 'default'}.${options.commitCleanup ? ' Spike deletes / price-dip fixes will be applied.' : ''}`);
    };
    return (
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ commitCleanup: false, resetCache: false }}>
            <Form.Item label="Date range" name="dateRange" help="Leave empty to use the script defaults">
                <DatePicker.RangePicker />
            </Form.Item>
            <Form.Item label="IDs / symbols" name="ids" help="Empty = the script's hardcoded default ID set">
                <Select
                    mode="multiple" allowClear showSearch placeholder="Pick assets (search by id, ticker, symbol)"
                    options={assetOptions}
                    filterOption={(input: string, opt: any) => opt.search.includes(input.toLowerCase())}
                    optionFilterProp="label"
                />
            </Form.Item>

            <Form.Item>
                <Button onClick={checkChains} loading={preflightLoading} disabled={!isConnected}>
                    Check for Solana / Stellar legs
                </Button>
                <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                    These chains throw on historical reads and get dropped to $0 by the refill — back them up via the Solana/Stellar tabs first.
                </Text>
            </Form.Item>
            {rwaPreflight && <PreflightWarning rwaPreflight={rwaPreflight} />}

            <Flex gap={10} wrap>
                <Form.Item label="Backfill concurrency" name="backfillConcurrency"><InputNumber min={1} max={50} placeholder="5" /></Form.Item>
                <Form.Item label="ID concurrency" name="idConcurrency"><InputNumber min={1} max={50} placeholder="10" /></Form.Item>
                <Form.Item label="Price concurrency" name="priceConcurrency"><InputNumber min={1} max={50} placeholder="8" /></Form.Item>
            </Flex>
            <Form.Item label="Reset disk cache" name="resetCache" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="Yes" unCheckedChildren="No" />
            </Form.Item>
            <Divider>Write options (default off)</Divider>
            <Form.Item label="Commit cleanup (apply spike deletes + price-dip fixes)" name="commitCleanup" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="WRITE" unCheckedChildren="dry" />
            </Form.Item>
            <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
        </Form>
    );
}

// ── Combined preview (refill → chain backfill, dry-run) ───────────────────
function CombinedPreviewForm({ run, isConnected, rwaRunning, choices }: any) {
    const [form] = Form.useForm();
    const assetId = Form.useWatch('assetId', form);
    const chain = Form.useWatch('chain', form);

    // Only assets that have a Solana or Stellar contract are candidates here —
    // those are the chains the parallel refill silently drops to $0.
    const candidates: RwaAsset[] = (choices.assets || []).filter(
        (a: RwaAsset) => (a.contracts?.Solana?.length || a.contracts?.Stellar?.length)
    );
    const assetOptions = candidates.map((a) => ({
        value: a.id,
        label: `${a.ticker || a.symbol || a.name || a.id} (${a.id})`,
        search: `${a.id} ${a.ticker} ${a.symbol} ${a.name}`.toLowerCase(),
    }));
    const selected = candidates.find((a) => a.id === assetId);
    const availableChains: Array<"solana" | "stellar"> = [];
    if (selected?.contracts?.Solana?.length) availableChains.push("solana");
    if (selected?.contracts?.Stellar?.length) availableChains.push("stellar");
    const derived = chain === "solana" ? selected?.contracts?.Solana?.[0]
        : chain === "stellar" ? selected?.contracts?.Stellar?.[0]
        : null;

    const buildOptions = (v: any): any => ({
        assetId: v.assetId,
        chain: v.chain,
        startDate: v.dateRange?.[0] ? dayjs(v.dateRange[0]).format('YYYY-MM-DD') : undefined,
        endDate: v.dateRange?.[1] ? dayjs(v.dateRange[1]).format('YYYY-MM-DD') : undefined,
        fromDate: v.fromDate ? dayjs(v.fromDate).format('YYYY-MM-DD') : undefined,
        flatNav: v.flatNav,
        fallbackNearestPrice: v.fallbackNearestPrice || false,
        fillMissingChains: v.fillMissingChains || false,
    });
    // Preview: dry-run, composes all chains in-memory (no DB writes).
    const onFinish = (v: any) => run('combined-preview', buildOptions(v), false, '');
    // Commit: writes the composed result (chains + EVM merge-write refill) to prod
    // in one orchestrated action. isWrite=true → typed-WRITE confirmation modal.
    const onCommit = () => {
        form.validateFields().then((v: any) => {
            const opts = buildOptions(v);
            const chainLabel = opts.chain === 'all' ? availableChains.join(' + ') : opts.chain;
            const summary = `Commit composed result for ${selected?.ticker || opts.assetId} (id ${opts.assetId}) to PROD: ${chainLabel} chain backfill(s) + EVM refill --merge-write${opts.startDate ? `, ${opts.startDate}→${opts.endDate || 'now'}` : ''}. Writes daily_rwa_data + backup_rwa_data.`;
            run('combined-commit', opts, true, summary);
        }).catch(() => { /* validation errors shown inline */ });
    };
    return (
        <Form form={form} layout="vertical" onFinish={onFinish}>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
                message="Dry-run only"
                description="Runs the parallel refill, then feeds its proposed output into the chain backfill. The supply CSV, mint, and asset address are all auto-derived — nothing is written, and stale CSVs are swept after 24h." />
            {!choices.hasDuneKey && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="DUNE_API_KEY not set — CSV auto-fetch will fail" />}
            {!choices.hasStellarDuneQuery && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="STELLAR_DUNE_QUERY_ID not set — Stellar combined preview will fail" />}
            <Form.Item label="Asset" name="assetId" rules={[{ required: true }]}>
                <Select showSearch placeholder="Pick the RWA (search by id, ticker, symbol)"
                    options={assetOptions}
                    filterOption={(input: string, opt: any) => opt.search.includes(input.toLowerCase())}
                    optionFilterProp="label" />
            </Form.Item>
            <Form.Item label="Chain to backfill" name="chain" rules={[{ required: true }]}
                help={!selected ? 'Pick an asset first' : availableChains.length === 0 ? 'This asset has no Solana or Stellar legs' : null}>
                <Select placeholder="Select chain" disabled={!selected}>
                    {availableChains.length > 1 && <Option value="all">{`All chains (compose: ${availableChains.join(' + ')})`}</Option>}
                    {availableChains.includes('solana') && <Option value="solana">Solana</Option>}
                    {availableChains.includes('stellar') && <Option value="stellar">Stellar</Option>}
                </Select>
            </Form.Item>
            {derived && <Alert type="info" style={{ marginBottom: 12 }} message={<span>Resolved {chain} address: <Text code copyable={{ text: derived }}>{derived}</Text></span>} />}
            <Form.Item label="Refill date range" name="dateRange" help="Leave empty for refill defaults"><DatePicker.RangePicker /></Form.Item>
            <Form.Item label="Backfill from-date (trim earlier rows)" name="fromDate"><DatePicker /></Form.Item>
            <Form.Item label="Flat NAV (skip coins API)" name="flatNav"><InputNumber min={0} step={0.01} placeholder="e.g. 1.00" /></Form.Item>
            <Flex gap={10} wrap>
                <Form.Item label="Fallback nearest price" name="fallbackNearestPrice" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
                <Form.Item label="Fill missing chains" name="fillMissingChains" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
            </Flex>
            <Form.Item>
                <Space>
                    {runButton(isConnected, rwaRunning, 'Run combined preview')}
                    <Button danger icon={<WarningOutlined />} disabled={!isConnected || rwaRunning} onClick={onCommit}>
                        Commit composed (all chains)
                    </Button>
                </Space>
            </Form.Item>
        </Form>
    );
}

// ── Total supply ─────────────────────────────────────────────────────────
function TotalSupplyForm({ run, isConnected, rwaRunning }: any) {
    const [form] = Form.useForm();
    const onFinish = (v: any) => {
        const options = { commit: v.commit || false, backup: v.backup || false };
        run('total-supply', options, options.commit, `Backfill the totalsupply column across all RWA daily rows.${options.backup ? ' Also updates backup_rwa_data.' : ''}`);
    };
    return (
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ commit: false, backup: false }}>
            <Paragraph type="secondary">Recomputes the totalsupply JSON column for every daily RWA row from representative tokens.</Paragraph>
            <Form.Item label="Also update backup_rwa_data" name="backup" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="Yes" unCheckedChildren="No" />
            </Form.Item>
            <Form.Item label="Commit (write to DB)" name="commit" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="WRITE" unCheckedChildren="dry" />
            </Form.Item>
            <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
        </Form>
    );
}

// ── Solana batch ───────────────────────────────────────────────────────
function SolanaBatchForm({ run, isConnected, rwaRunning, choices }: any) {
    const [form] = Form.useForm();
    const onFinish = (v: any) => {
        const options = {
            only: v.only || '', skip: v.skip || '',
            noXstocks: v.noXstocks || false, skipFetch: v.skipFetch || false, commit: v.commit || false,
        };
        run('solana-batch', options, options.commit, `Solana RWA backfill via Dune${options.only ? ` (only ${options.only})` : ' (all named + xStocks)'}. Writes mcap/activemcap/totalsupply for missing/zero Solana rows.`);
    };
    return (
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ noXstocks: false, skipFetch: false, commit: false }}>
            {!choices.hasDuneKey && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="DUNE_API_KEY not set on the server" description="Set it in the server .env to run Solana backfills." />}
            <Form.Item label="Only (single token)" name="only" help="Leave empty to run all named targets + auto-discovered xStocks">
                <AutoComplete
                    allowClear placeholder="e.g. USDY (or an xStock ticker)"
                    options={(choices.solanaNamedTargets || []).map((t: string) => ({ value: t }))}
                    filterOption={(input: string, opt: any) => opt.value.toLowerCase().includes(input.toLowerCase())}
                />
            </Form.Item>
            <Form.Item label="Skip (comma separated labels)" name="skip"><Input placeholder="e.g. NFLXx,ABCx" /></Form.Item>
            <Form.Item label="No xStocks (named tokens only)" name="noXstocks" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="Yes" unCheckedChildren="No" />
            </Form.Item>
            <Form.Item label="Skip fetch (reuse existing CSVs)" name="skipFetch" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="Yes" unCheckedChildren="No" />
            </Form.Item>
            <Form.Item label="Commit (write to DB)" name="commit" valuePropName="checked" layout="horizontal">
                <Switch checkedChildren="WRITE" unCheckedChildren="dry" />
            </Form.Item>
            <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
        </Form>
    );
}

// ── Solana / Stellar single (asset picker, server derives everything) ──
function SingleAssetForms({ run, isConnected, rwaRunning, choices }: any) {
    const [solForm] = Form.useForm();
    const [stelForm] = Form.useForm();
    const solAssetId = Form.useWatch('assetId', solForm);
    const stelAssetId = Form.useWatch('assetId', stelForm);

    const solCandidates: RwaAsset[] = (choices.assets || []).filter((a: RwaAsset) => a.contracts?.Solana?.length);
    const stelCandidates: RwaAsset[] = (choices.assets || []).filter((a: RwaAsset) => a.contracts?.Stellar?.length);
    const opt = (list: RwaAsset[]) => list.map((a) => ({
        value: a.id, label: `${a.ticker || a.symbol || a.name || a.id} (${a.id})`,
        search: `${a.id} ${a.ticker} ${a.symbol} ${a.name}`.toLowerCase(),
    }));
    const solMint = solCandidates.find((a) => a.id === solAssetId)?.contracts?.Solana?.[0];
    const stelAsset = stelCandidates.find((a) => a.id === stelAssetId)?.contracts?.Stellar?.[0];

    const solFinish = (v: any) => {
        const options = {
            assetId: v.assetId,
            fromDate: v.fromDate ? dayjs(v.fromDate).format('YYYY-MM-DD') : undefined,
            flatNav: v.flatNav,
            fallbackNearestPrice: v.fallbackNearestPrice || false,
            fillMissingChains: v.fillMissingChains || false,
            commit: v.commit || false,
        };
        run('solana-single', options, options.commit, `Backfill Solana mcap for asset ${options.assetId}.`);
    };
    const stelFinish = (v: any) => {
        const options = {
            assetId: v.assetId,
            fromDate: v.fromDate ? dayjs(v.fromDate).format('YYYY-MM-DD') : undefined,
            flatNav: v.flatNav,
            fallbackNearestPrice: v.fallbackNearestPrice || false,
            fillMissingChains: v.fillMissingChains || false,
            commit: v.commit || false,
        };
        run('stellar-single', options, options.commit, `Backfill Stellar mcap for asset ${options.assetId}.`);
    };

    return (
        <div>
            <Alert type="info" showIcon style={{ marginBottom: 10 }}
                message="The mint / asset / supply CSV are auto-derived"
                description="Pick an asset; the server resolves the address from RWA metadata, decimals via RPC (or 8 for xStocks), and fetches the supply CSV from Dune. CSVs older than 24h are swept automatically." />
            {!choices.hasDuneKey && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="DUNE_API_KEY not set — CSV auto-fetch will fail" />}
            <Divider>Solana single asset</Divider>
            <Form form={solForm} layout="vertical" onFinish={solFinish} initialValues={{ commit: false }}>
                <Form.Item label="Asset" name="assetId" rules={[{ required: true }]}>
                    <Select showSearch placeholder="Pick an asset with a Solana leg" options={opt(solCandidates)}
                        filterOption={(input: string, o: any) => o.search.includes(input.toLowerCase())} optionFilterProp="label" />
                </Form.Item>
                {solMint && <Alert type="info" style={{ marginBottom: 12 }} message={<span>Resolved mint: <Text code copyable={{ text: solMint }}>{solMint}</Text></span>} />}
                <Form.Item label="From date (trim earlier rows)" name="fromDate"><DatePicker /></Form.Item>
                <Form.Item label="Flat NAV (skip coins API)" name="flatNav"><InputNumber min={0} step={0.01} placeholder="e.g. 1.00" /></Form.Item>
                <Flex gap={10} wrap>
                    <Form.Item label="Fallback nearest price" name="fallbackNearestPrice" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
                    <Form.Item label="Fill missing chains" name="fillMissingChains" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
                </Flex>
                <Form.Item label="Commit (write to DB)" name="commit" valuePropName="checked" layout="horizontal"><Switch checkedChildren="WRITE" unCheckedChildren="dry" /></Form.Item>
                <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
            </Form>

            <Divider>Stellar single asset</Divider>
            {!choices.hasStellarDuneQuery && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="STELLAR_DUNE_QUERY_ID not set — Stellar CSV fetch will fail" />}
            <Form form={stelForm} layout="vertical" onFinish={stelFinish} initialValues={{ commit: false }}>
                <Form.Item label="Asset" name="assetId" rules={[{ required: true }]}>
                    <Select showSearch placeholder="Pick an asset with a Stellar leg" options={opt(stelCandidates)}
                        filterOption={(input: string, o: any) => o.search.includes(input.toLowerCase())} optionFilterProp="label" />
                </Form.Item>
                {stelAsset && <Alert type="info" style={{ marginBottom: 12 }} message={<span>Resolved asset: <Text code copyable={{ text: stelAsset }}>{stelAsset}</Text></span>} />}
                <Form.Item label="From date" name="fromDate"><DatePicker /></Form.Item>
                <Form.Item label="Flat NAV" name="flatNav"><InputNumber min={0} step={0.01} /></Form.Item>
                <Flex gap={10} wrap>
                    <Form.Item label="Fallback nearest price" name="fallbackNearestPrice" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
                    <Form.Item label="Fill missing chains" name="fillMissingChains" valuePropName="checked" layout="horizontal"><Switch size="small" /></Form.Item>
                </Flex>
                <Form.Item label="Commit (write to DB)" name="commit" valuePropName="checked" layout="horizontal"><Switch checkedChildren="WRITE" unCheckedChildren="dry" /></Form.Item>
                <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
            </Form>
        </div>
    );
}

// ── xStock excluded ──────────────────────────────────────────────────────
function XstockExcludedForm({ run, isConnected, rwaRunning, choices }: any) {
    const [form] = Form.useForm();
    const mode = Form.useWatch('mode', form);
    const onFinish = (v: any) => {
        const options: any = {
            startDate: v.dateRange?.[0] ? dayjs(v.dateRange[0]).format('YYYY-MM-DD') : undefined,
            endDate: v.dateRange?.[1] ? dayjs(v.dateRange[1]).format('YYYY-MM-DD') : undefined,
            commit: v.commit || false,
        };
        if (v.mode === 'all') options.all = true;
        else if (v.mode === 'ticker') options.ticker = v.ticker;
        else options.assetId = v.assetId;
        const scope = options.all ? 'ALL xStock/Backed assets' : (options.ticker || options.assetId);
        run('xstock-excluded', options, options.commit, `Backfill excluded-balance mcap for ${scope}.`);
    };
    return (
        <Form form={form} layout="vertical" onFinish={onFinish} initialValues={{ mode: 'ticker', commit: false }}>
            {!choices.hasAlchemyKey && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="ALCHEMY_API_KEY / SOLANA_RPC not set on the server" />}
            <Form.Item label="Mode" name="mode">
                <Select>
                    <Option value="ticker">Single ticker</Option>
                    <Option value="assetId">Single asset id</Option>
                    <Option value="all">All xStock / Backed Finance</Option>
                </Select>
            </Form.Item>
            {mode === 'ticker' && <Form.Item label="Ticker" name="ticker" rules={[{ required: true }]}><Input placeholder="e.g. METAx" /></Form.Item>}
            {mode === 'assetId' && <Form.Item label="Asset ID" name="assetId" rules={[{ required: true }]}><Input /></Form.Item>}
            <Form.Item label="Date range" name="dateRange" help="Defaults: start 2025-01-01 → today"><DatePicker.RangePicker /></Form.Item>
            <Form.Item label="Commit (write to DB)" name="commit" valuePropName="checked" layout="horizontal"><Switch checkedChildren="WRITE" unCheckedChildren="dry" /></Form.Item>
            <Form.Item>{runButton(isConnected, rwaRunning)}</Form.Item>
        </Form>
    );
}
