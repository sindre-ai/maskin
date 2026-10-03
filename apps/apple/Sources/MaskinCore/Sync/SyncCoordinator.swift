import Foundation
import Observation

/// The scene phase as a plain value, so MaskinCore needs no SwiftUI. Map `ScenePhase` onto it in
/// the app shell: `.active` / `.inactive` / `.background`.
public enum SyncScenePhase: Sendable, Equatable {
	case active, inactive, background
}

/// One place for "keep the app's data current":
/// - returning to the foreground after a while asks every store to refetch;
/// - connectivity is observed (`isOnline`, for a global offline banner) and regaining it
///   refreshes and lets the outbox replay;
/// - bursts (a flapping network, rapid foreground/background) coalesce into one refresh.
///
/// Refreshing is `EventHub.requestRefresh()`, i.e. the existing `.reconnected` signal that every
/// store already handles, so adopting stores need no extra wiring.
@MainActor
@Observable
public final class SyncCoordinator {
	public struct Tuning: Sendable, Equatable {
		/// Foreground refresh only after being away at least this long.
		public var staleAfter: TimeInterval
		/// Never request two refreshes closer than this (coalescing window).
		public var minRefreshInterval: TimeInterval
		public init(staleAfter: TimeInterval = 45, minRefreshInterval: TimeInterval = 5) {
			self.staleAfter = staleAfter
			self.minRefreshInterval = minRefreshInterval
		}
	}

	/// Best current guess; `true` until the system says otherwise. Drives the global offline banner.
	public private(set) var isOnline: Bool

	@ObservationIgnored private let network: any NetworkMonitoring
	@ObservationIgnored private let refresh: @MainActor () -> Void
	@ObservationIgnored private let outboxDidBecomeActive: (@MainActor () -> Void)?
	@ObservationIgnored private let outboxDrain: (@MainActor () async -> Void)?
	@ObservationIgnored private let outboxReleaseHolds: (@MainActor () -> Void)?
	@ObservationIgnored private let tuning: Tuning
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var backgroundedAt: Date?
	@ObservationIgnored private var lastRefreshAt: Date?
	@ObservationIgnored private var observer: Task<Void, Never>?

	public init(
		network: any NetworkMonitoring = NWPathNetworkMonitor(),
		refresh: @escaping @MainActor () -> Void,
		outboxDidBecomeActive: (@MainActor () -> Void)? = nil,
		outboxDrain: (@MainActor () async -> Void)? = nil,
		outboxReleaseHolds: (@MainActor () -> Void)? = nil,
		tuning: Tuning = Tuning(),
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.network = network
		self.refresh = refresh
		self.outboxDidBecomeActive = outboxDidBecomeActive
		self.outboxDrain = outboxDrain
		self.outboxReleaseHolds = outboxReleaseHolds
		self.tuning = tuning
		self.now = now
		self.isOnline = network.isOnline
	}

	/// Production wiring: refreshes through the event hub, and drives the outbox when given.
	public convenience init(
		events: EventHub, outbox: Outbox? = nil, network: any NetworkMonitoring = NWPathNetworkMonitor(),
		tuning: Tuning = Tuning()
	) {
		var onActive: (@MainActor () -> Void)?
		var drain: (@MainActor () async -> Void)?
		var release: (@MainActor () -> Void)?
		if let outbox {
			onActive = { outbox.appDidBecomeActive() }
			drain = { await outbox.drain() }
			release = { outbox.releaseHolds() }
		}
		let refresh: @MainActor () -> Void = { [weak events] in events?.requestRefresh() }
		self.init(
			network: network, refresh: refresh, outboxDidBecomeActive: onActive,
			outboxDrain: drain, outboxReleaseHolds: release, tuning: tuning)
	}

	deinit { observer?.cancel() }

	/// Begin observing connectivity. Idempotent.
	public func start() {
		guard observer == nil else { return }
		let updates = network.updates()
		observer = Task { [weak self] in
			for await online in updates {
				guard let self else { return }
				await self.networkChanged(online: online)
			}
		}
	}

	public func stop() {
		observer?.cancel()
		observer = nil
	}

	// MARK: Scene

	/// Convenience for `.onChange(of: scenePhase)`.
	public func scenePhaseChanged(_ phase: SyncScenePhase) {
		switch phase {
		case .active: appDidBecomeActive()
		case .background: appDidEnterBackground()
		case .inactive: break
		}
	}

	public func appDidEnterBackground() {
		backgroundedAt = now()
		outboxReleaseHolds?()
	}

	public func appDidBecomeActive() {
		isOnline = network.isOnline
		outboxDidBecomeActive?()
		defer { backgroundedAt = nil }
		guard let away = backgroundedAt, now().timeIntervalSince(away) >= tuning.staleAfter else {
			return
		}
		requestRefresh(reason: "foreground")
	}

	// MARK: Connectivity

	/// A reachability flip. Going offline only flips `isOnline`; coming back online refreshes
	/// (coalesced, so a flapping link refreshes once per window) and lets the outbox replay.
	public func networkChanged(online: Bool) async {
		guard online != isOnline else { return }
		isOnline = online
		SyncLog.sync.info("connectivity online=\(online)")
		guard online else { return }
		requestRefresh(reason: "reconnected")
		if let outboxDrain {
			SyncLog.sync.info("outbox drain requested reason=reconnected")
			await outboxDrain()
		}
	}

	// MARK: Refresh

	/// Ask every store to refetch. Returns whether a refresh was actually sent: not while
	/// offline, and not twice inside `minRefreshInterval`.
	@discardableResult
	public func requestRefresh(reason: String = "manual") -> Bool {
		let current = now()
		guard isOnline else {
			SyncLog.sync.debug("refresh skipped reason=offline")
			return false
		}
		if let last = lastRefreshAt, current.timeIntervalSince(last) < tuning.minRefreshInterval {
			SyncLog.sync.debug("refresh coalesced reason=\(reason, privacy: .public)")
			return false
		}
		lastRefreshAt = current
		SyncLog.sync.info("refresh reason=\(reason, privacy: .public)")
		refresh()
		return true
	}
}
