import { capturePosthogEvent } from './posthog'

// Ship-metric emitter for the multi-GitHub-install bet. One event per resolved
// GitHub installation at session-launch: if a workspace holds N installs, an
// agent session start produces N `github_installation_validated` rows, each
// carrying which owner was exercised and whether the wiring (env var + MCP
// entry) + preflight write-scope probe cleared.
//
// The actual `git push` runs inside the microVM, so `push_succeeded` here is a
// launch-time proxy: the preflight verdict when preflight ran for that
// identity (write-scope probe against /installation/repositories or the target
// repo's push permission), else the wiring flags.

interface GithubInstallationValidatedProps {
	workspaceId: string
	installationCount: number
	ownerLogin: string
	envVarPresent: boolean
	mcpEntryPresent: boolean
	pushSucceeded: boolean
}

export async function trackGithubInstallationValidated(
	p: GithubInstallationValidatedProps,
): Promise<void> {
	await capturePosthogEvent('github_installation_validated', p.workspaceId, {
		workspace_id: p.workspaceId,
		installation_count: p.installationCount,
		owner_login: p.ownerLogin,
		env_var_present: p.envVarPresent,
		mcp_entry_present: p.mcpEntryPresent,
		push_succeeded: p.pushSucceeded,
	})
}
