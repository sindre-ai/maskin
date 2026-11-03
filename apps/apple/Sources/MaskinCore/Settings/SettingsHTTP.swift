import Foundation
import MaskinAPI

/// A thin `URLSession` transport for Settings routes newer than the checked-in OpenAPI snapshot.
/// Stamps the bearer key, the client source and (when set) the workspace header. Error text is
/// fixed sentences: no bodies, ids or keys are ever interpolated.
public struct SettingsHTTP: Sendable {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let workspaceID: String?
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		workspaceID: String? = nil, session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.workspaceID = workspaceID
		self.session = session
	}

	func makeRequest(
		_ method: String, _ path: String, body: Data? = nil, key: String? = nil,
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
		if let workspaceID { request.setValue(workspaceID, forHTTPHeaderField: "X-Workspace-Id") }
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		}
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
		return request
	}

	public func send(
		_ method: String, _ path: String, body: Data? = nil, key: String? = nil,
		query: [URLQueryItem] = []
	) async throws -> (Data, Int) {
		let request = await makeRequest(method, path, body: body, key: key, query: query)
		do {
			let (data, response) = try await session.data(for: request)
			return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
		} catch {
			throw SettingsError("Couldn't reach Maskin. Check your connection and try again.")
		}
	}

	public static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
		do { return try JSONDecoder().decode(type, from: data) } catch {
			throw SettingsError("Maskin sent a reply this version can't read. Update the app and try again.")
		}
	}

	/// The server's own `error.message` when it sent one.
	public static func serverMessage(_ data: Data) -> String? {
		struct Envelope: Decodable {
			struct Inner: Decodable { var message: String? }
			var error: Inner?
		}
		let text = (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.message?
			.trimmingCharacters(in: .whitespacesAndNewlines)
		return (text?.isEmpty == false) ? text : nil
	}

	/// Shared wording for statuses that mean the same thing everywhere.
	public static func error(status: Int, data: Data, fallback: String) -> SettingsError {
		switch status {
		case 401: SettingsError("Your session has ended. Log in again.")
		case 429: SettingsError("Too many attempts. Wait a minute and try again.")
		case 400, 403, 409:
			SettingsError(serverMessage(data) ?? (status == 403 ? "You can't do that here." : fallback))
		default: SettingsError(fallback)
		}
	}
}
