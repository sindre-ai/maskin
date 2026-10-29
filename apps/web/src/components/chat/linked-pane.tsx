import { LinkedObjectCard } from '@/components/chat/linked-object-preview'
import { ObjectReferenceCard } from '@/components/chat/linked-object-reference'
import { LinkedPanelContext } from '@/components/chat/linked-panel-context'
import { ProducedFilesGroup, ProducedObjectsGroup } from '@/components/objects/produced-pane'
import { EmptyState } from '@/components/shared/empty-state'
import { FilePreview } from '@/components/shared/file-preview'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { TypeBadge } from '@/components/shared/type-badge'
import { Button } from '@/components/ui/button'
import type { LinkedItem } from '@/hooks/use-conversation-linked'
import type { ProducedFileItem, ProducedObjectItem } from '@/hooks/use-conversation-produced'
import { useObject } from '@/hooks/use-objects'
import { cn } from '@/lib/cn'
import { showsObjectCard } from '@/lib/linked-objects'
import { useEffect, useRef, useState } from 'react'

export interface LinkedFocus {
	kind: 'object' | 'file'
	id: string
	/** Changes on every request so asking for the same item twice highlights it twice. */
	nonce: number
}

interface LinkedPaneProps {
	workspaceId: string
	conversationId: string
	items: LinkedItem[]
	producedObjects: ProducedObjectItem[]
	producedFiles: ProducedFileItem[]
	producedLoading: boolean
	focus: LinkedFocus | null
	/** Called once a focus request has been acted on, so the route forgets it. */
	onFocusConsumed: () => void
	onJumpToMessage: (messageId: number) => void
	className?: string
}

const HIGHLIGHT_MS = 2000

/** The item's type, so a mixed list says what each row is. Objects read it from the (cached) object. */
function ItemTypeLabel({ item }: { item: LinkedItem }) {
	const { data: object } = useObject(item.id, { enabled: item.kind === 'object' })
	const type = item.kind === 'file' ? 'file' : object?.type
	return type ? <TypeBadge type={type} className="shrink-0" /> : null
}

function ItemHeader({ item, onJump }: { item: LinkedItem; onJump: (messageId: number) => void }) {
	return (
		<div className="mb-1 flex items-center justify-between gap-2">
			<div className="flex min-w-0 items-center gap-2">
				<ItemTypeLabel item={item} />
				<p className="min-w-0 truncate text-xs text-muted-foreground">
					from {item.actorName} · <RelativeTime date={item.createdAt} />
				</p>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="shrink-0"
				onClick={() => onJump(item.messageId)}
			>
				Jump to message
			</Button>
		</div>
	)
}

function LinkedObjectBody({
	item,
	workspaceId,
	conversationId,
	focused,
}: {
	item: LinkedItem
	workspaceId: string
	conversationId: string
	focused: boolean
}) {
	const { data: object, isLoading } = useObject(item.id)
	if (isLoading) return <Skeleton className="h-14 w-full rounded-md" />
	if (!object || object.workspaceId !== workspaceId) return null
	// The same gate as the transcript: a draft is the approval card, any other object the reference card.
	if (showsObjectCard(object, workspaceId)) {
		return (
			<LinkedObjectCard
				workspaceId={workspaceId}
				objectId={item.id}
				conversationId={conversationId}
				agentId={item.actorType === 'agent' ? item.actorId : undefined}
				defaultExpanded={focused}
				className="mt-1 max-w-none"
			/>
		)
	}
	return <ObjectReferenceCard workspaceId={workspaceId} objectId={item.id} />
}

function LinkedItemRow({
	item,
	workspaceId,
	conversationId,
	focus,
	onFocusConsumed,
	onJump,
}: {
	item: LinkedItem
	workspaceId: string
	conversationId: string
	focus: LinkedFocus | null
	onFocusConsumed: () => void
	onJump: (messageId: number) => void
}) {
	const ref = useRef<HTMLLIElement>(null)
	const [highlighted, setHighlighted] = useState(false)
	// A focus request opens this row's card once; the key remounts the card so `defaultExpanded`
	// applies, and the route forgets the request so a later mount of the tab does not repeat it.
	const [expand, setExpand] = useState<{ key: number; open: boolean }>({ key: 0, open: false })
	const nonce = focus?.kind === item.kind && focus.id === item.id ? focus.nonce : null
	// biome-ignore lint/correctness/useExhaustiveDependencies: onFocusConsumed is a fresh closure each render; only a new request should run this
	useEffect(() => {
		if (nonce === null) return
		setExpand((prev) => ({ key: prev.key + 1, open: true }))
		setHighlighted(true)
		ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
		onFocusConsumed()
	}, [nonce])
	useEffect(() => {
		if (!highlighted) return
		const timer = window.setTimeout(() => setHighlighted(false), HIGHLIGHT_MS)
		return () => window.clearTimeout(timer)
	}, [highlighted])

	return (
		<li
			ref={ref}
			data-linked-id={item.id}
			data-highlighted={highlighted ? 'true' : undefined}
			className="min-w-0 rounded-lg p-1 transition-shadow data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring"
		>
			<ItemHeader item={item} onJump={onJump} />
			{item.kind === 'file' ? (
				<FilePreview
					key={expand.key}
					workspaceId={workspaceId}
					fileId={item.id}
					defaultExpanded={expand.open}
					className="mt-1 max-w-none"
				/>
			) : (
				<LinkedObjectBody
					key={expand.key}
					item={item}
					workspaceId={workspaceId}
					conversationId={conversationId}
					focused={expand.open}
				/>
			)}
		</li>
	)
}

/**
 * The Items tab of the chat's Overview drawer: every object and file the conversation's
 * messages link to, newest first, where drafts can be approved and files read, followed by
 * what the chat's sessions produced that no message links to. Each item is drawn as the transcript
 * draws it: a draft as its approval card, any other object as the reference card. The transcript
 * keeps its cards; this is the place to work.
 */
export function LinkedPane({
	workspaceId,
	conversationId,
	items,
	producedObjects,
	producedFiles,
	producedLoading,
	focus,
	onFocusConsumed,
	onJumpToMessage,
	className,
}: LinkedPaneProps) {
	// An item that is both linked and produced shows once, as its linked card.
	const linkedKeys = new Set(items.map((i) => `${i.kind}:${i.id}`))
	const unlinkedObjects = producedObjects.filter((o) => !linkedKeys.has(`object:${o.entityId}`))
	const unlinkedFiles = producedFiles.filter((f) => !linkedKeys.has(`file:${f.fileId}`))
	const isEmpty = items.length === 0 && unlinkedObjects.length === 0 && unlinkedFiles.length === 0

	return (
		<div className={cn('flex min-h-0 flex-col gap-4 overflow-y-auto px-3 py-3', className)}>
			{isEmpty ? (
				producedLoading ? (
					<Skeleton className="h-14 w-full rounded-md" />
				) : (
					<EmptyState
						title="Nothing here yet"
						description="Objects and files that messages link to, or that agents produce in this chat, will appear here."
					/>
				)
			) : (
				<>
					{items.length > 0 ? (
						// The cards here are already in the panel, so they must not offer "Show in panel".
						<LinkedPanelContext.Provider value={null}>
							<ul className="flex flex-col gap-3" aria-label="Linked items">
								{items.map((item) => (
									<LinkedItemRow
										key={`${item.kind}:${item.id}`}
										item={item}
										workspaceId={workspaceId}
										conversationId={conversationId}
										focus={focus}
										onFocusConsumed={onFocusConsumed}
										onJump={onJumpToMessage}
									/>
								))}
							</ul>
						</LinkedPanelContext.Provider>
					) : null}
					<ProducedObjectsGroup workspaceId={workspaceId} items={unlinkedObjects} />
					<ProducedFilesGroup workspaceId={workspaceId} items={unlinkedFiles} />
				</>
			)}
		</div>
	)
}
