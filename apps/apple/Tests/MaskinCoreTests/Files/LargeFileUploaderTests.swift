import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

/// Plays storage and the API from memory and records every request with its body.
private final class StoreProtocol: URLProtocol, @unchecked Sendable {
	struct Seen {
		var method: String
		var path: String
		var authorization: String?
		var body: Data
	}
	nonisolated(unsafe) static var seen: [Seen] = []
	/// Statuses to answer the next PUTs with before answering 200.
	nonisolated(unsafe) static var putFailures: [Int] = []
	nonisolated(unsafe) static var completeStatus = 201
	static let lock = NSLock()

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

	override func startLoading() {
		let r = request
		var body = r.httpBody ?? Data()
		if let stream = r.httpBodyStream {
			stream.open()
			var buffer = [UInt8](repeating: 0, count: 4096)
			while stream.hasBytesAvailable {
				let n = stream.read(&buffer, maxLength: buffer.count)
				if n <= 0 { break }
				body.append(buffer, count: n)
			}
			stream.close()
		}
		let path = r.url?.path ?? ""
		var status = 200
		var headers = ["Content-Type": "application/json"]
		var reply = Data("{}".utf8)
		Self.lock.withLock {
			Self.seen.append(
				Seen(
					method: r.httpMethod ?? "", path: path, authorization: r.value(forHTTPHeaderField: "Authorization"),
					body: body))
			switch (r.httpMethod ?? "", path) {
			case ("POST", "/api/files/uploads"):
				status = 201
				reply = Data(
					"""
					{"upload_id":"up-1","file_id":"f-1","part_size":4,"expires_at":"2030-01-01T00:00:00Z",
					"parts":[{"part_number":1,"url":"https://storage.test/part/1"},
					{"part_number":2,"url":"https://storage.test/part/2"}]}
					""".utf8)
			case ("PUT", _):
				if !Self.putFailures.isEmpty {
					status = Self.putFailures.removeFirst()
				} else {
					headers["ETag"] = "\"etag-\(path.last.map(String.init) ?? "")\""
				}
			case ("POST", "/api/files/uploads/up-1/complete"):
				status = Self.completeStatus
				reply = Data(
					#"{"id":"file-9","name":"Report.pdf","mimeType":"application/pdf","sizeBytes":6}"#.utf8)
			default:
				break
			}
		}
		let response = HTTPURLResponse(url: r.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: reply)
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

@Suite("LargeFileUploader", .serialized)
struct LargeFileUploaderTests {
	private func uploader() -> LargeFileUploader {
		StoreProtocol.lock.withLock {
			StoreProtocol.seen = []
			StoreProtocol.putFailures = []
			StoreProtocol.completeStatus = 201
		}
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [StoreProtocol.self]
		let transport = LargeFileUploadTransport(
			baseURL: URL(string: "https://api.test")!, clientSource: "test",
			credentials: { MaskinCredentials(apiKey: "ank_test", workspaceId: "ws-1") },
			session: URLSession(configuration: config))
		return LargeFileUploader(transport: transport, workspaceID: "ws-1", retryDelay: { _ in .milliseconds(1) })
	}

	private var seen: [StoreProtocol.Seen] { StoreProtocol.lock.withLock { StoreProtocol.seen } }

	private func tempFile(_ text: String) throws -> URL {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).pdf")
		try Data(text.utf8).write(to: url)
		return url
	}

	@Test("the JSON route's cap decides which way a file goes")
	func routing() {
		let mib = 1024 * 1024
		#expect(!FileUploadLimits.needsDirectUpload(sizeBytes: 10 * mib, mimeType: "application/pdf"))
		#expect(FileUploadLimits.needsDirectUpload(sizeBytes: 10 * mib + 1, mimeType: "application/pdf"))
		#expect(!FileUploadLimits.needsDirectUpload(sizeBytes: 50 * mib, mimeType: "video/quicktime"))
		#expect(FileUploadLimits.needsDirectUpload(sizeBytes: 50 * mib + 1, mimeType: "video/mp4"))
		#expect(ChatLimits.maxFileBytes == 1024 * mib)
	}

	@Test("parts are cut from the file in order, sent without credentials, and completed with their ETags")
	func uploadsInParts() async throws {
		let url = try tempFile("abcdef")
		defer { try? FileManager.default.removeItem(at: url) }
		let ref = try await uploader().upload(name: "Report.pdf", mimeType: "application/pdf", fileURL: url, sizeBytes: 6)

		#expect(ref.fileID == "file-9")
		let puts = seen.filter { $0.method == "PUT" }
		#expect(puts.map { String(decoding: $0.body, as: UTF8.self) } == ["abcd", "ef"])
		#expect(puts.allSatisfy { $0.authorization == nil })
		let start = try #require(seen.first)
		#expect(start.authorization == "Bearer ank_test")
		let startBody = try #require(try JSONSerialization.jsonObject(with: start.body) as? [String: Any])
		#expect(startBody["size_bytes"] as? Int == 6)
		#expect(startBody["mime_type"] as? String == "application/pdf")
		let complete = try #require(seen.last)
		#expect(complete.path == "/api/files/uploads/up-1/complete")
		let done = try JSONDecoder().decode([String: [LargeFileUploader.StoredPart]].self, from: complete.body)
		#expect(done["parts"] == [.init(part_number: 1, etag: "\"etag-1\""), .init(part_number: 2, etag: "\"etag-2\"")])
	}

	@Test("a part that fails is tried again, up to three times")
	func retriesAPart() async throws {
		let url = try tempFile("abcdef")
		defer { try? FileManager.default.removeItem(at: url) }
		let upload = uploader()
		StoreProtocol.lock.withLock { StoreProtocol.putFailures = [500, 503] }
		_ = try await upload.upload(name: "Report.pdf", mimeType: "application/pdf", fileURL: url, sizeBytes: 6)
		#expect(seen.filter { $0.method == "PUT" }.count == 4)
	}

	@Test("a part that keeps failing abandons the upload and reports the error")
	func abandonsOnFailure() async throws {
		let url = try tempFile("abcdef")
		defer { try? FileManager.default.removeItem(at: url) }
		let upload = uploader()
		StoreProtocol.lock.withLock { StoreProtocol.putFailures = [500, 500, 500] }
		await #expect(throws: ChatsError.self) {
			try await upload.upload(name: "Report.pdf", mimeType: "application/pdf", fileURL: url, sizeBytes: 6)
		}
		#expect(seen.filter { $0.method == "PUT" }.count == 3)
		#expect(seen.contains { $0.method == "DELETE" && $0.path == "/api/files/uploads/up-1" })
		#expect(!seen.contains { $0.path.hasSuffix("/complete") })
	}

	@Test("a file over 1 GB is refused before anything is sent")
	func refusesOversize() async throws {
		let upload = uploader()
		await #expect(throws: ChatsError.self) {
			try await upload.upload(
				name: "Huge.bin", mimeType: "application/octet-stream",
				fileURL: URL(fileURLWithPath: "/dev/null"), sizeBytes: FileUploadLimits.maxLargeFileBytes + 1)
		}
		#expect(seen.isEmpty)
	}
}
