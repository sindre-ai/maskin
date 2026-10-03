import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `FilesRemote`. File bytes arrive inline in the JSON body, so no separate
/// authenticated download is involved.
public struct APIFilesRemote: FilesRemote {
	private let client: Client
	/// Only the list needs the workspace header; by-id calls derive it from the file.
	private let credentials: MaskinCredentialsProvider?

	public init(client: Client, credentials: MaskinCredentialsProvider? = nil) {
		self.client = client
		self.credentials = credentials
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

	public func saveAnnotations(
		fileId: String, annotations: [FileAnnotation], idempotencyKey: String
	) async throws -> [FileAnnotation] {
		do {
			let body = try Self.convert(
				PatchDTO(annotations: annotations.map(AnnotationDTO.init)),
				as: Operations.patch_sol_api_sol_files_sol__lcub_id_rcub_.Input.Body.jsonPayload.self)
			let output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
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

	var model: FileSummary {
		FileSummary(
			id: id, name: name, description: description, mimeType: mimeType, sizeBytes: sizeBytes,
			updatedAt: updatedAt.flatMap(ISODate.parse))
	}
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
