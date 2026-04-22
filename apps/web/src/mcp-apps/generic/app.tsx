import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'

type PlainRecord = Record<string, unknown>

const PRIMARY_LABEL_KEYS = ['name', 'title', 'displayName', 'display_name', 'id'] as const
const SECONDARY_FIELD_KEYS = ['status', 'type', 'provider', 'kind', 'category', 'role'] as const

function pickString(obj: PlainRecord, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = obj[key]
		if (typeof value === 'string' && value.length > 0) return value
		if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	}
	return null
}

function primaryLabel(item: PlainRecord, fallback: string): string {
	return pickString(item, PRIMARY_LABEL_KEYS) ?? fallback
}

function GenericApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (data == null) return <RawTextView text={text} />

	const unwrapped = unwrapEnvelope(data)

	if (isArray(unwrapped)) {
		return <GenericListView items={unwrapped} />
	}

	if (isObject(data)) {
		const record = data as PlainRecord
		if (isSuccessOnly(record)) return <StatusLineView record={record} />
		return <GenericObjectView record={record} />
	}

	return <RawTextView text={text} />
}

function isSuccessOnly(record: PlainRecord): boolean {
	if (record.success !== true) return false
	// Only `success` + a handful of trivial metadata fields (no nested structure)
	const meaningfulKeys = Object.keys(record).filter((k) => k !== 'success')
	return meaningfulKeys.every((k) => {
		const v = record[k]
		return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
	})
}

function GenericListView({ items }: { items: unknown[] }) {
	if (!items.length) {
		return <EmptyState title="No results" description="The tool returned an empty list" />
	}

	return (
		<div className="p-4 space-y-1">
			{items.map((item, index) => (
				<GenericListRow key={keyFor(item, index)} item={item} fallback={`#${index + 1}`} />
			))}
		</div>
	)
}

function keyFor(item: unknown, index: number): string {
	if (isObject<PlainRecord>(item)) {
		const id = (item as PlainRecord).id
		if (typeof id === 'string' || typeof id === 'number') return String(id)
	}
	return `row-${index}`
}

function GenericListRow({ item, fallback }: { item: unknown; fallback: string }) {
	if (!isObject<PlainRecord>(item)) {
		return (
			<div className="px-3 py-2 rounded-lg text-sm text-foreground font-mono">{String(item)}</div>
		)
	}

	const record = item as PlainRecord
	const label = primaryLabel(record, fallback)
	const status =
		typeof record.status === 'string' && record.status.length > 0 ? record.status : null
	const secondary = status ? null : pickString(record, SECONDARY_FIELD_KEYS)
	const enabled =
		typeof record.enabled === 'boolean'
			? record.enabled
			: typeof record.set === 'boolean'
				? record.set
				: null

	return (
		<div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors">
			{enabled !== null && (
				<span
					className={`w-2 h-2 rounded-full ${enabled ? 'bg-success' : 'bg-muted-foreground'}`}
				/>
			)}
			<span className="text-sm text-foreground flex-1 truncate">{label}</span>
			{status && <StatusBadge status={status} />}
			{secondary && <span className="text-xs text-muted-foreground capitalize">{secondary}</span>}
		</div>
	)
}

function GenericObjectView({ record }: { record: PlainRecord }) {
	const entries = Object.entries(record)
	const title = primaryLabel(record, 'Result')
	const status =
		typeof record.status === 'string' && record.status.length > 0 ? record.status : null

	return (
		<div className="p-4 max-w-2xl">
			<div className="flex items-center gap-2 mb-4">
				<h1 className="text-lg font-semibold text-foreground flex-1 truncate">{title}</h1>
				{status && <StatusBadge status={status} />}
			</div>
			<div className="space-y-1.5">
				{entries.map(([key, value]) => (
					<div key={key} className="flex gap-3 text-xs border-b border-border py-1.5">
						<span className="text-muted-foreground font-medium min-w-[140px] capitalize">
							{key.replace(/_/g, ' ')}
						</span>
						<span className="text-foreground break-all">{formatValue(value)}</span>
					</div>
				))}
			</div>
		</div>
	)
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return '—'
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return JSON.stringify(value, null, 2)
}

function StatusLineView({ record }: { record: PlainRecord }) {
	const detailEntries = Object.entries(record).filter(([k]) => k !== 'success')
	const detail = detailEntries
		.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${formatValue(v)}`)
		.join(' · ')

	return (
		<div className="p-6 text-center">
			<p className="text-sm font-medium text-foreground">Done.</p>
			{detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
		</div>
	)
}

function RawTextView({ text }: { text: string }) {
	return (
		<pre className="p-4 text-xs text-foreground font-mono whitespace-pre-wrap break-all">
			{text}
		</pre>
	)
}

renderMcpApp('Generic', <GenericApp />)
