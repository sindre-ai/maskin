import {
	AgentReferenceCard,
	AgentReferenceChip,
	LoopReferenceCard,
	LoopReferenceChip,
	ObjectReferenceCard,
	ObjectReferenceChip,
	TriggerReferenceCard,
	TriggerReferenceChip,
} from '@/components/chat/linked-object-reference'
import { useLinkedPanel } from '@/components/chat/linked-panel-context'
import { StatusSelect } from '@/components/objects/property-selects'
import { FilePreview, isPreviewableFile } from '@/components/shared/file-preview'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { ObjectPreviewMeta } from '@/components/shared/object-preview-meta'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useFiles } from '@/hooks/use-files'
import { useObjectTypeLabel } from '@/hooks/use-object-type-label'
import { useApproveObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { statusLabel } from '@/lib/constants'
import { type LinkedTarget, showsObjectCard } from '@/lib/linked-objects'
import { describeObjectProperties } from '@/lib/object-properties'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, PanelRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'

interface PreviewProps {
	workspaceId: string
	objectId: string
	/** Open straight away instead of contracted (the drawer's working view). */
	defaultExpanded?: boolean
	className?: string
	/** The chat the message is in and the agent that wrote it; together they let an approval
	 *  or a status change tell that agent. Without them the card only previews. */
	conversationId?: string
	agentId?: string
}

/** One object drawn as a card: what it says, its status, Approve for a draft. Draws any object that has text; callers decide which objects deserve a card (see `hasPreviewCard`). */
export function LinkedObjectCard({
	workspaceId,
	objectId,
	conversationId,
	agentId,
	defaultExpanded = false,
	className,
}: PreviewProps) {
	const { data: object } = useObject(objectId)
	const { workspace } = useWorkspace()
	const typeLabel = useObjectTypeLabel()
	const update = useUpdateObject(workspaceId)
	const approve = useApproveObject()
	const linkedPanel = useLinkedPanel()
	// Contracted shows the header and title; the text and the next-phase button
	// appear once the top of the card is clicked.
	const [expanded, setExpanded] = useState(defaultExpanded)

	// Nothing for an object that is missing, in another workspace, or has no
	// text: the link in the message is still there, so the preview only ever adds.
	const body = object?.content?.trim()
	if (!object || object.workspaceId !== workspaceId || !body) return null

	// The workspace's own statuses for this object's type, never a fixed list.
	const statuses =
		(workspace.settings as { statuses?: Record<string, string[]> } | undefined)?.statuses?.[
			object.type
		] ?? []
	const canAct = Boolean(conversationId && agentId)
	// Sent with an approval or a status change so the server tells the agent behind the card.
	// Nothing is posted in the chat: the person did not write a message.
	const chat =
		conversationId && agentId ? { conversation_id: conversationId, agent_id: agentId } : undefined
	// A draft an integration can deliver (an email, a LinkedIn message or post, a Slack message)
	// has a preview. Its card says what it is, shows where it goes and ends in an approval
	// instead of the next phase: the person's yes to this exact text, after which the agent is
	// told to send it. Which objects qualify, and how they are sent, is the integration's own
	// declaration (`deliverables`), so this card knows nothing of LinkedIn.
	const preview = object.preview ?? null
	// Open, the preview block shows who it goes to and what kind of message it is; the line under
	// the title then leaves those out. Contracted, that block is hidden and the line keeps them.
	const properties = describeObjectProperties(
		object.metadata,
		expanded && preview
			? {
					recipients: preview.recipients.flatMap((r) => [r.name, r.address]),
					label: preview.label,
				}
			: undefined,
	)
	const delivery = preview?.delivery?.state
	// What would go out. For most drafts that is the whole text; for one that carries a header
	// (a LinkedIn post filed with its account and angle) it is the post alone, and that is
	// what the card shows. Such a text is edited on the object page, where the header is.
	const shown = preview ? preview.body : body
	const editable = canAct && (!preview || preview.body.trim() === body)
	// The phase after this one in the workspace's own order, if there is one.
	const nextStatus = statuses[statuses.indexOf(object.status) + 1]

	// The agent is always told, by the server, with the text as it stands so it can compare it
	// with what the task holds now before it sends anything.
	const moveTo = (status: string) => {
		if (status === object.status) return
		update.mutate({ id: object.id, data: { status, chat } })
	}

	// The person's yes to this exact text. The server tells the agent to send it, with the text,
	// so it does not have to guess what was approved.
	const approveDraft = () => {
		if (!preview) return
		approve.mutate({ id: object.id, contentHash: preview.content_hash, chat })
	}

	return (
		<div
			data-linked-card=""
			className={cn(
				'@container not-prose mt-2 max-w-[660px] overflow-hidden rounded-xl border border-border bg-card',
				className,
			)}
		>
			{/* The whole top (header and title) toggles the card. The status menu and
			    Open stop the click so they keep doing their own job; the status menu's
			    dropdown is portalled but still bubbles through React, so it is covered too. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard path; its click bubbles here */}
			<div className="cursor-pointer" onClick={() => setExpanded((open) => !open)}>
				<div
					className={cn(
						'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2',
						expanded && 'border-b border-border',
					)}
				>
					{/* The chip yields first: it shrinks and truncates so the icon controls stay on this row. */}
					<span className="min-w-0 flex-1">
						<span className="inline-block max-w-full truncate rounded-md bg-secondary px-2 py-1 align-middle font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-secondary-foreground">
							{preview?.label ?? typeLabel(object.type)}
						</span>
					</span>
					{canAct && statuses.length > 0 ? (
						// On a narrow card the status menu takes a row of its own instead of being cut off.
						<span
							className="order-last w-full @sm:order-none @sm:w-auto"
							onClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => e.stopPropagation()}
						>
							<StatusSelect
								current={object.status}
								options={statuses}
								onChange={moveTo}
								variant="chip"
							/>
						</span>
					) : null}
					{linkedPanel ? (
						<button
							type="button"
							aria-label="Show in panel"
							title="Show in panel"
							onClick={(e) => {
								e.stopPropagation()
								linkedPanel.openLinked({ kind: 'object', id: object.id })
							}}
							className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:text-foreground"
						>
							<PanelRight size={14} aria-hidden />
						</button>
					) : null}
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => e.stopPropagation()}
						className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<span className="sr-only @sm:not-sr-only">Open</span>
						<ArrowUpRight size={13} aria-hidden />
					</Link>
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? 'Contract preview' : 'Expand preview'}
						className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:text-foreground"
					>
						<ChevronDown
							size={14}
							aria-hidden
							className={cn('transition-transform', expanded && 'rotate-180')}
						/>
					</button>
				</div>
				<p
					className={cn(
						'px-3 text-sm font-semibold leading-snug text-foreground',
						expanded ? 'pt-3' : 'truncate pt-1',
						!expanded && properties.length === 0 && 'pb-3',
					)}
				>
					{object.title || 'Untitled'}
				</p>
				{/* What the object is about, from its metadata: "LinkedIn message · P1". */}
				{properties.length > 0 ? (
					<p
						className={cn(
							'truncate px-3 pt-0.5 text-xs text-muted-foreground',
							!expanded && 'pb-3',
						)}
					>
						{properties.join(' · ')}
					</p>
				) : null}
			</div>
			{expanded ? (
				<>
					{object.preview ? (
						<div className="px-3 pt-2">
							<ObjectPreviewMeta preview={object.preview} />
						</div>
					) : null}
					{/* Click the text to edit it where it stands; it saves when you click away.
					    A very long text scrolls inside the card instead of being cut off. */}
					<div className="max-h-50 overflow-y-auto px-3 pt-2 text-[13.5px]">
						<MarkdownContent
							content={shown}
							size="sm"
							editable={editable}
							editorLabel="Edit the text"
							onChange={async (value) => {
								await update.mutateAsync({ id: object.id, data: { content: value } })
							}}
						/>
					</div>
					{preview ? (
						<div className="flex items-center justify-end gap-2 px-3 pb-3 pt-1">
							{delivery === 'sent' ? (
								<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
									<Check size={13} aria-hidden />
									Sent
								</span>
							) : delivery === 'approved' ? (
								<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
									<Check size={13} aria-hidden />
									Approved, sending
								</span>
							) : (
								<Button
									type="button"
									size="sm"
									disabled={
										!canAct || approve.isPending || update.isPending || preview.missing.length > 0
									}
									onClick={approveDraft}
								>
									Approve and send
									<ArrowRight size={14} aria-hidden />
								</Button>
							)}
						</div>
					) : canAct && nextStatus ? (
						<div className="flex items-center justify-end px-3 pb-3 pt-1">
							<Button
								type="button"
								size="sm"
								disabled={update.isPending}
								onClick={() => moveTo(nextStatus)}
							>
								Move to {statusLabel(nextStatus)}
								<ArrowRight size={14} aria-hidden />
							</Button>
						</div>
					) : (
						<div className="pb-3" />
					)}
				</>
			) : null}
			{update.error ? (
				<p role="alert" className="px-3 pb-2 text-xs text-destructive">
					Could not save: {update.error.message}
				</p>
			) : null}
			{approve.error ? (
				<p role="alert" className="px-3 pb-2 text-xs text-destructive">
					Could not approve: {approve.error.message}
				</p>
			) : null}
		</div>
	)
}

/**
 * A link's card. A draft an integration can deliver gets its approval card; any other object gets
 * the reference card (what it is, where it stands, who has it), except in a list, where only a
 * draft is a card. A file is a card once it is known to be previewable. Otherwise `fallback` (the
 * original link or paragraph; nothing for a card that is only ever added) stays, so a link never
 * vanishes. A loop or a trigger is never a draft: it is a reference card on its own line, a chip
 * (the fallback) in a list, and nothing under a sentence.
 */
export function LinkedCardOrLink({
	workspaceId,
	target,
	conversationId,
	agentId,
	fallback = null,
	label,
	inList = false,
	after = false,
}: {
	workspaceId: string
	target: LinkedTarget
	conversationId?: string
	agentId?: string
	fallback?: ReactNode
	/** Text that led the link ("Draft:"); kept above the card once it replaces the link. */
	label?: string
	/** The link stood in a list item. */
	inList?: boolean
	/** The card goes under the sentence that links it: only a draft is drawn. */
	after?: boolean
}) {
	if (target.kind === 'agent') {
		if (after) return null
		if (inList) return <>{fallback}</>
		return (
			<AgentCardOrLink
				workspaceId={workspaceId}
				agentId={target.id}
				fallback={fallback}
				label={label}
			/>
		)
	}
	if (target.kind === 'loop' || target.kind === 'trigger') {
		if (after) return null
		if (inList) return <>{fallback}</>
		return withLabel(
			label,
			target.kind === 'loop' ? (
				<LoopReferenceCard workspaceId={workspaceId} loopId={target.id} />
			) : (
				<TriggerReferenceCard workspaceId={workspaceId} triggerId={target.id} />
			),
		)
	}
	return target.kind === 'object' ? (
		<ObjectCardOrLink
			workspaceId={workspaceId}
			objectId={target.id}
			conversationId={conversationId}
			agentId={agentId}
			fallback={fallback}
			label={label}
			inList={inList}
			after={after}
		/>
	) : (
		<FileCardOrLink
			workspaceId={workspaceId}
			fileId={target.id}
			fallback={fallback}
			label={inList ? label : undefined}
		/>
	)
}

/** An agent's card on its own line; an address that points at a person keeps the original link. */
function AgentCardOrLink({
	workspaceId,
	agentId,
	fallback,
	label,
}: {
	workspaceId: string
	agentId: string
	fallback: ReactNode
	label?: string
}) {
	const { data: actors } = useActors(workspaceId, { enabled: true })
	if (actors?.find((a) => a.id === agentId)?.type === 'human') return <>{fallback}</>
	return withLabel(label, <AgentReferenceCard workspaceId={workspaceId} agentId={agentId} />)
}

function withLabel(label: string | undefined, card: ReactNode): ReactNode {
	return label ? (
		<>
			<p>{label}</p>
			{card}
		</>
	) : (
		card
	)
}

/** `MarkdownContent`'s `linkedCards.renderCard`: it cannot import the cards, which render markdown. */
export function renderLinkedCard(
	target: LinkedTarget,
	fallback: ReactNode,
	context: {
		workspaceId: string
		conversationId?: string
		agentId?: string
		label?: string
		inList?: boolean
		after?: boolean
	},
): ReactNode {
	return <LinkedCardOrLink {...context} target={target} fallback={fallback} />
}

/** `MarkdownContent`'s `linkedCards.renderChip`: a link to an object, loop or trigger inside a sentence, a list, a quote or a table. A draft keeps its link; its card goes under the text. */
export function renderLinkedChip(
	target: LinkedTarget,
	fallback: ReactNode,
	context: { workspaceId: string },
): ReactNode {
	switch (target.kind) {
		case 'object':
			return (
				<ObjectReferenceChip
					workspaceId={context.workspaceId}
					objectId={target.id}
					fallback={fallback}
				/>
			)
		case 'loop':
			return (
				<LoopReferenceChip
					workspaceId={context.workspaceId}
					loopId={target.id}
					fallback={fallback}
				/>
			)
		case 'trigger':
			return (
				<TriggerReferenceChip
					workspaceId={context.workspaceId}
					triggerId={target.id}
					fallback={fallback}
				/>
			)
		case 'agent':
			return (
				<AgentReferenceChip
					workspaceId={context.workspaceId}
					agentId={target.id}
					fallback={fallback}
				/>
			)
		default:
			return fallback
	}
}

function ObjectCardOrLink({
	workspaceId,
	objectId,
	conversationId,
	agentId,
	fallback,
	label,
	inList,
	after,
}: {
	workspaceId: string
	objectId: string
	conversationId?: string
	agentId?: string
	fallback: ReactNode
	label?: string
	inList: boolean
	after: boolean
}) {
	const { data: object } = useObject(objectId)
	// A draft keeps today's card, and its lead-in only in a list.
	if (showsObjectCard(object, workspaceId)) {
		return withLabel(
			inList ? label : undefined,
			<LinkedObjectCard
				workspaceId={workspaceId}
				objectId={objectId}
				conversationId={conversationId}
				agentId={agentId}
			/>,
		)
	}
	// Under a sentence, and in a list, only a draft is a card; any other link there is a chip.
	if (after) return null
	if (inList) return <>{fallback}</>
	return withLabel(label, <ObjectReferenceCard workspaceId={workspaceId} objectId={objectId} />)
}

function FileCardOrLink({
	workspaceId,
	fileId,
	fallback,
	label,
}: {
	workspaceId: string
	fileId: string
	fallback: ReactNode
	label?: string
}) {
	// A list row is a few hundred bytes; the file itself may be megabytes and is fetched by the card.
	const { data } = useFiles(workspaceId, { ids: [fileId] })
	const file = data?.[0]
	if (!file || !isPreviewableFile(file.mimeType)) return <>{fallback}</>
	return withLabel(
		label,
		<FilePreview
			workspaceId={workspaceId}
			fileId={fileId}
			meta={{ name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes }}
		/>,
	)
}
