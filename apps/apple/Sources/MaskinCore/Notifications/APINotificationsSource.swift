import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `NotificationsSource`: the generated client behind a private adapter, so operation
/// names never leak out of this file.
///
/// Every response body is re-encoded and decoded into `Wire`, one tolerant shape for all four
/// notification-returning operations (the generator emits a distinct but identical payload type
/// per operation).
public struct APINotificationsSource: NotificationsSource {
	private let client: Client
	private let workspaceId: @Sendable () async -> String?

	/// `workspaceId` supplies the `X-Workspace-Id` the list and respond operations require as an
	/// explicit argument (the client's middleware sets the same value on the wire).
	public init(client: Client, workspaceId: @escaping @Sendable () async -> String?) {
		self.client = client
		self.workspaceId = workspaceId
	}

	public init(environment: AppEnvironment) {
		let credentials = environment.auth.credentialsProvider
		self.init(client: environment.client) { await credentials()?.workspaceId }
	}

	/// The list endpoint is ascending with a 100-row page cap, so reading the newest rows means
	/// walking to the end. Bounded so a runaway inbox can't loop forever.
	private static let pageSize = 100
	private static let maxPages = 10

	public func list() async throws -> [AppNotification] {
		let workspace = try await requireWorkspace()
		var all: [AppNotification] = []
		for page in 0..<Self.maxPages {
			let output = try await client.get_sol_api_sol_notifications(
				query: .init(limit: Self.pageSize, offset: page * Self.pageSize),
				headers: .init(x_hyphen_workspace_hyphen_id: workspace))
			guard case .ok(let ok) = output else { throw NotificationsError("Couldn't load notifications.") }
			let rows = try ok.body.json
			all += try rows.map(Self.convert)
			if rows.count < Self.pageSize { break }
		}
		return all
	}

	public func setStatus(id: String, status: AppNotification.Status) async throws -> AppNotification {
		guard let wire = Self.statusPayload(status) else {
			throw NotificationsError("Unsupported status.")
		}
		let output = try await client.patch_sol_api_sol_notifications_sol__lcub_id_rcub_(
			path: .init(id: id), body: .json(.init(status: wire)))
		guard case .ok(let ok) = output else { throw NotificationsError("Couldn't update the notification.") }
		return try Self.convert(try ok.body.json)
	}

	public func delete(id: String) async throws {
		let output = try await client.delete_sol_api_sol_notifications_sol__lcub_id_rcub_(
			path: .init(id: id))
		guard case .ok = output else { throw NotificationsError("Couldn't delete the notification.") }
	}

	public func respond(id: String, response: JSONValue) async throws -> AppNotification {
		let workspace = try await requireWorkspace()
		let container = try Self.roundTrip(response, as: OpenAPIValueContainer.self)
		let output = try await client.post_sol_api_sol_notifications_sol__lcub_id_rcub__sol_respond(
			path: .init(id: id), headers: .init(x_hyphen_workspace_hyphen_id: workspace),
			body: .json(.init(response: container)))
		switch output {
		case .ok(let ok): return try Self.convert(try ok.body.json)
		case .badRequest: throw NotificationsError("This was already answered.")
		default: throw NotificationsError("Couldn't send your response.")
		}
	}

	public func actors(ids: [String]) async throws -> [NotificationActor] {
		guard !ids.isEmpty else { return [] }
		var found: [NotificationActor] = []
		for chunk in ServerLimits.chunks(ids) {
			let output = try await client.get_sol_api_sol_actors(
				query: .init(limit: chunk.count, ids: chunk.joined(separator: ",")))
			guard case .ok(let ok) = output else {
				throw NotificationsError("Couldn't load sender names.")
			}
			found += try ok.body.json.map {
				NotificationActor(id: $0.id, name: $0.name, isAgent: $0._type == "agent")
			}
		}
		return found
	}

	// MARK: Mapping

	private func requireWorkspace() async throws -> String {
		guard let workspace = await workspaceId() else {
			throw NotificationsError("No workspace selected.")
		}
		return workspace
	}

	private static func statusPayload(
		_ status: AppNotification.Status
	) -> Operations.patch_sol_api_sol_notifications_sol__lcub_id_rcub_.Input.Body.jsonPayload.statusPayload? {
		switch status {
		case .pending: .pending
		case .seen: .seen
		case .resolved: .resolved
		case .dismissed: .dismissed
		case .other: nil
		}
	}

	private struct Wire: Decodable {
		var id: String
		var workspaceId: String
		var type: String
		var title: String
		var content: String?
		var metadata: [String: JSONValue]?
		var sourceActorId: String
		var targetActorId: String?
		var objectId: String?
		var sessionId: String?
		var status: String
		var resolvedAt: String?
		var createdAt: String?
	}

	private static func convert(_ payload: some Encodable) throws -> AppNotification {
		let w = try roundTrip(payload, as: Wire.self)
		return AppNotification.make(
			id: w.id, workspaceId: w.workspaceId, type: w.type, title: w.title, content: w.content,
			metadata: w.metadata, sourceActorId: w.sourceActorId, targetActorId: w.targetActorId,
			objectId: w.objectId, sessionId: w.sessionId, status: w.status,
			resolvedAt: w.resolvedAt.flatMap(parseDate), createdAt: w.createdAt.flatMap(parseDate))
	}

	private static func roundTrip<T: Decodable>(_ value: some Encodable, as: T.Type) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}

	static func parseDate(_ s: String) -> Date? {
		let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? withFraction.parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
	}
}
