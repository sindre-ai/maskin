// Operator-run KEK rotation for one workspace (aws-kms only).
//
// Creates the next KMS key and alias for the workspace, proves a round trip on it,
// and only then points workspace_kms_aliases.kek_alias at it. Existing credentials
// are not re-encrypted: they are re-wrapped lazily by the nightly DEK rotation or
// POST /api/integrations/:id/rotate-dek. Never schedules a key for deletion.
//
// Run:
//   DATABASE_URL=... KEYCHAIN_KMS=aws-kms KEYCHAIN_ENV=staging AWS_REGION=eu-central-1 \
//     pnpm --filter @maskin/dev exec tsx scripts/rotate-kek.ts <workspace-uuid>
//
// Safe to re-run: a run that failed part-way reuses the alias it already made.
// Exit code 0 = rotated, 2 = skipped (another run holds the lock, not aws-kms, or the
// workspace has no KEK yet), 1 = failed (the old key is still live).

import { createDb } from '@maskin/db'
import { rotateWorkspaceKek } from '../src/lib/integrations/rotate-kek'
import { getKmsProvider } from '../src/lib/keychain-kms'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main(): Promise<number> {
	const workspaceId = process.argv[2]?.trim()
	if (!workspaceId || !UUID_RE.test(workspaceId)) {
		console.error('Usage: tsx scripts/rotate-kek.ts <workspace-uuid>')
		return 1
	}
	const url = process.env.DATABASE_URL
	if (!url) {
		console.error('DATABASE_URL is required')
		return 1
	}
	const db = createDb(url)
	try {
		const result = await rotateWorkspaceKek(db, getKmsProvider(db), workspaceId)
		console.log(JSON.stringify(result))
		if (result.status === 'rotated') return 0
		return result.status === 'skipped' ? 2 : 1
	} finally {
		await db.$client.end()
	}
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err instanceof Error ? err.message : String(err))
		process.exit(1)
	},
)
