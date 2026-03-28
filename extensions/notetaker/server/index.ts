import { createDecipheriv } from 'node:crypto'
import { integrations } from '@ai-native/db/schema'
import type { ModuleDefinition, ModuleEnv } from '@ai-native/module-sdk'
import { OpenAPIHono } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import { MODULE_ID, MODULE_NAME } from '../shared.js'
import healthRoutes from './routes/health.js'
import { createProcessRoutes } from './routes/process.js'
import { createSyncRoutes } from './routes/sync.js'
import { createUploadRoutes } from './routes/upload.js'
import type { GetTokenFn } from './services/scheduler.js'

/**
 * Decrypt integration credentials using the platform's encryption key.
 * Uses AES-256-GCM matching apps/dev/src/lib/crypto.ts format.
 */
function decryptCredentials(ciphertext: string): string {
	const key = process.env.INTEGRATION_ENCRYPTION_KEY
	if (!key) throw new Error('INTEGRATION_ENCRYPTION_KEY not set')
	const keyBuf = Buffer.from(key, 'hex')
	const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':')
	if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid ciphertext')
	const decipher = createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivHex, 'hex'), {
		authTagLength: 16,
	})
	decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
	const decrypted = Buffer.concat([
		decipher.update(Buffer.from(encryptedHex, 'hex')),
		decipher.final(),
	])
	return decrypted.toString('utf8')
}

/** Create a getToken function that reads credentials from the integrations table. */
function createTokenGetter(env: ModuleEnv): GetTokenFn {
	return async (integrationId: string) => {
		const [integration] = await env.db
			.select({ credentials: integrations.credentials })
			.from(integrations)
			.where(eq(integrations.id, integrationId))
			.limit(1)

		if (!integration) throw new Error(`Integration ${integrationId} not found`)

		const creds = JSON.parse(decryptCredentials(integration.credentials)) as {
			accessToken?: string
		}
		if (!creds.accessToken) throw new Error(`No access token for integration ${integrationId}`)
		return creds.accessToken
	}
}

function createRoutes(env: ModuleEnv) {
	const app = new OpenAPIHono()
	app.route('/', healthRoutes)
	app.route('/', createUploadRoutes(env))
	app.route('/', createProcessRoutes(env))
	app.route('/', createSyncRoutes(env, createTokenGetter(env)))
	return app
}

const notetakerExtension: ModuleDefinition = {
	id: MODULE_ID,
	name: MODULE_NAME,
	version: '0.1.0',
	objectTypes: [
		{
			type: 'meeting',
			label: 'Meeting',
			icon: 'video',
			defaultStatuses: ['scheduled', 'recording', 'transcribing', 'completed', 'failed'],
		},
	],
	routes: createRoutes,
	defaultSettings: {
		display_names: {
			meeting: 'Meeting',
		},
		statuses: {
			meeting: ['scheduled', 'recording', 'transcribing', 'completed', 'failed'],
		},
	},
}

export default notetakerExtension
