import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { buildHoldPreview } from '../../services/voice-hold-preview'
import { createWriteGate } from '../../services/voice-write-gate'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const TOOL = 'gmail_send_email'

async function seedEmail(content: string) {
	const humanId = getTestActorId()
	const ws = await insertWorkspace(db, humanId)
	const object = await insertObject(db, ws.id, humanId, {
		title: 'Reply to Lars Honoré',
		content,
		metadata: { kind: 'email', to: 'Lars Honoré <lars@example.dk>', subject: 'Meeting' },
	})
	if (!object) throw new Error('object insert failed')
	const args = { object_id: object.id, workspace_id: ws.id }
	const gate = createWriteGate({
		voiceSessionId: 'voice-1',
		isReadOnlyTool: () => false,
		previewFor: (tool, a) => buildHoldPreview({ db, workspaceId: ws.id, tool, args: a }),
	})
	const say = (item: string) => {
		gate.noteSpeechStarted(item)
		gate.noteUserLine('yes', item)
	}
	return { ws, object, args, gate, say }
}

describe('a held send against real Postgres', () => {
	it('reads the recipient, subject and text of the email as stored right now', async () => {
		const { gate, args } = await seedEmail('Can we meet Tuesday at 10 or Wednesday at 14?')
		const hold = await gate.review(TOOL, args, null)
		expect(hold).toMatchObject({
			kind: 'hold',
			changed: false,
			preview: {
				recipients: ['Lars Honoré <lars@example.dk>'],
				subject: 'Meeting',
				body: 'Can we meet Tuesday at 10 or Wednesday at 14?',
			},
		})
	})

	it('runs after a yes when the draft has not changed', async () => {
		const { gate, args, say } = await seedEmail('Tuesday at 10?')
		const hold = await gate.review(TOOL, args, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say('item_yes')
		expect(await gate.review(TOOL, args, hold.id)).toMatchObject({
			kind: 'run',
			confirmed: { yesCount: 1, readBackMatches: true },
		})
	})

	it('does not run on a yes when the draft was edited between the hold and the repeat', async () => {
		const { gate, args, say, object } = await seedEmail(
			'Two slots: Tuesday at 10 or Wednesday at 14.',
		)
		const hold = await gate.review(TOOL, args, null)
		if (hold.kind !== 'hold') throw new Error('expected a hold')
		say('item_yes')

		// The new wording is saved after the question. The arguments (the object id) stay the same.
		await db
			.update(objects)
			.set({ content: 'One slot: Thursday at 9.', updatedAt: new Date() })
			.where(eq(objects.id, object.id))

		const again = await gate.review(TOOL, args, hold.id)
		expect(again).toMatchObject({
			kind: 'hold',
			changed: true,
			preview: { body: 'One slot: Thursday at 9.' },
		})
		if (again.kind !== 'hold') throw new Error('expected a hold')
		expect(again.id).not.toBe(hold.id)

		// A fresh yes to the new text runs it. The first yes was for the old text, so this send reads 2.
		say('item_yes_2')
		expect(await gate.review(TOOL, args, again.id)).toMatchObject({
			kind: 'run',
			confirmed: { yesCount: 2, readBackMatches: true },
		})
	})

	it('does not read an email that belongs to another workspace', async () => {
		const { object } = await seedEmail('Secret wording.')
		const other = await insertWorkspace(db, getTestActorId())
		const result = await buildHoldPreview({
			db,
			workspaceId: other.id,
			tool: TOOL,
			args: { object_id: object.id },
		})
		expect(result.body).toBeNull()
		expect(result.note).toContain('does not exist in this workspace')
	})
})
