import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import notetakerExtension from '@maskin/ext-notetaker/server'
import type { ModuleEnv, ModuleLifecycleContext } from '@maskin/module-sdk'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import type { AgentStorageManager } from '../../services/agent-storage'
import type { SessionManager } from '../../services/session-manager'
import { buildActor, buildTrigger, buildWorkspace } from '../factories'
import { createTestContext } from '../setup'

function buildCtx(): ModuleLifecycleContext {
	return { workspaceId: randomUUID(), actorId: randomUUID() }
}

/**
 * Wraps the mock db Proxy so we can observe calls to top-level operations
 * (insert/update/delete/select) and capture args passed to chained `.set()` — both
 * of which are awkward to observe directly on a Proxy-based mock.
 */
function instrument(db: Database) {
	const calls = {
		insert: 0,
		update: 0,
		delete: 0,
		select: 0,
	}
	const capturedUpdateSets: Record<string, unknown>[] = []

	const wrapped = new Proxy(db, {
		get(target, prop, receiver) {
			if (prop === 'insert') {
				calls.insert++
				return (t: unknown) => Reflect.get(target, prop, receiver)(t)
			}
			if (prop === 'update') {
				calls.update++
				return (t: unknown) => {
					const chain = Reflect.get(target, prop, receiver)(t) as Record<string, unknown>
					const originalSet = chain.set as (v: Record<string, unknown>) => unknown
					chain.set = (values: Record<string, unknown>) => {
						capturedUpdateSets.push(values)
						return originalSet.call(chain, values)
					}
					return chain
				}
			}
			if (prop === 'delete') {
				calls.delete++
				return (t: unknown) => Reflect.get(target, prop, receiver)(t)
			}
			if (prop === 'select' || prop === 'selectDistinct') {
				calls.select++
				return () => Reflect.get(target, prop, receiver)()
			}
			return Reflect.get(target, prop, receiver)
		},
	})

	return { db: wrapped, calls, capturedUpdateSets }
}

function buildEnv(db: ModuleEnv['db']): ModuleEnv {
	return {
		db,
		notifyBridge: {} as PgNotifyBridge,
		sessionManager: {} as SessionManager,
		agentStorage: {} as AgentStorageManager,
		storageProvider: {} as StorageProvider,
	}
}

describe('notetaker extension', () => {
	it('exposes onEnable/onDisable hooks and a meeting object type', () => {
		expect(notetakerExtension.id).toBe('notetaker')
		expect(notetakerExtension.onEnable).toBeTypeOf('function')
		expect(notetakerExtension.onDisable).toBeTypeOf('function')
		const meetingType = notetakerExtension.objectTypes.find((t) => t.type === 'meeting')
		expect(meetingType).toBeDefined()
	})

	describe('onEnable (fresh install — no existing ids)', () => {
		it('creates three agents and three triggers and persists ids to custom_extensions.notetaker.config', async () => {
			const ctx = buildCtx()
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const summarizerId = randomUUID()
			const dispatcherId = randomUUID()
			const calendarSyncerId = randomUUID()
			const mcTriggerId = randomUUID()
			const trTriggerId = randomUUID()
			const csTriggerId = randomUUID()

			const { db: rawDb, mockResults } = createTestContext()
			mockResults.selectQueue = [[workspace]]
			// Order matches onEnable: summarizer actor, member, dispatcher actor, member,
			// calendar syncer actor, member, meeting.created trigger, transcript.attached
			// trigger, calendar.sync trigger.
			mockResults.insertQueue = [
				[{ id: summarizerId }],
				[],
				[{ id: dispatcherId }],
				[],
				[{ id: calendarSyncerId }],
				[],
				[{ id: mcTriggerId }],
				[{ id: trTriggerId }],
				[{ id: csTriggerId }],
			]
			const { db, calls, capturedUpdateSets } = instrument(rawDb)

			await notetakerExtension.onEnable?.(buildEnv(db), ctx)

			// 3 agents + 3 workspace_members + 3 triggers = 9 inserts
			expect(calls.insert).toBe(9)
			// Single update for the workspace settings merge.
			expect(calls.update).toBe(1)

			const settings = capturedUpdateSets[0].settings as Record<string, unknown>
			const custom = settings.custom_extensions as Record<
				string,
				{ config: Record<string, unknown> }
			>
			expect(custom.notetaker.config).toMatchObject({
				summarizerActorId: summarizerId,
				dispatcherActorId: dispatcherId,
				calendarSyncerActorId: calendarSyncerId,
				meetingCreatedTriggerId: mcTriggerId,
				transcriptReadyTriggerId: trTriggerId,
				calendarSyncTriggerId: csTriggerId,
				autoJoin: true,
				defaultLanguage: 'en',
				botName: 'Maskin Notetaker',
				syncIntervalMinutes: 10,
			})
		})

		it('targets the calendar.sync cron trigger at the calendar syncer agent (not the dispatcher)', async () => {
			const ctx = buildCtx()
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: { enabled_modules: ['work', 'notetaker'] },
			})
			const summarizerId = randomUUID()
			const dispatcherId = randomUUID()
			const calendarSyncerId = randomUUID()

			const { db: rawDb, mockResults } = createTestContext()
			mockResults.selectQueue = [[workspace]]
			mockResults.insertQueue = [
				[{ id: summarizerId }],
				[],
				[{ id: dispatcherId }],
				[],
				[{ id: calendarSyncerId }],
				[],
				[{ id: randomUUID() }],
				[{ id: randomUUID() }],
				[{ id: randomUUID() }],
			]
			const triggerInserts: Record<string, unknown>[] = []
			const wrapped = new Proxy(rawDb, {
				get(target, prop, receiver) {
					if (prop === 'insert') {
						return (t: unknown) => {
							const chain = Reflect.get(target, prop, receiver)(t) as Record<string, unknown>
							const originalValues = chain.values as (v: Record<string, unknown>) => unknown
							chain.values = (vals: Record<string, unknown>) => {
								if (vals && typeof vals === 'object' && 'targetActorId' in vals) {
									triggerInserts.push(vals)
								}
								return originalValues.call(chain, vals)
							}
							return chain
						}
					}
					return Reflect.get(target, prop, receiver)
				},
			})

			await notetakerExtension.onEnable?.(buildEnv(wrapped), ctx)

			const cronTrigger = triggerInserts.find((t) => t.name === 'calendar.sync')
			expect(cronTrigger).toBeDefined()
			expect(cronTrigger?.targetActorId).toBe(calendarSyncerId)
			expect(cronTrigger?.targetActorId).not.toBe(dispatcherId)
		})
	})

	describe('onEnable (idempotent re-enable — all ids already stored)', () => {
		it('reuses existing agents and triggers without inserting new rows', async () => {
			const ctx = buildCtx()
			const ids = {
				summarizerActorId: randomUUID(),
				dispatcherActorId: randomUUID(),
				calendarSyncerActorId: randomUUID(),
				meetingCreatedTriggerId: randomUUID(),
				transcriptReadyTriggerId: randomUUID(),
				calendarSyncTriggerId: randomUUID(),
			}
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: {
					enabled_modules: ['work', 'notetaker'],
					custom_extensions: {
						notetaker: {
							name: 'Notetaker',
							types: ['meeting'],
							enabled: true,
							config: { ...ids, autoJoin: true, defaultLanguage: 'en', syncIntervalMinutes: 10 },
						},
					},
				},
			})

			const { db: rawDb, mockResults } = createTestContext()
			// readConfig → workspace; then each ensure* selects its existing row.
			mockResults.selectQueue = [
				[workspace],
				[buildActor({ id: ids.summarizerActorId, type: 'agent' })],
				[buildActor({ id: ids.dispatcherActorId, type: 'agent' })],
				[buildActor({ id: ids.calendarSyncerActorId, type: 'agent' })],
				[buildTrigger({ id: ids.meetingCreatedTriggerId, workspaceId: ctx.workspaceId })],
				[buildTrigger({ id: ids.transcriptReadyTriggerId, workspaceId: ctx.workspaceId })],
				[buildTrigger({ id: ids.calendarSyncTriggerId, workspaceId: ctx.workspaceId })],
			]
			const { db, calls } = instrument(rawDb)

			await notetakerExtension.onEnable?.(buildEnv(db), ctx)

			// No inserts at all — every resource already existed.
			expect(calls.insert).toBe(0)
			// 3 trigger reconciliation updates + 1 workspace settings update = 4.
			expect(calls.update).toBe(4)
		})
	})

	describe('onDisable', () => {
		it('deletes stored agents and triggers and clears their ids from config', async () => {
			const ctx = buildCtx()
			const ids = {
				summarizerActorId: randomUUID(),
				dispatcherActorId: randomUUID(),
				calendarSyncerActorId: randomUUID(),
				meetingCreatedTriggerId: randomUUID(),
				transcriptReadyTriggerId: randomUUID(),
				calendarSyncTriggerId: randomUUID(),
			}
			const workspace = buildWorkspace({
				id: ctx.workspaceId,
				settings: {
					enabled_modules: ['work'],
					custom_extensions: {
						notetaker: {
							name: 'Notetaker',
							types: ['meeting'],
							enabled: true,
							config: { ...ids, autoJoin: true, defaultLanguage: 'en', syncIntervalMinutes: 10 },
						},
					},
				},
			})

			const { db: rawDb, mockResults } = createTestContext()
			mockResults.selectQueue = [[workspace]]
			const { db, calls, capturedUpdateSets } = instrument(rawDb)

			await notetakerExtension.onDisable?.(buildEnv(db), ctx)

			// 3 trigger deletes + 3 * (workspace_members + actors) = 9 deletes.
			expect(calls.delete).toBe(9)
			expect(calls.update).toBe(1)

			const settings = capturedUpdateSets[0].settings as Record<string, unknown>
			const custom = settings.custom_extensions as Record<
				string,
				{ config: Record<string, unknown> }
			>
			expect(custom.notetaker.config.summarizerActorId).toBeUndefined()
			expect(custom.notetaker.config.dispatcherActorId).toBeUndefined()
			expect(custom.notetaker.config.calendarSyncerActorId).toBeUndefined()
			expect(custom.notetaker.config.meetingCreatedTriggerId).toBeUndefined()
			expect(custom.notetaker.config.transcriptReadyTriggerId).toBeUndefined()
			expect(custom.notetaker.config.calendarSyncTriggerId).toBeUndefined()
		})
	})

	describe('mcpTools', () => {
		it('exposes a sync_calendars tool that POSTs the extension sync-calendars route', async () => {
			const tool = notetakerExtension.mcpTools?.find((t) => t.name === 'sync_calendars')
			if (!tool) throw new Error('sync_calendars tool not registered')

			const calls: { method: string; path: string; body?: unknown }[] = []
			const result = await tool.handler({}, async (method, path, body) => {
				calls.push({ method, path, body })
				return { synced: 0, created: 0, updated: 0, providers: [] }
			})

			expect(calls).toEqual([{ method: 'POST', path: '/sync-calendars', body: undefined }])
			expect(result.content[0].text).toContain('synced')
		})
	})
})
