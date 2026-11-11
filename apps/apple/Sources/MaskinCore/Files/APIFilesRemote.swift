import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `FilesRemote`. File bytes arrive inline in the JSON body, so no separate
/// authenticated download is involved.
public struct APIFilesRemote: FilesRemote {
	private let client: Client
	/// Only the list needs the workspace header; by-id calls derive it from the file.
	private let credentials: MaskinCredentialsProvider?
	/// Where the tag calls go. The generated client predates the tag fields, so these requests are
	/// built by hand; without it the tag calls report that tags aren't available.
	private let raw: RawTransport?

	struct RawTransport: Sendable {
		var baseURL: URL
		var clientSource: String
		var session: URLSession
	}

	public init(client: Client, credentials: MaskinCredentialsProvider? = nil) {
		self.client = client
		self.credentials = credentials
		self.raw = nil
	}

	public init(
		client: Client, credentials: MaskinCredentialsProvider?, baseURL: URL, clientSource: String,
		session: URLSession = .shared
	) {
		self.client = client
		self.credentials = credentials
		self.raw = RawTransport(baseURL: baseURL, clientSource: clientSource, session: session)
	}

	// MARK: Tags

	public func list(query: String, tags: [String], match: FileTagMatch, limit: Int, offset: Int) async throws
		-> [FileSummary]
	{
		// No tags: the generated call, exactly as before.
		if tags.isEmpty { return try await list(query: query, limit: limit, offset: offset) }
		var items = [
			URLQueryItem(name: "tags", value: tags.joined(separator: ",")),
			URLQueryItem(name: "tags_match", value: match.rawValue),
			URLQueryItem(name: "limit", value: String(min(limit, ServerLimits.maxPageSize))),
			URLQueryItem(name: "offset", value: String(offset)),
		]
		if !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
		let data = try await send(method: "GET", path: "api/files", query: items)
		return try Self.decode([SummaryDTO].self, from: data).map(\.model)
	}

	public func tagCounts() async throws -> [FileTagCount] {
		let data = try await send(method: "GET", path: "api/files/tags")
		return try Self.decode([TagCountDTO].self, from: data).map { FileTagCount(tag: $0.tag, count: $0.count) }
	}

	public func tags(ofFile id: String) async throws -> [String] {
		let data = try await send(
			method: "GET", path: "api/files",
			query: [URLQueryItem(name: "ids", value: id), URLQueryItem(name: "limit", value: "1")])
		guard let row = try Self.decode([SummaryDTO].self, from: data).first else {
			throw FileError("This file doesn't exist or you don't have access.", isNotFound: true)
		}
		return row.tags ?? []
	}

	public func saveTags(fileId: String, tags: [String], idempotencyKey: String) async throws -> [String] {
		let body = try JSONEncoder().encode(TagsPatchDTO(tags: tags))
		let data = try await send(
			method: "PATCH", path: "api/files/\(fileId)", body: body, idempotencyKey: idempotencyKey)
		return try Self.decode(TagsPatchDTO.self, from: data).tags
	}

	/// One hand-built request. Built apart from sending so a test can read the path, headers and body.
	func makeRequest(
		method: String, path: String, query: [URLQueryItem], body: Data?, idempotencyKey: String?,
		transport: RawTransport
	) async -> URLRequest {
		var components = URLComponents(
			url: transport.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
		if !query.isEmpty { components?.queryItems = query }
		var request = URLRequest(url: components?.url ?? transport.baseURL.appendingPathComponent(path))
		request.httpMethod = method
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(transport.clientSource, forHTTPHeaderField: "X-Client-Source")
		if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
		if let credentials = await credentials?() {
			request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = credentials.workspaceId {
				request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
			}
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = body
		}
		return request
	}

	private func send(
		method: String, path: String, query: [URLQueryItem] = [], body: Data? = nil,
		idempotencyKey: String? = nil
	) async throws -> Data {
		guard let raw else { throw FileError("Tags aren't available here.") }
		let request = await makeRequest(
			method: method, path: path, query: query, body: body, idempotencyKey: idempotencyKey,
			transport: raw)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await raw.session.data(for: request)
		} catch {
			let d = RemoteFailure.describe(error)
			throw FileError(d.message, isOffline: d.isOffline)
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		switch status {
		case 200..<300: return data
		case 404: throw FileError("This file doesn't exist or you don't have access.", isNotFound: true)
		default: throw FileError("The server couldn't update tags.")
		}
	}

	static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
		do {
			return try JSONDecoder().decode(type, from: data)
		} catch {
			throw FileError("Maskin sent a reply this version can't read.")
		}
	}

	public func list(query: String, limit: Int, offset: Int) async throws -> [FileSummary] {
		let workspace = await credentials?()?.workspaceId ?? ""
		do {
			let output = try await client.get_sol_api_sol_files(
				.init(
					query: .init(
						q: query.isEmpty ? nil : query, limit: min(limit, ServerLimits.maxPageSize),
						offset: offset),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw FileError("The server couldn't list files.") }
			return try Self.convert(ok.body.json, as: [SummaryDTO].self).map(\.model)
		} catch {
			if let error = error as? FileError { throw error }
			let d = RemoteFailure.describe(error)
			throw FileError(d.message, isOffline: d.isOffline)
		}
	}

	public func briefings(limit: Int) async throws -> [FileSummary] {
		let workspace = await credentials?()?.workspaceId ?? ""
		do {
			let output = try await client.get_sol_api_sol_files(
				.init(
					query: .init(kind: .briefing, limit: min(limit, ServerLimits.maxPageSize)),
					headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
			guard case .ok(let ok) = output else { throw FileError("The server couldn't list briefings.") }
			return try Self.convert(ok.body.json, as: [SummaryDTO].self).map(\.model)
		} catch {
			if let error = error as? FileError { throw error }
			let d = RemoteFailure.describe(error)
			throw FileError(d.message, isOffline: d.isOffline)
		}
	}

	/// The server caps a page at `ServerLimits.maxPageSize`, so ids go in chunks that fit both that
	/// and a sensible URL length.
	public func summaries(ids: [String]) async throws -> [FileSummary] {
		let unique = Array(NSOrderedSet(array: ids)) as? [String] ?? ids
		guard !unique.isEmpty else { return [] }
		let workspace = await credentials?()?.workspaceId ?? ""
		let chunkSize = 40
		var found: [FileSummary] = []
		for start in stride(from: 0, to: unique.count, by: chunkSize) {
			let chunk = unique[start..<min(start + chunkSize, unique.count)]
			do {
				let output = try await client.get_sol_api_sol_files(
					.init(
						query: .init(ids: chunk.joined(separator: ","), limit: chunk.count),
						headers: .init(x_hyphen_workspace_hyphen_id: workspace)))
				guard case .ok(let ok) = output else { throw FileError("The server couldn't list files.") }
				found += try Self.convert(ok.body.json, as: [SummaryDTO].self).map(\.model)
			} catch {
				if let error = error as? FileError { throw error }
				let d = RemoteFailure.describe(error)
				throw FileError(d.message, isOffline: d.isOffline)
			}
		}
		return found
	}

	public func saveAnnotations(
		fileId: String, annotations: [FileAnnotation], idempotencyKey: String
	) async throws -> [FileAnnotation] {
		do {
			let body = try Self.convert(
				PatchDTO(annotations: annotations.map(AnnotationDTO.init)),
				as: Operations.patch_sol_api_sol_files_sol__lcub_id_rcub_.Input.Body.jsonPayload.self)
			let output = try await IdempotencyKey.bind(idempotencyKey) {
				try await client.patch_sol_api_sol_files_sol__lcub_id_rcub_(
					.init(path: .init(id: fileId), body: .json(body)))
			}
			switch output {
			case .ok(let ok):
				return try Self.convert(ok.body.json.annotations ?? [], as: [AnnotationDTO].self).map(\.model)
			case .notFound:
				throw FileError("This file doesn't exist or you don't have access.", isNotFound: true)
			default:
				throw FileError("The server couldn't save your comment.")
			}
		} catch {
			if let error = error as? FileError { throw error }
			let d = RemoteFailure.describe(error)
			throw FileError(d.message, isOffline: d.isOffline)
		}
	}

	static func convert<T: Decodable>(_ value: some Encodable, as: T.Type) throws -> T {
		try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
	}

	public func file(id: String) async throws -> FileDetail {
		do {
			let output = try await client.get_sol_api_sol_files_sol__lcub_id_rcub_(.init(path: .init(id: id)))
			switch output {
			case .ok(let ok):
				// Mapped straight from the decoded body: re-encoding a 10 MB payload to JSON and back
				// would copy the bytes several more times.
				return try Self.model(ok.body.json)
			case .notFound:
				throw FileError("This file doesn't exist or you don't have access.", isNotFound: true)
			default:
				throw FileError("The server couldn't load this file.")
			}
		} catch {
			if let error = error as? FileError { throw error }
			let d = RemoteFailure.describe(error)
			throw FileError(d.message, isOffline: d.isOffline)
		}
	}

	private static func model(_ json: Operations.get_sol_api_sol_files_sol__lcub_id_rcub_.Output.Ok.Body.jsonPayload)
		throws -> FileDetail
	{
		let bytes: Data
		if json.encoding == .base64 {
			guard let decoded = Data(base64Encoded: json.content) else {
				throw FileError("This file's contents couldn't be read.")
			}
			bytes = decoded
		} else {
			bytes = Data(json.content.utf8)
		}
		return FileDetail(
			id: json.id, name: json.name, description: json.description, mimeType: json.mimeType,
			sizeBytes: json.sizeBytes, createdAt: ISODate.parse(json.createdAt),
			updatedAt: ISODate.parse(json.updatedAt), data: bytes,
			annotations: ((try? convert(json.annotations ?? [], as: [AnnotationDTO].self)) ?? []).map(\.model))
	}
}

// MARK: - DTOs

private struct SummaryDTO: Decodable {
	var id: String
	var name: String
	var description: String?
	var mimeType: String
	var sizeBytes: Int
	var updatedAt: String?
	/// Absent from the generated client's list body until it is regenerated, hence optional.
	var tags: [String]?

	var model: FileSummary {
		FileSummary(
			id: id, name: name, description: description, mimeType: mimeType, sizeBytes: sizeBytes,
			updatedAt: updatedAt.flatMap(ISODate.parse), tags: tags ?? [])
	}
}

private struct TagCountDTO: Decodable {
	var tag: String
	var count: Int
}

/// The body of a tag save, and the part of the file the server answers with.
private struct TagsPatchDTO: Codable {
	var tags: [String]
}

private struct PatchDTO: Encodable {
	var annotations: [AnnotationDTO]
}

/// The wire shape of a pin, both directions.
struct AnnotationDTO: Codable {
	var id: String
	var pinNumber: Int?
	var selector: String?
	var bounds: FileBounds
	var comment: String
	var position: FilePoint?

	init(_ a: FileAnnotation) {
		id = a.id
		pinNumber = a.pinNumber
		selector = a.selector
		bounds = a.bounds
		comment = a.comment
		position = a.position
	}

	var model: FileAnnotation {
		FileAnnotation(
			id: id, pinNumber: pinNumber, comment: comment, selector: selector ?? "", bounds: bounds,
			position: position)
	}
}
