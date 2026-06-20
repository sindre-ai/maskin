import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { Check, Copy, Pencil, RefreshCw } from 'lucide-react'
import { useCallback, useState } from 'react'

interface MessageActionsProps {
	/** Raw text to copy to the clipboard. */
	copyText: string
	onRegenerate?: () => void
	onEdit?: () => void
	className?: string
}

/**
 * Hover toolbar shown on each message row (Claude/v0 style): copy, and for
 * agent messages regenerate, for user messages edit & resend. Rendered with
 * `opacity-0 group-hover:opacity-100` by the parent row so it only appears on
 * hover / focus-within.
 */
export function MessageActions({ copyText, onRegenerate, onEdit, className }: MessageActionsProps) {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(copyText)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch (err) {
			console.error('[sindre-chat] copy failed', err)
		}
	}, [copyText])

	return (
		<div
			className={cn(
				'flex items-center gap-0.5 rounded-md border border-border bg-bg-surface p-0.5 shadow-2xs',
				className,
			)}
		>
			<ActionButton label={copied ? 'Copied' : 'Copy'} onClick={() => void handleCopy()}>
				{copied ? <Check size={13} className="text-primary" /> : <Copy size={13} />}
			</ActionButton>
			{onEdit ? (
				<ActionButton label="Edit & resend" onClick={onEdit}>
					<Pencil size={13} />
				</ActionButton>
			) : null}
			{onRegenerate ? (
				<ActionButton label="Regenerate" onClick={onRegenerate}>
					<RefreshCw size={13} />
				</ActionButton>
			) : null}
		</div>
	)
}

function ActionButton({
	label,
	onClick,
	children,
}: {
	label: string
	onClick: () => void
	children: React.ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-6 w-6 text-text-secondary"
					onClick={onClick}
					aria-label={label}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}
