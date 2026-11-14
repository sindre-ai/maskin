import { trackAppActive, trackNpsSurveyDue } from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import { setFaroUser } from '@/lib/faro'
import {
	identifyForWorkspace,
	registerWorkspaceProperties,
	setCapturingEnabled,
	setWorkspaceGroup,
} from '@/lib/posthog'
import { useEffect, useState } from 'react'

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
	/** The recommend question may be asked: its flag is on and the person is not on our team. */
	npsSurveyDue?: boolean
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
	npsSurveyDue = false,
}: WorkspaceAnalyticsInput) {
	// True once identify has finished for this workspace, so the recommend question's
	// start event lands on the identified person and not on an anonymous one.
	const [identified, setIdentified] = useState(false)

	useEffect(() => {
		if (!resolved) return
		const actor = getStoredActor()
		if (!actor) return
		let cancelled = false
		setIdentified(false)
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
			if (cancelled) return
			if (shareUsage) trackAppActive()
			setIdentified(true)
		})
		return () => {
			cancelled = true
		}
	}, [resolved, workspaceId, isTeam, internal, paying, createdAt, shareUsage, anonymizeWorkspace])

	// Its own effect, so the flag arriving after the first render does not send the
	// group, identify and app_active again.
	useEffect(() => {
		if (identified && npsSurveyDue && shareUsage) trackNpsSurveyDue()
	}, [identified, npsSurveyDue, shareUsage])
}
