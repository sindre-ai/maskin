import Foundation
import MaskinAPI

/// Production `KeychainAPI`. The list, access, remove and activity calls use the generated client.
/// Adding a credential has no request body in the API description (the server reads and zeroes the
/// raw bytes, as for `chat-capture`), so that one is built by hand; nothing here logs or keeps a value.
public struct APIKeychainSource: KeychainAPI {
	private let client: Client
	private let workspaceID: String
	private let baseURL: URL
	private let clientSource: String
	private let credentialsProvider: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		client: Client, workspaceID: String, baseURL: URL, clientSource: String,
		credentials: @escaping MaskinCredentialsProvider, session: URLSession = .shared
	) {
		self.client = client
		self.workspaceID = workspaceID
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentialsProvider = credentials
		self.session = session
	}

	public func credentials() async throws -> [KeychainCredential] {
		let output = try await client.get_sol_api_sol_integrations(
			.init(headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw KeychainAccessError("Couldn't load your credentials.") }
		return try ok.body.json.compactMap { row in
			// The Keychain lists what a member holds (pasted or chat-captured), not the registered providers,
			// and not a key that was undone (the row is kept for the audit chain, the key is gone).
			guard let mode = row.providerMode?.rawValue, let kind = KeychainCredential.Kind(rawValue: mode),
				row.status != "undone"
			else { return nil }
			let name = row.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
			return KeychainCredential(
				id: row.id, name: (name?.isEmpty == false ? name : nil) ?? "Credential", kind: kind,
				capturedViaChat: row.source == "chat_capture", createdAt: ChatDates.parse(row.createdAt),
				createdByID: row.createdBy ?? "", agentIDs: (row.agentGrants ?? []).map(\.actorId))
		}
	}

	public func agents() async throws -> [KeychainAgent] {
		try await APISettingsSource(client: client, workspaceID: workspaceID)
			.list(workspaceId: workspaceID).filter(\.isAgent).map { KeychainAgent(id: $0.actorId, name: $0.name) }
	}

	public func setAgents(credentialID: String, agentIDs: [String]) async throws {
		let output = try await client.put_sol_api_sol_integrations_sol__lcub_id_rcub__sol_grants(
			.init(
				path: .init(id: credentialID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
				body: .json(.init(grants: agentIDs.map { .init(actorId: $0, access: .read_write) }))))
		switch output {
		case .ok: return
		case .forbidden: throw KeychainAccessError("Only a person can change who can use a credential.")
		default: throw KeychainAccessError("Couldn't update access.")
		}
	}

	public func remove(credentialID: String) async throws {
		let output = try await client.post_sol_api_sol_integrations_sol__lcub_id_rcub__sol_remove(
			.init(path: .init(id: credentialID), headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok = output else { throw KeychainAccessError("Couldn't remove it.") }
	}

	public func audit(credentialID: String, before: String?) async throws -> KeychainAuditPage {
		let output = try await client.get_sol_api_sol_integrations_sol__lcub_id_rcub__sol_audit_hyphen_log(
			.init(
				path: .init(id: credentialID), query: .init(limit: 25, before_id: before),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		guard case .ok(let ok) = output else { throw KeychainAccessError("Couldn't load the activity.") }
		let page = try ok.body.json
		return KeychainAuditPage(
			entries: page.entries.map {
				KeychainAuditEntry(
					id: $0.id, actorID: $0.actorId, action: KeychainAuditEntry.Action(rawValue: $0.action),
					sessionID: $0.sessionId, outboundTarget: $0.outboundTarget, viaChat: $0.source == "chat_capture",
					at: ChatDates.parse($0.readAt))
			}, nextBeforeID: page.nextBeforeId)
	}

	public func add(name: String, value: KeychainNewValue) async throws -> String {
		var body: [String: Any] = ["displayName": name]
		let path: String
		switch value {
		case .apiKey(let secret):
			path = "api/integrations/byo-apikey"
			body["detectedProvider"] = "manual"
			body["rawSecret"] = secret
		case .login(let username, let password):
			path = "api/integrations/byo-login"
			body["username"] = username
			body["password"] = password
		}
		var request = URLRequest(url: baseURL.appendingPathComponent(path))
		request.httpMethod = "POST"
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
		if let creds = await credentialsProvider() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			request.setValue(creds.workspaceId ?? workspaceID, forHTTPHeaderField: "X-Workspace-Id")
		}
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch {
			throw KeychainAccessError("Couldn't reach Maskin. Check your connection and try again.")
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else {
			throw KeychainAccessError(APIKeychainCaptureSource.failure(status: status, body: data))
		}
		struct Saved: Decodable { var integrationId: String }
		return (try? JSONDecoder().decode(Saved.self, from: data))?.integrationId ?? ""
	}
}
