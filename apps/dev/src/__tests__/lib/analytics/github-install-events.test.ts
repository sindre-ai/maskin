import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackGithubInstallationValidated } from '../../../lib/analytics/github-install-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackGithubInstallationValidated', () => {
	it('emits github_installation_validated with workspace as distinct id and the contracted props', async () => {
		await trackGithubInstallationValidated({
			workspaceId: 'ws-1',
			installationCount: 2,
			ownerLogin: 'sindre-ai',
			envVarPresent: true,
			mcpEntryPresent: true,
			pushSucceeded: true,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('github_installation_validated', 'ws-1', {
			workspace_id: 'ws-1',
			installation_count: 2,
			owner_login: 'sindre-ai',
			env_var_present: true,
			mcp_entry_present: true,
			push_succeeded: true,
		})
	})

	it('carries a push_succeeded=false verdict through for failed wiring', async () => {
		await trackGithubInstallationValidated({
			workspaceId: 'ws-1',
			installationCount: 1,
			ownerLogin: 'vaerksted-ai',
			envVarPresent: true,
			mcpEntryPresent: false,
			pushSucceeded: false,
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.push_succeeded).toBe(false)
		expect(props.mcp_entry_present).toBe(false)
	})
})
