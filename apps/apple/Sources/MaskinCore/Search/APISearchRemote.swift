import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `SearchRemote`: the generated client behind a private adapter. Responses are
/// re-decoded into the small DTOs below so generated payload types never leak.
public struct APISearchRemote: SearchRemote {
	private let client: Client
	private let credentials: MaskinCredentialsProvider

	public init(client: Client, credentials: @escaping MaskinCredentialsProvider) {
		self.client = client
		self.credentials = credentials
	}

	private func workspaceHeader() async -> String { await credentials()?.workspaceId ?? "" }

	public func searchObjects(query: String, limit: Int) async throws -> [SearchResult] {
		let workspace = await workspaceHeader()
		do {
			let output = try await client.get_sol_api_sol_objects_sol_search(
				.init(
					query: .init(q: query, limit: min(limit, ServerLimits.maxPageSize)),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw SearchError("Search failed.") }
			return try Self.convert(ok.body.json, as: [ObjectHit].self).map(\.result)
		} catch {
			throw RemoteFailure.searchError(error)
		}
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

	public func conversations() async throws -> [SearchResult] {
		let workspace = await workspaceHeader()
		do {
			return try await ServerLimits.fetchAll(maxPages: 3) { limit, offset in
				let output = try await client.get_sol_api_sol_conversations(
					.init(
						query: .init(limit: limit, offset: offset),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok(let ok) = output else { throw SearchError("Search failed.") }
				return try Self.convert(ok.body.json, as: ConversationPageDTO.self).conversations.map(\.result)
			}
		} catch {
			throw RemoteFailure.searchError(error)
		}
	}

	public func agents() async throws -> [SearchResult] {
		let workspace = await workspaceHeader()
		do {
			return try await ServerLimits.fetchAll(maxPages: 5) { limit, offset in
				let output = try await client.get_sol_api_sol_actors(
					.init(
						query: .init(limit: limit, offset: offset),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok(let ok) = output else { throw SearchError("Search failed.") }
				return try Self.convert(ok.body.json, as: [ActorHit].self).filter { $0.type == "agent" }.map(\.result)
			}
		} catch {
			throw RemoteFailure.searchError(error)
		}
	}

	public func flows() async throws -> [SearchResult] {
		let workspace = await workspaceHeader()
		do {
			return try await APILoopsSource(client: client, workspaceID: workspace).loops().map { loop in
				SearchResult(
					kind: .object, entityId: loop.id, title: loop.displayName, subtitle: loop.pill.label,
					snippet: loop.content ?? "", detail: "loop", updatedAt: loop.updatedAt)
			}
		} catch {
			throw RemoteFailure.searchError(error)
		}
	}

	static func convert<T: Decodable>(_ value: some Encodable, as: T.Type) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}
}

// MARK: - DTOs

private struct ObjectHit: Decodable {
	var id: String
	var type: String
	var title: String?
	var content: String?
	var status: String
	var updatedAt: String?

	var result: SearchResult {
		let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return SearchResult(
			kind: .object, entityId: id, title: trimmed.isEmpty ? "Untitled" : trimmed,
			subtitle: status.replacingOccurrences(of: "_", with: " "), snippet: content ?? "",
			detail: type, updatedAt: updatedAt.flatMap(ISODate.parse))
	}
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

private struct ConversationPageDTO: Decodable {
	struct Participant: Decodable {
		var actorName: String
	}
	struct Row: Decodable {
		var id: String
		var title: String
		var snippet: String?
		var lastMessageAt: String?
		var participants: [Participant]

		var result: SearchResult {
			let people = participants.map(\.actorName).joined(separator: ", ")
			return SearchResult(
				kind: .chat, entityId: id, title: title.isEmpty ? "Untitled chat" : title,
				subtitle: people, snippet: snippet ?? "", updatedAt: lastMessageAt.flatMap(ISODate.parse))
		}
	}
	var conversations: [Row]
}

private struct ActorHit: Decodable {
	var id: String
	var type: String
	var name: String
	var description: String?

	var result: SearchResult {
		SearchResult(kind: .agent, entityId: id, title: name, snippet: description ?? "")
	}
}
