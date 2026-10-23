import Foundation
import MaskinAPI

/// Production `DeletionAPI`. Plain `URLSession` requests, not the generated client: these routes
/// are newer than the checked-in OpenAPI snapshot, and the generated client's middleware ends the
/// session on ANY 401, which here means "wrong password", not "signed out".
///
/// Error messages are fixed sentences or the server's own `error.message`; the password is never
/// logged or interpolated into anything.
public struct APIDeletionSource: DeletionAPI {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func accountPreview(deleteSoleWorkspaces: Bool) async throws -> AccountDeletionPreview {
		let (data, status) = try await send(
			"GET", "api/account/deletion-preview",
			query: deleteSoleWorkspaces ? [URLQueryItem(name: "delete_sole_workspaces", value: "true")] : [])
		guard status == 200 else { throw Self.error(status: status, data: data, fallback: "Couldn't check your account.") }
		return try Self.decode(AccountDeletionPreview.self, data)
	}

	public func deleteAccount(password: String, deleteSoleWorkspaces: Bool, idempotencyKey: String)
		async throws
	{
		let body = try JSONEncoder().encode(
			AccountDeleteBody(password: password, deleteSoleWorkspaces: deleteSoleWorkspaces))
		let (data, status) = try await send(
			"POST", "api/account/delete", body: body, idempotencyKey: idempotencyKey)
		guard status == 200 else {
			if status == 401 { throw DeletionError.wrongPassword }
			throw Self.error(status: status, data: data, fallback: "Couldn't delete your account.")
		}
	}

	public func workspacePreview(workspaceId: String) async throws -> WorkspaceDeletionPreview {
		let (data, status) = try await send("GET", "api/workspaces/\(workspaceId)/deletion-preview")
		guard status == 200 else { throw Self.error(status: status, data: data, fallback: "Couldn't check this workspace.") }
		return try Self.decode(WorkspaceDeletionPreview.self, data)
	}

	public func deleteWorkspace(workspaceId: String, confirmName: String, idempotencyKey: String)
		async throws
	{
		let body = try JSONEncoder().encode(WorkspaceDeleteBody(confirmName: confirmName))
		let (data, status) = try await send(
			"POST", "api/workspaces/\(workspaceId)/delete", body: body, idempotencyKey: idempotencyKey)
		guard status == 200 else {
			throw Self.error(status: status, data: data, fallback: "Couldn't delete the workspace.")
		}
	}

	// MARK: Wire

	struct AccountDeleteBody: Encodable {
		var password: String
		var deleteSoleWorkspaces: Bool
		enum CodingKeys: String, CodingKey {
			case password, deleteSoleWorkspaces = "delete_sole_workspaces"
		}
	}

	struct WorkspaceDeleteBody: Encodable {
		var confirmName: String
		enum CodingKeys: String, CodingKey { case confirmName = "confirm_name" }
	}

	/// Built apart from sending so tests can read the headers and body.
	func makeRequest(
		_ method: String, _ path: String, body: Data?, idempotencyKey: String?,
		query: [URLQueryItem] = []
	) async -> URLRequest {
		var url = baseURL.appendingPathComponent(path)
		if !query.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
			parts.queryItems = query
			url = parts.url ?? url
		}
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		}
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
		return request
	}

	private func send(
		_ method: String, _ path: String, body: Data? = nil, idempotencyKey: String? = nil,
		query: [URLQueryItem] = []
	) async throws -> (Data, Int) {
		let request = await makeRequest(
			method, path, body: body, idempotencyKey: idempotencyKey, query: query)
		do {
			let (data, response) = try await session.data(for: request)
			return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
		} catch {
			throw DeletionError("Couldn't reach Maskin. Check your connection and try again.")
		}
	}

	static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
		do { return try JSONDecoder().decode(type, from: data) } catch {
			throw DeletionError("Maskin sent a reply this version can't read. Update the app and try again.")
		}
	}

	private struct ErrorEnvelope: Decodable {
		struct Inner: Decodable { var message: String? }
		var error: Inner?
	}

	/// The server's own sentence when it sent one (409 and 403 explain themselves), else fixed copy.
	static func error(status: Int, data: Data, fallback: String) -> DeletionError {
		let server = (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error?.message
		let clean = server?.trimmingCharacters(in: .whitespacesAndNewlines)
		switch status {
		case 401: return DeletionError("Your session has ended. Log in again.")
		case 404: return DeletionError("That workspace isn't available to you any more.")
		case 429: return DeletionError("Too many attempts. Wait a minute and try again.")
		case 400, 403, 409:
			if let clean, !clean.isEmpty { return DeletionError(clean) }
			if status == 403 { return DeletionError("You can't do that here.") }
			if status == 409 { return DeletionError("Something is blocking this. Check the list and try again.") }
			return DeletionError(fallback)
		default: return DeletionError(fallback)
		}
	}
}
