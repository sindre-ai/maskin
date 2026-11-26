import Foundation
import MaskinAPI

/// The chat list's attention fields (`needs_you`, `working`, `later`, `error`), the Later list and
/// the Later flag. Plain `URLSession` rather than the generated client, like `APIChatSearch`: the
/// checked-in client is older than these fields, and a generated row would drop them. The columns
/// the list already read keep their meaning; the new ones are read when the server sends them.
public struct APIChatAttention: Sendable {
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

	/// `GET /api/conversations`. `later` asks for the chats on Later only; the other lists leave
	/// them out. Flags are sent only when true: the server reads any present value as true.
	public func page(
		archived: Bool, pinnedOnly: Bool, unreadOnly: Bool, hideQuiet: Bool, later: Bool, limit: Int,
		offset: Int
	) async throws -> ConversationPage {
		var parts = URLComponents(
			url: baseURL.appendingPathComponent("api/conversations"), resolvingAgainstBaseURL: false)
		var items: [URLQueryItem] = []
		if pinnedOnly { items.append(URLQueryItem(name: "pinned", value: "true")) }
		if archived { items.append(URLQueryItem(name: "archived", value: "true")) }
		if unreadOnly { items.append(URLQueryItem(name: "unread_only", value: "true")) }
		if hideQuiet { items.append(URLQueryItem(name: "hide_quiet", value: "true")) }
		if later { items.append(URLQueryItem(name: "later", value: "true")) }
		items.append(URLQueryItem(name: "limit", value: String(min(limit, ChatLimits.maxConversationsPage))))
		items.append(URLQueryItem(name: "offset", value: String(offset)))
		parts?.queryItems = items
		let data = try await send(await makeRequest(url: parts?.url, method: "GET", body: nil), failure: "Couldn't load conversations.")
		return try Self.decode(data)
	}

	/// `PATCH /api/conversations/{id}/me` with `later`: the caller's own flag.
	public func setLater(conversationID: String, later: Bool) async throws {
		let body = try JSONEncoder().encode(["later": later])
		let url = baseURL.appendingPathComponent("api/conversations/\(conversationID)/me")
		_ = try await send(
			await makeRequest(url: url, method: "PATCH", body: body), failure: "Couldn't update the conversation.")
	}

	/// Built apart from sending so tests can read the URL and headers.
	func makeRequest(url: URL?, method: String, body: Data?) async -> URLRequest {
		var request = URLRequest(url: url ?? baseURL)
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let body {
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			// Writes carry an idempotency key, so a retry cannot apply twice.
			request.setValue(IdempotencyKey.make(), forHTTPHeaderField: "Idempotency-Key")
		}
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = creds.workspaceId { request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id") }
		}
		return request
	}

	private func send(_ request: URLRequest, failure: String) async throws -> Data {
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
		guard (200..<300).contains(status) else { throw ChatsError(failure, status: status) }
		return data
	}

	// MARK: Wire

	private struct Page: Decodable {
		var conversations: [Row]
		var has_more: Bool
	}

	private struct Row: Decodable {
		var id: String
		var title: String
		var lastMessageAt: String?
		var createdAt: String?
		var pinned: Bool
		var archived: Bool
		var unread_count: Double
		var snippet: String?
		var snippet_actor_name: String?
		var snippet_actor_id: String?
		var directPairKey: String?
		var tags: [String]?
		var participants: [Person]
		var working: [Working]?
		var needs_you: Bool?
		var later: Bool?
		var error: Failure?
	}

	private struct Person: Decodable {
		var actorId: String
		var actorName: String
		var actorType: String
	}

	private struct Working: Decodable {
		var agent_id: String
		var session_id: String
	}

	private struct Failure: Decodable {
		var reason: String?
		var last_person_message_id: Int?
	}

	/// Rows as the list shows them. Fields an older server does not send read as off.
	static func decode(_ data: Data) throws -> ConversationPage {
		let page: Page
		do { page = try JSONDecoder().decode(Page.self, from: data) } catch {
			throw ChatsError("Couldn't read the conversations.")
		}
		return ConversationPage(
			conversations: page.conversations.map { row in
				ConversationSummary(
					id: row.id, title: row.title, lastMessageAt: ChatDates.parse(row.lastMessageAt),
					createdAt: ChatDates.parse(row.createdAt), pinned: row.pinned, archived: row.archived,
					unreadCount: Int(row.unread_count), snippet: row.snippet,
					snippetActorName: row.snippet_actor_name, snippetActorID: row.snippet_actor_id,
					directPairKey: row.directPairKey,
					participants: row.participants.map {
						ChatParticipant(id: $0.actorId, name: $0.actorName, actorType: $0.actorType)
					},
					needsYou: row.needs_you ?? false,
					working: (row.working ?? []).map { ChatWorkingAgent(agentID: $0.agent_id, sessionID: $0.session_id) },
					later: row.later ?? false,
					stopReason: row.error.map { ChatStopReason(serverValue: $0.reason) },
					retryMessageID: row.error?.last_person_message_id, tags: row.tags ?? [])
			},
			hasMore: page.has_more)
	}
}
