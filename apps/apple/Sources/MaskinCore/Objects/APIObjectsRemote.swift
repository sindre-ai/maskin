import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `ObjectsRemote`: the generated client behind a private adapter. Generated operation
/// names and payload types stay inside this file; responses are re-decoded into the small DTOs
/// below so the mapping is written once instead of once per operation.
public struct APIObjectsRemote: ObjectsRemote {
	private let client: Client
	private let credentials: MaskinCredentialsProvider
	/// Where the raw calls go: the generated client has no operation for approving a draft yet.
	/// Without it `approve` reports that it can't.
	private let raw: RawTransport?

	struct RawTransport: Sendable {
		var baseURL: URL
		var clientSource: String
		var session: URLSession
	}

	public init(client: Client, credentials: @escaping MaskinCredentialsProvider) {
		self.client = client
		self.credentials = credentials
		self.raw = nil
	}

	public init(
		client: Client, credentials: @escaping MaskinCredentialsProvider, baseURL: URL, clientSource: String,
		session: URLSession = .shared
	) {
		self.client = client
		self.credentials = credentials
		self.raw = RawTransport(baseURL: baseURL, clientSource: clientSource, session: session)
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
						_type: query.type, status: query.status, driver: query.driver, sort: query.sort.serverField,
						order: query.sort.serverAscending ? .asc : .desc,
						limit: min(query.limit, ServerLimits.maxPageSize), offset: query.offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw Self.failure(output) }
			return try Self.convert(ok.body.json, as: [ObjectDTO].self).map(\.model)
		} catch {
			throw Self.wrap(error)
		}
	}

	// MARK: Board

	public func board(_ query: ObjectsBoardQuery) async throws -> [ObjectsBoardColumn] {
		let workspace = await workspaceHeader()
		do {
			let output = try await client.get_sol_api_sol_objects_sol_board(
				.init(
					query: .init(
						_type: query.type, sort: query.sort.serverField,
						order: query.sort.serverAscending ? .asc : .desc,
						limit: min(query.limit, ServerLimits.maxPageSize), offset: query.offset,
						column: query.column),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw Self.failure(output) }
			return try Self.convert(ok.body.json, as: BoardDTO.self).columns.map(\.model)
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
							.init(
								title: patch.title, content: patch.content, status: patch.status,
								metadata: try Self.metadataPatch(patch.metadata), driver: patch.driver))))
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

	/// Only the changed keys (the server shallow-merges); an empty string becomes JSON null so
	/// the key is cleared.
	static func metadataPatch(
		_ metadata: [String: String]?
	) throws -> Operations.patch_sol_api_sol_objects_sol__lcub_id_rcub_.Input.Body.jsonPayload.metadataPayload? {
		guard let metadata, !metadata.isEmpty else { return nil }
		var values: [String: OpenAPIValueContainer] = [:]
		for (key, value) in metadata {
			values[key] = try OpenAPIValueContainer(unvalidatedValue: value.isEmpty ? nil : value)
		}
		return .init(additionalProperties: values)
	}

	public func createRelationship(
		sourceId: String, sourceType: String, targetId: String, targetType: String, type: String,
		idempotencyKey: String
	) async throws -> ObjectLink {
		let workspace = await workspaceHeader()
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_relationships(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspace),
						body: .json(
							.init(
								source_type: sourceType, source_id: sourceId, target_type: targetType,
								target_id: targetId, _type: type))))
			}
			guard case .created(let created) = output else { throw Self.failure(output) }
			let dto = try Self.convert(created.body.json, as: RelationshipDTO.self)
			let title = dto.targetTitle?.isEmpty == false ? dto.targetTitle : nil
			return ObjectLink(
				id: dto.id, relation: dto.type, isOutgoing: true, otherId: dto.targetId,
				otherType: dto.targetType, otherTitle: title ?? "Untitled")
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

private struct BoardDTO: Decodable {
	struct Column: Decodable {
		var id: String
		var value: String
		var total: Double
		var objects: [ObjectDTO]

		var model: ObjectsBoardColumn {
			ObjectsBoardColumn(id: id, value: value, total: Int(total), objects: objects.map(\.model))
		}
	}

	var columns: [Column]
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
				otherStatus: known?.status, otherDriver: known?.driver)
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

// MARK: - Drafts

extension APIObjectsRemote: ObjectDraftsRemote {
	public func detail(objectId: String) async throws -> ObjectDetail {
		do {
			let output = try await client.get_sol_api_sol_objects_sol__lcub_id_rcub_(.init(path: .init(id: objectId)))
			switch output {
			case .ok(let ok):
				return try Self.convert(ok.body.json, as: DetailDTO.self).model
			case .notFound:
				throw ObjectsError(ObjectsRemoteMessages.notFound)
			default:
				throw Self.failure(output)
			}
		} catch {
			throw Self.wrap(error)
		}
	}

	public func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		guard let raw else { throw ObjectApprovalError.other("Approving isn't available here.") }
		let request = await makeApprovalRequest(
			objectId: objectId, contentHash: contentHash, idempotencyKey: idempotencyKey, transport: raw)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await raw.session.data(for: request)
		} catch {
			let offline = Self.wrap(error).isOffline
			throw offline ? ObjectApprovalError.offline : ObjectApprovalError.other("Couldn't reach Maskin.")
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		return try Self.approvalResult(status: status, body: data)
	}

	var rawTransportForTesting: RawTransport? { raw }

	/// Built apart from sending so a test can read the path, headers and body.
	func makeApprovalRequest(
		objectId: String, contentHash: String, idempotencyKey: String, transport: RawTransport
	) async -> URLRequest {
		var request = URLRequest(
			url: transport.baseURL.appendingPathComponent("api/objects/\(objectId)/approval"))
		request.httpMethod = "POST"
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue(transport.clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
		if let credentials = await credentials() {
			request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = credentials.workspaceId {
				request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
			}
		}
		request.httpBody = try? JSONEncoder().encode(["content_hash": contentHash])
		return request
	}

	/// What a response to the approval means: the new preview, or why not.
	static func approvalResult(status: Int, body: Data) throws -> ObjectPreview {
		struct Envelope: Decodable {
			struct Failure: Decodable {
				struct Detail: Decodable { var message: String? }
				var message: String?
				var details: [Detail]?
			}
			var error: Failure?
		}
		let failure = (try? JSONDecoder().decode(Envelope.self, from: body))?.error
		switch status {
		case 200..<300:
			struct Approved: Decodable { var preview: FeedPreviewDTO }
			guard let approved = try? JSONDecoder().decode(Approved.self, from: body) else {
				throw ObjectApprovalError.other("Maskin sent a reply this version can't read.")
			}
			return approved.preview.model
		case 409: throw ObjectApprovalError.changed
		case 400:
			let detail = failure?.details?.compactMap(\.message).first ?? failure?.message
			throw ObjectApprovalError.incomplete(detail)
		case 403: throw ObjectApprovalError.notAllowed
		case 404: throw ObjectApprovalError.notFound
		default: throw ObjectApprovalError.other("The server couldn't approve this draft.")
		}
	}
}

/// `preview` as the server writes it, read by hand so it maps the same on a read and on approval.
struct FeedPreviewDTO: Decodable {
	struct Recipient: Decodable { var role: String; var name: String?; var address: String? }
	struct Detail: Decodable { var label: String; var value: String }
	struct Delivery: Decodable { var state: String }
	var kind: String
	var label: String
	var recipients: [Recipient]?
	var subject: String?
	var details: [Detail]?
	var body: String
	var missing: [String]?
	var warnings: [String]?
	var content_hash: String
	var delivery: Delivery?

	var model: ObjectPreview {
		ObjectPreview(
			kind: kind, label: label,
			recipients: (recipients ?? []).map { .init(role: $0.role, name: $0.name, address: $0.address) },
			subject: subject, details: (details ?? []).map { .init(label: $0.label, value: $0.value) },
			body: body, missing: missing ?? [], warnings: warnings ?? [], contentHash: content_hash,
			delivery: delivery.flatMap { ObjectPreview.Delivery(rawValue: $0.state) })
	}
}

private struct DetailDTO: Decodable {
	var workspaceId: String
	var preview: FeedPreviewDTO?
	var object: ObjectDTO

	init(from decoder: Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		workspaceId = try c.decode(String.self, forKey: .workspaceId)
		preview = try c.decodeIfPresent(FeedPreviewDTO.self, forKey: .preview)
		object = try ObjectDTO(from: decoder)
	}

	enum Keys: String, CodingKey { case workspaceId, preview }

	var model: ObjectDetail {
		ObjectDetail(object: object.model, workspaceId: workspaceId, preview: preview?.model)
	}
}
