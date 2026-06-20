import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { ConversationComposer } from '@/components/sindre/conversation-composer'
import { ConversationTranscript } from '@/components/sindre/conversation-transcript'
import { Button } from '@/components/ui/button'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import type { ChatMessage } from '@/lib/chat-store'
import { cn } from '@/lib/cn'
import type { SindreSelection, SindreSelectionAction } from '@/lib/sindre-selection'
import type { UserAttachmentView } from '@/lib/sindre-stream'
import { X } from 'lucide-react'

interface ThreadPanelProps {
	workspaceId: string
	parent: ChatMessage
	replies: ChatMessage[]
	currentUserId: string
	agents: ConversationParticipant[]
	draft: string
	onDraftChange: (next: string) => void
	onSend: () => void
	onStop: () => void
	isBusy: boolean
	selection: SindreSelection
	onDispatchSelection: (action: SindreSelectionAction) => void
	onRegenerate: (messageId: string) => void
	onEditUserMessage: (text: string) => void
	onClose: () => void
	className?: string
}

/**
 * Slack-style side thread. Mounts as an absolute overlay over the conversation
 * view (the Sindre panel is itself a sidebar, so the thread takes its full
 * width on every viewport: matches the prototype's "right-anchored 380px
 * desktop / full-screen Sheet ≤640px" because the host sidebar is already
 * full-screen on mobile and 380px-typical on desktop). Thread replies don't
 * echo back into the main transcript — that lives elsewhere.
 */
export function ThreadPanel({
	workspaceId,
	parent,
	replies,
	currentUserId,
	agents,
	draft,
	onDraftChange,
	onSend,
	onStop,
	isBusy,
	selection,
	onDispatchSelection,
	onRegenerate,
	onEditUserMessage,
	onClose,
	className,
}: ThreadPanelProps) {
	return (
		<aside
			aria-label="Thread"
			className={cn(
				'absolute inset-0 z-30 flex h-full min-h-0 flex-col gap-2 border-l border-border bg-background',
				className,
			)}
		>
			<ThreadHeader replyCount={replies.length} onClose={onClose} />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<ThreadParentRow message={parent} currentUserId={currentUserId} />
				<div className="border-border border-b" />
				<ConversationTranscript
					messages={replies}
					currentUserId={currentUserId}
					onRegenerate={onRegenerate}
					onEditUserMessage={onEditUserMessage}
					hideReplies={false}
					className="min-h-[160px]"
				/>
			</div>
			<ConversationComposer
				workspaceId={workspaceId}
				agents={agents}
				value={draft}
				onValueChange={onDraftChange}
				onSend={onSend}
				onStop={onStop}
				isBusy={isBusy}
				selection={selection}
				onDispatchSelection={onDispatchSelection}
				placeholder="Reply in thread… use @ to mention an agent"
			/>
		</aside>
	)
}

function ThreadHeader({ replyCount, onClose }: { replyCount: number; onClose: () => void }) {
	return (
		<div className="flex shrink-0 items-center justify-between gap-2 border-border border-b px-3 py-2">
			<div className="flex items-baseline gap-2">
				<span className="font-medium text-foreground text-sm">Thread</span>
				<span className="text-text-muted text-xs">
					{replyCount === 0
						? 'No replies yet'
						: `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
				</span>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="h-7 w-7"
				onClick={onClose}
				aria-label="Close thread"
			>
				<X size={15} />
			</Button>
		</div>
	)
}

function ThreadParentRow({
	message,
	currentUserId,
}: {
	message: ChatMessage
	currentUserId: string
}) {
	const isSelf = message.role === 'user' && message.senderId === currentUserId
	return (
		<div className="flex gap-2.5 px-3 py-2">
			<div className="w-6 shrink-0 pt-0.5">
				<ActorAvatar
					name={message.senderName}
					type={message.role === 'agent' ? 'agent' : 'user'}
					size="md"
				/>
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="font-medium text-foreground text-sm">
						{isSelf ? 'You' : message.senderName}
					</span>
					<RelativeTime
						date={new Date(message.createdAt).toISOString()}
						className="text-text-muted text-xs"
					/>
				</div>
				<div className="mt-0.5 text-sm">
					{message.role === 'user' ? (
						<UserParentBody text={message.text} attachments={message.attachments} />
					) : (
						<AgentParentBody message={message} />
					)}
				</div>
			</div>
		</div>
	)
}

function UserParentBody({
	text,
	attachments,
}: {
	text: string
	attachments?: UserAttachmentView[]
}) {
	return (
		<div className="flex flex-col gap-1">
			{attachments && attachments.length > 0 ? (
				<p className="text-text-muted text-xs">
					{attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
				</p>
			) : null}
			<span className="whitespace-pre-wrap text-foreground">{text}</span>
		</div>
	)
}

function AgentParentBody({ message }: { message: ChatMessage }) {
	if (message.role !== 'agent') return null
	// Show the plain text the agent ended up saying; rich blocks live in the
	// main transcript and would be visually noisy in the thread header.
	const text = message.events
		.filter(
			(e): e is Extract<(typeof message.events)[number], { kind: 'text' }> => e.kind === 'text',
		)
		.map((e) => e.text)
		.join('')
		.trim()
	return <span className="whitespace-pre-wrap text-foreground">{text}</span>
}
