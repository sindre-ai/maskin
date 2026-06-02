import { CompactEmpty } from '@/mcp-apps/shared/compact-empty'
import { useCallTool, useToolResult } from '@/mcp-apps/shared/mcp-app-provider'
import { renderMcpApp } from '@/mcp-apps/shared/render'
import { useWorkspaceSchema } from '@/mcp-apps/shared/use-workspace-schema'
import { useWebAppHref } from '@/mcp-apps/shared/web-app-link'
import { ExternalLink } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef } from 'react'

interface HeroCardActor {
	id: string
	name: string | null
}

interface HeroCardMeta {
	label: string
	value: string
}

interface HeroCardPrimaryAction {
	label: string
	kind: string
}

interface HeroCardObject {
	id: string
	type: string
	title: string | null
	status: string | null
	owner: HeroCardActor | null
	contextLine: string
	metas?: HeroCardMeta[]
	primaryAction?: HeroCardPrimaryAction
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
		return <CompactEmpty toolName={heroCard.tool} label="no results" />
	}
	if (heroCard.kind === 'list') {
		const objs = heroCard.objects ?? []
		return <HeroCardList objects={objs} totalCount={heroCard.totalCount ?? objs.length} />
	}
	if (!heroCard.object) {
		return <CompactEmpty toolName={heroCard.tool} label="no object" />
	}
	return <HeroCardSingle object={heroCard.object} toolName={toolName} />
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
				{object.metas && object.metas.length > 0 && (
					<dl className="flex flex-wrap items-center gap-x-3 gap-y-1 m-0">
						{object.metas.map((m, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: metas come from a schema annotation; order is stable and two entries can legitimately share a label
							<div key={i} className="flex items-center gap-1 text-[11.5px]">
								<dt className="text-muted-foreground">{m.label}:</dt>
								<dd className="text-foreground tabular-nums m-0">{m.value}</dd>
							</div>
						))}
					</dl>
				)}
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
							{object.primaryAction?.label ?? 'Open in Maskin'}
							<ExternalLink className="size-3" />
						</a>
					) : null}
				</div>
			</article>
		</div>
	)
}

function HeroCardList({ objects, totalCount }: { objects: HeroCardObject[]; totalCount: number }) {
	// T3 doesn't ship a styled list envelope; the existing objects widget renders
	// collections for now. This branch only fires when the predicate stays on
	// `objects` but the bundle was loaded somehow (e.g. cached host). A compact
	// summary keeps the surface useful instead of blank.
	return (
		<div className="p-3">
			<div className="font-mono text-[11px] text-muted-foreground">
				{totalCount} result{totalCount === 1 ? '' : 's'}
			</div>
			<ul className="mt-2 space-y-1">
				{objects.slice(0, 4).map((o) => (
					<li key={o.id} className="text-sm text-foreground truncate">
						{o.title || 'Untitled'}
					</li>
				))}
			</ul>
		</div>
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

export { HeroCardApp, HeroCardRoot, HeroCardSingle, extractHeroCard }
export type { HeroCardObject, HeroCardPayload }
