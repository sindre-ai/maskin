import Foundation

/// Coalesces a burst of live events into one trailing refetch. Events carry ids only, so each
/// one used to trigger a full reload; a busy workspace emits dozens of session events a minute.
///
/// `minInterval` also spaces the runs: a refetch never starts sooner than that after the last
/// one (a run of this debouncer, or one the owner reported with `noteRan()`), so a steady
/// stream of events costs one request per interval, not one per `delay`.
@MainActor
final class RefreshDebouncer {
	typealias Sleep = @Sendable (Duration) async -> Void
	typealias Clock = @MainActor () -> ContinuousClock.Instant

	private let delay: Duration
	private let minInterval: Duration
	private let sleep: Sleep
	private let now: Clock
	private var pending: Task<Void, Never>?
	private var lastRun: ContinuousClock.Instant?

	init(
		delay: Duration = .seconds(1), minInterval: Duration = .zero,
		sleep: @escaping Sleep = { try? await Task.sleep(for: $0) },
		now: @escaping Clock = { ContinuousClock.now }
	) {
		self.delay = delay
		self.minInterval = minInterval
		self.sleep = sleep
		self.now = now
	}

	/// Runs `action` once, `delay` after the first call in a burst (or when `minInterval` since the
	/// last run is up, if that is later); calls inside the window are absorbed into it.
	func schedule(_ action: @escaping @MainActor () async -> Void) {
		guard pending == nil else { return }
		let wait = max(delay, untilIntervalElapsed())
		pending = Task { [sleep] in
			await sleep(wait)
			guard !Task.isCancelled else { return }
			self.pending = nil
			self.lastRun = self.now()
			await action()
		}
	}

	/// The owner refetched on its own (first load, pull to refresh): count it as a run.
	func noteRan() { lastRun = now() }

	/// A run started less than `minInterval` ago.
	var isFresh: Bool { untilIntervalElapsed() > .zero }

	/// Runs `action` now unless a run started less than `minInterval` ago. For a reconnect or a
	/// return to the foreground, where every open list asks at once.
	func runIfStale(_ action: @MainActor () async -> Void) async {
		guard !isFresh else { return }
		lastRun = now()
		await action()
	}

	func cancel() {
		pending?.cancel()
		pending = nil
	}

	/// Waits for the scheduled run, if any, to finish. For tests.
	func settle() async { await pending?.value }

	private func untilIntervalElapsed() -> Duration {
		guard let lastRun else { return .zero }
		return max(.zero, minInterval - (now() - lastRun))
	}
}
