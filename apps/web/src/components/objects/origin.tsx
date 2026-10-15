import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { useActors } from '@/hooks/use-actors'
import { useSession } from '@/hooks/use-sessions'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronDown, Lock } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, useMemo, useState } from 'react'

/**
 * `<Origin>` — the system-written lineage block. Renders NOTHING when the
 * object has no `produced_by` ancestor. Compact by default, expands in
 * place to a Chat | Session card on click. When the session has no parent
 * conversation (agent-started session without a chat) the Chat cell is
 * hidden and the Session cell stretches full-width.
 *
 * Placement: object-detail shell, between `ObjectDetailIdentity` and
 * `ObjectAskBanner` (per CPO 2026-09-22, top-of-page not right-rail).
 *
 * Absence contract (spec §Rabbit holes): no session = no block, never
 * an "unknown" placeholder.
 */
export function Origin({
	object,
	relationships,
	workspaceId,
}: {
	object: Pick<ObjectResponse, 'id'>
	relationships: RelationshipResponse[]
	workspaceId: string
}) {
	const lineage = useMemo(
		() => resolveLineage(relationships, object.id),
		[relationships, object.id],
	)
	const { data: actors } = useActors(workspaceId, { enabled: !!lineage })
	const [expanded, setExpanded] = useState(false)

	if (!lineage) return null

	const agent = actors?.find((a) => a.id === lineage.sessionActorId)

	return (
		<OriginBlock
			lineage={lineage}
			agentName={agent?.name}
			agentType={agent?.type}
			workspaceId={workspaceId}
			expanded={expanded}
			onToggle={() => setExpanded((prev) => !prev)}
		/>
	)
}

interface Lineage {
	sessionId: string
	sessionTitle: string | null
	sessionActorId: string | null
	spawnedAt: string | null
	conversation: { id: string; title: string | null; messageId: number | null } | null
}

/**
 * Given the object's graph relationships, resolve the produced_by edge
 * (session → object) and, if present, the spawned edge upstream
 * (conversation → session) that the graph endpoint hydrates one hop
 * further for provenance. Returns `null` when there is no lineage —
 * that is the signal `<Origin>` should not render at all.
 */
export function resolveLineage(
	relationships: RelationshipResponse[],
	objectId: string,
): Lineage | null {
	// The produced_by edge is the anchor: session → object, target=objectId.
	// If multiple sessions have produced this object (rare — an object
	// mutated across sessions), pick the oldest, since Origin means "where
	// this originated" not "who last touched it".
	const producedBy = relationships
		.filter(
			(r) => r.type === 'produced_by' && r.sourceType === 'session' && r.targetId === objectId,
		)
		.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0]

	if (!producedBy) return null

	const sessionId = producedBy.sourceId

	// The spawned edge (conversation → session) is the upstream hop. It
	// does NOT touch this object; the graph endpoint returns it in the
	// same array as a courtesy so Origin can render its Chat cell in one
	// round-trip.
	const spawned = relationships.find(
		(r) => r.type === 'spawned' && r.targetType === 'session' && r.targetId === sessionId,
	)

	const conversation = spawned
		? {
				id: spawned.sourceId,
				title: spawned.sourceTitle ?? null,
				messageId: coerceMessageId(spawned.metadata),
			}
		: null

	return {
		sessionId,
		sessionTitle: producedBy.sourceTitle ?? null,
		sessionActorId: producedBy.createdBy ?? null,
		spawnedAt: producedBy.createdAt,
		conversation,
	}
}

function coerceMessageId(metadata: Record<string, unknown> | null | undefined): number | null {
	if (!metadata) return null
	const raw = metadata.messageId
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw)
	return null
}

function OriginBlock({
	lineage,
	agentName,
	agentType,
	workspaceId,
	expanded,
	onToggle,
}: {
	lineage: Lineage
	agentName?: string
	agentType?: string
	workspaceId: string
	expanded: boolean
	onToggle: () => void
}) {
	// Keyboard contract from the design spec §7: Enter/Space toggles the
	// compact form; Esc collapses when expanded. Handled here so both the
	// compact button and the expanded surface honour the same shortcut.
	const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key === 'Escape' && expanded) {
			event.preventDefault()
			onToggle()
		}
	}

	if (!expanded) {
		return (
			<button
				type="button"
				aria-expanded="false"
				aria-label="Origin — click to expand"
				onClick={onToggle}
				onKeyDown={handleKeyDown}
				data-origin
				data-origin-state="compact"
				className={cn(
					'mt-3.5 flex w-full flex-wrap items-center gap-2 rounded-[11px]',
					'border border-border-subtle bg-surface-sunken px-[11px] py-[9px]',
					'text-left transition-colors duration-180 ease-standard',
					'hover:bg-muted hover:border-border',
					'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
				)}
			>
				<CompactRow lineage={lineage} agentName={agentName} agentType={agentType} />
			</button>
		)
	}

	return (
		<section
			aria-label="Origin — expanded"
			data-origin
			data-origin-state="expanded"
			onKeyDown={handleKeyDown}
			className={cn(
				'mt-3.5 flex flex-col gap-3 rounded-[11px] border border-border bg-card p-3',
				'shadow-xs transition-colors duration-180 ease-standard',
			)}
		>
			<button
				type="button"
				aria-expanded="true"
				aria-label="Origin — click to collapse"
				onClick={onToggle}
				className="-mx-1 -mt-1 flex w-[calc(100%+0.5rem)] flex-wrap items-center gap-2 rounded-md px-1 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
			>
				<CompactRow lineage={lineage} agentName={agentName} agentType={agentType} expanded />
			</button>
			<ExpandedCells lineage={lineage} workspaceId={workspaceId} />
		</section>
	)
}

function CompactRow({
	lineage,
	agentName,
	agentType,
	expanded = false,
}: {
	lineage: Lineage
	agentName?: string
	agentType?: string
	expanded?: boolean
}) {
	// Mobile wrap: eyebrow on its own line at ≤640px, agent chip + time on
	// the next. Design spec §5 (mobile).
	return (
		<>
			<span className="eyebrow shrink-0 basis-full sm:basis-auto">Origin</span>
			<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[11.5px] leading-[1.45] text-muted-foreground">
				{agentName && (
					<ActorAvatar
						id={lineage.sessionActorId ?? undefined}
						name={agentName}
						type={agentType ?? 'agent'}
						size="sm"
						className="size-5 shrink-0 text-[8.5px]"
					/>
				)}
				{agentName && <span className="shrink-0 font-semibold text-foreground">{agentName}</span>}
				{lineage.conversation?.title ? (
					<>
						<span className="shrink-0">in</span>
						<span className="min-w-0 max-w-full truncate font-medium text-brand-subtle-foreground">
							{lineage.conversation.title}
						</span>
					</>
				) : null}
				{lineage.spawnedAt && (
					<span className="shrink-0">
						· spawned <RelativeTime date={lineage.spawnedAt} className="inline" />
					</span>
				)}
			</span>
			<ChevronDown
				size={14}
				aria-hidden
				className={cn(
					'shrink-0 text-muted-foreground transition-transform duration-180 ease-standard',
					expanded && 'rotate-180',
				)}
			/>
		</>
	)
}

function ExpandedCells({ lineage, workspaceId }: { lineage: Lineage; workspaceId: string }) {
	const hasChat = lineage.conversation !== null
	const [sessionOpen, setSessionOpen] = useState(false)
	// Session lives as a Sheet (SessionDetailPanel), not a route, so the
	// Session cell is a button that opens the sheet in place. The session
	// row itself is fetched lazily on first open — no network cost until
	// the user cares.
	const { data: session } = useSession(sessionOpen ? lineage.sessionId : null, workspaceId)

	return (
		<div className="flex flex-col gap-3">
			<div className={cn('grid gap-3', hasChat ? 'sm:grid-cols-2' : 'sm:grid-cols-1')}>
				{hasChat && lineage.conversation && (
					<OriginCell heading="Chat">
						<Link
							to="/$workspaceId/chats/$conversationId"
							params={{ workspaceId, conversationId: lineage.conversation.id }}
							className="block truncate text-[12.5px] font-medium text-foreground hover:text-brand"
						>
							{lineage.conversation.title ?? 'Untitled chat'}
						</Link>
					</OriginCell>
				)}
				<OriginCell heading="Session">
					<button
						type="button"
						onClick={() => setSessionOpen(true)}
						className="block w-full truncate text-left text-[12.5px] font-medium text-foreground hover:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded"
					>
						{lineage.sessionTitle ?? 'Untitled session'}
					</button>
				</OriginCell>
			</div>
			{hasChat && lineage.conversation && (
				<Link
					to="/$workspaceId/chats/$conversationId"
					params={{ workspaceId, conversationId: lineage.conversation.id }}
					search={
						lineage.conversation.messageId != null
							? { msg: lineage.conversation.messageId }
							: undefined
					}
					className={cn(
						'inline-flex items-center gap-1.5 self-start text-[11.5px] font-medium text-brand',
						'hover:text-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded',
					)}
				>
					Open chat at this moment
				</Link>
			)}
			<p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
				<Lock size={10} aria-hidden />
				System-written · not editable
			</p>
			<SessionDetailPanel
				session={session ?? null}
				workspaceId={workspaceId}
				open={sessionOpen}
				onOpenChange={setSessionOpen}
			/>
		</div>
	)
}

function OriginCell({ heading, children }: { heading: string; children: React.ReactNode }) {
	return (
		<div className="min-w-0 rounded-md border border-border/60 bg-background/60 px-3 py-2">
			<div className="eyebrow mb-1">{heading}</div>
			{children}
		</div>
	)
}
