import Foundation
import MaskinAPI

/// What search needs to rank by what the person opened before (frecency). The server keeps one
/// decayed open count per person and result; the phone ranks on the device, so it reads the ranking
/// bonus of the caller's own opened results and reports each open from a search result.
public protocol SearchOpensRemote: Sendable {
	/// `GET /api/search/opens`: entity id to bonus points (already decayed and capped), best first.
	func bonuses() async throws -> [String: Int]
	/// `POST /api/search/opens`: the person opened this result from a search. Best effort.
	func recordOpen(entityId: String) async
}

/// Production `SearchOpensRemote`. Plain `URLSession`, not the generated client: the checked-in
/// client is older than these routes (same reason as `APIChatSearch`).
public struct APISearchOpens: SearchOpensRemote {
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

	public func bonuses() async throws -> [String: Int] {
		let request = await makeRequest(method: "GET", body: nil)
		let (data, response) = try await session.data(for: request)
		guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SearchError("Couldn't load search history.") }
		return try Self.decode(data)
	}

	public func recordOpen(entityId: String) async {
		guard let body = try? JSONEncoder().encode(["entity_id": entityId]) else { return }
		let request = await makeRequest(method: "POST", body: body)
		_ = try? await session.data(for: request)
	}

	/// Built apart from sending so tests can read the URL, method and headers.
	func makeRequest(method: String, body: Data?) async -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/search/opens"))
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = creds.workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
		}
		return request
	}

	private struct Response: Decodable {
		var opens: [Row]
	}

	private struct Row: Decodable {
		var entityId: String
		var bonus: Int

		enum CodingKeys: String, CodingKey {
			case entityId = "entity_id"
			case bonus
		}
	}

	static func decode(_ data: Data) throws -> [String: Int] {
		let response = try JSONDecoder().decode(Response.self, from: data)
		return Dictionary(response.opens.map { ($0.entityId, $0.bonus) }, uniquingKeysWith: max)
	}
}
