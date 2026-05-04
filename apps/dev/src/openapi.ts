import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { type AppDeps, createApp, getOpenApiConfig } from './app-factory'
import type { AgentStorageManager } from './services/agent-storage'
import type { SessionManager } from './services/session-manager'

/**
 * Build no-op stub deps. `getOpenAPI31Document()` only reads route metadata —
 * it never invokes handlers or middleware — so every field can be an empty
 * placeholder. The cast goes via `unknown` because nothing inside the spec
 * generation touches these objects.
 */
function createStubDeps(): AppDeps {
	return {
		db: {} as unknown as Database,
		notifyBridge: {} as unknown as PgNotifyBridge,
		sessionManager: {} as unknown as SessionManager,
		agentStorage: {} as unknown as AgentStorageManager,
		storageProvider: {} as unknown as StorageProvider,
	}
}

/**
 * Build the OpenAPI 3.1 document from the same `createApp` used at runtime,
 * without booting Postgres, S3, or Docker. Intended for tooling that dumps
 * the spec to JSON for SDK generation.
 *
 * Return type is widened to `Record<string, unknown>` so consumers don't pull
 * in `openapi3-ts` as a transitive type dependency — the value is serialized
 * straight to JSON anyway.
 */
export function buildOpenAPIDocument(): Record<string, unknown> {
	const app = createApp(createStubDeps(), { includeExtensions: false })
	return app.getOpenAPI31Document(getOpenApiConfig()) as unknown as Record<string, unknown>
}
