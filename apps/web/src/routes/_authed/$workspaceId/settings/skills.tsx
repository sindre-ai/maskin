import { Skills } from '@/components/agents/skills'
import { RouteError } from '@/components/shared/route-error'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/settings/skills')({
	component: TeamSkillsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TeamSkillsPage() {
	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-base font-semibold text-foreground">Team skills</h2>
				<p className="text-xs text-muted-foreground mt-1">
					Shared SKILL.md instructions available to every workspace member and every agent container
					session running in this workspace. Team skills are also exposed through the maskin MCP
					server, so any Claude Code session connected to this workspace sees them. Personal skills
					on an individual agent override a team skill with the same name.
				</p>
			</div>
			<Skills scope={{ kind: 'workspace' }} />
		</div>
	)
}
