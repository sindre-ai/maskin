import { EmptyState } from '@/components/shared/empty-state'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keychain')({
	component: KeychainLayout,
})

// The one place the Keychain pages read their flag. The settings nav reads it
// separately to hide the entry; this is what makes a typed-in URL answer not found.
function KeychainLayout() {
	const enabled = useFeatureFlag('keychain-settings-ui')
	if (!enabled) return <EmptyState title="Page not found" />
	return <Outlet />
}
