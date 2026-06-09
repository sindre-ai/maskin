import { EmptyState } from '@/components/shared/empty-state'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import {
	useConversationMessages,
	useConversations,
	useCreateConversation,
} from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { ChevronLeft, MessageSquarePlus, Plus, Send, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ConversationResponse } from '@/lib/api'
import { ConversationRow } from './conversation-row'

interface ConversationDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function ConversationDrawer({ open, onOpenChange }: ConversationDrawerProps) {
	const isMobile = useIsMobile()
	const { workspaceId } = useWorkspace()
	const [active, setActive] = useState<ConversationResponse | null>(null)
	const { data: conversations = [], isLoading } = useConversations(workspaceId)
	const createConversation = useCreateConversation(workspaceId)

	// Reset active view when drawer closes
	useEffect(() => {
		if (!open) setActive(null)
	}, [open])

	const recent = conversations.filter((c) => c.type === 'dm')
	const rooms = conversations.filter((c) => c.type === 'room')

	function handleCreateConversation() {
		const actor = getStoredActor()
		// The API always adds the caller; we pass the actor's own ID to satisfy min(1)
		const participantIds = actor ? [actor.id] : ['00000000-0000-0000-0000-000000000000']
		createConversation.mutate(
			{ type: 'dm', participant_actor_ids: participantIds },
			{
				onSuccess: (created) => setActive(created),
			},
		)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isMobile ? 'bottom' : 'right'}
				className={cn(
					'flex flex-col gap-0 p-0 [&>button]:hidden',
					isMobile
						? 'h-[90dvh] rounded-t-xl'
						: 'w-[400px] max-w-[400px] sm:max-w-[400px]',
				)}
			>
				{active ? (
					<ActiveConversationView
						workspaceId={workspaceId}
						conversation={active}
						onBack={() => setActive(null)}
						onClose={() => onOpenChange(false)}
					/>
				) : (
					<ConversationListView
						recent={recent}
						rooms={rooms}
						isLoading={isLoading}
						onSelect={setActive}
						onCreateConversation={handleCreateConversation}
						isCreating={createConversation.isPending}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</SheetContent>
		</Sheet>
	)
}

interface ConversationListViewProps {
	recent: ConversationResponse[]
	rooms: ConversationResponse[]
	isLoading: boolean
	onSelect: (c: ConversationResponse) => void
	onCreateConversation: () => void
	isCreating: boolean
	onClose: () => void
}

function ConversationListView({
	recent,
	rooms,
	isLoading,
	onSelect,
	onCreateConversation,
	isCreating,
	onClose,
}: ConversationListViewProps) {
	const isEmpty = !isLoading && recent.length === 0 && rooms.length === 0

	return (
		<>
			<div className="flex h-[52px] shrink-0 items-center justify-between border-b px-3">
				<span className="text-sm font-medium">Conversations</span>
				<div className="flex items-center gap-0.5">
					<IconButton
						onClick={onCreateConversation}
						aria-label="New conversation"
						disabled={isCreating}
					>
						<Plus size={14} />
					</IconButton>
					<IconButton onClick={onClose} aria-label="Close">
						<X size={11} />
					</IconButton>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{isEmpty ? (
					<div className="flex h-full items-center justify-center">
						<EmptyState
							title="No conversations yet"
							description="Start your first conversation"
						/>
					</div>
				) : (
					<div className="px-1.5 py-1.5">
						{recent.length > 0 && (
							<>
								<SectionLabel>Recent</SectionLabel>
								{recent.map((c) => (
									<ConversationRow
										key={c.id}
										type="dm"
										title={c.title}
										preview={c.lastMessagePreview}
										timestamp={c.lastActivityAt ?? c.createdAt}
										unread={false}
										onClick={() => onSelect(c)}
									/>
								))}
							</>
						)}
						{rooms.length > 0 && (
							<>
								<SectionLabel>Rooms</SectionLabel>
								{rooms.map((c) => (
									<ConversationRow
										key={c.id}
										type="room"
										title={c.title}
										preview={c.lastMessagePreview}
										timestamp={c.lastActivityAt ?? c.createdAt}
										unread={false}
										onClick={() => onSelect(c)}
									/>
								))}
							</>
						)}
					</div>
				)}
			</div>

			<div className="shrink-0 border-t p-2">
				<button
					type="button"
					onClick={onCreateConversation}
					disabled={isCreating}
					className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
				>
					<Plus size={13} />
					New conversation
				</button>
			</div>
		</>
	)
}

interface ActiveConversationViewProps {
	workspaceId: string
	conversation: ConversationResponse
	onBack: () => void
	onClose: () => void
}

function ActiveConversationView({
	workspaceId,
	conversation,
	onBack,
	onClose,
}: ActiveConversationViewProps) {
	const { data, isLoading } = useConversationMessages(workspaceId, conversation.id)
	const composerRef = useRef<HTMLTextAreaElement>(null)

	// Messages are returned newest-first; reverse for display
	const messages = data ? [...data.data].reverse() : []

	return (
		<>
			<div className="flex h-[52px] shrink-0 items-center gap-1 border-b px-2">
				<IconButton onClick={onBack} aria-label="Back to conversations">
					<ChevronLeft size={15} />
				</IconButton>
				<span className="min-w-0 flex-1 truncate text-center text-sm font-medium">
					{conversation.title ?? 'Untitled'}
				</span>
				<IconButton onClick={onClose} aria-label="Close">
					<X size={11} />
				</IconButton>
			</div>

			{data && data.total > 0 && (
				<div className="mx-3 mt-2.5 shrink-0 rounded-md border-l-2 bg-muted/50 px-3 py-2">
					<p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
						Resumed · {data.total} message{data.total !== 1 ? 's' : ''}
					</p>
					{conversation.lastMessagePreview && (
						<p className="truncate text-xs text-muted-foreground">
							…{conversation.lastMessagePreview}
						</p>
					)}
				</div>
			)}

			<div className="flex-1 overflow-y-auto px-3 py-3.5">
				{isLoading && <LoadingSkeleton />}
				{messages.length === 0 && !isLoading && (
					<div className="flex h-full items-center justify-center">
						<EmptyState
							title="No messages yet"
							description="Start the conversation below"
						/>
					</div>
				)}
				<div className="flex flex-col gap-3.5">
					{messages.map((msg) => (
						<div key={msg.id} className="flex items-start gap-2">
							<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px]">
								<MessageSquarePlus size={12} className="text-muted-foreground" />
							</div>
							<div>
								<p className="rounded-lg bg-muted px-2.5 py-2 text-sm leading-relaxed">
									{msg.content}
								</p>
								<p className="mt-0.5 text-[11px] text-muted-foreground">
									{new Date(msg.createdAt).toLocaleTimeString([], {
										hour: '2-digit',
										minute: '2-digit',
									})}
								</p>
							</div>
						</div>
					))}
				</div>
			</div>

			<div className="flex shrink-0 items-end gap-2 border-t px-3 py-2.5">
				<textarea
					ref={composerRef}
					rows={1}
					placeholder="Continue conversation…"
					className="flex-1 resize-none rounded-lg border bg-muted/50 px-2.5 py-2 text-sm leading-snug placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
						}
					}}
				/>
				<button
					type="button"
					disabled
					aria-label="Send"
					className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-foreground text-background opacity-40"
				>
					<Send size={13} />
				</button>
			</div>
		</>
	)
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
			{children}
		</p>
	)
}

function IconButton({
	children,
	onClick,
	'aria-label': ariaLabel,
	disabled,
}: {
	children: ReactNode
	onClick?: () => void
	'aria-label': string
	disabled?: boolean
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={ariaLabel}
			className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
		>
			{children}
		</button>
	)
}

function LoadingSkeleton() {
	return (
		<div className="flex flex-col gap-3.5">
			{[...Array(3)].map((_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: loading skeleton has no better key
				<div key={i} className="flex items-start gap-2">
					<div className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-muted" />
					<div className="h-9 flex-1 animate-pulse rounded-lg bg-muted" />
				</div>
			))}
		</div>
	)
}
