import { describe, expect, it } from 'vitest'
import { MASKIN_SELF_WORKSPACE_ID, parseArgs } from '../../../scripts/seed-default-agent'

describe('seed-default-agent parseArgs', () => {
	it('defaults to Maskin self workspace when no flag or env is set', () => {
		expect(parseArgs(['node', 'script.ts'], {})).toEqual({
			workspaceId: MASKIN_SELF_WORKSPACE_ID,
			unset: false,
		})
	})

	it('honours --workspace-id flag over WORKSPACE_ID env', () => {
		const flagId = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
		const envId = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
		const parsed = parseArgs(['node', 'script.ts', `--workspace-id=${flagId}`], {
			WORKSPACE_ID: envId,
		})
		expect(parsed.workspaceId).toBe(flagId)
	})

	it('falls back to WORKSPACE_ID env when no flag is passed', () => {
		const envId = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
		const parsed = parseArgs(['node', 'script.ts'], { WORKSPACE_ID: envId })
		expect(parsed.workspaceId).toBe(envId)
	})

	it('flips unset on when --unset is passed', () => {
		expect(parseArgs(['node', 'script.ts', '--unset'], {}).unset).toBe(true)
	})

	it('throws on a non-UUID workspace id', () => {
		expect(() => parseArgs(['node', 'script.ts', '--workspace-id=not-a-uuid'], {})).toThrow(
			/Invalid workspace id/,
		)
	})
})
