import { useFeatureFlag } from '@/hooks/use-feature-flag'

/**
 * Whether the connect entry point for a provider is shown to this actor.
 *
 * The backend registers some providers unconditionally so their OAuth callback
 * and MCP routes stay reachable for tester actors, but their connect entry point
 * stays hidden from everyone else until the flag flips on. Settings →
 * Integrations and the Connect card an agent puts in chat both ask this, so a
 * flagged provider can't be reached through one surface while hidden on the
 * other. Per-actor behaviour gate, never a shared-state change.
 */
export function useProviderVisibility(): (providerName: string) => boolean {
	const googleMeetVisible = useFeatureFlag('google-meet-integration-ui')
	const resendVisible = useFeatureFlag('resend-integration-ui')
	return (providerName) => {
		if (providerName === 'google-meet') return googleMeetVisible
		if (providerName === 'resend') return resendVisible
		return true
	}
}
