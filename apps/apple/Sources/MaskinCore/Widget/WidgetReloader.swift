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
	private let lock = NSLock()
	private var pending: Task<Void, Never>?

	public init(wrapping base: any WidgetReloader, delay: TimeInterval = 1.5) {
		self.base = base
		self.delay = delay
	}

	public func reload() {
		lock.withLock {
			pending?.cancel()
			pending = Task { [base, delay] in
				try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
				guard !Task.isCancelled else { return }
				base.reload()
			}
		}
	}
}
