import type { Database } from '@maskin/db'
import { actors } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'

export function generateApiKey(): { key: string } {
	const key = `ank_${crypto.randomUUID().replace(/-/g, '')}`
	return { key }
}

export async function validateApiKey(
	db: Database,
	apiKey: string,
): Promise<{ actorId: string; type: string } | null> {
	const [actor] = await db
		.select({ id: actors.id, type: actors.type })
		.from(actors)
		.where(eq(actors.apiKey, apiKey))
		.limit(1)

	return actor ? { actorId: actor.id, type: actor.type } : null
}
