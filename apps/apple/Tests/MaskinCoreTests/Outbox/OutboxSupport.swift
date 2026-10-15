import Foundation
import MaskinAPI

@testable import MaskinCore

/// Polls until `condition` holds (up to ~3s). The outbox drains on background tasks, so tests
/// wait for the observable outcome instead of sleeping a fixed time.
@MainActor
func eventually(
	timeout: Duration = .seconds(15), _ condition: @MainActor () -> Bool
) async -> Bool {
	let deadline = ContinuousClock.now.advanced(by: timeout)
	while ContinuousClock.now < deadline {
		if condition() { return true }
		try? await Task.sleep(for: .milliseconds(10))
	}
	return condition()
}

func temporaryOutboxFile() -> URL {
	FileManager.default.temporaryDirectory
		.appendingPathComponent("outbox-tests-\(UUID().uuidString)", isDirectory: true)
		.appendingPathComponent("outbox.json")
}

/// Executor that records each call (with the Idempotency-Key in scope) and fails on script.
final class ScriptedExecutor: OutboxExecuting, @unchecked Sendable {
	struct Call: Equatable { var kind: String; var payload: String; var key: String? }

	private let lock = NSLock()
	private var recorded: [Call] = []
	private var scripted: [String: [any Error]] = [:]

	var calls: [Call] { lock.withLock { recorded } }

	/// Errors thrown, in order, the next times a payload is executed; then it succeeds.
	func fail(payload: String, with errors: [any Error]) {
		lock.withLock { scripted[payload] = errors }
	}

	func execute(kind: String, payload: Data) async throws {
		let text = (try? JSONDecoder().decode(String.self, from: payload)) ?? ""
		let key = IdempotencyKey.current
		let next: (any Error)? = lock.withLock {
			recorded.append(Call(kind: kind, payload: text, key: key))
			guard var queue = scripted[text], !queue.isEmpty else { return nil }
			let error = queue.removeFirst()
			scripted[text] = queue
			return error
		}
		if let next { throw next }
	}
}
