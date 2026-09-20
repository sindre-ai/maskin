import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import { formatUsd } from '@/components/settings/billing-usage'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { trackCreditsExhaustedErrorShown } from '@/lib/analytics'
import {
	closeInsufficientCreditsModal,
	getInsufficientCreditsPayload,
	subscribeInsufficientCredits,
} from '@/lib/insufficient-credits'
import { useWorkspace } from '@/lib/workspace-context'

export type TopupTarget = { kind: 'billing-settings' } | { kind: 'external'; url: string }

/**
 * The one relative value the backend emits today. It has no SPA route of its
 * own, so it maps to the billing surface, which is where credits are actually
 * topped up — the shim dies once the backend emits a real path (Task 3 owns
 * that mapping).
 */
const BILLING_CREDITS_PATH = '/billing/credits'

/**
 * Maps the known relative sentinel to billing settings and passes every other
 * value through verbatim, so a corrected backend path — or an absolute provider
 * URL — is followed rather than silently collapsed onto billing settings.
 */
export function resolveTopupTarget(topupUrl: string): TopupTarget {
	if (topupUrl === BILLING_CREDITS_PATH) return { kind: 'billing-settings' }
	return { kind: 'external', url: topupUrl }
}

/**
 * One instance, mounted at the workspace layout. Every session-start call site
 * reports its 402 to the shared opener instead of presenting its own error, so
 * the modal blocks with a single top-up CTA and the analytics event fires once.
 */
export function InsufficientCreditsModal() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const payload = useSyncExternalStore(
		subscribeInsufficientCredits,
		getInsufficientCreditsPayload,
		getInsufficientCreditsPayload,
	)

	// A switch to another workspace must not carry this workspace's 402 across:
	// the balance belongs to the workspace that got the error, so drop it.
	const previousWorkspaceId = useRef(workspaceId)
	useEffect(() => {
		if (previousWorkspaceId.current === workspaceId) return
		previousWorkspaceId.current = workspaceId
		closeInsufficientCreditsModal()
	}, [workspaceId])

	// Fire once per open. Each open stores a fresh payload object, so keying on
	// that reference is the signal; also depending on workspaceId would re-fire
	// the event with the previous balance when only the workspace changed.
	const trackedPayload = useRef<unknown>(null)
	useEffect(() => {
		if (!payload) {
			trackedPayload.current = null
			return
		}
		if (trackedPayload.current === payload) return
		trackedPayload.current = payload
		trackCreditsExhaustedErrorShown({
			workspace_id: workspaceId,
			balance_cents: payload.balance_cents,
		})
	}, [payload, workspaceId])

	const handleTopUp = () => {
		if (!payload) return
		const target = resolveTopupTarget(payload.topup_url)
		// Close first: the billing route is a sibling under this layout, so the
		// modal stays mounted across the navigation unless it is closed explicitly.
		closeInsufficientCreditsModal()
		if (target.kind === 'external') {
			window.location.assign(target.url)
			return
		}
		navigate({ to: '/$workspaceId/settings/billing', params: { workspaceId } })
	}

	return (
		<ResponsiveDialog
			open={payload !== null}
			onOpenChange={(next) => {
				if (!next) closeInsufficientCreditsModal()
			}}
		>
			{payload ? (
				<ResponsiveDialogContent hideCloseButton>
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>Out of credits</ResponsiveDialogTitle>
						<ResponsiveDialogDescription>
							Your workspace balance is {formatUsd(payload.balance_cents / 100)}. Top up to run this
							agent.
						</ResponsiveDialogDescription>
					</ResponsiveDialogHeader>
					<ResponsiveDialogFooter>
						<Button variant="outline" onClick={closeInsufficientCreditsModal}>
							Close
						</Button>
						<Button onClick={handleTopUp}>Top up credits</Button>
					</ResponsiveDialogFooter>
				</ResponsiveDialogContent>
			) : null}
		</ResponsiveDialog>
	)
}
