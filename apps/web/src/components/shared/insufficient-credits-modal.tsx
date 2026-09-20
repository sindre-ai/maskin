import { useNavigate } from '@tanstack/react-router'
import { useEffect, useSyncExternalStore } from 'react'

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
 * The backend currently emits the relative '/billing/credits', which has no SPA
 * route, so a relative value cannot be navigated to. Only an absolute https://
 * target is followed (a provider-supplied URL is an external input — a relative
 * or non-https value would be an open redirect); everything else resolves to the
 * billing settings surface, which is where credits are actually topped up.
 */
export function resolveTopupTarget(topupUrl: string): TopupTarget {
	if (/^https:\/\//.test(topupUrl)) return { kind: 'external', url: topupUrl }
	return { kind: 'billing-settings' }
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

	useEffect(() => {
		if (!payload) return
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
