import { getEnvOrThrow } from '../env'
import type { WebhookConfig } from '../types'
import { verifyHmacSha1, verifyHmacSha256, verifyTimestampSignature } from './signatures'

export class WebhookHandler {
	/** Verify a webhook signature using the provider's configured scheme. */
	verify(config: WebhookConfig, body: string, headers: Record<string, string>): boolean {
		const secret = getEnvOrThrow(config.secretEnv)

		if (config.signatureScheme === 'timestamp') {
			if (
				!config.timestampHeader ||
				!config.timestampSignatureHeader ||
				!config.timestampBodyTemplate
			) {
				throw new Error(
					'timestampHeader, timestampSignatureHeader, and timestampBodyTemplate are required for timestamp scheme',
				)
			}
			return verifyTimestampSignature(body, headers, secret, {
				timestampHeader: config.timestampHeader,
				signatureHeader: config.timestampSignatureHeader,
				bodyTemplate: config.timestampBodyTemplate,
				signaturePrefix: config.timestampSignaturePrefix,
			})
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
