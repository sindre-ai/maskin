import type { PreflightIdentity, PreflightVerdict } from './preflight'

/**
 * The backup GitHub rule: an install named in MASKIN_GITHUB_BACKUP_OWNERS (comma-separated org
 * logins) gets its MCP server attached only when no other GitHub server works for the session,
 * so a session stops carrying a third GitHub server it will not use. Unset (the default) means
 * every install is attached, as before. The org that owns the session's target repo is never
 * treated as a backup, and a server the agent lists in its own config is never dropped.
 */
export function githubBackupOwners(env: NodeJS.ProcessEnv = process.env): Set<string> {
	return new Set(
		(env.MASKIN_GITHUB_BACKUP_OWNERS ?? '')
			.split(',')
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	)
}

const REFUSED = new Set(['401-unauth', '403-permission'])

/** True when the backup is needed: nothing else is attached, or another server was refused (401/403). */
export function backupIsNeeded(primaryCount: number, verdicts: PreflightVerdict[]): boolean {
	return primaryCount === 0 || verdicts.some((v) => !v.healthy && REFUSED.has(v.failureClass ?? ''))
}

/**
 * Runs the launch check on the main servers first and on the backups only when needed.
 * Returns the verdicts, and the backup server names to leave out of this session.
 */
export async function preflightWithBackup(
	identities: PreflightIdentity[],
	backupNames: ReadonlySet<string>,
	run: (ids: PreflightIdentity[]) => Promise<PreflightVerdict[]>,
): Promise<{ verdicts: PreflightVerdict[]; dropped: string[] }> {
	const backups = identities.filter((i) => backupNames.has(i.name))
	if (backups.length === 0) return { verdicts: await run(identities), dropped: [] }
	const primary = identities.filter((i) => !backupNames.has(i.name))
	const verdicts = primary.length > 0 ? await run(primary) : []
	if (backupIsNeeded(primary.length, verdicts)) {
		return { verdicts: [...verdicts, ...(await run(backups))], dropped: [] }
	}
	return { verdicts, dropped: backups.map((b) => b.name) }
}
