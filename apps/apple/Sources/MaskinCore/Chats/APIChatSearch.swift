import Foundation
import MaskinAPI

/// Production `ChatSearching`: `GET /api/search?types=chat`. Plain `URLSession`, not the generated
/// client: the checked-in client is older than this route (same reason as `APIDeletionSource`).
/// Titles, people and message text are matched by the server, archived chats included.
public struct APIChatSearch: ChatSearching {
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

	public func search(query: String) async throws -> [ChatSearchHit] {
		let request = await makeRequest(query: query)
		let data: Data
		let status: Int
		do {
			let (body, response) = try await session.data(for: request)
			data = body
			status = (response as? HTTPURLResponse)?.statusCode ?? 0
		} catch {
			if error is CancellationError || (error as? URLError)?.code == .cancelled { throw error }
			throw ChatsError("Couldn't reach Maskin. Check your connection and try again.")
		}
		guard status == 200 else { throw ChatsError("Couldn't search chats.", status: status) }
		return try Self.decode(data)
	}

	/// Built apart from sending so tests can read the URL and headers.
	func makeRequest(query: String) async -> URLRequest {
		let url = baseURL.appendingPathComponent("api/search")
		var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
		parts?.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "types", value: "chat")]
		var request = URLRequest(url: parts?.url ?? url)
		request.httpMethod = "GET"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = creds.workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
		}
		return request
	}

	// MARK: Wire

	private struct Response: Decodable {
		var results: [Row]
	}

	private struct Row: Decodable {
		var id: String
		var title: String
		var sub: String?
		var snippet: String?
		var status: String
		var updatedAt: String?
	}

	static func decode(_ data: Data) throws -> [ChatSearchHit] {
		let response: Response
		do { response = try JSONDecoder().decode(Response.self, from: data) } catch {
			throw ChatsError("Maskin sent a reply this version can't read. Update the app and try again.")
		}
		return response.results.map { row in
			ChatSearchHit(
				id: row.id, title: row.title, people: row.sub, snippet: row.snippet,
				archived: row.status == "archived", updatedAt: row.updatedAt.flatMap(parseDate))
		}
	}

	/// The server sends ISO 8601 with milliseconds; accept it with or without them.
	static func parseDate(_ text: String) -> Date? {
		let fractional = ISO8601DateFormatter()
		fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = fractional.date(from: text) { return date }
		let plain = ISO8601DateFormatter()
		plain.formatOptions = [.withInternetDateTime]
		return plain.date(from: text)
	}
}
