import Foundation
import Testing

@testable import MaskinCore

@Suite("ShareQueue sign-out")
struct ShareQueueSignOutTests {
	private let scratch = ShareScratch()

	private func request(attachments: Int = 0) -> ShareRequest {
		let files = (0..<attachments).map { index in
			ShareAttachment(
				kind: .pdf, name: "Brief\(index).pdf", mimeType: "application/pdf",
				fileURL: scratch.file("Brief\(index).pdf", bytes: 64), sizeBytes: 64)
		}
		return ShareRequest(
			destination: .object(type: "insight"), title: "A page", note: "Look at this",
			content: ShareContent(
				link: URL(string: "https://example.com/p"), linkTitle: "A page", attachments: files),
			status: "new")
	}

	@Test("removeAll drops every parked share and its files, and the queue still works after")
	func removeAll() throws {
		let queue = ShareQueue(root: scratch.url.appendingPathComponent("queue"))
		_ = try queue.enqueue(request(attachments: 1), workspaceId: "ws-1", idempotencyBase: "a")
		_ = try queue.enqueue(request(), workspaceId: "ws-1", idempotencyBase: "b")
		#expect(queue.pending().count == 2)
		queue.removeAll()
		#expect(queue.pending().isEmpty)
		#expect(!FileManager.default.fileExists(atPath: queue.root.path))
		_ = try queue.enqueue(request(), workspaceId: "ws-2", idempotencyBase: "c")
		#expect(queue.pending().count == 1)
	}
}
