/** Re-export API types for use in MCP apps without depending on api.ts auth/fetch logic */
export type {
	ObjectResponse,
	ActorResponse,
	ActorListItem,
	ActorWithKey,
	WorkspaceResponse,
	WorkspaceWithRole,
	MemberResponse,
	RelationshipResponse,
	TriggerResponse,
	EventResponse,
} from '@/lib/api'
