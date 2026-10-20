import Foundation
import MaskinAPI

/// Where activity traces come from. A protocol so the store tests without a server and the
/// backend can change shape (the steps endpoint today, raw log envelopes tomorrow) without the
/// UI noticing.
public protocol SessionActivitySource: Sendable {
	/// The newest `limitTurns` turns of a session. `background` marks a fetch the user did not
	/// ask for (history for a finished turn): it declines to use Low Data Mode connections.
	func activity(sessionID: String, limitTurns: Int, background: Bool) async throws -> SessionActivity
}

/// Builds traces from `GET /api/sessions/{id}/logs`, the same raw log the web segments client-side
/// (there is no server-side `/activity` endpoint). Hand-rolled over URLSession so a poll can ask
/// only for rows newer than the last one it holds (`since`); it still sends the same headers
/// (`Authorization`, `X-Workspace-Id`, `X-Client-Source`) as every other call.
public struct HTTPSessionActivitySource: SessionActivitySource {
	/// Hard ceiling on one response, so a runaway trace can't eat a cellular plan.
	public static let maxBodyBytes = 3 * 1024 * 1024
	/// Rows per request; the server's `limit` maximum is 500.
	public static let pageRows = 300
	/// Pages a single catch-up may read before it settles for what it has.
	public static let maxPages = 4
	/// Rows kept per session in memory; the oldest drop first.
	public static let maxRows = 1500

	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession
	private let rows = LogRowCache()

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func activity(sessionID: String, limitTurns: Int, background: Bool) async throws
		-> SessionActivity
	{
		guard let creds = await credentials(), let workspace = creds.workspaceId else {
			throw ChatsError("Not signed in.")
		}
		var held = await rows.rows(sessionID)
		if let last = held.last {
			// Catch up: everything after the newest row we have.
			var cursor = last.id
			for _ in 0..<Self.maxPages {
				let page = try await fetch(
					sessionID, creds: creds, workspace: workspace, since: cursor, background: background)
				held.append(contentsOf: page)
				guard page.count == Self.pageRows, let newest = page.last else { break }
				cursor = newest.id
			}
		} else {
			held = try await fetch(
				sessionID, creds: creds, workspace: workspace, since: nil, background: background)
		}
		if held.count > Self.maxRows { held = Array(held.suffix(Self.maxRows)) }
		await rows.store(held, for: sessionID)
		let turns = ActivityLogParser.turns(from: held, sessionID: sessionID)
		return SessionActivity(
			sessionID: sessionID, turns: Array(turns.suffix(max(limitTurns, 1))), oldestLogID: held.first?.id)
	}

	private func fetch(
		_ sessionID: String, creds: MaskinCredentials, workspace: String, since: Int?, background: Bool
	) async throws -> [SessionLogRow] {
		var components = URLComponents(
			url: baseURL.appendingPathComponent("api/sessions/\(sessionID)/logs"),
			resolvingAgainstBaseURL: false)
		var items = [URLQueryItem(name: "limit", value: String(Self.pageRows))]
		if let since {
			items.append(URLQueryItem(name: "since", value: String(since)))
			items.append(URLQueryItem(name: "order", value: "asc"))
		} else {
			// First read of a (possibly long-lived) session: the newest rows, not the oldest.
			items.append(URLQueryItem(name: "order", value: "desc"))
		}
		components?.queryItems = items
		guard let url = components?.url else { throw ChatsError("Bad logs URL.") }
		var request = URLRequest(url: url)
		request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		request.setValue(workspace, forHTTPHeaderField: "X-Workspace-Id")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.timeoutInterval = 15
		if background { request.allowsConstrainedNetworkAccess = false }
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw ChatsError("No response.") }
		guard (200..<300).contains(http.statusCode) else {
			throw ChatsHTTPError(status: http.statusCode, message: "Couldn't load the agent's steps.")
		}
		guard data.count <= Self.maxBodyBytes else { throw ChatsError("The agent's steps are too large.") }
		return try Self.decodeRows(data)
	}

	/// Tolerant: a row missing a field is skipped, not fatal.
	static func decodeRows(_ data: Data) throws -> [SessionLogRow] {
		guard case .array(let items) = try JSONDecoder().decode(JSONValue.self, from: data) else {
			throw ChatsError("Unexpected logs response.")
		}
		return items.compactMap { item in
			guard let id = item["id"]?.intValue, let stream = item["stream"]?.stringValue,
				let content = item["content"]?.stringValue
			else { return nil }
			return SessionLogRow(
				id: id, stream: stream, content: content,
				createdAt: ChatDates.parse(item["createdAt"]?.stringValue))
		}
		.sorted { $0.id < $1.id }
	}
}

/// The rows already read per session, so a poll fetches only what is new.
actor LogRowCache {
	private var bySession: [String: [SessionLogRow]] = [:]
	func rows(_ id: String) -> [SessionLogRow] { bySession[id] ?? [] }
	func store(_ rows: [SessionLogRow], for id: String) { bySession[id] = rows }
}

extension HTTPSessionActivitySource {
	@MainActor
	public init(environment: AppEnvironment) {
		self.init(
			baseURL: environment.baseURL, clientSource: environment.clientSource,
			credentials: environment.auth.credentialsProvider)
	}
}
