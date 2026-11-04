import { Button } from '@/components/ui/button'
import { useBillingUsage } from '@/hooks/use-billing'
import { trialCardState } from '@/lib/trial'
import { Link } from '@tanstack/react-router'
import { useEffect } from 'react'

// Remembers, per workspace, that the last billing read said "not on a trial", so a
// repeat visit does not hold a slot open for a card that will not come.
const notTrialKey = (workspaceId: string) => `trial-card-absent:${workspaceId}`

function readNotTrial(workspaceId: string): boolean {
	try {
		return localStorage.getItem(notTrialKey(workspaceId)) === '1'
	} catch {
		return false
	}
}

/**
 * Left-nav card for a workspace still on its trial: how long is left and a way
 * to pick a plan (v3 prototype: "Trial" / "5 days left" with an inline
 * Upgrade pill). Renders nothing on any other plan or if usage has failed, and once the trial has ended (the expiry banner owns that).
 */
export function TrialCard({ workspaceId }: { workspaceId: string }) {
	const { data: usage, isPending, isSuccess } = useBillingUsage(workspaceId)
	const state = trialCardState(usage)

	useEffect(() => {
		// A failed read says nothing about the plan, so it must not flip the flag.
		if (!isSuccess || !usage) return
		try {
			if (state) localStorage.removeItem(notTrialKey(workspaceId))
			else localStorage.setItem(notTrialKey(workspaceId), '1')
		} catch {
			// Storage can be unavailable (private mode); the slot just is not remembered.
		}
	}, [isSuccess, usage, state, workspaceId])

	if (!state) {
		// Usage is still loading: hold the card's slot open so the rows below it do
		// not jump up when the card arrives (a new workspace is on a trial).
		if (isPending && !readNotTrial(workspaceId)) {
			return <div aria-hidden="true" className="min-h-16 group-data-[collapsible=icon]:hidden" />
		}
		return null
	}

	return (
		<section
			aria-label="Trial"
			className="flex min-h-16 items-center gap-3.5 rounded-2xl bg-sidebar-accent py-3.5 pr-3 pl-[18px] group-data-[collapsible=icon]:hidden"
		>
			<p className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-sidebar-foreground">
				Trial
				<span className="mt-px block text-[13px] font-normal text-muted-foreground">
					{state.left}
				</span>
			</p>
			<Button asChild size="sm" className="shrink-0 rounded-full px-4 max-md:h-11">
				<Link to="/$workspaceId/settings/billing" params={{ workspaceId }}>
					Upgrade
				</Link>
			</Button>
		</section>
	)
}
