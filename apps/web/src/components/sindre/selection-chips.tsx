import { cn } from '@/lib/cn'
import type { SindreSelection } from '@/lib/sindre-selection'
import { Bell, Bot, Box, FileText, X } from 'lucide-react'
import type { ReactNode } from 'react'

export interface SelectionChipsProps {
	selection: SindreSelection
	onRemoveAgent: () => void
	onRemoveObject: (id: string) => void
	onRemoveNotification: (id: string) => void
	onRemoveFile: (name: string) => void
	className?: string
}

/**
 * Renders the active composer selection as a row of chips below the Sindre
 * composer. Each chip carries a remove X that dispatches back through the
 * parent's handlers (typically wired to `sindreSelectionReducer`). Returns
 * null when the selection is empty so an empty row never adds vertical
 * padding.
 */
export function SelectionChips({
	selection,
	onRemoveAgent,
	onRemoveObject,
	onRemoveNotification,
	onRemoveFile,
	className,
}: SelectionChipsProps) {
	const hasAgent = selection.agent !== null
	const hasObjects = selection.objects.length > 0
	const hasNotifications = selection.notifications.length > 0
	const files = selection.files ?? []
	const hasFiles = files.length > 0
	if (!hasAgent && !hasObjects && !hasNotifications && !hasFiles) return null

	const agentLabel = selection.agent?.name?.trim() || selection.agent?.id || 'Unnamed agent'

	return (
		<ul
			className={cn('flex list-none flex-wrap items-center gap-1 p-0', className)}
			aria-label="Selected context"
		>
			{selection.agent !== null && (
				<Chip
					icon={<Bot size={12} aria-hidden />}
					label={agentLabel}
					onRemove={onRemoveAgent}
					removeLabel={`Remove ${agentLabel}`}
				/>
			)}
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
			{files.map((file) => (
				<Chip
					key={file.name}
					icon={<FileText size={12} aria-hidden />}
					label={file.name}
					onRemove={() => onRemoveFile(file.name)}
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
}

function Chip({ icon, label, onRemove, removeLabel }: ChipProps) {
	return (
		<li className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-bg-surface px-2 py-0.5 text-xs text-foreground">
			<span className="text-muted-foreground">{icon}</span>
			<span className="max-w-[12rem] truncate">{label}</span>
			<button
				type="button"
				onClick={onRemove}
				aria-label={removeLabel}
				className="-mr-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<X size={10} aria-hidden />
			</button>
		</li>
	)
}
