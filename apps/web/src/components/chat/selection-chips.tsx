import type { ChatSelection } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { AtSign, Bell, Box, FileText, X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface SelectionChipsProps {
	selection: ChatSelection
	onRemoveAgent: (id: string) => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
	onRemoveFile: (fileId: string) => void
	/**
	 * The current actor's id. Mention chips for this id use the warning-subtle
	 * palette so the sender can see they've pinged themselves (mockup: the
	 * composer flags self-mentions rather than silently sending them).
	 */
	selfActorId?: string | null
	className?: string
}

/**
 * Renders the active composer selection as a row of chips below the chat
 * composer. Each chip carries a remove X that dispatches back through the
 * parent's handlers (typically wired to `chatSelectionReducer`). Returns
 * null when the selection is empty so an empty row never adds vertical
 * padding.
 */
export function SelectionChips({
	selection,
	onRemoveAgent,
	onRemoveObject,
	onRemoveNotification,
	onRemoveFile,
	selfActorId,
	className,
}: SelectionChipsProps) {
	const hasAgents = selection.agents.length > 0
	const hasObjects = selection.objects.length > 0
	const hasNotifications = selection.notifications.length > 0
	const hasFiles = selection.files.length > 0
	if (!hasAgents && !hasObjects && !hasNotifications && !hasFiles) return null

	return (
		<ul
			className={cn('flex list-none flex-wrap items-center gap-1 p-0', className)}
			aria-label="Selected context"
		>
			{selection.agents.map((agentId) => {
				const label = selection.agentNames[agentId]?.trim() || agentId
				const isSelf = selfActorId !== undefined && selfActorId === agentId
				return (
					<Chip
						key={agentId}
						icon={<AtSign size={12} aria-hidden />}
						label={label}
						onRemove={() => onRemoveAgent(agentId)}
						removeLabel={`Remove mention ${label}`}
						variant={isSelf ? 'warning' : 'default'}
					/>
				)
			})}
			{selection.objects.map((object) => {
				const label = object.title?.trim() || object.id
				return (
					<Chip
						key={object.id}
						icon={<Box size={12} aria-hidden />}
						label={label}
						onRemove={() => onRemoveObject(object.id)}
						removeLabel={`Remove ${label}`}
					/>
				)
			})}
			{selection.notifications.map((notification) => {
				const label = notification.title?.trim() || notification.id
				return (
					<Chip
						key={notification.id}
						icon={<Bell size={12} aria-hidden />}
						label={label}
						onRemove={() => onRemoveNotification(notification.id)}
						removeLabel={`Remove ${label}`}
					/>
				)
			})}
			{selection.files.map((file) => (
				<Chip
					key={file.fileId}
					icon={<FileText size={12} aria-hidden />}
					label={file.name}
					onRemove={() => onRemoveFile(file.fileId)}
					removeLabel={`Remove ${file.name}`}
				/>
			))}
		</ul>
	)
}

interface ChipProps {
	icon: ReactNode
	label: string
	onRemove: () => void
	removeLabel: string
	variant?: 'default' | 'warning'
}

function Chip({ icon, label, onRemove, removeLabel, variant = 'default' }: ChipProps) {
	return (
		<li
			className={cn(
				'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs',
				variant === 'warning'
					? 'bg-warning/10 text-warning'
					: 'border border-border bg-card text-foreground',
			)}
		>
			<span className={variant === 'warning' ? '' : 'text-muted-foreground'}>{icon}</span>
			<span className="max-w-[12rem] truncate">{label}</span>
			<button
				type="button"
				onClick={onRemove}
				aria-label={removeLabel}
				className={cn(
					'-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
					variant === 'warning'
						? 'text-warning hover:bg-warning/10'
						: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
				)}
			>
				<X size={10} aria-hidden />
			</button>
		</li>
	)
}
