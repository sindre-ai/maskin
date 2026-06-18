import { CompactEmpty } from '@/mcp-apps/shared/compact-empty'
import { useCallTool, useToolResult, useWebAppContext } from '@/mcp-apps/shared/mcp-app-provider'
import { renderMcpApp } from '@/mcp-apps/shared/render'
import { type WorkspaceSchema, useWorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import {
	WEB_APP_OBJECT_TYPES,
	type WebAppObjectType,
	type WebAppTarget,
	useWebAppHref,
} from '@/mcp-apps/shared/web-app-link'
import { ExternalLink, User } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef } from 'react'

interface HeroCardActor {
	id: string
	name: string | null
	type: string | null
}

interface HeroCardObject {
	id: string
	type: string
	title: string | null
	status: string | null
	driver: HeroCardActor | null
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

function statusPillClass(status: string): string {
	const base = 'text-[10.5px] px-1.5 py-0.5 rounded-full font-medium'
	switch (status.toLowerCase()) {
		case 'active':
			return `${base} bg-green-100 text-green-800`
		case 'running':
			return `${base} inline-flex items-center gap-1.5 bg-blue-100 text-blue-800 before:content-[''] before:size-1 before:rounded-full before:bg-blue-800 before:animate-pulse`
		case 'idle':
		case 'system':
			return `${base} bg-slate-100 text-slate-600`
		case 'paused':
			return `${base} bg-amber-100 text-amber-800`
		case 'failed':
			return `${base} bg-red-100 text-red-800`
		default:
			return `${base} bg-muted text-muted-foreground`
	}
}

function useHeroObjectHref(object: HeroCardObject): string | null {
	const ctx = useWebAppContext()
	const objectHref = useWebAppHref(rowTarget(object))
	if (object.type === 'workspace') {
		return ctx ? `${ctx.baseUrl}/${object.id}` : null
	}
	return objectHref
}

function HeroCardSingle({ object, toolName }: { object: HeroCardObject; toolName: string }) {
	const callTool = useCallTool()
	const href = useHeroObjectHref(object)
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

	const content = (
		<article className="flex flex-col gap-2.5 px-4 py-3.5 bg-card border border-border rounded-[10px] max-w-[540px] transition-colors hover:border-border-hover">
			<div className="flex items-center gap-2">
				<div className="flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-primary text-primary-foreground text-[9px] leading-none font-bold shrink-0">
					M
				</div>
				<span className="font-mono text-[11px] text-muted-foreground lowercase">{typeLabel}</span>
				<div className="flex-1" />
				{object.status && <span className={statusPillClass(object.status)}>{object.status}</span>}
			</div>
			<h3 className="text-[15px] font-semibold leading-snug text-foreground m-0 line-clamp-1">
				{object.title || 'Untitled'}
			</h3>
			<p className="text-[13px] text-muted-foreground leading-relaxed m-0 line-clamp-1">
				{object.contextLine}
			</p>
			<div className="flex items-center gap-2.5 pt-2 border-t border-border mt-0.5">
				{object.driver?.name &&
					(object.driver.type !== 'agent' ? (
						<span className="text-[11.5px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
							<User className="size-3 shrink-0" />
							Driver: {object.driver.name}
						</span>
					) : (
						<span className="text-[11.5px] text-muted-foreground tabular-nums">
							Driver: {object.driver.name}
						</span>
					))}
				{href ? (
					<span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-foreground px-2.5 py-1 rounded-md bg-transparent border border-border group-hover:bg-muted group-hover:border-border-hover transition-colors min-h-[28px]">
						Open in Maskin
						<ExternalLink className="size-3" />
					</span>
				) : null}
			</div>
		</article>
	)

	return (
		<div className="p-3">
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noreferrer"
					onClick={onCtaClick}
					className="group block max-w-[540px] no-underline text-foreground"
				>
					{content}
				</a>
			) : (
				content
			)}
		</div>
	)
}

const MAX_VISIBLE_ROWS = 4

/**
 * Pick the deep-link target for the footer CTA. Object/search tools land on
 * the workspace objects list (filtered to a uniform type when possible);
 * actor and trigger tools land on their dedicated list pages. Anything else
 * falls back to the workspace root.
 */
function buildListCtaTarget(toolName: string, objects: HeroCardObject[]): WebAppTarget {
	if (toolName === 'list_workspaces') return { kind: 'workspace' }
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
// WEB_APP_OBJECT_TYPES list so additions flow through automatically.
const WEB_APP_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(WEB_APP_OBJECT_TYPES)
function isWebAppObjectType(type: string): type is WebAppObjectType {
	return WEB_APP_OBJECT_TYPE_SET.has(type)
}

function rowTarget(row: HeroCardObject): WebAppTarget {
	if (row.type === 'workspace') return { kind: 'workspace' }
	if (row.type === 'actor') return { kind: 'actor', id: row.id }
	if (row.type === 'trigger') return { kind: 'trigger', id: row.id }
	return { kind: 'object', id: row.id }
}

function pickPluralLabel(toolName: string, schema: WorkspaceSchema | null, rows: HeroCardObject[]) {
	if (toolName === 'list_workspaces') return 'Workspaces'
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
	const callTool = useCallTool()

	const visible = objects.slice(0, MAX_VISIBLE_ROWS)
	const totalRemainder = Math.max(0, totalCount - visible.length)

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

				<div className="flex flex-col">
					{visible.length === 0 ? (
						<div className="px-4 py-3 text-[12px] text-muted-foreground">No rows to show.</div>
					) : (
						visible.map((row) => <HeroCardListRow key={row.id} row={row} schema={schema} />)
					)}
				</div>

				<footer className="flex items-center px-4 py-2.5 border-t border-border bg-muted/30">
					<span className="text-[11.5px] text-muted-foreground">
						{totalRemainder > 0 ? `+${totalRemainder} more` : 'All shown'}
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
	const ctx = useWebAppContext()
	const targetHref = useWebAppHref(rowTarget(row))
	const href = row.type === 'workspace' && ctx ? `${ctx.baseUrl}/${row.id}` : targetHref
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
	renderMcpApp('HeroCard', <HeroCardRoot />, { showThemeToggle: false })
}

export { HeroCardApp, HeroCardList, HeroCardRoot, HeroCardSingle, extractHeroCard }
export type { HeroCardObject, HeroCardPayload }
