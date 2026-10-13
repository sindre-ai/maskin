import Foundation
import Testing

@testable import MaskinCore

private final class Clock: @unchecked Sendable {
	private let lock = NSLock()
	private var date = Date(timeIntervalSince1970: 1_000_000)
	var now: Date {
		lock.lock()
		defer { lock.unlock() }
		return date
	}
	func advance(_ seconds: TimeInterval) {
		lock.lock()
		date = date.addingTimeInterval(seconds)
		lock.unlock()
	}
}

@MainActor
private final class Probe {
	var refreshes = 0
	var drains = 0
	var becameActive = 0
	var holds = 0
}

@MainActor
private func make(
	online: Bool = true, clock: Clock, probe: Probe, network: ManualNetworkMonitor? = nil
) -> (SyncCoordinator, ManualNetworkMonitor) {
	let net = network ?? ManualNetworkMonitor(isOnline: online)
	let coordinator = SyncCoordinator(
		network: net, refresh: { probe.refreshes += 1 },
		outboxDidBecomeActive: { probe.becameActive += 1 },
		outboxDrain: { probe.drains += 1 }, outboxReleaseHolds: { probe.holds += 1 },
		tuning: .init(staleAfter: 45, minRefreshInterval: 5), now: { clock.now })
	return (coordinator, net)
}

@MainActor
@Suite("SyncCoordinator")
struct SyncCoordinatorTests {
	@Test func foregroundAfterALongAbsenceRefreshesOnce() {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(clock: clock, probe: probe)
		sync.appDidEnterBackground()
		clock.advance(120)
		sync.appDidBecomeActive()
		#expect(probe.refreshes == 1)
		#expect(probe.becameActive == 1)
		#expect(probe.holds == 1)
	}

	@Test func aQuickAppSwitchDoesNotRefresh() {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(clock: clock, probe: probe)
		sync.appDidEnterBackground()
		clock.advance(10)
		sync.appDidBecomeActive()
		#expect(probe.refreshes == 0)
		#expect(probe.becameActive == 1)
	}

	@Test func coldLaunchActivationDoesNotRefresh() {
		let probe = Probe()
		let (sync, _) = make(clock: Clock(), probe: probe)
		sync.appDidBecomeActive()
		#expect(probe.refreshes == 0)
	}

	@Test func regainingConnectivityRefreshesAndDrainsTheOutbox() async {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(clock: clock, probe: probe)
		await sync.networkChanged(online: false)
		#expect(!sync.isOnline)
		#expect(probe.refreshes == 0)
		clock.advance(60)
		await sync.networkChanged(online: true)
		#expect(sync.isOnline)
		#expect(probe.refreshes == 1)
		#expect(probe.drains == 1)
	}

	@Test func aFlappingNetworkCoalescesRefreshesButAlwaysDrains() async {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(clock: clock, probe: probe)
		for _ in 0..<4 {
			await sync.networkChanged(online: false)
			clock.advance(0.5)
			await sync.networkChanged(online: true)
			clock.advance(0.5)
		}
		#expect(probe.refreshes == 1)
		#expect(probe.drains == 4)
	}

	@Test func noRefreshWhileOffline() async {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(online: false, clock: clock, probe: probe)
		#expect(sync.requestRefresh() == false)
		#expect(probe.refreshes == 0)
	}

	@Test func refreshesAfterTheCoalescingWindowGoThrough() {
		let clock = Clock()
		let probe = Probe()
		let (sync, _) = make(clock: clock, probe: probe)
		#expect(sync.requestRefresh())
		#expect(!sync.requestRefresh())
		clock.advance(6)
		#expect(sync.requestRefresh())
		#expect(probe.refreshes == 2)
	}

	@Test func observedNetworkUpdatesReachTheCoordinator() async throws {
		let clock = Clock()
		let probe = Probe()
		let (sync, net) = make(clock: clock, probe: probe)
		sync.start()
		net.set(online: false)
		for _ in 0..<200 where sync.isOnline { await Task.yield() }
		#expect(!sync.isOnline)
		sync.stop()
	}

	@Test func eventHubRequestRefreshBroadcastsReconnected() async {
		let hub = EventHub(client: nil)
		let stream = hub.subscribe()
		hub.requestRefresh()
		var iterator = stream.makeAsyncIterator()
		#expect(await iterator.next() == .reconnected)
	}
}
