import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `FilesRemote`. File bytes arrive inline in the JSON body, so no separate
/// authenticated download is involved.
public struct APIFilesRemote: FilesRemote {
	private let client: Client

	public init(client: Client) { self.client = client }

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
			annotations: (json.annotations ?? []).map {
				FileAnnotation(id: $0.id, pinNumber: $0.pinNumber, comment: $0.comment)
			})
	}
}
