import { describe, expect, it, vi } from 'vitest'
import {
	backupIsNeeded,
	githubBackupOwners,
	preflightWithBackup,
} from '../../../lib/github/backup-install'
import type { PreflightIdentity, PreflightVerdict } from '../../../lib/github/preflight'

const id = (name: string): PreflightIdentity => ({ name, token: 'ghs_x' })
const ok = (name: string): PreflightVerdict => ({ name, healthy: true })
const bad = (name: string, failureClass: PreflightVerdict['failureClass']): PreflightVerdict => ({
	name,
	healthy: false,
	failureClass,
})
const runner = (verdicts: Record<string, PreflightVerdict>) =>
	vi.fn(async (ids: PreflightIdentity[]) => ids.map((i) => verdicts[i.name] as PreflightVerdict))

describe('githubBackupOwners', () => {
	it('is empty when unset, so every install is attached as before', () => {
		expect(githubBackupOwners({}).size).toBe(0)
	})
	it('reads a comma list, trimmed and lower-cased', () => {
		expect([
			...githubBackupOwners({ MASKIN_GITHUB_BACKUP_OWNERS: ' Vaerksted-AI, other ' }),
		]).toEqual(['vaerksted-ai', 'other'])
	})
})

describe('backupIsNeeded', () => {
	it('is needed on a 401 or 403, or when nothing else is attached', () => {
		expect(backupIsNeeded(1, [bad('a', '401-unauth')])).toBe(true)
		expect(backupIsNeeded(1, [bad('a', '403-permission')])).toBe(true)
		expect(backupIsNeeded(0, [])).toBe(true)
	})
	it('is not needed when the others answer, or fail for another reason', () => {
		expect(backupIsNeeded(1, [ok('a')])).toBe(false)
		expect(backupIsNeeded(1, [bad('a', 'upstream-error')])).toBe(false)
	})
})

describe('preflightWithBackup', () => {
	const backups = new Set(['github-vaerksted-ai'])
	const both = [id('github-sindre-ai'), id('github-vaerksted-ai')]

	it('leaves the backup out, and does not check it, when the first answers', async () => {
		const run = runner({ 'github-sindre-ai': ok('github-sindre-ai') })
		const out = await preflightWithBackup(both, backups, run)
		expect(out.dropped).toEqual(['github-vaerksted-ai'])
		expect(run).toHaveBeenCalledTimes(1)
	})

	it('keeps and checks the backup when the first is refused', async () => {
		const run = runner({
			'github-sindre-ai': bad('github-sindre-ai', '401-unauth'),
			'github-vaerksted-ai': ok('github-vaerksted-ai'),
		})
		const out = await preflightWithBackup(both, backups, run)
		expect(out.dropped).toEqual([])
		expect(out.verdicts.map((v) => v.name)).toEqual(['github-sindre-ai', 'github-vaerksted-ai'])
	})

	it('keeps the backup when it is the only GitHub server', async () => {
		const run = runner({ 'github-vaerksted-ai': ok('github-vaerksted-ai') })
		const out = await preflightWithBackup([id('github-vaerksted-ai')], backups, run)
		expect(out.dropped).toEqual([])
	})

	it('does nothing when no backup is named', async () => {
		const run = runner({
			'github-sindre-ai': ok('github-sindre-ai'),
			'github-vaerksted-ai': ok('github-vaerksted-ai'),
		})
		const out = await preflightWithBackup(both, new Set(), run)
		expect(out.dropped).toEqual([])
		expect(run).toHaveBeenCalledTimes(1)
		expect(run.mock.calls[0]?.[0]).toHaveLength(2)
	})
})
