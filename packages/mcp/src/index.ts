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

// R11-B (LinkedIn attachments + destructive post CRUD schemas). Re-exported
// through the package's public entry so `apps/dev`'s in-process LinkedIn MCP
// shell — and R11-A's per-identity registrar when it lands — can import the
// same Zod shapes without a second copy drifting.
export {
	IMAGE_MIME_TYPES,
	LINKEDIN_ATTACHMENT_MIME_TYPES,
	LINKEDIN_ATTACHMENT_SEND_MODES,
	LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE,
	VIDEO_MIME_TYPES,
	DOCUMENT_MIME_TYPES,
	isImageAttachment,
	linkedinAttachmentSchema,
	linkedinAttachmentsArraySchema,
} from './lib/linkedin-attachments.js'
export type {
	LinkedInAttachment,
	LinkedInAttachmentMimeType,
	LinkedInAttachmentSendMode,
	LinkedInAttachmentsArray,
} from './lib/linkedin-attachments.js'
export {
	FORBIDDEN_IDENTITY_PER_CALL_FIELDS,
	LINKEDIN_CAN_COMMENT_VALUES,
	LINKEDIN_MESSAGE_MAX_CHARS,
	LINKEDIN_POST_MAX_CHARS,
	LINKEDIN_R11_INPUT_SHAPES,
	deletePostInputSchema,
	deletePostInputShape,
	editPostInputSchema,
	editPostInputShape,
	publishPostInputSchema,
	publishPostInputShape,
	sendMessageInputSchema,
	sendMessageInputShape,
} from './lib/linkedin-tool-schemas.js'
export type {
	DeletePostInput,
	EditPostInput,
	LinkedInCanComment,
	PublishPostInput,
	SendMessageInput,
} from './lib/linkedin-tool-schemas.js'
