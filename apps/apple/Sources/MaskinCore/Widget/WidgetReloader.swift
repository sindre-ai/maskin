import Foundation
#if canImport(WidgetKit) && (os(iOS) || os(macOS) || os(watchOS))
	import WidgetKit
#endif

/// Tells the system the widgets' data changed. The app calls it when the For You feed or a
/// decision changes and on sign-out/sign-in; WidgetKit then asks the extension for a new timeline.
public protocol WidgetReloader: Sendable {
	func reload()
}

public struct NoopWidgetReloader: WidgetReloader {
	public init() {}
	public func reload() {}
}

#if canImport(WidgetKit) && (os(iOS) || os(macOS) || os(watchOS))
	public struct SystemWidgetReloader: WidgetReloader {
		public init() {}
		public func reload() { WidgetCenter.shared.reloadAllTimelines() }
	}
#endif

/// The reloader the app should use on this platform.
public func makeWidgetReloader() -> any WidgetReloader {
	#if canImport(WidgetKit) && (os(iOS) || os(macOS) || os(watchOS))
		DebouncedWidgetReloader(wrapping: SystemWidgetReloader())
	#else
		NoopWidgetReloader()
	#endif
}

/// Collapses a burst of calls (a feed refresh and the decisions it triggers) into one reload,
/// fired `delay` after the LAST call.
public final class DebouncedWidgetReloader: WidgetReloader, @unchecked Sendable {
	private let base: any WidgetReloader
	private let delay: TimeInterval
	private let sleep: @Sendable (TimeInterval) async -> Void
	private let lock = NSLock()
	private var pending: Task<Void, Never>?

	/// `sleep` is how the delay is waited out; tests pass their own so a burst is coalesced by
	/// construction instead of by racing a real clock.
	public init(
		wrapping base: any WidgetReloader, delay: TimeInterval = 1.5,
		sleep: @escaping @Sendable (TimeInterval) async -> Void = {
			try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000))
		}
	) {
		self.base = base
		self.delay = delay
		self.sleep = sleep
	}

	public func reload() {
		lock.withLock {
			pending?.cancel()
			pending = Task { [base, delay, sleep] in
				await sleep(delay)
				guard !Task.isCancelled else { return }
				base.reload()
			}
		}
	}
}
