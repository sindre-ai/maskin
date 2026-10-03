import Foundation
import MaskinAPI

/// Stops an agent turn from the Live Activity's Stop button, with no UI: reads the signed-in
/// session from the shared Keychain and calls `POST /api/sessions/{id}/stop`.
public struct TurnStopper: Sendable {
	private let secrets: any SecretStore
	private let makeAPI: @Sendable (StoredSession, String) -> any ChatAPI

	public init(secrets: any SecretStore, makeAPI: @escaping @Sendable (StoredSession, String) -> any ChatAPI) {
		self.secrets = secrets
		self.makeAPI = makeAPI
	}

	public static func production(baseURL: URL, clientSource: String, secrets: any SecretStore)
		-> TurnStopper
	{
		TurnStopper(secrets: secrets) { session, workspaceId in
			let client = MaskinClient.make(
				serverURL: baseURL, clientSource: clientSource,
				credentials: { MaskinCredentials(apiKey: session.apiKey, workspaceId: workspaceId) })
			return APIChatsSource(client: client, workspaceID: workspaceId)
		}
	}

	/// `true` when the server accepted the stop. Ids are validated before they reach a request.
	public func stop(sessionId: String, workspaceId: String) async -> Bool {
		guard DeepLink.isSafeID(sessionId), DeepLink.isSafeID(workspaceId),
			let data = try? secrets.read(),
			let session = try? JSONDecoder().decode(StoredSession.self, from: data),
			// The card may belong to another workspace than the one now signed in (switched or
			// re-signed-in since it started): never stop a turn with the wrong identity.
			session.workspaceId == workspaceId
		else { return false }
		do {
			try await makeAPI(session, workspaceId).stopSession(sessionID: sessionId)
			return true
		} catch { return false }
	}
}
