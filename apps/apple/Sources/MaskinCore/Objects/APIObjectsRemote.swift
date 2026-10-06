import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `ObjectsRemote`: the generated client behind a private adapter. Generated operation
/// names and payload types stay inside this file; responses are re-decoded into the small DTOs
/// below so the mapping is written once instead of once per operation.
public struct APIObjectsRemote: ObjectsRemote {
	private let client: Client
	private let credentials: MaskinCredentialsProvider

	public init(client: Client, credentials: @escaping MaskinCredentialsProvider) {
		self.client = client
		self.credentials = credentials
	}

	/// Required by the generated signatures; the auth middleware stamps the same value.
	private func workspaceHeader() async -> String { await credentials()?.workspaceId ?? "" }

	// MARK: List

	public func list(_ query: ObjectsQuery) async throws -> [WorkObject] {
		let workspace = await workspaceHeader()
		do {
			if !query.search.isEmpty {
				let output = try await client.get_sol_api_sol_objects_sol_search(
					.init(
						query: .init(
							q: query.search, _type: query.type, status: query.status, limit: min(query.limit, ServerLimits.maxPageSize),
							offset: query.offset),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok(let ok) = output else { throw Self.failure(output) }
				return try Self.convert(ok.body.json, as: [ObjectDTO].self).map(\.model)
			}
			let output = try await client.get_sol_api_sol_objects(
				.init(
					query: .init(
						_type: query.type, status: query.status, sort: "updatedAt", order: .desc,
						limit: min(query.limit, ServerLimits.maxPageSize), offset: query.offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw Self.failure(output) }
			return try Self.convert(ok.body.json, as: [ObjectDTO].self).map(\.model)
		} catch {
			throw Self.wrap(error)
		}
	}

	// MARK: Detail

	public func graph(objectId: String) async throws -> ObjectGraph {
		let workspace = await workspaceHeader()
		do {
			let output = try await client.get_sol_api_sol_objects_sol__lcub_id_rcub__sol_graph(
				.init(
					path: .init(id: objectId),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			switch output {
			case .ok(let ok):
				return try Self.convert(ok.body.json, as: GraphDTO.self).model
			case .notFound:
				throw ObjectsError(ObjectsRemoteMessages.notFound)
			default:
				throw Self.failure(output)
			}
		} catch {
			throw Self.wrap(error)
		}
	}

	// MARK: Writes

	public func create(_ draft: ObjectDraft, idempotencyKey: String) async throws -> WorkObject {
		let workspace = await workspaceHeader()
		let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
		let content = draft.content.trimmingCharacters(in: .whitespacesAndNewlines)
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_objects(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspace),
						body: .json(
							.init(
								_type: draft.type, title: title.isEmpty ? nil : title,
								content: content.isEmpty ? nil : content, status: draft.status))))
			}
			guard case .created(let created) = output else { throw Self.failure(output) }
			return try Self.convert(created.body.json, as: ObjectDTO.self).model
		} catch {
			throw Self.wrap(error)
		}
	}

	public func update(
		objectId: String, patch: ObjectPatch, idempotencyKey: String
	) async throws -> WorkObject {
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.patch_sol_api_sol_objects_sol__lcub_id_rcub_(
					.init(
						path: .init(id: objectId),
						body: .json(
							.init(title: patch.title, content: patch.content, status: patch.status))))
			}
			switch output {
			case .ok(let ok): return try Self.convert(ok.body.json, as: ObjectDTO.self).model
			case .notFound: throw ObjectsError(ObjectsRemoteMessages.notFound)
			default: throw Self.failure(output)
			}
		} catch {
			throw Self.wrap(error)
		}
	}

	public func delete(objectId: String) async throws {
		do {
			let output = try await client.delete_sol_api_sol_objects_sol__lcub_id_rcub_(
				.init(path: .init(id: objectId)))
			guard case .ok = output else { throw Self.failure(output) }
		} catch {
			throw Self.wrap(error)
		}
	}

	public func setStarred(objectId: String, starred: Bool) async throws {
		let workspace = await workspaceHeader()
		do {
			if starred {
				let output = try await client.post_sol_api_sol_objects_sol__lcub_id_rcub__sol_star(
					.init(
						path: .init(id: objectId),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok = output else { throw Self.failure(output) }
			} else {
				let output = try await client.delete_sol_api_sol_objects_sol__lcub_id_rcub__sol_star(
					.init(
						path: .init(id: objectId),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok = output else { throw Self.failure(output) }
			}
		} catch {
			throw Self.wrap(error)
		}
	}

	/// `{ "refs": [ids] }`, or nothing when no object is linked.
	static func refsMetadata(
		_ refs: [String]
	) throws -> Operations.post_sol_api_sol_events.Input.Body.jsonPayload.metadataPayload? {
		guard !refs.isEmpty else { return nil }
		return .init(additionalProperties: ["refs": try .init(unvalidatedValue: refs)])
	}

	public func postComment(
		objectId: String, content: String, mentions: [String], refs: [String],
		attachmentFileIds: [String], parentEventId: Int?, idempotencyKey: String
	) async throws -> ObjectEvent {
		let workspace = await workspaceHeader()
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_events(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspace),
						body: .json(
							.init(
								entity_id: objectId, content: content,
								mentions: mentions.isEmpty ? nil : mentions, parent_event_id: parentEventId,
								attachment_file_ids: attachmentFileIds.isEmpty ? nil : attachmentFileIds,
								metadata: try Self.refsMetadata(refs)))))
			}
			guard case .created(let created) = output else { throw Self.failure(output) }
			return try Self.convert(created.body.json, as: EventDTO.self).model
		} catch {
			throw Self.wrap(error)
		}
	}

	// MARK: Directory

	public func actors() async throws -> [ActorRef] {
		do {
			let header = await workspaceHeader()
			return try await ServerLimits.fetchAll { limit, offset in
				let output = try await client.get_sol_api_sol_actors(
					.init(
						query: .init(limit: limit, offset: offset),
						headers: .init(x_hyphen_workspace_hyphen_id: header)))
				guard case .ok(let ok) = output else { throw Self.failure(output) }
				return try Self.convert(ok.body.json, as: [ActorDTO].self).map {
					ActorRef(id: $0.id, name: $0.name, isAgent: $0.type == "agent")
				}
			}
		} catch {
			throw Self.wrap(error)
		}
	}

	public func schema(workspaceId: String) async throws -> ObjectsSchema {
		do {
			let output = try await client.get_sol_api_sol_workspaces()
			guard case .ok(let ok) = output else { throw Self.failure(output) }
			let workspaces = try Self.convert(ok.body.json, as: [WorkspaceDTO].self)
			guard let settings = workspaces.first(where: { $0.id == workspaceId })?.settings else {
				return .fallback
			}
			return Self.schema(from: settings)
		} catch {
			throw Self.wrap(error)
		}
	}

	static func schema(from settings: JSONValue) -> ObjectsSchema {
		var statuses: [String: [String]] = [:]
		if case .object(let raw)? = settings["statuses"] {
			for (type, value) in raw {
				if case .array(let items) = value { statuses[type] = items.compactMap(\.stringValue) }
			}
		}
		var names: [String: String] = [:]
		if case .object(let raw)? = settings["display_names"] {
			for (type, value) in raw { if let s = value.stringValue { names[type] = s } }
		}
		guard !statuses.isEmpty else { return .fallback }
		let core = ["insight", "bet", "task"].filter { statuses[$0] != nil }
		// Loops have their own surface; everything else is a custom type worth listing.
		let custom = statuses.keys.filter { !["insight", "bet", "task", "loop"].contains($0) }.sorted()
		return ObjectsSchema(
			types: core + custom,
			displayNames: ObjectsSchema.fallback.displayNames.merging(names) { $1 },
			statuses: ObjectsSchema.fallback.statuses.merging(statuses) { $1 })
	}

	// MARK: Mapping helpers

	static func convert<T: Decodable>(_ value: some Encodable, as: T.Type) throws -> T {
		let data = try JSONEncoder().encode(value)
		return try JSONDecoder().decode(T.self, from: data)
	}

	private static func failure(_ output: some Any) -> ObjectsError {
		ObjectsError("The server couldn't complete that request.")
	}

	static func wrap(_ error: Error) -> ObjectsError {
		if let error = error as? ObjectsError { return error }
		var current: Error? = error
		while let e = current {
			if let url = e as? URLError {
				let offline: Set<URLError.Code> = [
					.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
					.cannotFindHost, .timedOut, .dataNotAllowed,
				]
				return ObjectsError(
					offline.contains(url.code)
						? "You're offline." : "Couldn't reach the server.",
					isOffline: offline.contains(url.code))
			}
			current = (e as? ClientError)?.underlyingError
		}
		return ObjectsError("Something went wrong. Try again.")
	}
}

// MARK: - DTOs

private struct ObjectDTO: Decodable {
	var id: String
	var type: String
	var title: String?
	var content: String?
	var status: String
	var metadata: [String: JSONValue]?
	var driver: String?
	var createdBy: String?
	var createdAt: String?
	var updatedAt: String?
	var activeSessionId: String?
	var activeSessionCurrentActivity: String?
	var is_starred_by_me: Bool?
	var unread_count: Double?

	var model: WorkObject {
		var scalars: [String: String] = [:]
		for (key, value) in metadata ?? [:] {
			switch value {
			case .string(let s) where !s.isEmpty: scalars[key] = s
			case .number(let n): scalars[key] = n.rounded() == n ? String(Int(n)) : String(n)
			case .bool(let b): scalars[key] = b ? "Yes" : "No"
			default: break
			}
		}
		return WorkObject(
			id: id, type: type, title: title, content: content, status: status, metadata: scalars,
			driverId: driver, createdBy: createdBy, createdAt: createdAt.flatMap(ISODate.parse),
			updatedAt: updatedAt.flatMap(ISODate.parse), isStarred: is_starred_by_me ?? false,
			unreadCount: Int(unread_count ?? 0), activeActivity: activeSessionCurrentActivity,
			hasActiveSession: !(activeSessionId ?? "").isEmpty)
	}
}

private struct RelationshipDTO: Decodable {
	var id: String
	var sourceType: String
	var sourceId: String
	var sourceTitle: String?
	var targetType: String
	var targetId: String
	var targetTitle: String?
	var type: String
}

private struct EventDTO: Decodable {
	var id: Double
	var actorId: String?
	var action: String
	var data: JSONValue?
	var createdAt: String?
	var description: String?

	var model: ObjectEvent {
		ObjectEvent(
			id: Int(id), actorId: actorId, action: action, data: data,
			createdAt: createdAt.flatMap(ISODate.parse), summary: description)
	}
}

private struct GraphDTO: Decodable {
	var object: ObjectDTO
	var relationships: [RelationshipDTO]?
	var connected_objects: [ObjectDTO]?
	var events: [EventDTO]?

	var model: ObjectGraph {
		let me = object.id
		let others = Dictionary((connected_objects ?? []).map { ($0.id, $0) }, uniquingKeysWith: { $1 })
		let links: [ObjectLink] = (relationships ?? []).compactMap { rel in
			let outgoing = rel.sourceId == me
			guard outgoing || rel.targetId == me else { return nil }
			let otherId = outgoing ? rel.targetId : rel.sourceId
			let known = others[otherId]
			let title = known?.title ?? (outgoing ? rel.targetTitle : rel.sourceTitle)
			return ObjectLink(
				id: rel.id, relation: rel.type, isOutgoing: outgoing, otherId: otherId,
				otherType: known?.type ?? (outgoing ? rel.targetType : rel.sourceType),
				otherTitle: (title?.isEmpty == false ? title : nil) ?? "Untitled",
				otherStatus: known?.status)
		}
		return ObjectGraph(object: object.model, links: links, events: (events ?? []).map(\.model))
	}
}

private struct ActorDTO: Decodable {
	var id: String
	var type: String
	var name: String
}

private struct WorkspaceDTO: Decodable {
	var id: String
	var settings: JSONValue?
}

enum ISODate {
	static func parse(_ s: String) -> Date? {
		let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
		return (try? fractional.parse(s)) ?? (try? Date.ISO8601FormatStyle().parse(s))
	}
}
