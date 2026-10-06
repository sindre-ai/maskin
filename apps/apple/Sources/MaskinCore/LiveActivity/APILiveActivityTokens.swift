import Foundation

/// Production `LiveActivityTokenRegistering` over plain `URLSession`. The generated client's
/// OpenAPI snapshot predates these routes, so this adapter owns the two small requests; swap it
/// for the generated operations when `openapi.json` is regenerated.
public struct APILiveActivityTokens: LiveActivityTokenRegistering {
	public struct Credentials: Sendable, Equatable {
		public var apiKey: String
		public var workspaceId: String?
		public init(apiKey: String, workspaceId: String?) {
			self.apiKey = apiKey
			self.workspaceId = workspaceId
		}
	}

	private let baseURL: URL
	private let clientSource: String
	private let credentials: @Sendable () async -> Credentials?
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping @Sendable () async -> Credentials?,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	struct Body: Codable, Equatable {
		var kind: String
		var device_id: String
		var session_id: String?
		var token: String
	}
	private struct Response: Decodable { var id: String }

	static func body(kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String)
		-> Body
	{
		Body(kind: kind.rawValue, device_id: deviceId, session_id: sessionId, token: token)
	}

	public func register(
		kind: LiveActivityTokenKind, deviceId: String, sessionId: String?, token: String
	) async throws -> String {
		var request = try await makeRequest("api/live-activities/tokens", method: "POST")
		request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONEncoder().encode(
			Self.body(kind: kind, deviceId: deviceId, sessionId: sessionId, token: token))
		let (data, response) = try await session.data(for: request)
		try Self.check(response)
		return try JSONDecoder().decode(Response.self, from: data).id
	}

	public func unregister(tokenId: String, credentials override: Credentials? = nil) async throws {
		// The id is server-issued; refuse anything that could alter the path.
		guard DeepLink.isSafeID(tokenId) else { return }
		let request = try await makeRequest(
			"api/live-activities/tokens/\(tokenId)", method: "DELETE", credentials: override)
		let (_, response) = try await session.data(for: request)
		if (response as? HTTPURLResponse)?.statusCode == 404 { return }  // already gone
		try Self.check(response)
	}

	private func makeRequest(_ path: String, method: String, credentials override: Credentials? = nil)
		async throws -> URLRequest
	{
		let live = await credentials()
		guard let creds = override ?? live else { throw URLError(.userAuthenticationRequired) }
		var request = URLRequest(url: baseURL.appendingPathComponent(path))
		request.httpMethod = method
		request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let ws = creds.workspaceId { request.setValue(ws, forHTTPHeaderField: "X-Workspace-Id") }
		return request
	}

	private static func check(_ response: URLResponse) throws {
		guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
			throw URLError(.badServerResponse)
		}
	}
}
