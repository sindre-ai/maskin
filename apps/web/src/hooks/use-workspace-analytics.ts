import { trackAppActive } from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import { setFaroUser } from '@/lib/faro'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
	setWorkspaceGroup,
} from '@/lib/posthog'
import { useEffect } from 'react'

interface WorkspaceAnalyticsInput {
	workspaceId: string
	/** False until the workspace has resolved from the user's memberships. */
	resolved: boolean
	isTeam: boolean
	internal: boolean
	paying: boolean
	createdAt: string | undefined
	shareUsage: boolean
	anonymizeWorkspace: boolean
}

/**
 * Pins the Synthesizer's join keys on every analytics event from this workspace,
 * and applies the workspace's Privacy & data settings — both the share-usage
 * opt-in/out and the SHA-256 identify when anonymise is on — so the prefs
 * survive reloads, not just the moment the user flips a switch.
 *
 * Takes primitives, not the workspace object: every refetch of the workspaces
 * list hands back a new object, and keying the effect on it re-sent the group
 * event, identify and app_active each time.
 */
export function useWorkspaceAnalytics({
	workspaceId,
	resolved,
	isTeam,
	internal,
	paying,
	createdAt,
	shareUsage,
	anonymizeWorkspace,
}: WorkspaceAnalyticsInput) {
	useEffect(() => {
		if (!resolved) return
		const actor = getStoredActor()
		if (!actor) return
		registerWorkspaceProperties({
			workspace_id: workspaceId,
			actor_id: actor.id,
			actor_type: actor.type,
			is_team: isTeam,
			internal,
			paying,
		})
		setCapturingEnabled(shareUsage)
		setWorkspaceGroup(workspaceId, createdAt)
		// Faro gets ids only — never the actor's email or the workspace name.
		// Unlike PostHog this is not gated on the share-usage analytics toggle:
		// it is crash reporting, the same category as Sentry, which is likewise
		// ungated.
		setFaroUser(actor.id, workspaceId)
		void identifyForWorkspace(actor.id, anonymizeWorkspace, {
			name: actor.name,
			email: actor.email,
		}).then(() => {
			if (shareUsage) trackAppActive()
		})
	}, [resolved, workspaceId, isTeam, internal, paying, createdAt, shareUsage, anonymizeWorkspace])
}
