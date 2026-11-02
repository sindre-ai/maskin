import Foundation

/// Coalesces a burst of live events into one trailing refetch. Events carry ids only, so each
/// one used to trigger a full reload; a busy workspace emits dozens of session events a minute.
@MainActor
final class RefreshDebouncer {
	typealias Sleep = @Sendable (Duration) async -> Void

	private let delay: Duration
	private let sleep: Sleep
	private var pending: Task<Void, Never>?

	init(delay: Duration = .seconds(1), sleep: @escaping Sleep = { try? await Task.sleep(for: $0) }) {
		self.delay = delay
		self.sleep = sleep
	}

	/// Runs `action` once, `delay` after the first call in a burst; calls inside the window are
	/// absorbed into it.
	func schedule(_ action: @escaping @MainActor () async -> Void) {
		guard pending == nil else { return }
		pending = Task { [delay, sleep] in
			await sleep(delay)
			guard !Task.isCancelled else { return }
			self.pending = nil
			await action()
		}
	}

	func cancel() {
		pending?.cancel()
		pending = nil
	}
}
