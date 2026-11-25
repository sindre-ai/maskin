import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `SearchRemote`. The server search (`GET /api/search`) goes through a plain
/// `URLSession`, not the generated client: the checked-in client is older than that route (same
/// reason as `APIChatSearch`). Files and the @ menu's people use the generated client. Responses are
/// re-decoded into the small DTOs below so generated payload types never leak.
public struct APISearchRemote: SearchRemote {
	private let client: Client
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession
	/// The most rows the server search returns (`limit` in its query).
	private static let maxLimit = 150

	public init(
		client: Client, baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.client = client
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	private func workspaceHeader() async -> String { await credentials()?.workspaceId ?? "" }

	public func search(query: String, participants: [String], limit: Int) async throws -> SearchAnswer {
		let request = await makeRequest(query: query, participants: participants, limit: limit)
		let data: Data
		let status: Int
		do {
			let (body, response) = try await session.data(for: request)
			data = body
			status = (response as? HTTPURLResponse)?.statusCode ?? 0
		} catch {
			if RemoteFailure.isCancellation(error) { throw error }
			throw RemoteFailure.searchError(error)
		}
		guard status == 200 else { throw SearchError("Search failed.") }
		return try Self.decode(data)
	}

	/// Built apart from sending so tests can read the URL and headers. No statuses are sent, so the
	/// server applies its default, the same as the web Search page (archived chats stay out).
	func makeRequest(query: String, participants: [String], limit: Int) async -> URLRequest {
		let url = baseURL.appendingPathComponent("api/search")
		var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
		var items = [URLQueryItem(name: "limit", value: String(min(limit, Self.maxLimit)))]
		if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
		if !participants.isEmpty { items.append(URLQueryItem(name: "participants", value: participants.joined(separator: ","))) }
		parts?.queryItems = items
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

	public func searchFiles(query: String, limit: Int) async throws -> [SearchResult] {
		let workspace = await workspaceHeader()
		do {
			let output = try await client.get_sol_api_sol_files(
				.init(
					query: .init(q: query, limit: min(limit, ServerLimits.maxPageSize)),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw SearchError("Search failed.") }
			return try Self.convert(ok.body.json, as: [FileHit].self).map(\.result)
		} catch {
			throw RemoteFailure.searchError(error)
		}
	}

	public func people() async throws -> [SearchPerson] {
		let workspace = await workspaceHeader()
		do {
			// Filter after paging: a page trimmed to humans or agents would look short and stop the walk.
			let actors = try await ServerLimits.fetchAll(maxPages: 5) { limit, offset in
				let output = try await client.get_sol_api_sol_actors(
					.init(
						query: .init(limit: limit, offset: offset),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok(let ok) = output else { throw SearchError("Search failed.") }
				return try Self.convert(ok.body.json, as: [ActorHit].self)
			}
			return actors.compactMap(\.person)
		} catch {
			throw RemoteFailure.searchError(error)
		}
	}

	/// Maps the server's rows onto results, keeping the server's order. People and automations have no
	/// screen on the phone, so they are left out.
	static func decode(_ data: Data) throws -> SearchAnswer {
		let response: ServerSearchDTO
		do { response = try JSONDecoder().decode(ServerSearchDTO.self, from: data) } catch {
			throw SearchError("Maskin sent a reply this version can't read. Update the app and try again.")
		}
		return SearchAnswer(results: response.results.compactMap(\.result), isPartial: !(response.partial ?? []).isEmpty)
	}

	static func convert<T: Decodable>(_ value: some Encodable, as: T.Type) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}
}

// MARK: - DTOs

private struct ServerSearchDTO: Decodable {
	struct Row: Decodable {
		var id: String
		var group: String
		var type: String
		var title: String
		var sub: String?
		var snippet: String?
		var status: String
		var updatedAt: String?

		var result: SearchResult? {
			let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
			let date = updatedAt.flatMap(ISODate.parse)
			let humanStatus = status.replacingOccurrences(of: "_", with: " ")
			switch group {
			case "chats":
				return SearchResult(
					kind: .chat, entityId: id, title: trimmed.isEmpty ? "Untitled chat" : trimmed, subtitle: sub ?? "",
					snippet: snippet ?? "", updatedAt: date)
			case "agents":
				return SearchResult(kind: .agent, entityId: id, title: trimmed, snippet: snippet ?? "", updatedAt: date)
			case "loops", "objects":
				return SearchResult(
					kind: .object, entityId: id, title: trimmed.isEmpty ? "Untitled" : trimmed, subtitle: humanStatus,
					snippet: snippet ?? "", detail: group == "loops" ? "loop" : type, updatedAt: date)
			default:
				return nil
			}
		}
	}
	var results: [Row]
	var partial: [String]?
}

private struct FileHit: Decodable {
	var id: String
	var name: String
	var description: String?
	var mimeType: String
	var updatedAt: String?

	var result: SearchResult {
		SearchResult(
			kind: .file, entityId: id, title: name, subtitle: FileContentKind.label(forMime: mimeType),
			snippet: description ?? "", detail: mimeType, updatedAt: updatedAt.flatMap(ISODate.parse))
	}
}

private struct ActorHit: Decodable {
	var id: String
	var type: String
	var name: String

	/// Nil for anything that is neither a person nor an agent.
	var person: SearchPerson? {
		guard type == "human" || type == "agent" else { return nil }
		return SearchPerson(id: id, name: name, isAgent: type == "agent")
	}
}
