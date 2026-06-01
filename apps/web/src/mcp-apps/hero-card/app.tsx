import { CompactEmpty } from '@/mcp-apps/shared/compact-empty'
import { useCallTool, useToolResult } from '@/mcp-apps/shared/mcp-app-provider'
import { renderMcpApp } from '@/mcp-apps/shared/render'
import { type WorkspaceSchema, useWorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import {
	WEB_APP_OBJECT_TYPES,
	type WebAppObjectType,
	type WebAppTarget,
	useWebAppHref,
} from '@/mcp-apps/shared/web-app-link'
import { ExternalLink, Search } from 'lucide-react'
import {
	Component,
	type ErrorInfo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

interface HeroCardActor {
	id: string
	name: string | null
}

interface HeroCardObject {
	id: string
	type: string
	title: string | null
	status: string | null
	owner: HeroCardActor | null
	contextLine: string
	badges?: string[]
}

type HeroCardKind = 'single' | 'list' | 'empty'

interface HeroCardPayload {
	kind: HeroCardKind
	tool: string
	object?: HeroCardObject
	objects?: HeroCardObject[]
	totalCount?: number
}

function extractHeroCard(result: unknown): HeroCardPayload | null {
	if (!result || typeof result !== 'object') return null
	const sc = (result as { structuredContent?: { heroCard?: unknown } }).structuredContent
	const hc = sc?.heroCard
	if (!hc || typeof hc !== 'object') return null
	const kind = (hc as { kind?: unknown }).kind
	if (kind !== 'single' && kind !== 'list' && kind !== 'empty') return null
	return hc as HeroCardPayload
}

function HeroCardApp() {
	const toolResult = useToolResult()
	const heroCard = toolResult ? extractHeroCard(toolResult.result) : null
	const toolName = toolResult?.toolName ?? 'unknown'

	useRenderTelemetry(heroCard, toolName)

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}
	if (!heroCard) {
		// Server didn't populate structuredContent — surface raw text so the
		// Markdown fallback path is visible instead of a blank card.
		return <RawFallback toolResult={toolResult} />
	}

	if (heroCard.kind === 'empty') {
		return <HeroCardEmpty toolName={heroCard.tool} />
	}
	if (heroCard.kind === 'list') {
		const objs = heroCard.objects ?? []
		return (
			<HeroCardList
				objects={objs}
				totalCount={heroCard.totalCount ?? objs.length}
				toolName={heroCard.tool || toolName}
			/>
		)
	}
	if (!heroCard.object) {
		return <CompactEmpty toolName={heroCard.tool} label="no object" />
	}
	return <HeroCardSingle object={heroCard.object} toolName={toolName} />
}

function HeroCardEmpty({ toolName }: { toolName: string }) {
	return <CompactEmpty toolName={toolName} label="no results" />
}

function HeroCardSingle({ object, toolName }: { object: HeroCardObject; toolName: string }) {
	const callTool = useCallTool()
	const href = useWebAppHref({ kind: 'object', id: object.id })
	const { schema } = useWorkspaceSchema()
	const typeLabel = schema?.types?.[object.type]?.display_name ?? object.type

	const onCtaClick = () => {
		callTool('record_widget_event', {
			widget_name: 'hero-card',
			event: 'click_through',
			tool_name: toolName,
			card_kind: 'single',
			object_type: object.type,
			object_id: object.id,
		}).catch(() => {
			// Telemetry must never block navigation — swallow.
		})
	}

	return (
		<div className="p-3">
			<article className="flex flex-col gap-2.5 px-4 py-3.5 bg-card border border-border rounded-[10px] max-w-[540px] transition-colors hover:border-border-hover">
				<div className="flex items-center gap-2">
					<div className="flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-primary text-primary-foreground text-[9px] leading-none font-bold shrink-0">
						M
					</div>
					<span className="font-mono text-[11px] text-muted-foreground lowercase">{typeLabel}</span>
					<div className="flex-1" />
					{object.status && (
						<span className="text-[10.5px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">
							{object.status}
						</span>
					)}
				</div>
				<h3 className="text-[15px] font-semibold leading-snug text-foreground m-0 line-clamp-1">
					{object.title || 'Untitled'}
				</h3>
				<p className="text-[13px] text-muted-foreground leading-relaxed m-0 line-clamp-1">
					{object.contextLine}
				</p>
				<div className="flex items-center gap-2.5 pt-2 border-t border-border mt-0.5">
					{object.owner?.name && (
						<span className="text-[11.5px] text-muted-foreground tabular-nums">
							Owner: {object.owner.name}
						</span>
					)}
					{href ? (
						<a
							href={href}
							target="_blank"
							rel="noreferrer"
							onClick={onCtaClick}
							className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-foreground px-2.5 py-1 rounded-md bg-transparent border border-border hover:bg-muted hover:border-border-hover transition-colors min-h-[28px]"
						>
							Open in Maskin
							<ExternalLink className="size-3" />
						</a>
					) : null}
				</div>
			</article>
		</div>
	)
}

const MAX_VISIBLE_ROWS = 4

type SortKey = 'title' | 'status' | 'owner'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
	{ value: 'title', label: 'Title' },
	{ value: 'status', label: 'Status' },
	{ value: 'owner', label: 'Owner' },
]

function compareRows(a: HeroCardObject, b: HeroCardObject, key: SortKey): number {
	const get = (o: HeroCardObject) => {
		if (key === 'title') return (o.title ?? '').toLowerCase()
		if (key === 'status') return (o.status ?? '').toLowerCase()
		return (o.owner?.name ?? '').toLowerCase()
	}
	return get(a).localeCompare(get(b))
}

function matchesFilter(o: HeroCardObject, q: string): boolean {
	const needle = q.trim().toLowerCase()
	if (!needle) return true
	return (
		(o.title ?? '').toLowerCase().includes(needle) ||
		(o.contextLine ?? '').toLowerCase().includes(needle) ||
		(o.status ?? '').toLowerCase().includes(needle) ||
		(o.owner?.name ?? '').toLowerCase().includes(needle)
	)
}

/**
 * Pick the deep-link target for the footer CTA. Object/search tools land on
 * the workspace objects list (filtered to a uniform type when possible);
 * actor and trigger tools land on their dedicated list pages. Anything else
 * falls back to the workspace root.
 */
function buildListCtaTarget(toolName: string, objects: HeroCardObject[]): WebAppTarget {
	if (toolName === 'list_actors') return { kind: 'actor' }
	if (toolName === 'list_triggers') return { kind: 'trigger' }
	const types = new Set(objects.map((o) => o.type))
	if (types.size === 1) {
		const [only] = [...types]
		if (only && isWebAppObjectType(only)) {
			return { kind: 'objects', type: only }
		}
	}
	return { kind: 'objects' }
}

// Only forward an object-table type the URL builder knows; otherwise the
// caller drops the filter so the URL stays valid. Built from the canonical
// `WEB_APP_OBJECT_TYPES` list — adding `goal`/`note` there flows through to
// the CTA filter automatically.
const WEB_APP_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(WEB_APP_OBJECT_TYPES)
function isWebAppObjectType(type: string): type is WebAppObjectType {
	return WEB_APP_OBJECT_TYPE_SET.has(type)
}

function rowTarget(row: HeroCardObject): WebAppTarget {
	if (row.type === 'actor') return { kind: 'actor', id: row.id }
	if (row.type === 'trigger') return { kind: 'trigger', id: row.id }
	return { kind: 'object', id: row.id }
}

function pickPluralLabel(toolName: string, schema: WorkspaceSchema | null, rows: HeroCardObject[]) {
	if (toolName === 'list_actors') return 'Actors'
	if (toolName === 'list_triggers') return 'Triggers'
	const types = new Set(rows.map((o) => o.type))
	if (types.size === 1) {
		const [only] = [...types]
		const display = only ? (schema?.types?.[only]?.display_name ?? only) : 'Objects'
		// Naive pluralisation — most schema display_names are short nouns.
		// `display_name + 's'` is wrong for irregulars, so callers can override
		// via the schema if needed.
		return `${display.charAt(0).toUpperCase()}${display.slice(1)}${display.endsWith('s') ? '' : 's'}`
	}
	return 'Objects'
}

function HeroCardList({
	objects,
	totalCount,
	toolName,
}: {
	objects: HeroCardObject[]
	totalCount: number
	toolName: string
}) {
	const { schema } = useWorkspaceSchema()
	const [sortKey, setSortKey] = useState<SortKey>('title')
	const [filter, setFilter] = useState('')
	const callTool = useCallTool()

	const filtered = useMemo(() => objects.filter((o) => matchesFilter(o, filter)), [objects, filter])
	const sorted = useMemo(
		() => [...filtered].sort((a, b) => compareRows(a, b, sortKey)),
		[filtered, sortKey],
	)
	const visible = sorted.slice(0, MAX_VISIBLE_ROWS)
	const remainder = Math.max(0, sorted.length - visible.length)
	const filteredOut = totalCount - filtered.length

	const ctaTarget = useMemo(() => buildListCtaTarget(toolName, objects), [toolName, objects])
	const ctaHref = useWebAppHref(ctaTarget)
	const pluralLabel = pickPluralLabel(toolName, schema, objects)

	const onCtaClick = () => {
		callTool('record_widget_event', {
			widget_name: 'hero-card',
			event: 'click_through',
			tool_name: toolName,
			card_kind: 'list',
		}).catch(() => {
			// Telemetry must never block navigation — swallow.
		})
	}

	const showControls = totalCount > MAX_VISIBLE_ROWS

	return (
		<div className="p-3">
			<div className="flex flex-col bg-card border border-border rounded-[10px] max-w-[540px] overflow-hidden">
				<header className="flex items-center gap-2 px-4 py-3 border-b border-border">
					<div className="flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-primary text-primary-foreground text-[9px] leading-none font-bold shrink-0">
						M
					</div>
					<span className="text-[13px] font-semibold text-foreground">{pluralLabel}</span>
					<div className="flex-1" />
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{totalCount}
					</span>
				</header>

				{showControls && (
					<div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/40">
						<div className="relative flex-1 min-w-0">
							<Search
								size={11}
								className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
							/>
							<input
								aria-label="Filter rows"
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter"
								className="w-full h-7 pl-6 pr-2 text-[12px] rounded-md bg-card border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-border-hover"
							/>
						</div>
						<label className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<span>Sort</span>
							<select
								aria-label="Sort rows"
								value={sortKey}
								onChange={(e) => setSortKey(e.target.value as SortKey)}
								className="h-7 px-1.5 text-[11px] rounded-md bg-card border border-border text-foreground focus:outline-none focus:border-border-hover"
							>
								{SORT_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						</label>
					</div>
				)}

				<div className="flex flex-col">
					{visible.length === 0 ? (
						<div className="px-4 py-3 text-[12px] text-muted-foreground">
							No rows match "{filter}".
						</div>
					) : (
						visible.map((row) => <HeroCardListRow key={row.id} row={row} schema={schema} />)
					)}
				</div>

				<footer className="flex items-center px-4 py-2.5 border-t border-border bg-muted/30">
					<span className="text-[11.5px] text-muted-foreground">
						{filteredOut > 0
							? `${filtered.length} of ${totalCount} shown · ${remainder > 0 ? `+${remainder} more in filter` : 'all shown'}`
							: remainder > 0
								? `+${remainder} more`
								: 'All shown'}
					</span>
					{ctaHref ? (
						<a
							href={ctaHref}
							target="_blank"
							rel="noreferrer"
							onClick={onCtaClick}
							className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-foreground px-2.5 py-1 rounded-md bg-transparent border border-border hover:bg-muted hover:border-border-hover transition-colors min-h-[28px]"
						>
							Open in Maskin
							<ExternalLink className="size-3" />
						</a>
					) : null}
				</footer>
			</div>
		</div>
	)
}

function HeroCardListRow({
	row,
	schema,
}: {
	row: HeroCardObject
	schema: WorkspaceSchema | null
}) {
	const href = useWebAppHref(rowTarget(row))
	const typeLabel = schema?.types?.[row.type]?.display_name ?? row.type
	const rowContent = (
		<>
			<div className="flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-primary text-primary-foreground text-[9px] leading-none font-bold shrink-0">
				M
			</div>
			<span className="text-[13.5px] font-medium text-foreground truncate min-w-0">
				{row.title || 'Untitled'}
			</span>
			{row.status ? (
				<span className="font-mono text-[10.5px] text-muted-foreground border border-border rounded px-1.5 py-0.5 shrink-0">
					{row.status}
				</span>
			) : null}
			<span className="ml-auto text-[11.5px] text-muted-foreground tabular-nums truncate shrink-0 max-w-[160px]">
				{row.contextLine || typeLabel}
			</span>
		</>
	)
	if (!href) {
		return (
			<div className="flex items-center gap-2 px-4 py-2.5 border-b border-border last:border-b-0">
				{rowContent}
			</div>
		)
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-2 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-muted transition-colors no-underline text-foreground"
		>
			{rowContent}
		</a>
	)
}

function RawFallback({
	toolResult,
}: { toolResult: NonNullable<ReturnType<typeof useToolResult>> }) {
	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>
	return <div className="p-4 text-sm text-foreground whitespace-pre-wrap">{text}</div>
}

function useRenderTelemetry(heroCard: HeroCardPayload | null, toolName: string) {
	const callTool = useCallTool()
	const firedRef = useRef(false)
	useEffect(() => {
		if (firedRef.current) return
		if (!heroCard) return
		firedRef.current = true
		callTool('record_widget_event', {
			widget_name: 'hero-card',
			event: 'render_success',
			tool_name: toolName,
			card_kind: heroCard.kind,
			object_type: heroCard.object?.type,
			object_id: heroCard.object?.id,
		}).catch(() => {
			// Telemetry must never throw out of the render path — swallow.
		})
	}, [heroCard, toolName, callTool])
}

interface ErrorBoundaryProps {
	children: ReactNode
	onError: (error: Error, info: ErrorInfo) => void
}

class HeroCardErrorBoundary extends Component<ErrorBoundaryProps, { hasError: boolean }> {
	constructor(props: ErrorBoundaryProps) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		this.props.onError(error, info)
	}

	render() {
		if (this.state.hasError) {
			return (
				<div className="p-4 text-sm text-muted-foreground">
					Card failed to render — see Maskin web app.
				</div>
			)
		}
		return this.props.children
	}
}

function HeroCardRoot() {
	const callTool = useCallTool()
	const toolResult = useToolResult()
	const onRenderError = (error: Error) => {
		const heroCard = toolResult ? extractHeroCard(toolResult.result) : null
		callTool('record_widget_event', {
			widget_name: 'hero-card',
			event: 'render_error',
			tool_name: toolResult?.toolName ?? 'unknown',
			card_kind: heroCard?.kind ?? 'empty',
			object_type: heroCard?.object?.type,
			object_id: heroCard?.object?.id,
		}).catch(() => {
			// Telemetry must never block the error UI — swallow.
		})
		console.error('[hero-card] render error', error)
	}
	return (
		<HeroCardErrorBoundary onError={onRenderError}>
			<HeroCardApp />
		</HeroCardErrorBoundary>
	)
}

// Skip the boot when there's no `#root` (tests import this module to exercise
// component logic without running the production renderer).
if (typeof document !== 'undefined' && document.getElementById('root')) {
	renderMcpApp('HeroCard', <HeroCardRoot />)
}

export { HeroCardApp, HeroCardList, HeroCardRoot, HeroCardSingle, extractHeroCard }
export type { HeroCardObject, HeroCardPayload }
