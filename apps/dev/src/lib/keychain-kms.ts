import { type KmsProvider, createKmsProvider } from '@maskin/auth/kms'
import { logger } from './logger'

let provider: KmsProvider | undefined

/** The process-wide key provider, built once from KEYCHAIN_MASTER_KEY. */
export function getKmsProvider(): KmsProvider {
	provider ??= createKmsProvider()
	return provider
}

/**
 * Called once at boot. A malformed key throws, so the process fails to start. An
 * unset key in production only warns: nothing reads it until the first envelope
 * write, and legacy credentials work without it.
 */
export function assertKeychainKeyConfig(
	env: Record<string, string | undefined> = process.env,
): void {
	if (env.KEYCHAIN_MASTER_KEY?.trim()) {
		createKmsProvider(env)
	} else if (env.NODE_ENV === 'production') {
		logger.warn('KEYCHAIN_MASTER_KEY is not set: Keychain envelope encryption is unavailable')
	}
}

/** For tests. */
export function setKmsProviderForTests(next: KmsProvider | undefined): void {
	provider = next
}
