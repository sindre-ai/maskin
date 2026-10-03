import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

@testable import MaskinCore

/// A scratch directory per test, removed on deinit.
final class ShareScratch: @unchecked Sendable {
	let url: URL
	init() {
		url = FileManager.default.temporaryDirectory.appendingPathComponent("share-test-\(UUID().uuidString)")
		try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
	}
	deinit { try? FileManager.default.removeItem(at: url) }

	func file(_ name: String, bytes: Int) -> URL {
		let target = url.appendingPathComponent(name)
		try? Data(repeating: 0x41, count: bytes).write(to: target)
		return target
	}

	/// A real image of `width`x`height`, noisy enough that it doesn't compress to nothing.
	func image(_ name: String, width: Int, height: Int, type: UTType = .jpeg) -> URL {
		let target = url.appendingPathComponent(name)
		let space = CGColorSpaceCreateDeviceRGB()
		let ctx = CGContext(
			data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
		for i in 0..<40 {
			ctx.setFillColor(
				CGColor(red: CGFloat(i % 7) / 7, green: CGFloat(i % 5) / 5, blue: CGFloat(i % 3) / 3, alpha: 1))
			ctx.fill(CGRect(x: i * width / 40, y: 0, width: width / 40 + 1, height: height))
		}
		let sink = CGImageDestinationCreateWithURL(target as CFURL, type.identifier as CFString, 1, nil)!
		CGImageDestinationAddImage(sink, ctx.makeImage()!, nil)
		CGImageDestinationFinalize(sink)
		return target
	}
}

/// A scripted `ShareItemSource`.
struct ShareFakeSource: ShareItemSource {
	var typeIdentifiers: [String]
	var suggestedName: String?
	var url: URL?
	var text: String?
	var file: URL?
	var loadFails = false

	func loadURL() async throws -> URL? {
		if loadFails { throw ShareItemUnreadable() }
		return url
	}
	func loadText() async throws -> String? {
		if loadFails { throw ShareItemUnreadable() }
		return text
	}
	func withFile<T: Sendable>(
		conformingTo type: UTType, _ body: @escaping @Sendable (URL) throws -> T
	) async throws -> T {
		guard let file else { throw ShareItemUnreadable() }
		return try body(file)
	}

	static func link(_ string: String) -> ShareFakeSource {
		ShareFakeSource(typeIdentifiers: [UTType.url.identifier], url: URL(string: string))
	}
	static func text(_ string: String) -> ShareFakeSource {
		ShareFakeSource(typeIdentifiers: [UTType.plainText.identifier], text: string)
	}
	static func image(_ file: URL, name: String? = nil) -> ShareFakeSource {
		ShareFakeSource(typeIdentifiers: [UTType.jpeg.identifier], suggestedName: name, file: file)
	}
	static func pdf(_ file: URL, name: String? = nil) -> ShareFakeSource {
		ShareFakeSource(typeIdentifiers: [UTType.pdf.identifier], suggestedName: name, file: file)
	}
}

/// Lets tests write `.link("…")` where a `[any ShareItemSource]` is expected.
extension ShareItemSource where Self == ShareFakeSource {
	static func link(_ string: String) -> ShareFakeSource { ShareFakeSource.link(string) }
	static func text(_ string: String) -> ShareFakeSource { ShareFakeSource.text(string) }
	static func image(_ file: URL, name: String? = nil) -> ShareFakeSource { ShareFakeSource.image(file, name: name) }
	static func pdf(_ file: URL, name: String? = nil) -> ShareFakeSource { ShareFakeSource.pdf(file, name: name) }
}

/// Records calls; failures are scripted per operation and consumed once.
final class FakeShareRemote: ShareRemote, @unchecked Sendable {
	enum Call: Equatable {
		case workspace
		case createObject(type: String, title: String, content: String, status: String, key: String)
		case upload(name: String, mime: String, key: String)
		case attach(file: String, object: String, objectType: String, key: String)
		case chat(conversation: String, content: String, files: [String], key: String)
	}

	private let lock = NSLock()
	private var _calls: [Call] = []
	var calls: [Call] { lock.withLock { _calls } }
	var workspaceResult: Result<ShareWorkspace, ShareError> = .success(
		ShareWorkspace(id: "ws-1", name: "Mesh Firm", schema: .fallback))
	var workspacesResult: [ShareWorkspace] = [
		ShareWorkspace(id: "ws-1", name: "Mesh Firm", schema: .fallback),
		ShareWorkspace(id: "ws-2", name: "Side Project", schema: .fallback),
	]
	var conversationsResult: [ShareConversation] = [ShareConversation(id: "c-1", title: "Launch plan")]
	/// Errors thrown by the next N calls of each kind.
	private var failures: [String: [ShareError]] = [:]
	private var counter = 0

	func failNext(_ op: String, with errors: ShareError...) {
		lock.withLock { failures[op, default: []] += errors }
	}

	private func record(_ call: Call, op: String) throws {
		try lock.withLock {
			_calls.append(call)
			if var queue = failures[op], !queue.isEmpty {
				let error = queue.removeFirst()
				failures[op] = queue
				throw error
			}
		}
	}

	private func nextID(_ prefix: String) -> String {
		lock.withLock {
			counter += 1
			return "\(prefix)-\(counter)"
		}
	}

	func workspace() async throws -> ShareWorkspace {
		try record(.workspace, op: "workspace")
		return try workspaceResult.get()
	}

	func workspaces() async throws -> [ShareWorkspace] { workspacesResult }
	func conversations() async throws -> [ShareConversation] { conversationsResult }
	func sendChatMessage(
		conversationID: String, content: String, attachments: [ChatAttachmentRef], idempotencyKey: String
	) async throws {
		try record(
			.chat(conversation: conversationID, content: content, files: attachments.map(\.fileID), key: idempotencyKey),
			op: "chat")
	}

	func createObject(
		type: String, title: String, content: String, status: String, idempotencyKey: String
	) async throws -> String {
		try record(
			.createObject(type: type, title: title, content: content, status: status, key: idempotencyKey),
			op: "object")
		return nextID("obj")
	}

	func uploadFile(name: String, mimeType: String, fileURL: URL, idempotencyKey: String) async throws -> String {
		try record(.upload(name: name, mime: mimeType, key: idempotencyKey), op: "upload")
		return nextID("file")
	}

	func attach(fileID: String, toObject objectID: String, objectType: String, idempotencyKey: String) async throws {
		try record(.attach(file: fileID, object: objectID, objectType: objectType, key: idempotencyKey), op: "attach")
	}
}
