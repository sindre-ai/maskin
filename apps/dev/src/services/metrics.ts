import type { Database } from '@maskin/db'
import { actors, integrations, objects, sessions, workspaces } from '@maskin/db/schema'
import { and, count, eq, gte, sql } from 'drizzle-orm'

export interface UsageMetrics {
	workspaces: {
		total: number
		daily: number
		weekly: number
	}
	objects: {
		total: number
		byType: { type: string; count: number }[]
		daily: number
		weekly: number
	}
	agents: {
		configured: number
		sessionsRun: number
		sessionsDaily: number
		sessionsWeekly: number
	}
	agentHours: {
		totalSeconds: number
		weeklySeconds: number
	}
	integrations: {
		connected: number
		byProvider: { provider: string; count: number }[]
	}
}

export interface PublicMetrics {
	workspacesCreated: number
	agentSessionsRun: number
	agentHoursThisWeek: number
	objectsCreated: number
}

export async function getUsageMetrics(db: Database): Promise<UsageMetrics> {
	const now = new Date()
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

	const [workspaceMetrics, objectMetrics, agentMetrics, agentHourMetrics, integrationMetrics] =
		await Promise.all([
			getWorkspaceMetrics(db, oneDayAgo, oneWeekAgo),
			getObjectMetrics(db, oneDayAgo, oneWeekAgo),
			getAgentMetrics(db, oneDayAgo, oneWeekAgo),
			getAgentHourMetrics(db, oneWeekAgo),
			getIntegrationMetrics(db),
		])

	return {
		workspaces: workspaceMetrics,
		objects: objectMetrics,
		agents: agentMetrics,
		agentHours: agentHourMetrics,
		integrations: integrationMetrics,
	}
}

export async function getPublicMetrics(db: Database): Promise<PublicMetrics> {
	const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

	const [wsCount, sessionCount, agentHours, objectCount] = await Promise.all([
		db.select({ count: count() }).from(workspaces),
		db.select({ count: count() }).from(sessions),
		db
			.select({
				totalSeconds: sql<number>`coalesce(sum(extract(epoch from (coalesce(${sessions.completedAt}, now()) - ${sessions.startedAt}))), 0)`,
			})
			.from(sessions)
			.where(and(gte(sessions.startedAt, oneWeekAgo), sql`${sessions.startedAt} is not null`)),
		db.select({ count: count() }).from(objects),
	])

	return {
		workspacesCreated: wsCount[0]?.count ?? 0,
		agentSessionsRun: sessionCount[0]?.count ?? 0,
		agentHoursThisWeek: Math.round(((agentHours[0]?.totalSeconds ?? 0) / 3600) * 10) / 10,
		objectsCreated: objectCount[0]?.count ?? 0,
	}
}

async function getWorkspaceMetrics(db: Database, oneDayAgo: Date, oneWeekAgo: Date) {
	const [total, daily, weekly] = await Promise.all([
		db.select({ count: count() }).from(workspaces),
		db.select({ count: count() }).from(workspaces).where(gte(workspaces.createdAt, oneDayAgo)),
		db.select({ count: count() }).from(workspaces).where(gte(workspaces.createdAt, oneWeekAgo)),
	])

	return {
		total: total[0]?.count ?? 0,
		daily: daily[0]?.count ?? 0,
		weekly: weekly[0]?.count ?? 0,
	}
}

async function getObjectMetrics(db: Database, oneDayAgo: Date, oneWeekAgo: Date) {
	const [total, byType, daily, weekly] = await Promise.all([
		db.select({ count: count() }).from(objects),
		db.select({ type: objects.type, count: count() }).from(objects).groupBy(objects.type),
		db.select({ count: count() }).from(objects).where(gte(objects.createdAt, oneDayAgo)),
		db.select({ count: count() }).from(objects).where(gte(objects.createdAt, oneWeekAgo)),
	])

	return {
		total: total[0]?.count ?? 0,
		byType: byType.map((r) => ({ type: r.type, count: r.count })),
		daily: daily[0]?.count ?? 0,
		weekly: weekly[0]?.count ?? 0,
	}
}

async function getAgentMetrics(db: Database, oneDayAgo: Date, oneWeekAgo: Date) {
	const [configured, sessionsRun, sessionsDaily, sessionsWeekly] = await Promise.all([
		db.select({ count: count() }).from(actors).where(eq(actors.type, 'agent')),
		db.select({ count: count() }).from(sessions),
		db.select({ count: count() }).from(sessions).where(gte(sessions.createdAt, oneDayAgo)),
		db.select({ count: count() }).from(sessions).where(gte(sessions.createdAt, oneWeekAgo)),
	])

	return {
		configured: configured[0]?.count ?? 0,
		sessionsRun: sessionsRun[0]?.count ?? 0,
		sessionsDaily: sessionsDaily[0]?.count ?? 0,
		sessionsWeekly: sessionsWeekly[0]?.count ?? 0,
	}
}

async function getAgentHourMetrics(db: Database, oneWeekAgo: Date) {
	const [total, weekly] = await Promise.all([
		db
			.select({
				totalSeconds: sql<number>`coalesce(sum(extract(epoch from (coalesce(${sessions.completedAt}, now()) - ${sessions.startedAt}))), 0)`,
			})
			.from(sessions)
			.where(sql`${sessions.startedAt} is not null`),
		db
			.select({
				totalSeconds: sql<number>`coalesce(sum(extract(epoch from (coalesce(${sessions.completedAt}, now()) - ${sessions.startedAt}))), 0)`,
			})
			.from(sessions)
			.where(and(gte(sessions.startedAt, oneWeekAgo), sql`${sessions.startedAt} is not null`)),
	])

	return {
		totalSeconds: Math.round(total[0]?.totalSeconds ?? 0),
		weeklySeconds: Math.round(weekly[0]?.totalSeconds ?? 0),
	}
}

async function getIntegrationMetrics(db: Database) {
	const [connected, byProvider] = await Promise.all([
		db.select({ count: count() }).from(integrations).where(eq(integrations.status, 'connected')),
		db
			.select({ provider: integrations.provider, count: count() })
			.from(integrations)
			.where(eq(integrations.status, 'connected'))
			.groupBy(integrations.provider),
	])

	return {
		connected: connected[0]?.count ?? 0,
		byProvider: byProvider.map((r) => ({ provider: r.provider, count: r.count })),
	}
}
