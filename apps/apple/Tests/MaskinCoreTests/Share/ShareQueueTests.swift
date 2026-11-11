import Foundation
import Testing

@testable import MaskinCore

private func request(
	_ scratch: ShareScratch, destination: ShareDestination = .object(type: "insight"),
	attachments: Int = 0
) -> ShareRequest {
	let files = (0..<attachments).map { index in
		ShareAttachment(
			kind: .pdf, name: "Brief\(index).pdf", mimeType: "application/pdf",
			fileURL: scratch.file("Brief\(index).pdf", bytes: 64), sizeBytes: 64)
	}
	return ShareRequest(
		destination: destination, title: "A page", note: "Look at this",
		content: ShareContent(
			link: URL(string: "https://example.com/p"), linkTitle: "A page", attachments: files),
		status: "new")
}

@Suite("ShareQueue")
struct ShareQueueTests {
	private let scratch = ShareScratch()
	private var queue: ShareQueue { ShareQueue(root: scratch.url.appendingPathComponent("queue")) }

	@Test("a parked share round-trips into the same request, files copied out of the temp area")
	func roundTrip() throws {
		let original = request(scratch, destination: .chat(id: "c-1"), attachments: 2)
		let share = try queue.enqueue(original, workspaceId: "ws-1", idempotencyBase: "base-1")
		// The extension's temp files may vanish right after enqueue.
		for attachment in original.content.attachments { try FileManager.default.removeItem(at: attachment.fileURL) }

		let listed = try #require(queue.pending().first)
		#expect(listed == share)
		let rebuilt = try #require(queue.request(for: listed))
		#expect(rebuilt.destination == .chat(id: "c-1"))
		#expect(rebuilt.note == "Look at this")
		#expect(rebuilt.content.link == original.content.link)
		#expect(rebuilt.content.attachments.map(\.name) == ["Brief0.pdf", "Brief1.pdf"])
		#expect(rebuilt.content.attachments.allSatisfy { FileManager.default.fileExists(atPath: $0.fileURL.path) })
		#expect(listed.idempotencyBase == "base-1")
	}

	@Test("remove deletes the share and its files")
	func remove() throws {
		let share = try queue.enqueue(request(scratch, attachments: 1), workspaceId: "ws-1", idempotencyBase: "b")
		queue.remove(share.id)
		#expect(queue.pending().isEmpty)
		let leftovers = try FileManager.default.contentsOfDirectory(at: queue.root, includingPropertiesForKeys: nil)
		#expect(leftovers.isEmpty)
	}

	@Test("refuses past the cap instead of growing without bound")
	func cap() throws {
		let queue = queue
		for _ in 0..<ShareQueue.maxPending {
			try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b")
		}
		#expect(throws: ShareError.queueFull) {
			try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b")
		}
	}

	@Test("drops shares older than the max age")
	func expiry() throws {
		let now = Date()
		try queue.enqueue(
			request(scratch), workspaceId: "ws-1", idempotencyBase: "old",
			now: now.addingTimeInterval(-ShareQueue.maxAge - 60))
		let fresh = try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "new", now: now)
		queue.purgeExpired(now: now)
		#expect(queue.pending().map(\.id) == [fresh.id])
	}

	@Test("an unwritable location is reported, not swallowed")
	func unwritable() {
		let blocked = ShareQueue(root: URL(fileURLWithPath: "/dev/null/queue"))
		#expect(throws: ShareError.queueUnavailable) {
			try blocked.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b")
		}
	}
}

@Suite("ShareQueueDrainer")
struct ShareQueueDrainerTests {
	private let scratch = ShareScratch()
	private var queue: ShareQueue { ShareQueue(root: scratch.url.appendingPathComponent("queue")) }

	@Test("sends each parked share to its own workspace with its original idempotency base")
	func sends() async throws {
		let queue = queue
		try queue.enqueue(request(scratch, attachments: 1), workspaceId: "ws-1", idempotencyBase: "b1")
		try queue.enqueue(request(scratch), workspaceId: "ws-2", idempotencyBase: "b2")
		let remote = FakeShareRemote()
		let seen = WorkspaceLog()
		let drainer = ShareQueueDrainer(queue: queue) { credentials in
			seen.add(credentials.workspaceId)
			return remote
		}

		let report = await drainer.drain(apiKey: "ank_x")
		#expect(report == .init(sent: 2, dropped: 0, remaining: 0))
		#expect(seen.values == ["ws-1", "ws-2"])
		#expect(queue.pending().isEmpty)
		let keys = remote.calls.compactMap { call -> String? in
			if case .createObject(_, _, _, _, let key) = call { key } else { nil }
		}
		#expect(keys == ["b1-object", "b2-object"])
	}

	@Test("stops at an offline failure and keeps that share and the ones behind it")
	func stopsOffline() async throws {
		let queue = queue
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b1")
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b2")
		let remote = FakeShareRemote()
		remote.failNext("object", with: .offline)
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 0, dropped: 0, remaining: 2))
		#expect(remote.calls.count == 1)
	}

	@Test("drops a share the server refuses for good so it can't block the rest")
	func dropsRefused() async throws {
		let queue = queue
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b1")
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b2")
		let remote = FakeShareRemote()
		remote.failNext("object", with: .rejected)
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 1, dropped: 1, droppedReasons: [.rejected], remaining: 0))
	}

	@Test("keeps everything when the session expired, for after the next sign-in")
	func expiredSession() async throws {
		let queue = queue
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "b1")
		let remote = FakeShareRemote()
		remote.failNext("object", with: .sessionExpired)
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 0, dropped: 0, remaining: 1))
	}
}

@Suite("ShareQueueDrainer new chat")
struct ShareQueueDrainerNewChatTests {
	private let scratch = ShareScratch()
	private var queue: ShareQueue { ShareQueue(root: scratch.url.appendingPathComponent("queue")) }

	private func chatKeys(_ remote: FakeShareRemote) -> [String] {
		remote.calls.compactMap { call -> String? in
			if case .createChat(_, _, _, _, let key) = call { key } else { nil }
		}
	}

	@Test("a saved share keeps its agent and its files, and the chat starts with them on the next open")
	func startsWithAgentAndFiles() async throws {
		let queue = queue
		try queue.enqueue(
			request(scratch, destination: .newChat(agentID: "agent-cpo"), attachments: 2), workspaceId: "ws-1",
			idempotencyBase: "b1")
		let remote = FakeShareRemote()
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 1, dropped: 0, remaining: 0))
		let created = remote.calls.compactMap { call -> (String, [String])? in
			if case .createChat(let agent, _, _, let files, _) = call { (agent, files) } else { nil }
		}
		#expect(created.count == 1 && created.first?.0 == "agent-cpo" && created.first?.1.count == 2)
	}

	@Test("a second drain never starts the same chat twice")
	func drainTwice() async throws {
		let queue = queue
		try queue.enqueue(
			request(scratch, destination: .newChat(agentID: "agent-cpo")), workspaceId: "ws-1", idempotencyBase: "b1")
		let remote = FakeShareRemote()
		let drainer = ShareQueueDrainer(queue: queue) { _ in remote }
		_ = await drainer.drain(apiKey: "k")
		let second = await drainer.drain(apiKey: "k")
		#expect(second == .init(sent: 0, dropped: 0, remaining: 0))
		#expect(chatKeys(remote) == ["share-chat-b1"])
	}

	@Test("a server hiccup keeps the share, and the retry uses the same chat key")
	func hiccupThenRetry() async throws {
		let queue = queue
		try queue.enqueue(
			request(scratch, destination: .newChat(agentID: "agent-cpo")), workspaceId: "ws-1", idempotencyBase: "b1")
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .server)
		let drainer = ShareQueueDrainer(queue: queue) { _ in remote }
		let first = await drainer.drain(apiKey: "k")
		#expect(first == .init(sent: 0, dropped: 0, remaining: 1))
		let second = await drainer.drain(apiKey: "k")
		#expect(second == .init(sent: 1, dropped: 0, remaining: 0))
		#expect(chatKeys(remote) == ["share-chat-b1", "share-chat-b1"])
	}

	@Test("a refused chat is dropped with its reason and does not block the next share")
	func refusedWithReason() async throws {
		let queue = queue
		try queue.enqueue(
			request(scratch, destination: .newChat(agentID: "agent-cpo")), workspaceId: "ws-1", idempotencyBase: "b1")
		try queue.enqueue(
			request(scratch, destination: .newChat(agentID: "agent-cpo")), workspaceId: "ws-1", idempotencyBase: "b2")
		let remote = FakeShareRemote()
		remote.failNext("createChat", with: .rejected)
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 1, dropped: 1, droppedReasons: [.rejected], remaining: 0))
	}

	@Test("shares saved before this change (an item, or a message to a chat) are still sent as they were")
	func oldSharesStillSend() async throws {
		let queue = queue
		try queue.enqueue(request(scratch), workspaceId: "ws-1", idempotencyBase: "old-1")
		try queue.enqueue(request(scratch, destination: .chat(id: "c-1")), workspaceId: "ws-1", idempotencyBase: "old-2")
		let remote = FakeShareRemote()
		let report = await ShareQueueDrainer(queue: queue) { _ in remote }.drain(apiKey: "k")
		#expect(report == .init(sent: 2, dropped: 0, remaining: 0))
		#expect(
			remote.calls.contains(
				.createObject(
					type: "insight", title: "A page", content: "Look at this\n\n[A page](https://example.com/p)",
					status: "new", key: "old-1-object")))
		#expect(
			remote.calls.contains(
				.chat(
					conversation: "c-1", content: "Look at this\n\n[A page](https://example.com/p)", files: [],
					key: "old-2-message")))
	}

	@Test("a share.json written by the previous build still reads back")
	func previousFormatReads() throws {
		let queue = queue
		let id = UUID()
		let folder = queue.root.appendingPathComponent(id.uuidString, isDirectory: true)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let json = """
			{"id":"\(id.uuidString)","createdAt":\(Date().timeIntervalSinceReferenceDate),"workspaceId":"ws-1",
			"destination":{"kind":"object","value":"insight"},"title":"T","note":"N","status":"new",
			"text":"hello","attachments":[],"idempotencyBase":"legacy"}
			"""
		try Data(json.utf8).write(to: folder.appendingPathComponent("share.json"))
		let share = try #require(queue.pending().first)
		#expect(share.destination.destination == .object(type: "insight"))
		#expect(share.idempotencyBase == "legacy")
		#expect(queue.request(for: share) != nil)
	}
}

private final class WorkspaceLog: @unchecked Sendable {
	private let lock = NSLock()
	private var _values: [String] = []
	var values: [String] { lock.withLock { _values } }
	func add(_ value: String) { lock.withLock { _values.append(value) } }
}
