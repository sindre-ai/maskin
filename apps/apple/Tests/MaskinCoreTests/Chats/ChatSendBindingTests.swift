import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

/// Answers every request with a 400, so the send ends in an error we ignore: these tests only
/// care how many times the Idempotency-Key was bound on the way there.
private struct RefusingTransport: ClientTransport {
	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var response = HTTPResponse(status: .badRequest)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(#"{"error":{"code":"X","message":"no"}}"#))
	}
}

private final class BindLog: @unchecked Sendable {
	private let lock = NSLock()
	private var keys: [String?] = []
	func add(_ key: String?) { lock.withLock { keys.append(key) } }
	func count(of key: String) -> Int { lock.withLock { keys.filter { $0 == key }.count } }
}

/// A nested `TaskLocal.withValue` yields the right value everywhere except the iOS 17 runtime
/// that aborts on it, so the value cannot show the bug. The count of real bindings can.
@Suite("Chat send binds the idempotency key once")
struct ChatSendBindingTests {
	@Test("a queued chat send goes from the outbox to the request through one binding")
	@MainActor
	func queuedSendBindsOnce() async throws {
		let client = Client(
			serverURL: URL(string: "http://localhost:3000")!, transport: RefusingTransport(),
			middlewares: [IdempotencyMiddleware()])
		let source = APIChatsSource(client: client, workspaceID: "ws-1")
		let executor = ChatSendExecutor(api: source, onDelivered: { _, _ in })
		let outbox = Outbox(
			fileURL: temporaryOutboxFile(), executor: executor, network: ManualNetworkMonitor(),
			workspaceId: { "ws-1" }, backoff: { _ in 0.02 }, maxAttempts: 1)

		let log = BindLog()
		IdempotencyKey.rebindObserver = { log.add($0) }
		defer { IdempotencyKey.rebindObserver = nil }

		let payload = ChatSendPayload(
			clientID: "c1", conversationID: "conv-1", content: "hi", metadata: nil,
			afterServerID: nil, createdAt: Date(), thread: nil)
		let entry = try outbox.enqueue(
			kind: ChatSendQueue.sendKind, lane: "conv-1", summary: "hi", payload: payload)
		#expect(await eventually { outbox.entries.isEmpty })

		// Bound once by the outbox. The source's own bind of the same key must be a no-op.
		#expect(log.count(of: entry.idempotencyKey) == 1)
	}
}
