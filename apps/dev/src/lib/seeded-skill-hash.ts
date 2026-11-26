import { createHash } from 'node:crypto'

/**
 * Key in workspace_skills.metadata holding the sha256 of the text a seeded skill was last written
 * with by the server. A copy whose current text still hashes to this value has not been edited
 * since, so the server may replace it with newer seeded text. Any edit changes the hash and the
 * copy is left alone for good.
 */
export const SEEDED_SKILL_HASH_KEY = 'seeded_content_sha256'

export function seededSkillHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex')
}
