import type { Database, Transaction } from '@maskin/db'
import { messages } from '@maskin/db/schema'
import {
	type MessageCardResolved,
	REQUEST_CARD_METADATA_KEYS,
	type RequestCardMetadataKey,
} from '@maskin/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

type Db = Database | Transaction

type Answer = {
	byActorId: string
	at: Date
	outcome: MessageCardResolved['outcome']
}

// A function, not a constant: it reads the messages table, and a module that touches it on
// import breaks every test that stubs the schema without it.
function notAnswered() {
	return sql`(${messages.metadata} -> 'card_resolved') IS NULL`
}

// Parenthesised: it sits inside an AND, and a bare OR would swallow the conditions before it.
function isRequestCard() {
	const kinds = REQUEST_CARD_METADATA_KEYS.map(
		(key) => sql`(${messages.metadata} -> ${key}::text) IS NOT NULL`,
	)
	return sql`(${sql.join(kinds, sql` OR `)})`
}

function stamp(answer: Answer) {
	const resolved: MessageCardResolved = {
		at: answer.at.toISOString(),
		by_actor_id: answer.byActorId,
		outcome: answer.outcome,
	}
	return sql`${messages.metadata} || ${JSON.stringify({ card_resolved: resolved })}::jsonb`
}

/**
 * A card was answered by a message of its own (a Not now, or a Done): write the time and the
 * answerer onto the card's message. Only a request card in the same conversation counts, and
 * only the first answer, so a stray or repeated card_answer changes nothing.
 *
 * Best effort: logged and swallowed, never blocks the message that answered it.
 */
export async function resolveCardFromAnswerMessage(
	db: Db,
	args: Answer & { conversationId: string; cardMessageId: number },
): Promise<void> {
	try {
		await db
			.update(messages)
			.set({ metadata: stamp(args) })
			.where(
				and(
					eq(messages.id, args.cardMessageId),
					eq(messages.conversationId, args.conversationId),
					notAnswered(),
					isRequestCard(),
				),
			)
	} catch (err) {
		logger.warn('Failed to record the answer on a request card', {
			conversationId: args.conversationId,
			messageId: args.cardMessageId,
			error: String(err),
		})
	}
}

/**
 * A card was answered by the action itself (the key was saved, the access was allowed): write
 * the time and the answerer onto the card the asking session posted. Run after the action has
 * committed, so a card is never marked answered for something that did not happen.
 *
 * The card is found by the asking session (every card message carries it) and its kind, and for
 * a card about one integration by that integration too. With two open cards of that kind the
 * latest one is the one answered. Nothing happens when there is none or it is already answered.
 *
 * Best effort: logged and swallowed, never fails the action that committed.
 */
export async function resolveCardFromAction(
	db: Db,
	args: Answer & {
		sessionId: string
		key: RequestCardMetadataKey
		integrationId?: string
	},
): Promise<void> {
	try {
		const [card] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.sessionId, args.sessionId),
					sql`(${messages.metadata} -> ${args.key}::text) IS NOT NULL`,
					notAnswered(),
					args.integrationId
						? sql`${messages.metadata} -> ${args.key}::text ->> 'integration_id' = ${args.integrationId}`
						: undefined,
				),
			)
			.orderBy(desc(messages.id))
			.limit(1)
		if (!card) return
		await db
			.update(messages)
			.set({ metadata: stamp(args) })
			.where(and(eq(messages.id, card.id), notAnswered()))
	} catch (err) {
		logger.warn('Failed to record the answer on a request card', {
			sessionId: args.sessionId,
			key: args.key,
			error: String(err),
		})
	}
}
