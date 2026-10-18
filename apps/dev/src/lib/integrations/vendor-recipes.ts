import type { WebhookConfig } from './types'

/**
 * Pre-fill values for the bring-your-own extension modal ("Start from a
 * recipe..."). A recipe is a starting point the owner can edit, not a runtime
 * source of truth. Hardcoded on purpose: a vendor_recipes table is not worth
 * it until a third vendor lands (tech spec 5b).
 */
export type VendorRecipe = {
	slug: string
	displayName: string
	mcpConfig?: {
		server: {
			type: 'stdio'
			command: string
			args: string[]
			/** Env var the stdio server reads its auth header from; value comes from the credential. */
			envFromCredential: string
		}
		credentialProvider: string
		autoInject: boolean
	}
	webhookConfig?: {
		signatureScheme: WebhookConfig['signatureScheme']
		signatureHeader: string
		signaturePrefix?: string
		secretSource: 'env' | 'credential'
		eventMap: {
			/** JSONPath into the delivery payload for the dedup id. */
			externalIdPath: string
			entityType: { literal: string } | { path: string }
			action: { literal: string } | { path: string }
		}
	}
	docsUrl: string
}

export const VENDOR_RECIPES: VendorRecipe[] = [
	{
		slug: 'fireflies',
		displayName: 'Fireflies',
		mcpConfig: {
			server: {
				type: 'stdio',
				command: 'npx',
				args: ['mcp-remote', 'https://api.fireflies.ai/mcp'],
				envFromCredential: 'AUTHORIZATION',
			},
			credentialProvider: 'extension-mcp:fireflies',
			autoInject: true,
		},
		// Fireflies V2 signs the raw body with HMAC-SHA256, no timestamp. The
		// completion event is meeting.transcribed with payload
		// { event, timestamp, meeting_id, client_reference_id? }.
		webhookConfig: {
			signatureScheme: 'hmac-sha256',
			signatureHeader: 'X-Hub-Signature',
			signaturePrefix: 'sha256=',
			secretSource: 'credential',
			eventMap: {
				externalIdPath: '$.meeting_id',
				entityType: { literal: 'fireflies.transcript' },
				action: { literal: 'ready' },
			},
		},
		docsUrl: 'https://docs.fireflies.ai/graphql-api/webhooks-v2',
	},
]
