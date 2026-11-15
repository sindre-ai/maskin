import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	chatSectionItems,
	chatSections,
	conversationParticipants,
	conversations,
} from '@maskin/db/schema'
import {
	CHAT_SECTIONS_MAX_PER_PERSON,
	chatSectionChatParamSchema,
	createChatSectionSchema,
	reorderChatSectionsSchema,
	updateChatSectionSchema,
} from '@maskin/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	chatSectionResponseSchema,
	errorSchema,
	idParamSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { loadSection, loadSections } from '../services/chat-sections'

/**
 * A person's own chat list sections. Every route reads and writes only the caller's rows: the
 * owner is always the authenticated actor, never a value from the request, and another person's
 * section answers 404 as if it did not exist. Events carry ids and counts, never a section name:
 * names are free text and private to the person.
 *
 * Like pin and archive (PATCH /conversations/:id/me) these write only the caller's own state, so
 * a read-only viewer may use them (see OPEN_ROUTES in the viewer route policy).
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const sectionNotFound = () => createApiError('NOT_FOUND', 'Section not found')

function isUniqueViolation(err: unknown, constraintName: string): boolean {
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as {
			code?: string
			constraint_name?: string
			message?: string
			cause?: unknown
		}
		if (
			e.code === '23505' &&
			(e.constraint_name === constraintName || e.message?.includes(constraintName))
		) {
			return true
		}
		current = e.cause
	}
	return false
}

function isForeignKeyViolation(err: unknown): boolean {
	for (let current: unknown = err; current && typeof current === 'object'; ) {
		const e = current as { code?: string; cause?: unknown }
		if (e.code === '23503') return true
		current = e.cause
	}
	return false
}

const NAME_TAKEN = 'You already have a section with this name'
const NAME_CONSTRAINT = 'chat_sections_owner_name_uniq'

// GET / - The caller's sections
const listRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Chat Sections'],
	summary: "List the caller's own chat sections, in order",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ sections: z.array(chatSectionResponseSchema) }) },
			},
			description: 'The caller’s sections, each with the chats in it',
		},
	},
})

app.openapi(listRoute, (async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	return c.json({ sections: await loadSections(c.get('db'), workspaceId, c.get('actorId')) })
}) as RouteHandler<typeof listRoute, Env>)

// POST / - Create a section
const createSectionRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Chat Sections'],
	summary: 'Create a section, last in the caller’s order',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: createChatSectionSchema } } },
	},
	responses: {
		201: {
			content: { 'application/json': { schema: chatSectionResponseSchema } },
			description: 'Section created',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The caller already has a section with this name, or has too many sections',
		},
	},
})

app.openapi(createSectionRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [{ total } = { total: 0 }] = await db
		.select({ total: sql<number>`count(*)::int` })
		.from(chatSections)
		.where(and(eq(chatSections.workspaceId, workspaceId), eq(chatSections.actorId, callerId)))
	if (total >= CHAT_SECTIONS_MAX_PER_PERSON) {
		return c.json(
			createApiError('CONFLICT', `You can have at most ${CHAT_SECTIONS_MAX_PER_PERSON} sections`),
			409,
		)
	}

	// The unique index on (workspace, owner, lower(name)) is the single judge of a duplicate name,
	// so two requests at once can not both win.
	const [created] = await db
		.insert(chatSections)
		.values({
			workspaceId,
			actorId: callerId,
			name: body.name,
			position: sql`(
				SELECT COALESCE(MAX(s.position) + 1, 0) FROM chat_sections s
				WHERE s.workspace_id = ${workspaceId} AND s.actor_id = ${callerId}
			)`,
		})
		.onConflictDoNothing()
		.returning()
	if (!created) return c.json(createApiError('CONFLICT', NAME_TAKEN), 409)

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'chat_section_created',
		entityType: 'chat_section',
		entityId: created.id,
	})

	return c.json(
		{
			id: created.id,
			name: created.name,
			position: created.position,
			collapsed: created.collapsed,
			conversationIds: [],
		},
		201,
	)
}) as RouteHandler<typeof createSectionRoute, Env>)

// PUT /order - Reorder the caller's sections
const reorderRoute = createRoute({
	method: 'put',
	path: '/order',
	tags: ['Chat Sections'],
	summary: 'Put the caller’s sections in a new order',
	description:
		'Send every one of the caller’s section ids exactly once, in the order they should show.',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: reorderChatSectionsSchema } } },
	},
	responses: {
		200: {
			content: {
				'application/json': { schema: z.object({ sections: z.array(chatSectionResponseSchema) }) },
			},
			description: 'The sections in their new order',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The ids are not exactly the caller’s sections',
		},
	},
})

app.openapi(reorderRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { ids } = c.req.valid('json')

	const reordered = await db.transaction(async (tx) => {
		// Lock the caller's rows so a section made or deleted at the same moment cannot slip
		// between the check and the writes.
		const owned = await tx
			.select({ id: chatSections.id })
			.from(chatSections)
			.where(and(eq(chatSections.workspaceId, workspaceId), eq(chatSections.actorId, callerId)))
			.for('update')
		const ownedIds = new Set(owned.map((r) => r.id))
		if (ids.length !== ownedIds.size || new Set(ids).size !== ids.length) return false
		if (!ids.every((id) => ownedIds.has(id))) return false
		for (const [position, id] of ids.entries()) {
			await tx
				.update(chatSections)
				.set({ position, updatedAt: new Date() })
				.where(and(eq(chatSections.id, id), eq(chatSections.actorId, callerId)))
		}
		return true
	})
	if (!reordered) {
		return c.json(
			createApiError('VALIDATION_ERROR', 'ids must list each of your sections exactly once'),
			400,
		)
	}

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'chat_sections_reordered',
		entityType: 'chat_section',
		entityId: callerId,
		data: { count: ids.length },
	})

	return c.json({ sections: await loadSections(db, workspaceId, callerId) }, 200)
}) as RouteHandler<typeof reorderRoute, Env>)

// PATCH /:id - Rename or fold a section
const updateSectionRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Chat Sections'],
	summary: 'Rename a section, or fold or unfold it',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
		body: { content: { 'application/json': { schema: updateChatSectionSchema } } },
	},
	responses: {
		200: {
			content: { 'application/json': { schema: chatSectionResponseSchema } },
			description: 'Section updated',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The caller already has a section with this name',
		},
	},
})

app.openapi(updateSectionRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	let updated: typeof chatSections.$inferSelect | undefined
	try {
		;[updated] = await db
			.update(chatSections)
			.set({
				...(body.name !== undefined && { name: body.name }),
				...(body.collapsed !== undefined && { collapsed: body.collapsed }),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(chatSections.id, id),
					eq(chatSections.workspaceId, workspaceId),
					eq(chatSections.actorId, callerId),
				),
			)
			.returning()
	} catch (err) {
		if (isUniqueViolation(err, NAME_CONSTRAINT)) {
			return c.json(createApiError('CONFLICT', NAME_TAKEN), 409)
		}
		throw err
	}
	if (!updated) return c.json(sectionNotFound(), 404)

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'chat_section_updated',
		entityType: 'chat_section',
		entityId: id,
		data: {
			renamed: body.name !== undefined,
			...(body.collapsed !== undefined && { collapsed: body.collapsed }),
		},
	})

	const section = await loadSection(db, workspaceId, callerId, id)
	if (!section) return c.json(sectionNotFound(), 404)
	return c.json(section, 200)
}) as RouteHandler<typeof updateSectionRoute, Env>)

// DELETE /:id - Delete a section; its chats go back to the list
const deleteSectionRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Chat Sections'],
	summary: 'Delete a section; its chats go back to the list',
	request: { headers: workspaceIdHeader, params: idParamSchema },
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						deleted: z.literal(true),
						// The chats the section held, so the client can say how many are back in the list
						// and undo by putting them in a new section.
						conversationIds: z.array(z.string().uuid()),
					}),
				},
			},
			description: 'Section deleted',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
	},
})

app.openapi(deleteSectionRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id } = c.req.valid('param')

	const section = await loadSection(db, workspaceId, callerId, id)
	if (!section) return c.json(sectionNotFound(), 404)

	// The items go with the section (cascade). A chat is never deleted or hidden by this.
	const [deleted] = await db
		.delete(chatSections)
		.where(
			and(
				eq(chatSections.id, id),
				eq(chatSections.workspaceId, workspaceId),
				eq(chatSections.actorId, callerId),
			),
		)
		.returning({ id: chatSections.id })
	if (!deleted) return c.json(sectionNotFound(), 404)

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'chat_section_deleted',
		entityType: 'chat_section',
		entityId: id,
		data: { chats: section.conversationIds.length },
	})

	return c.json({ deleted: true as const, conversationIds: section.conversationIds }, 200)
}) as RouteHandler<typeof deleteSectionRoute, Env>)

// PUT /:id/chats/:conversationId - Put a chat in a section
const putChatRoute = createRoute({
	method: 'put',
	path: '/{id}/chats/{conversationId}',
	tags: ['Chat Sections'],
	summary: 'Put a chat in a section, out of any other section it was in',
	request: { headers: workspaceIdHeader, params: chatSectionChatParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: chatSectionResponseSchema } },
			description: 'The section, with the chat in it',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The section is not the caller’s, or the caller is not in the chat',
		},
	},
})

app.openapi(putChatRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, conversationId } = c.req.valid('param')

	const section = await loadSection(db, workspaceId, callerId, id)
	if (!section) return c.json(sectionNotFound(), 404)

	// Only a chat the caller is still in, in this workspace. Anything else is "not found", the same
	// answer a chat that does not exist gets.
	const [chat] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.innerJoin(
			conversationParticipants,
			and(
				eq(conversationParticipants.conversationId, conversations.id),
				eq(conversationParticipants.actorId, callerId),
				isNull(conversationParticipants.leftAt),
			),
		)
		.where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, workspaceId)))
		.limit(1)
	if (!chat) return c.json(createApiError('NOT_FOUND', 'Conversation not found'), 404)

	try {
		await db
			.insert(chatSectionItems)
			.values({ sectionId: id, conversationId, actorId: callerId })
			.onConflictDoUpdate({
				target: [chatSectionItems.actorId, chatSectionItems.conversationId],
				set: { sectionId: id, createdAt: new Date() },
			})
	} catch (err) {
		// The section was deleted between the check and the write.
		if (isForeignKeyViolation(err)) return c.json(sectionNotFound(), 404)
		throw err
	}

	await recordEvent(db, {
		workspaceId,
		actorId: callerId,
		action: 'chat_section_chat_added',
		entityType: 'chat_section',
		entityId: id,
		data: { conversation_id: conversationId },
	})

	const updated = await loadSection(db, workspaceId, callerId, id)
	if (!updated) return c.json(sectionNotFound(), 404)
	return c.json(updated, 200)
}) as RouteHandler<typeof putChatRoute, Env>)

// DELETE /:id/chats/:conversationId - Take a chat out of a section
const deleteChatRoute = createRoute({
	method: 'delete',
	path: '/{id}/chats/{conversationId}',
	tags: ['Chat Sections'],
	summary: 'Take a chat out of a section; it goes back to the list',
	request: { headers: workspaceIdHeader, params: chatSectionChatParamSchema },
	responses: {
		200: {
			content: { 'application/json': { schema: chatSectionResponseSchema } },
			description: 'The section, without the chat',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The section is not the caller’s',
		},
	},
})

app.openapi(deleteChatRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { id, conversationId } = c.req.valid('param')

	const section = await loadSection(db, workspaceId, callerId, id)
	if (!section) return c.json(sectionNotFound(), 404)

	// Only the row for this section: a chat the caller has since moved to another section stays there.
	const removed = await db
		.delete(chatSectionItems)
		.where(
			and(
				eq(chatSectionItems.sectionId, id),
				eq(chatSectionItems.conversationId, conversationId),
				eq(chatSectionItems.actorId, callerId),
			),
		)
		.returning({ conversationId: chatSectionItems.conversationId })

	if (removed.length > 0) {
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'chat_section_chat_removed',
			entityType: 'chat_section',
			entityId: id,
			data: { conversation_id: conversationId },
		})
	}

	const updated = await loadSection(db, workspaceId, callerId, id)
	if (!updated) return c.json(sectionNotFound(), 404)
	return c.json(updated, 200)
}) as RouteHandler<typeof deleteChatRoute, Env>)

export default app
