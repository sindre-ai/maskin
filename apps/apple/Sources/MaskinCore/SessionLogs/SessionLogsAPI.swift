import Foundation
import MaskinAPI

/// Which rows of a session's log to read. Mirrors the query of `GET /api/sessions/{id}/logs`.
public struct SessionLogQuery: Equatable, Sendable {
	public enum Order: String, Sendable { case ascending = "asc", descending = "desc" }

	public var since: Int?
	public var before: Int?
	public var order: Order
	public var limit: Int

	public init(since: Int? = nil, before: Int? = nil, order: Order = .ascending, limit: Int = 200) {
		self.since = since
		self.before = before
		self.order = order
		self.limit = limit
	}
}

/// Where a session's log rows come from. A protocol so the store tests without a server.
public protocol SessionLogsAPI: Sendable {
	func logs(sessionID: String, query: SessionLogQuery) async throws -> [SessionLogRow]
}

/// Production source over the generated client. Generated names stay in this file.
public struct APISessionLogsSource: SessionLogsAPI {
	private let client: Client
	private let workspaceID: String

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func logs(sessionID: String, query: SessionLogQuery) async throws -> [SessionLogRow] {
		let output = try await client.get_sol_api_sol_sessions_sol__lcub_id_rcub__sol_logs(
			.init(
				path: .init(id: sessionID),
				query: .init(
					since: query.since, before: query.before, limit: query.limit,
					order: query.order == .ascending ? .asc : .desc),
				headers: .init(x_hyphen_workspace_hyphen_id: workspaceID)))
		switch output {
		case .ok(let ok):
			return try ok.body.json.map {
				SessionLogRow(
					id: Int($0.id), stream: $0.stream, content: $0.content,
					createdAt: ChatDates.parse($0.createdAt))
			}
		case .notFound: throw SessionLogsError("This session's log isn't available.")
		default: throw SessionLogsError("Couldn't load the log.")
		}
	}
}

public struct SessionLogsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}
