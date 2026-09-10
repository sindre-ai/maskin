export { createMcpServer } from './server.js'
export { tools } from './tools.js'

// R11-A · LinkedIn fan-out foundation exports.
// Kept out of any barrel that a non-linkedin caller would import so the type
// surface stays small — the linkedin-unipile provider (apps/dev) imports them
// under a linkedin/ subpath instead.
export type {
	LinkedInIdentityType,
	LinkedInMcpInstanceConfig,
	LinkedInPhase1Verb,
} from './lib/linkedin-mcp-context.js'
export {
	LINKEDIN_PHASE1_VERBS,
	instanceSlug,
	toolName,
} from './lib/linkedin-mcp-context.js'
export { toolsForIdentity } from './linkedin/register.js'
export {
	__resetLinkedInMcpRegistryForTests,
	deregisterLinkedInMcpInstancesForIntegration,
	getLinkedInMcpInstancesForIntegration,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
} from './lib/registry.js'
