import Foundation
import MaskinAPI

/// `POST /api/sessions/{id}/pause`, behind a protocol so the pauser tests without a server.
public protocol SessionPausing: Sendable {
	func pause(sessionID: String) async throws
}

/// Production `SessionPausing` over the generated client. Generated operation names stay here.
public struct APISessionPauser: SessionPausing {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func pause(sessionID: String) async throws {
		let output = try await client.post_sol_api_sol_sessions_sol__lcub_id_rcub__sol_pause(
			.init(path: .init(id: sessionID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok = output else { throw AgentsError("Couldn't pause the agent.") }
	}
}

/// Pauses agents from the Live Activity's Pause buttons, with no UI: reads the signed-in session
/// from the shared Keychain and pauses each session. "Pause all" is this with every agent's
/// session; the calls run together and one refusal does not stop the others.
public struct SessionPauser: Sendable {
	private let secrets: any SecretStore
	private let makeAPI: @Sendable (StoredSession, String) -> any SessionPausing

	public init(
		secrets: any SecretStore, makeAPI: @escaping @Sendable (StoredSession, String) -> any SessionPausing
	) {
		self.secrets = secrets
		self.makeAPI = makeAPI
	}

	public static func production(baseURL: URL, clientSource: String, secrets: any SecretStore)
		-> SessionPauser
	{
		SessionPauser(secrets: secrets) { session, workspaceId in
			let client = MaskinClient.make(
				serverURL: baseURL, clientSource: clientSource,
				credentials: { MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId) })
			return APISessionPauser(client: client, workspaceID: workspaceId)
		}
	}

	/// The session ids the server paused. Ids are validated before they reach a request, and the
	/// card may belong to another workspace than the one now signed in (switched or re-signed-in
	/// since it started): nothing is paused with the wrong identity.
	public func pause(sessionIds: [String], workspaceId: String) async -> [String] {
		guard DeepLink.isSafeID(workspaceId),
			let data = try? secrets.read(),
			let session = try? JSONDecoder().decode(StoredSession.self, from: data),
			session.workspaceId == workspaceId
		else { return [] }
		let api = makeAPI(session, workspaceId)
		let ids = Array(Set(sessionIds.filter(DeepLink.isSafeID)))
		let paused = await withTaskGroup(of: String?.self) { group in
			for id in ids {
				group.addTask {
					do {
						try await api.pause(sessionID: id)
						return id
					} catch { return nil }
				}
			}
			var out: [String] = []
			for await id in group { if let id { out.append(id) } }
			return out
		}
		return paused.sorted()
	}
}
