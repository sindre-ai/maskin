export { createMcpServer, getServerHandlers } from './server.js'
export type { McpConfig, McpToolHandler } from './server.js'
export { tools } from './tools.js'

// CTO pre-req 1 for Voice v1 (bet 16bd0042). Extracted so both the stdio
// transport (via createMcpServer) and the voice tool-proxy (Task 3) dispatch
// tools through the same wrapped handler map — no drift between "chat" and
// "voice" tool behaviour. See ./invoke.ts for the shape.
export {
	UnknownToolError,
	createInvokeTool,
	invokeTool,
	_resetInvokeToolForTests,
} from './invoke.js'
export type { InvokeContext, InvokeTool } from './invoke.js'

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

// Voice v1 Task 3: the tool whitelist + guardrails, and the Realtime tool
// definitions / argument gate the WS tool-proxy in apps/dev runs before calling
// invokeTool. One source of truth so session-mint (pins session.tools) and the
// proxy (re-enforces per call) cannot drift.
export {
	VOICE_ALLOWED_TOOLS,
	VOICE_CREATE_COMMENT_MAX_ATTENTION,
	VOICE_CREATE_OBJECTS_ALLOWED_TYPES,
	VOICE_READ_TOOLS,
	VOICE_TOOL_ERROR_CODES,
	VOICE_WRITE_TOOLS,
	VoiceToolNotAllowedError,
	assertVoiceInvocationAllowed,
	isVoiceAllowedTool,
} from './voice-tool-whitelist.js'
export type { VoiceAllowedTool, VoiceToolErrorCode } from './voice-tool-whitelist.js'
export { VOICE_REALTIME_TOOLS, parseVoiceToolArgs } from './voice-tools.js'
export type { VoiceRealtimeTool } from './voice-tools.js'
