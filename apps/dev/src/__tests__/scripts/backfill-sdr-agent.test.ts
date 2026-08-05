import { describe, expect, it } from 'vitest'
import { parseArgs } from '../../../scripts/backfill-sdr-agent'

describe('backfill-sdr-agent parseArgs', () => {
	it('parses --workspace-id flag', () => {
		expect(
			parseArgs(['node', 'x', '--workspace-id=aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'], {}),
		).toEqual({ workspaceId: 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa', all: false })
	})

	it('flips all on when --all is passed', () => {
		expect(parseArgs(['node', 'x', '--all'], {})).toEqual({ workspaceId: null, all: true })
	})

	it('falls back to WORKSPACE_ID env when no flag is passed', () => {
		expect(
			parseArgs(['node', 'x'], { WORKSPACE_ID: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb' }),
		).toEqual({ workspaceId: 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb', all: false })
	})

	it('prefers --workspace-id flag over WORKSPACE_ID env', () => {
		const flagId = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
		const envId = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'
		expect(
			parseArgs(['node', 'x', `--workspace-id=${flagId}`], { WORKSPACE_ID: envId }).workspaceId,
		).toBe(flagId)
	})

	it('throws when --all is combined with --workspace-id', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'
		expect(() => parseArgs(['node', 'x', '--all', `--workspace-id=${id}`], {})).toThrow(
			/--all cannot be combined with --workspace-id/,
		)
	})

	it('throws on a non-UUID workspace id', () => {
		expect(() => parseArgs(['node', 'x', '--workspace-id=not-a-uuid'], {})).toThrow(
			/Invalid workspace id/,
		)
	})

	it('throws when no target is given', () => {
		expect(() => parseArgs(['node', 'x'], {})).toThrow(/Provide --workspace-id/)
	})
})
