import Foundation
import MaskinAPI
import OpenAPIRuntime

/// The workspace a share lands in: its name (shown on the sheet) and its real object types.
public struct ShareWorkspace: Sendable, Equatable {
	public var id: String
	public var name: String
	public var schema: ObjectsSchema

	public init(id: String, name: String, schema: ObjectsSchema) {
		self.id = id
		self.name = name
		self.schema = schema
	}
}

/// A conversation the share can be sent into.
public struct ShareConversation: Sendable, Equatable, Identifiable {
	public var id: String
	public var title: String
	public init(id: String, title: String) {
		self.id = id
		self.title = title
	}
}

/// What the share needs from the server. A protocol so posting is tested without one; the
/// production implementation wraps the generated client.
public protocol ShareRemote: Sendable {
	/// `GET /api/workspaces`, narrowed to the signed-in workspace.
	func workspace() async throws -> ShareWorkspace
	/// `GET /api/workspaces`: every workspace the person is in (for the picker). Schemas are not
	/// loaded here; `workspace()` fetches the chosen one's.
	func workspaces() async throws -> [ShareWorkspace]
	/// Recent, unarchived conversations of the workspace, newest first.
	func conversations() async throws -> [ShareConversation]
	/// `POST /api/conversations/{id}/messages`.
	func sendChatMessage(
		conversationID: String, content: String, attachments: [ChatAttachmentRef], idempotencyKey: String
	) async throws
	/// `POST /api/objects`; returns the new object's id.
	func createObject(
		type: String, title: String, content: String, status: String, idempotencyKey: String
	) async throws -> String
	/// `POST /api/files` (base64 JSON, 10 MB cap); returns the new file's id.
	func uploadFile(name: String, mimeType: String, fileURL: URL, idempotencyKey: String) async throws -> String
	/// `POST /api/relationships`: the `attached` edge the web app writes for an object's files.
	func attach(fileID: String, toObject objectID: String, objectType: String, idempotencyKey: String) async throws
}

extension ShareRemote {
	public func workspaces() async throws -> [ShareWorkspace] { try await [workspace()] }
	public func conversations() async throws -> [ShareConversation] { [] }
	public func sendChatMessage(
		conversationID: String, content: String, attachments: [ChatAttachmentRef], idempotencyKey: String
	) async throws { throw ShareError.rejected }
}

/// Production `ShareRemote`. Nothing it throws carries a body, a token or shared content.
public struct APIShareRemote: ShareRemote {
	private let client: Client
	private let workspaceID: String

	/// The same relationship the web writes when a file is attached to an object.
	static let attachedRelation = "attached"

	public init(client: Client, workspaceID: String) {
		self.client = client
		self.workspaceID = workspaceID
	}

	public func workspace() async throws -> ShareWorkspace {
		do {
			let output = try await client.get_sol_api_sol_workspaces()
			switch output {
			case .ok(let ok):
				let rows = try APIObjectsRemote.convert(ok.body.json, as: [ShareWorkspaceDTO].self)
				guard let row = rows.first(where: { $0.id == workspaceID }) else { throw ShareError.noWorkspace }
				let schema = row.settings.map(APIObjectsRemote.schema(from:)) ?? .fallback
				return ShareWorkspace(id: row.id, name: row.name, schema: schema)
			case .undocumented(let status, _): throw Self.failure(status: status)
			}
		} catch { throw Self.map(error) }
	}

	public func workspaces() async throws -> [ShareWorkspace] {
		do {
			let output = try await client.get_sol_api_sol_workspaces()
			switch output {
			case .ok(let ok):
				let rows = try APIObjectsRemote.convert(ok.body.json, as: [ShareWorkspaceDTO].self)
				return rows.map { ShareWorkspace(id: $0.id, name: $0.name, schema: .fallback) }
			case .undocumented(let status, _): throw Self.failure(status: status)
			}
		} catch { throw Self.map(error) }
	}

	public func conversations() async throws -> [ShareConversation] {
		do {
			let page = try await APIChatsSource(client: client, workspaceID: workspaceID)
				.list(archived: false, limit: 25, offset: 0)
			return page.conversations.map { ShareConversation(id: $0.id, title: $0.title) }
		} catch { throw Self.map(error) }
	}

	public func sendChatMessage(
		conversationID: String, content: String, attachments: [ChatAttachmentRef], idempotencyKey: String
	) async throws {
		do {
			_ = try await APIChatsSource(client: client, workspaceID: workspaceID).send(
				conversationID: conversationID, content: content,
				metadata: ChatSendMetadata(attachments: attachments), idempotencyKey: idempotencyKey)
		} catch let error as ChatsHTTPError {
			throw Self.failure(status: error.status)
		} catch { throw Self.map(error) }
	}

	public func createObject(
		type: String, title: String, content: String, status: String, idempotencyKey: String
	) async throws -> String {
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_objects(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
						body: .json(
							.init(
								_type: type, title: title.isEmpty ? nil : title,
								content: content.isEmpty ? nil : content, status: status))))
			}
			switch output {
			case .created(let created): return try created.body.json.id
			case .badRequest, .notFound, .conflict: throw ShareError.rejected
			case .internalServerError: throw ShareError.server
			case .undocumented(let status, _): throw Self.failure(status: status)
			}
		} catch { throw Self.map(error) }
	}

	public func uploadFile(
		name: String, mimeType: String, fileURL: URL, idempotencyKey: String
	) async throws -> String {
		do {
			// Read only now, and drop the base64 copy as soon as the request body is built.
			let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_files(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
						body: .json(
							.init(
								name: name, mime_type: mimeType, content: data.base64EncodedString(),
								encoding: .base64))))
			}
			switch output {
			case .created(let created): return try created.body.json.id
			case .badRequest: throw ShareError.fileRejected(name: name)
			case .internalServerError: throw ShareError.server
			case .undocumented(let status, _): throw Self.failure(status: status)
			}
		} catch { throw Self.map(error) }
	}

	public func attach(
		fileID: String, toObject objectID: String, objectType: String, idempotencyKey: String
	) async throws {
		do {
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_relationships(
					.init(
						headers: .init(x_hyphen_workspace_hyphen_id: workspaceID),
						body: .json(
							.init(
								source_type: objectType, source_id: objectID, target_type: "file",
								target_id: fileID, _type: Self.attachedRelation))))
			}
			switch output {
			case .created: return
			case .badRequest: throw ShareError.rejected
			case .internalServerError: throw ShareError.server
			case .undocumented(let status, _): throw Self.failure(status: status)
			}
		} catch { throw Self.map(error) }
	}

	static func failure(status: Int) -> ShareError {
		switch status {
		case 401: .sessionExpired
		case 408, 429, 500...599: .server
		case 400...499: .rejected
		default: .unknown
		}
	}

	static func map(_ error: Error) -> ShareError {
		if let error = error as? ShareError { return error }
		var current: Error? = error
		while let e = current {
			if let url = e as? URLError {
				let offline: Set<URLError.Code> = [
					.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
					.cannotFindHost, .timedOut, .dataNotAllowed,
				]
				return offline.contains(url.code) ? .offline : .server
			}
			current = (e as? ClientError)?.underlyingError
		}
		return .unknown
	}
}

private struct ShareWorkspaceDTO: Decodable {
	var id: String
	var name: String
	var settings: JSONValue?
}
