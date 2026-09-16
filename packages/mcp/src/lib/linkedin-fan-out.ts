/**
 * R11-A · Barrel export for the LinkedIn fan-out primitives.
 *
 * Split out from `src/index.ts` on purpose. `index.ts` pulls in `server.ts`
 * and its transitive dependencies (`@maskin/shared`, `@maskin/module-sdk`)
 * — the whole platform MCP surface. Any caller that only needs the LinkedIn
 * fan-out types + filter + registry (the linkedin-unipile provider in
 * apps/dev, and the R11 test suites) should import from
 * `@maskin/mcp/linkedin` instead so those transitive deps don't have to be
 * built for a LinkedIn-only vitest run.
 */

export type {
	LinkedInIdentityType,
	LinkedInMcpInstanceConfig,
	LinkedInPhase1Verb,
	LinkedInPhase2Verb,
	LinkedInVerb,
} from './linkedin-mcp-context.js'
export {
	LINKEDIN_ALL_VERBS,
	LINKEDIN_PHASE1_VERBS,
	LINKEDIN_PHASE2_VERBS,
	instanceSlug,
	toolName,
} from './linkedin-mcp-context.js'
export { toolsForIdentity } from '../linkedin/register.js'
export {
	__resetLinkedInMcpRegistryForTests,
	deregisterLinkedInMcpInstance,
	deregisterLinkedInMcpInstancesForIntegration,
	getLinkedInMcpInstancesForIntegration,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
} from './registry.js'
