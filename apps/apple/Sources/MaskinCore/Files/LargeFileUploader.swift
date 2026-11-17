import Foundation
import MaskinAPI

/// Upload caps (`packages/shared/src/schemas/files.ts`). A file the JSON route (`POST /api/files`,
/// base64) accepts goes that way; anything bigger goes straight to storage in parts.
public enum FileUploadLimits {
	/// `MAX_FILE_SIZE_BYTES`: what the JSON route takes for every type except video.
	public static let maxJSONBytes = 10 * 1024 * 1024
	/// `MAX_VIDEO_FILE_SIZE_BYTES`.
	public static let maxJSONVideoBytes = 50 * 1024 * 1024
	/// `MAX_LARGE_FILE_SIZE_BYTES` (1 GiB): the ceiling for a direct upload.
	public static let maxLargeFileBytes = 1024 * 1024 * 1024
	/// `MAX_INLINE_FILE_SIZE_BYTES`: above this a file is read back as a download URL, not inline bytes.
	public static let maxInlineBytes = maxJSONVideoBytes

	/// `maxFileSizeBytesFor`: the JSON route's cap for a file of this type.
	public static func maxJSONBytes(forMime mime: String) -> Int {
		mime.lowercased().hasPrefix("video/") ? maxJSONVideoBytes : maxJSONBytes
	}

	/// True when the JSON route would refuse this file, so it has to go to storage in parts.
	public static func needsDirectUpload(sizeBytes: Int, mimeType: String) -> Bool {
		sizeBytes > maxJSONBytes(forMime: mimeType)
	}
}

/// Where the hand-built upload requests go. The generated client predates the `/api/files/uploads`
/// routes, so `LargeFileUploader` builds these requests itself with the same headers.
public struct LargeFileUploadTransport: Sendable {
	public var baseURL: URL
	public var clientSource: String
	public var credentials: MaskinCredentialsProvider
	public var session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}
}

/// Sends a file of up to 1 GiB straight to object storage over presigned multipart URLs, the way the
/// web does (`apps/web/src/lib/large-file-upload.ts`, `docs/runbooks/large-file-uploads.md`):
/// start, PUT each part and keep its ETag, complete. Parts are read from disk one at a time, so the
/// file is never held in memory whole. Abandoning the upload (failure or cancel) tells the API to
/// discard the parts already stored.
public struct LargeFileUploader: Sendable {
	static let partAttempts = 3
	static let completeAttempts = 3

	let transport: LargeFileUploadTransport
	let workspaceID: String
	/// Pause before the next try of a part or of complete; shortened in tests.
	let retryDelay: @Sendable (Int) -> Duration

	public init(
		transport: LargeFileUploadTransport, workspaceID: String,
		retryDelay: @escaping @Sendable (Int) -> Duration = { .milliseconds(500 * $0) }
	) {
		self.transport = transport
		self.workspaceID = workspaceID
		self.retryDelay = retryDelay
	}

	struct Part: Decodable, Equatable {
		var part_number: Int
		var url: String
	}
	struct StartResponse: Decodable {
		var upload_id: String
		var part_size: Int
		var parts: [Part]
	}
	struct StoredPart: Codable, Equatable {
		var part_number: Int
		var etag: String
	}
	private struct StartBody: Encodable {
		var name: String
		var mime_type: String
		var size_bytes: Int
	}
	private struct CompleteBody: Encodable {
		var parts: [StoredPart]
	}
	private struct FileRow: Decodable {
		var id: String
		var name: String
		var mimeType: String
		var sizeBytes: Int
	}

	public func upload(
		name: String, mimeType: String, fileURL: URL, sizeBytes: Int
	) async throws -> ChatAttachmentRef {
		guard sizeBytes > 0, sizeBytes <= FileUploadLimits.maxLargeFileBytes else {
			throw ChatsError("That file is over the 1 GB limit.")
		}
		let started = try await start(name: name, mimeType: mimeType, sizeBytes: sizeBytes)
		let stored: [StoredPart]
		do {
			stored = try await putParts(started, fileURL: fileURL, sizeBytes: sizeBytes)
		} catch {
			await abandon(started.upload_id)
			throw error
		}
		let row = try await complete(uploadID: started.upload_id, parts: stored)
		return ChatAttachmentRef(fileID: row.id, name: row.name, mimeType: row.mimeType, sizeBytes: row.sizeBytes)
	}

	// MARK: Steps

	private func start(name: String, mimeType: String, sizeBytes: Int) async throws -> StartResponse {
		let body = try JSONEncoder().encode(StartBody(name: name, mime_type: mimeType, size_bytes: sizeBytes))
		let (data, status) = try await send(method: "POST", path: "api/files/uploads", body: body)
		guard (200..<300).contains(status) else {
			throw status == 400
				? ChatsError("The server didn't accept that file.") : Self.failure(status: status)
		}
		return try Self.decode(StartResponse.self, from: data)
	}

	/// The parts, in order. Each is read from disk only when its turn comes and dropped after its PUT.
	private func putParts(_ started: StartResponse, fileURL: URL, sizeBytes: Int) async throws -> [StoredPart] {
		let handle = try FileHandle(forReadingFrom: fileURL)
		defer { try? handle.close() }
		var stored: [StoredPart] = []
		for part in started.parts.sorted(by: { $0.part_number < $1.part_number }) {
			try Task.checkCancellation()
			let offset = (part.part_number - 1) * started.part_size
			let length = min(started.part_size, sizeBytes - offset)
			guard length > 0, let url = URL(string: part.url) else {
				throw ChatsError("The server sent an upload address this version can't use.")
			}
			let etag = try await putWithRetry(url: url, handle: handle, offset: offset, length: length)
			stored.append(StoredPart(part_number: part.part_number, etag: etag))
		}
		return stored
	}

	private func putWithRetry(url: URL, handle: FileHandle, offset: Int, length: Int) async throws -> String {
		var lastError: any Error = ChatsError("The upload failed.")
		for attempt in 1...Self.partAttempts {
			try Task.checkCancellation()
			do {
				try handle.seek(toOffset: UInt64(offset))
				guard let chunk = try handle.read(upToCount: length), chunk.count == length else {
					throw ChatsError("Couldn't read that file.")
				}
				return try await put(url: url, chunk: chunk)
			} catch is CancellationError {
				throw CancellationError()
			} catch let error as URLError where error.code == .cancelled {
				throw CancellationError()
			} catch {
				lastError = error
				if attempt < Self.partAttempts { try await Task.sleep(for: retryDelay(attempt)) }
			}
		}
		throw lastError
	}

	/// One part to its presigned URL. No auth headers: the URL is signed, and an extra header the
	/// signature doesn't cover can make storage refuse it.
	private func put(url: URL, chunk: Data) async throws -> String {
		var request = URLRequest(url: url)
		request.httpMethod = "PUT"
		request.timeoutInterval = 300
		let (_, response) = try await transport.session.upload(for: request, from: chunk)
		guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
			throw ChatsError("The upload failed (storage error \((response as? HTTPURLResponse)?.statusCode ?? 0)).")
		}
		guard let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty else {
			throw ChatsError("The upload couldn't be finished (storage sent no part receipt).")
		}
		return etag
	}

	/// Completing is safe to repeat (the server returns the file the first call made), so a lost
	/// answer or a 5xx is retried. A refusal abandons the upload.
	private func complete(uploadID: String, parts: [StoredPart]) async throws -> FileRow {
		let body = try JSONEncoder().encode(CompleteBody(parts: parts))
		let key = IdempotencyKey.make()
		var lastError: any Error = ChatsError("The upload failed.")
		for attempt in 1...Self.completeAttempts {
			do {
				let (data, status) = try await send(
					method: "POST", path: "api/files/uploads/\(uploadID)/complete", body: body, idempotencyKey: key)
				if (200..<300).contains(status) { return try Self.decode(FileRow.self, from: data) }
				if status < 500 {
					await abandon(uploadID)
					throw Self.failure(status: status)
				}
				lastError = Self.failure(status: status)
			} catch let error as URLError where error.code != .cancelled {
				lastError = error
			}
			if attempt < Self.completeAttempts { try await Task.sleep(for: retryDelay(attempt)) }
		}
		throw lastError
	}

	/// Best effort: tell the API to throw the stored parts away. Runs in its own task so a cancelled
	/// upload still gets to send it.
	private func abandon(_ uploadID: String) async {
		await Task {
			_ = try? await send(method: "DELETE", path: "api/files/uploads/\(uploadID)", body: nil)
		}.value
	}

	// MARK: Requests

	func makeRequest(method: String, path: String, body: Data?, idempotencyKey: String?) async -> URLRequest {
		var request = URLRequest(url: transport.baseURL.appendingPathComponent(path))
		request.httpMethod = method
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(transport.clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(workspaceID, forHTTPHeaderField: "X-Workspace-Id")
		request.setValue(idempotencyKey ?? IdempotencyKey.make(), forHTTPHeaderField: "Idempotency-Key")
		if let credentials = await transport.credentials() {
			request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = body
		}
		return request
	}

	private func send(
		method: String, path: String, body: Data?, idempotencyKey: String? = nil
	) async throws -> (Data, Int) {
		let request = await makeRequest(method: method, path: path, body: body, idempotencyKey: idempotencyKey)
		let (data, response) = try await transport.session.data(for: request)
		return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
	}

	static func failure(status: Int) -> ChatsError {
		switch status {
		case 400: ChatsError("The server didn't accept that file.")
		case 401: ChatsError("You're signed out. Sign in again to upload.")
		case 403: ChatsError("You don't have permission to upload files here.")
		default: ChatsError("The upload failed (error \(status)).")
		}
	}

	static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
		do {
			return try JSONDecoder().decode(type, from: data)
		} catch {
			throw ChatsError("Maskin sent a reply this version can't read.")
		}
	}
}
