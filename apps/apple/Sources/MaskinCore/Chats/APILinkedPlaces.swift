import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Reads the agent and the chat a link points at, with the same calls the Agents and Chats screens
/// use. No server change: an agent is one actor read plus its newest session, a chat is one
/// conversation read plus its newest message.
public struct APILinkedPlacesRemote: LinkedPlacesRemote {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func agent(id: String) async throws -> LinkedAgent? {
		let output = try await client.get_sol_api_sol_actors_sol__lcub_id_rcub_(
			.init(path: .init(id: id), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		let row: Operations.get_sol_api_sol_actors_sol__lcub_id_rcub_.Output.Ok.Body.jsonPayload
		switch output {
		case .ok(let ok): row = try ok.body.json
		case .notFound: return nil
		default: throw AgentsError("Couldn't open this agent.")
		}
		// A person at an agent address is not an agent: the link stays a link.
		guard row._type == "agent" else { return nil }
		// A failed session read leaves the badge and the last-active fact out; it does not fail the card.
		var working: Bool?
		var lastActive: Date?
		do {
			let latest = try await APIAgentsSource(client: client, workspaceID: workspaceID).latestSession(agentID: id)
			let stored = AgentStatus(rawValue: row.agentState.rawValue) ?? .idle
			working = AgentStatusResolver.resolve(stored: stored, latest: latest) == .running
			lastActive = latest?.activityDate
		} catch {}
		return LinkedAgent(
			target: LinkedTarget(kind: .agent, uuid: row.id), name: row.name,
			summary: LinkedObject.summary(from: row.description), isWorking: working, lastActive: lastActive,
			skillCount: row.skills?.count ?? 0)
	}

	public func chat(id: String) async throws -> LinkedChat? {
		let output = try await client.get_sol_api_sol_conversations_sol__lcub_id_rcub_(
			.init(path: .init(id: id), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		let row: Operations.get_sol_api_sol_conversations_sol__lcub_id_rcub_.Output.Ok.Body.jsonPayload
		switch output {
		case .ok(let ok): row = try ok.body.json
		case .notFound: return nil
		case .undocumented(let status, _) where status == 403 || status == 404: return nil
		default: throw ChatsError("Couldn't open this conversation.")
		}
		// The newest message is a second read; without it the card shows the rest.
		let newest = try? await APIChatsSource(client: client, workspaceID: workspaceID)
			.messages(conversationID: id, beforeID: nil, afterID: nil, limit: 5).messages
			.last { $0.kind == "message" }
		return LinkedChat(
			target: LinkedTarget(kind: .chat, uuid: row.id), title: row.title, isPinned: row.pinned,
			isArchived: row.archived, lastAuthorID: newest?.actorID, lastAuthorName: newest?.actorName,
			lastAuthorIsAgent: newest?.author == .agent, lastText: LinkedChat.line(from: newest?.content),
			people: row.participants.map(\.actorName),
			updatedAt: ChatDates.parse(row.lastMessageAt) ?? ChatDates.parse(row.createdAt))
	}
}
