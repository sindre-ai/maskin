import Foundation
import MaskinAPI
import Observation

/// What "Create view with agent" needs from the server. A protocol so the store tests without one.
public protocol CreateViewSource: Sendable {
	/// The workspace's Design Studio agent, or nil when it has none.
	func designStudio(workspaceID: String) async throws -> ChatParticipant?
}

/// Who the "Create view with agent" item opens a chat with. The item shows only when the flag is
/// on for the person (read by `FeatureFlagStore`), they can write (not a viewer) and the workspace
/// has a Design Studio agent.
@MainActor
@Observable
public final class CreateViewStore {
	public private(set) var agent: ChatParticipant?
	@ObservationIgnored private let source: any CreateViewSource
	/// Only the latest load may write, so a slow answer for a workspace the person left is dropped.
	@ObservationIgnored private var generation = 0

	public init(source: any CreateViewSource) {
		self.source = source
	}

	/// Finds Design Studio. A failure leaves the item hidden.
	public func load(workspaceID: String?) async {
		generation += 1
		let mine = generation
		guard let workspaceID else { return reset() }
		let found = try? await source.designStudio(workspaceID: workspaceID)
		guard mine == generation else { return }
		agent = found
	}

	public func reset() {
		generation += 1
		agent = nil
	}

	/// The agent to open the chat with, or nil when the flag is off or the item should not show
	/// for this role.
	public func agent(forRole role: String?, flagOn: Bool) -> ChatParticipant? {
		flagOn && role != "viewer" ? agent : nil
	}
}

/// Production source: the generated client stays in this file.
public struct APICreateViewSource: CreateViewSource {
	private let client: Client

	public init(client: Client) {
		self.client = client
	}

	public func designStudio(workspaceID: String) async throws -> ChatParticipant? {
		var offset = 0
		let pageSize = 100
		while offset < 10_000 {
			let output = try await client.get_sol_api_sol_actors(
				.init(
					query: .init(limit: pageSize, offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
			guard case .ok(let ok) = output else { return nil }
			let rows = try ok.body.json
			if let found = rows.first(where: { $0._type == "agent" && $0.name == CreateViewMessage.agentName }) {
				return ChatParticipant(id: found.id, name: found.name, kind: .agent)
			}
			if rows.count < pageSize { break }
			offset += pageSize
		}
		return nil
	}
}
