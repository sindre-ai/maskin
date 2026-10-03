import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { Lock } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

interface SecretDetectedCardProps {
	/** high blocks the send (indigo); low only asks (amber). */
	variant: 'high' | 'low'
	/** One-line diagnostic, for example "Looks like a Cloudflare API token". */
	diagnostic: string
	/** First and last characters only, never the whole value. */
	mask: string
	/** Display name for the service, high variant only. */
	service?: string
	/** The agent the message was addressed to. */
	agentName: string
	/** False when this composer has no session to vault into. */
	canVault: boolean
	busy?: boolean
	error?: string | null
	onVault?: () => void
	onSendAsIs?: () => void
	onEdit?: () => void
	onCancel: () => void
}

/**
 * The chat card shown when the composer guard stops a send. Visually distinct from a
 * normal message on purpose: it is the security-load-bearing moment of the in-chat
 * vault flow. No CTA fires on Enter, only on an explicit press, and Esc cancels.
 */
export function SecretDetectedCard({
	variant,
	diagnostic,
	mask,
	service,
	agentName,
	canVault,
	busy = false,
	error = null,
	onVault,
	onSendAsIs,
	onEdit,
	onCancel,
}: SecretDetectedCardProps) {
	const headingId = useId()
	const describedById = useId()
	const primaryRef = useRef<HTMLButtonElement>(null)
	const high = variant === 'high'

	useEffect(() => {
		primaryRef.current?.focus()
	}, [])

	return (
		// biome-ignore lint/a11y/useSemanticElements: role=dialog on a non-modal inline card is deliberate, see the SPEC accessibility notes
		<div
			role="dialog"
			aria-labelledby={headingId}
			aria-describedby={describedById}
			onKeyDown={(e) => {
				if (e.key === 'Escape' && !busy) {
					e.preventDefault()
					onCancel()
				}
			}}
			className={cn(
				'flex flex-col gap-3 rounded-xl border p-4',
				high ? 'border-brand/40 bg-brand-subtle' : 'border-warning/40 bg-warning/10',
			)}
		>
			<div className="flex items-start gap-2">
				{high ? <Lock size={16} className="mt-0.5 shrink-0 text-brand" aria-hidden /> : null}
				<h3 id={headingId} className="text-sm font-semibold">
					{high
						? 'Maskin detected a secret in your message.'
						: 'Maybe not a secret — asking to be sure.'}
				</h3>
			</div>

			<div id={describedById} className="flex flex-col gap-2 text-sm">
				{high ? (
					<>
						<p>
							{diagnostic} ({mask}). Your message has been redacted from the transcript and is safe
							to vault. Nothing has been sent to {agentName} yet.
						</p>
						{canVault ? (
							<div className="rounded-md border border-border bg-background px-3 py-2 text-xs">
								<p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
									Preview of what will be vaulted
								</p>
								<p>Service — {service}</p>
								<p>Type — API key</p>
								<p>Value — {mask} (only last 4 shown, ever)</p>
							</div>
						) : null}
					</>
				) : (
					<p>
						{mask} {diagnostic}. I paused the message to double-check. If this isn't a secret, tap
						"Send as-is" and I'll never flag this shape again in this session.
					</p>
				)}
				{high && !canVault ? (
					<p className="text-xs text-muted-foreground">
						This chat can't vault a key yet. Cancel, then add it from a chat with a live session.
					</p>
				) : null}
			</div>

			{error ? (
				<p
					role="alert"
					className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
				>
					{error}
				</p>
			) : null}

			<div className="flex flex-col gap-2 sm:flex-row">
				{high ? (
					canVault ? (
						<Button ref={primaryRef} type="button" disabled={busy} onClick={onVault}>
							{busy ? <Spinner /> : null}
							Vault + assign scope →
						</Button>
					) : null
				) : (
					<Button ref={primaryRef} type="button" disabled={busy} onClick={onSendAsIs}>
						{busy ? <Spinner /> : null}
						Send as-is
					</Button>
				)}
				{!high && onEdit ? (
					<Button type="button" variant="outline" disabled={busy} onClick={onEdit}>
						Edit message
					</Button>
				) : null}
				{high ? (
					<Button
						ref={canVault ? undefined : primaryRef}
						type="button"
						variant={canVault ? 'ghost' : 'outline'}
						disabled={busy}
						onClick={onCancel}
					>
						Cancel message
					</Button>
				) : null}
			</div>

			{high ? (
				<p className="text-xs text-muted-foreground">
					You can rename the credential and pick which agents can use it on the next step.
					Fail-closed by default — zero agents until you say so.
				</p>
			) : null}
			<p className="text-xs text-muted-foreground">
				<span aria-hidden>{high ? '🔒 ' : '🟡 '}</span>
				{high
					? 'Sending blocked while a secret decision is pending.'
					: 'Low-confidence match — action needed above.'}
			</p>
		</div>
	)
}

interface VaultedCardProps {
	credentialName: string
	agentCount: number
	undoAvailable: boolean
	undoing: boolean
	undone: boolean
	error: string | null
	onUndo: () => void
}

/** 7c-2 (vaulted) and 7c-4 (undone). Relaunch states belong to PR #4. */
export function VaultedCard({
	credentialName,
	agentCount,
	undoAvailable,
	undoing,
	undone,
	error,
	onUndo,
}: VaultedCardProps) {
	if (undone) {
		return (
			<output className="flex flex-col gap-1 rounded-xl border border-border bg-muted p-4 text-sm">
				<h3 className="font-semibold">Undone. {credentialName} is removed.</h3>
			</output>
		)
	}
	return (
		<output className="flex flex-col gap-2 rounded-xl border border-success/40 bg-success/10 p-4 text-sm">
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-semibold">
					Vaulted. {credentialName} is now available to {agentCount}{' '}
					{agentCount === 1 ? 'agent' : 'agents'}.
				</h3>
				<span className="rounded-full border border-success/40 px-2 py-0.5 text-xs font-medium">
					Live
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				Encrypted. Redacted from this transcript. Every read shows up in the audit log.
			</p>
			{error ? (
				<p
					role="alert"
					className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
				>
					{error}
				</p>
			) : null}
			{undoAvailable ? (
				<div className="flex flex-col gap-1">
					<div>
						<Button type="button" variant="outline" size="sm" disabled={undoing} onClick={onUndo}>
							{undoing ? 'Undoing…' : 'Undo'}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">Undo within 5 min.</p>
				</div>
			) : null}
		</output>
	)
}
