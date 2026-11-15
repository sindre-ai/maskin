import type { Database } from '@maskin/db'
import { messages } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import type { TurnImage } from './container-manager'
import { type WorkspaceDesktopService, createWorkspaceDesktopService } from './workspace-desktop'

/** A sleeping computer wakes in a few seconds; past this the agent is told and looks itself. */
export const HANDBACK_SCREENSHOT_TIMEOUT_MS = 20_000

const SCREENSHOT_TAKEN_NOTE =
	'Here is a screenshot of your computer, taken just now when they pressed Done. Look at it before you carry on.'
const SCREENSHOT_FAILED_NOTE =
	'I could not take a screenshot of your computer just now (it did not answer). Call desktop_screenshot yourself and check the screen before you carry on.'

export interface ComputerHandback {
	/** Added after the Done text of the turn. */
	note: string
	/** The screenshot, or none when it could not be taken. */
	images: TurnImage[]
}

type Screenshot = { image_base64?: unknown; mime_type?: unknown }

async function takeScreenshot(
	service: WorkspaceDesktopService,
	workspaceId: string,
	agentId: string,
): Promise<TurnImage | null> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const result = await Promise.race([
			service.control(workspaceId, agentId, 'screenshot', {}, HANDBACK_SCREENSHOT_TIMEOUT_MS),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), HANDBACK_SCREENSHOT_TIMEOUT_MS)
			}),
		])
		if (!result || result.status !== 200) return null
		const body = result.body as Screenshot
		if (typeof body.image_base64 !== 'string' || body.image_base64.length === 0) return null
		return {
			mediaType: typeof body.mime_type === 'string' ? body.mime_type : 'image/jpeg',
			data: body.image_base64,
		}
	} catch (err) {
		logger.warn('Could not take the screenshot for a computer handback', {
			workspaceId,
			agentId,
			error: String(err),
		})
		return null
	} finally {
		clearTimeout(timer)
	}
}

/**
 * When a person presses Done on a computer card, the screenshot the agent's next turn starts
 * with, taken now on the server so it does not depend on the agent remembering to look.
 *
 * Only for a card of this chat that `agentId` itself posted: Done on anyone else's card, or on
 * any other kind of card, returns null and the turn goes out as it was. A screenshot that cannot
 * be taken still returns a note, so the agent is told to look itself.
 */
export async function computerHandbackForCard(
	db: Database,
	args: {
		workspaceId: string
		conversationId: string
		/** The card the Done answers (the message id carried in card_answer). */
		cardMessageId: number
		agentId: string
		desktopService?: WorkspaceDesktopService
	},
): Promise<ComputerHandback | null> {
	const [card] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.id, args.cardMessageId),
				eq(messages.conversationId, args.conversationId),
				eq(messages.actorId, args.agentId),
				sql`(${messages.metadata} -> 'computer_request') IS NOT NULL`,
			),
		)
		.limit(1)
	if (!card) return null

	const image = await takeScreenshot(
		args.desktopService ?? createWorkspaceDesktopService(db),
		args.workspaceId,
		args.agentId,
	)
	return image
		? { note: SCREENSHOT_TAKEN_NOTE, images: [image] }
		: { note: SCREENSHOT_FAILED_NOTE, images: [] }
}

/**
 * The same for a message in a chat: only when it is a Done (the hidden message the card sends),
 * which names the card it answers in its metadata.
 */
export async function computerHandbackForMessage(
	db: Database,
	args: {
		workspaceId: string
		conversationId: string
		messageId: number
		agentId: string
		desktopService?: WorkspaceDesktopService
	},
): Promise<ComputerHandback | null> {
	const [message] = await db
		.select({ metadata: messages.metadata })
		.from(messages)
		.where(and(eq(messages.id, args.messageId), eq(messages.conversationId, args.conversationId)))
		.limit(1)
	const answer = (
		message?.metadata as { card_answer?: { message_id?: unknown; outcome?: unknown } } | null
	)?.card_answer
	if (!answer || answer.outcome !== 'done' || typeof answer.message_id !== 'number') return null
	return computerHandbackForCard(db, { ...args, cardMessageId: answer.message_id })
}
