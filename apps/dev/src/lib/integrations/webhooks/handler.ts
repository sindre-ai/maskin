import type { WebhookConfig } from '../types'
import { verifyHmacSha1, verifyHmacSha256, verifyTimestampSignature } from './signatures'

export class WebhookHandler {
	/**
	 * Verify a webhook signature using the provider's configured scheme.
	 * Returns false for 'custom' scheme — custom providers must handle verification themselves.
	 */
	verify(config: WebhookConfig, body: string, headers: Record<string, string>): boolean {
		const secret = process.env[config.secretEnv]
		if (!secret) {
			throw new Error(`${config.secretEnv} environment variable is required for webhook verification`)
		}

		if (config.signatureScheme === 'timestamp') {
			return verifyTimestampSignature(body, headers, secret)
		}

		if (config.signatureScheme === 'custom') {
			return false
		}

		const signature = headers[config.signatureHeader]
		if (!signature) return false

		switch (config.signatureScheme) {
			case 'hmac-sha256':
				return verifyHmacSha256(body, signature, secret, config.signaturePrefix)
			case 'hmac-sha1':
				return verifyHmacSha1(body, signature, secret, config.signaturePrefix)
		}
	}
}
