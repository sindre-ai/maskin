import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { Switch } from '@/components/ui/switch'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { type ActorResponse, ApiError, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useId } from 'react'
import { toast } from 'sonner'

// Verbatim helper copy from the design SPEC §Copy — a string not listed
// there is a bug.
const HELP_COPY = 'Let workspace members hold a live voice call with this agent.'

// The agent-settings toggle that flips actors.metadata.voice_enabled. Gated by
// the `voice-mode-v1` feature flag — same boundary the primary Call button on
// the header uses. Non-admins get a 403 from the backend; we surface that in a
// toast rather than a mid-form ban, since the whole section is admin territory
// and the current user model doesn't distinguish "read this agent" from
// "administer this agent" at render time.
export function AgentVoiceModeSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const enabled = useFeatureFlag('voice-mode-v1')
	const queryClient = useQueryClient()
	const switchId = useId()

	const mutation = useMutation({
		mutationFn: (voiceEnabled: boolean) =>
			api.actors.voiceMode(agent.id, workspaceId, { enabled: voiceEnabled }),
		onSuccess: (updated) => {
			// Optimistic-refresh both the detail row and the workspace list so
			// the badge on /agents flips without a manual refetch when an admin
			// toggles voice on from the detail page.
			queryClient.setQueryData(queryKeys.actors.detail(agent.id), updated)
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
		onError: (err) => {
			if (err instanceof ApiError && err.status === 403) {
				toast.error('Only workspace admins can toggle voice mode.')
				return
			}
			toast.error(`Couldn't update voice mode for ${agent.name}`)
		},
	})

	const handleChange = useCallback((next: boolean) => mutation.mutate(next), [mutation])

	if (!enabled) return null
	// Voice is agent-only — humans and system actors don't get a Call button, so
	// the toggle also doesn't apply.
	if (agent.type !== 'agent') return null

	return (
		<section aria-labelledby="agent-voice-mode-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading id="agent-voice-mode-heading" title="Voice mode" />
			<div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-background/60 px-4 py-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<label
						htmlFor={switchId}
						className="text-[13px] font-semibold text-foreground cursor-pointer"
					>
						Enable voice calls
					</label>
					<p className="text-[12px] text-muted-foreground">{HELP_COPY}</p>
				</div>
				<Switch
					id={switchId}
					checked={agent.voice_enabled === true}
					disabled={mutation.isPending}
					onCheckedChange={handleChange}
					aria-label="Enable voice calls with this agent"
				/>
			</div>
		</section>
	)
}
