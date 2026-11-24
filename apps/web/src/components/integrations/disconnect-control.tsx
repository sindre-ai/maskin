import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { useCanWrite } from '@/hooks/use-can-write'
import { cn } from '@/lib/cn'
import { PILL_BUTTON } from '@/lib/pill-button'
import { useEffect, useRef, useState } from 'react'

/**
 * Disconnect on a connected tool's row. Pressing it swaps the button for the question on the
 * row itself ("Disconnect Slack? Agents lose access." with Disconnect and Keep), so nothing
 * opens on top of the page. Keep gets focus when the question appears, and the Disconnect
 * button gets it back when the question goes away.
 */
export function DisconnectControl({
	name,
	billingNote = false,
	pending,
	onDisconnect,
	className,
}: {
	/** What the question names: the tool, or the account or installation inside a multi-install tool. */
	name: string
	/** The card states a per-identity charge; repeat that disconnecting stops it. */
	billingNote?: boolean
	pending: boolean
	/** Runs the disconnect; `onSettled` fires once it has finished, either way. */
	onDisconnect: (onSettled: () => void) => void
	/** Extra classes for the Disconnect button. */
	className?: string
}) {
	const canWrite = useCanWrite()
	const [confirming, setConfirming] = useState(false)
	const buttonRef = useRef<HTMLButtonElement>(null)
	const keepRef = useRef<HTMLButtonElement>(null)
	const returnFocus = useRef(false)

	useEffect(() => {
		if (confirming) keepRef.current?.focus()
		else if (returnFocus.current) buttonRef.current?.focus()
		returnFocus.current = false
	}, [confirming])

	const keep = () => {
		returnFocus.current = true
		setConfirming(false)
	}

	if (!confirming) {
		return (
			<ViewerTooltip>
				<Button
					ref={buttonRef}
					variant="ghost"
					size="sm"
					className={cn(PILL_BUTTON, 'text-error hover:text-error', className)}
					onClick={() => setConfirming(true)}
					disabled={pending || !canWrite}
				>
					Disconnect
				</Button>
			</ViewerTooltip>
		)
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: <fieldset> is meant for form controls; a Keep or Disconnect pair is more idiomatic as role="group"
		<div
			role="group"
			aria-label={`Disconnect ${name}`}
			className="flex flex-wrap items-center gap-2"
			onKeyDown={(e) => {
				if (e.key !== 'Escape') return
				e.stopPropagation()
				keep()
			}}
		>
			<p className="text-[13px] text-foreground">Disconnect {name}? Agents lose access.</p>
			{billingNote && (
				<p className="basis-full text-xs text-muted-foreground">
					Disconnecting stops the $49/month charge at the end of the current period.
				</p>
			)}
			<Button ref={keepRef} variant="outline" size="sm" className={PILL_BUTTON} onClick={keep}>
				Keep
			</Button>
			<Button
				variant="destructive"
				size="sm"
				className={PILL_BUTTON}
				disabled={pending}
				onClick={() => onDisconnect(() => setConfirming(false))}
			>
				Disconnect
			</Button>
		</div>
	)
}
