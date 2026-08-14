import { Button } from '@/components/ui/button'
import { useUpdateObject } from '@/hooks/use-objects'
import { trackQualifiedBetVisible } from '@/lib/analytics'
import type { ObjectResponse } from '@/lib/api'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

interface SignupDraftCardProps {
	workspaceId: string
	bet: ObjectResponse
	// Workspace `createdAt` — signup timestamp. Passed in so the emit doesn't
	// depend on a second query and stays deterministic under test.
	workspaceCreatedAt: string | null
}

// Minutes since the workspace was created. Signup provisions the workspace
// in the same request that inserts the actor, so `workspace.createdAt` is the
// signup timestamp. Returns 0 if the timestamp is missing or negative (clock
// skew) so the property is always a valid non-negative integer.
export function computeMinutesSinceSignup(
	workspaceCreatedAt: string | null,
	now: number = Date.now(),
): number {
	if (!workspaceCreatedAt) return 0
	const created = new Date(workspaceCreatedAt).getTime()
	if (!Number.isFinite(created)) return 0
	const diffMs = now - created
	if (diffMs <= 0) return 0
	return Math.floor(diffMs / 60_000)
}

export function SignupDraftCard({ workspaceId, bet, workspaceCreatedAt }: SignupDraftCardProps) {
	const navigate = useNavigate()
	const updateObject = useUpdateObject(workspaceId)
	// Fire `qualified_bet_visible` exactly once per mount for this bet id.
	// Keyed on bet.id so switching bets in the same session emits again for the
	// new bet, but a re-render with the same bet doesn't double-count.
	const emittedFor = useRef<string | null>(null)

	useEffect(() => {
		if (emittedFor.current === bet.id) return
		emittedFor.current = bet.id
		trackQualifiedBetVisible({
			entity_id: bet.id,
			entity_type: 'bet',
			minutes_since_signup: computeMinutesSinceSignup(workspaceCreatedAt),
		})
	}, [bet.id, workspaceCreatedAt])

	function handleAccept() {
		const existing = (bet.metadata ?? {}) as Record<string, unknown>
		updateObject.mutate({
			id: bet.id,
			data: { metadata: { ...existing, accepted_from_signup: true } },
		})
	}

	function handleEdit() {
		navigate({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId, objectId: bet.id },
		})
	}

	function handleDismiss() {
		const existing = (bet.metadata ?? {}) as Record<string, unknown>
		updateObject.mutate({
			id: bet.id,
			data: {
				status: 'failed',
				metadata: { ...existing, dismissal_reason: 'signup_auto_draft_rejected' },
			},
		})
	}

	return (
		<div
			className="rounded-lg border border-border bg-card"
			data-testid="signup-draft-card"
			data-bet-id={bet.id}
		>
			<div className="border-b border-border px-4 py-3">
				<p className="text-xs uppercase tracking-wide text-muted-foreground">
					Drafted for your first session
				</p>
				<p className="mt-1 text-sm font-medium text-foreground">{bet.title}</p>
			</div>
			<div className="flex flex-wrap gap-2 px-4 py-3">
				<Button
					type="button"
					size="sm"
					onClick={handleAccept}
					disabled={updateObject.isPending}
					data-testid="signup-draft-card-accept"
				>
					Accept
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={handleEdit}
					disabled={updateObject.isPending}
					data-testid="signup-draft-card-edit"
				>
					Edit
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={handleDismiss}
					disabled={updateObject.isPending}
					data-testid="signup-draft-card-dismiss"
				>
					Dismiss
				</Button>
			</div>
		</div>
	)
}
