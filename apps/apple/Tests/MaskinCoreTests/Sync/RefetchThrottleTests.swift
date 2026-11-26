import Foundation
import Testing

@testable import MaskinCore

/// A debouncer with no waiting: an event refetches at once.
@MainActor
func instantRefetch() -> RefreshDebouncer {
	RefreshDebouncer(delay: .zero, sleep: { _ in })
}

/// A clock the test moves by hand. `sleep` parks until `advance` passes its deadline, so events at
/// known times cause refetches at known times.
@MainActor
final class VirtualTime {
	private(set) var now = ContinuousClock.now
	private var sleepers: [(deadline: ContinuousClock.Instant, wake: CheckedContinuation<Void, Never>)] = []

	func sleep(_ duration: Duration) async {
		let deadline = now + duration
		await withCheckedContinuation { sleepers.append((deadline: deadline, wake: $0)) }
	}

	/// Moves time forward, waking each sleeper whose deadline passes, earliest first.
	func advance(by duration: Duration) async {
		let target = now + duration
		while let next = sleepers.enumerated()
			.filter({ $0.element.deadline <= target })
			.min(by: { $0.element.deadline < $1.element.deadline })
		{
			sleepers.remove(at: next.offset)
			now = max(now, next.element.deadline)
			next.element.wake.resume()
			await settleHard()
		}
		now = target
	}

	/// Lets queued tasks (an event reaching a store, a sleeper registering) run.
	func settle() async {
		for _ in 0..<30 { await Task.yield() }
	}

	/// Also waits out the fake network round trips of a refetch that has just started.
	func settleHard() async {
		await settle()
		try? await Task.sleep(for: .milliseconds(30))
		await settle()
	}
}

@MainActor
private final class Counter { var n = 0 }

private func sessionEvent(_ i: Int) -> HubSignal {
	.event(WorkspaceEvent(id: "\(i)", action: "updated", entityType: .session, entityId: "s\(i)"))
}

private func chatEvent(_ i: Int) -> HubSignal {
	.event(WorkspaceEvent(id: "\(i)", action: "message_posted", entityType: .conversation, entityId: "c\(i)"))
}

@Suite("RefreshDebouncer spacing")
@MainActor
struct RefreshDebouncerSpacingTests {
	private func debouncer(_ time: VirtualTime) -> RefreshDebouncer {
		RefreshDebouncer(
			delay: .seconds(1), minInterval: .seconds(5), sleep: { await time.sleep($0) }, now: { time.now })
	}

	@Test("the first event after quiet waits the base delay, the next waits out the interval")
	func spacing() async {
		let time = VirtualTime()
		let d = debouncer(time)
		let runs = Counter()
		d.schedule { runs.n += 1 }
		await time.settle()
		await time.advance(by: .seconds(1))
		#expect(runs.n == 1)
		d.schedule { runs.n += 1 }
		await time.settle()
		await time.advance(by: .seconds(4))
		#expect(runs.n == 1)
		await time.advance(by: .seconds(1))
		#expect(runs.n == 2)
	}

	@Test("runIfStale skips a run that follows another within the interval")
	func runIfStale() async {
		let time = VirtualTime()
		let d = debouncer(time)
		let runs = Counter()
		await d.runIfStale { runs.n += 1 }
		await d.runIfStale { runs.n += 1 }
		#expect(runs.n == 1)
		await time.advance(by: .seconds(5))
		await d.runIfStale { runs.n += 1 }
		#expect(runs.n == 2)
	}

	@Test("a refetch the owner reports counts as a run")
	func noteRan() async {
		let time = VirtualTime()
		let d = debouncer(time)
		d.noteRan()
		#expect(d.isFresh)
		await time.advance(by: .seconds(5))
		#expect(!d.isFresh)
	}
}

@Suite("Agents store refetch limits")
@MainActor
struct AgentsStoreRefetchTests {
	private func makeStore(_ api: FakeAgentsAPI, hub: EventHub?, _ time: VirtualTime) -> AgentsStore {
		AgentsStore(
			api: api, events: hub, debounce: .seconds(1), minInterval: .seconds(5),
			sleep: { await time.sleep($0) }, now: { time.now })
	}

	@Test("50 session events in 10 seconds reload the actors list at most twice")
	func burst() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let initial = await api.calls
		for i in 1...50 {
			hub.broadcast(sessionEvent(i))
			await time.settle()
			await time.advance(by: .milliseconds(200))
		}
		let caused = await api.calls - initial
		#expect(caused >= 1)
		#expect(caused <= 2)
		store.stop()
	}

	@Test("a reconnect right after a reload does not reload again; a later one does")
	func reconnectGate() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let initial = await api.calls
		hub.broadcast(.reconnected)
		await time.settleHard()
		#expect(await api.calls == initial)
		await time.advance(by: .seconds(6))
		hub.broadcast(.reconnected)
		await time.settleHard()
		#expect(await api.calls == initial + 1)
		store.stop()
	}

	@Test("no reload for events in the background; one when the app comes back")
	func background() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let initial = await api.calls
		hub.setForeground(false)
		for i in 1...10 {
			hub.broadcast(sessionEvent(i))
			await time.settle()
			await time.advance(by: .seconds(1))
		}
		#expect(await api.calls == initial)
		hub.setForeground(true)
		await time.settleHard()
		#expect(await api.calls == initial + 1)
		store.stop()
	}

	@Test("coming back with nothing skipped reloads nothing")
	func foregroundWithoutSkips() async {
		let api = FakeAgentsAPI([agentRow("forge")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let initial = await api.calls
		hub.setForeground(false)
		await time.advance(by: .seconds(30))
		hub.setForeground(true)
		await time.settleHard()
		#expect(await api.calls == initial)
		store.stop()
	}

	@Test("a quiet agent's latest session is asked for at most once a minute")
	func quietLookups() async {
		let api = FakeAgentsAPI([agentRow("quiet")])
		await api.set(latest: ["quiet": agentSession("old", actor: "quiet")])
		let time = VirtualTime()
		let store = makeStore(api, hub: nil, time)
		await store.refresh()
		await store.refresh()
		await store.refresh()
		#expect(await api.latestCalls == ["quiet"])
		#expect(store.agent(id: "quiet")?.latestSession?.id == "old")
		await time.advance(by: .seconds(61))
		await store.refresh()
		#expect(await api.latestCalls == ["quiet", "quiet"])
	}
}

@Suite("Team list refetch limits")
@MainActor
struct ConversationsStoreRefetchTests {
	private func makeStore(_ api: FakeListAPI, hub: EventHub, _ time: VirtualTime) -> ConversationsStore {
		func refetch() -> RefreshDebouncer {
			RefreshDebouncer(
				delay: .seconds(1), minInterval: .seconds(5), sleep: { await time.sleep($0) },
				now: { time.now })
		}
		return ConversationsStore(
			api: api, events: hub, chatRefetch: refetch(), peopleRefetch: refetch())
	}

	@Test("50 chat events in 10 seconds reload the chat list and the threads list at most twice each")
	func chatBurst() async {
		let api = FakeListAPI([chatConvo("a")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let lists = await api.listCalls
		let threads = await api.threadsCalls
		for i in 1...50 {
			hub.broadcast(chatEvent(i))
			await time.settle()
			await time.advance(by: .milliseconds(200))
		}
		// One list request per reload (the archived list is only asked for on start and reconnect).
		let listsCaused = await api.listCalls - lists
		let threadsCaused = await api.threadsCalls - threads
		#expect(listsCaused >= 1 && listsCaused <= 2)
		#expect(threadsCaused >= 1 && threadsCaused <= 2)
		store.stop()
	}

	@Test("50 session events in 10 seconds reload the actors list at most twice")
	func actorsBurst() async {
		let api = FakeListAPI([chatConvo("a")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let initial = await api.actorsCalls
		for i in 1...50 {
			hub.broadcast(sessionEvent(i))
			await time.settle()
			await time.advance(by: .milliseconds(200))
		}
		let caused = await api.actorsCalls - initial
		#expect(caused >= 1 && caused <= 2)
		store.stop()
	}

	@Test("a reconnect right after a reload reloads no list; a later one reloads each once")
	func reconnectGate() async {
		let api = FakeListAPI([chatConvo("a")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let (lists, threads, actors) = (await api.listCalls, await api.threadsCalls, await api.actorsCalls)
		hub.broadcast(.reconnected)
		await time.settleHard()
		#expect(await api.listCalls == lists)
		#expect(await api.threadsCalls == threads)
		#expect(await api.actorsCalls == actors)
		await time.advance(by: .seconds(6))
		hub.broadcast(.reconnected)
		await time.settleHard()
		#expect(await api.threadsCalls == threads + 1)
		#expect(await api.actorsCalls == actors + 1)
		// The chat list and the archived list: two list requests.
		#expect(await api.listCalls == lists + 2)
		store.stop()
	}

	@Test("no reload for events in the background; one reload per list when the app comes back")
	func background() async {
		let api = FakeListAPI([chatConvo("a")])
		let hub = EventHub(client: nil)
		let time = VirtualTime()
		let store = makeStore(api, hub: hub, time)
		await store.start()
		let (lists, threads, actors) = (await api.listCalls, await api.threadsCalls, await api.actorsCalls)
		hub.setForeground(false)
		for i in 1...10 {
			hub.broadcast(chatEvent(i))
			hub.broadcast(sessionEvent(i))
			await time.settle()
			await time.advance(by: .seconds(1))
		}
		#expect(await api.listCalls == lists)
		#expect(await api.threadsCalls == threads)
		#expect(await api.actorsCalls == actors)
		hub.setForeground(true)
		await time.settleHard()
		#expect(await api.threadsCalls == threads + 1)
		#expect(await api.actorsCalls == actors + 1)
		store.stop()
	}
}

@MainActor
private final class Seen { var values: [Bool] = [] }

@Suite("Foreground state reaches the event hub")
@MainActor
struct ForegroundStateTests {
	@Test("the coordinator reports leaving and entering the foreground")
	func coordinatorReports() {
		let seen = Seen()
		let sync = SyncCoordinator(
			network: ManualNetworkMonitor(isOnline: true), refresh: {},
			foregroundChanged: { seen.values.append($0) })
		sync.scenePhaseChanged(.background)
		sync.scenePhaseChanged(.inactive)
		sync.scenePhaseChanged(.active)
		#expect(seen.values == [false, true])
	}

	@Test("the production coordinator drives the hub's foreground flag")
	func hubFollows() {
		let hub = EventHub(client: nil)
		let sync = SyncCoordinator(events: hub, network: ManualNetworkMonitor(isOnline: true))
		#expect(hub.isForeground)
		sync.appDidEnterBackground()
		#expect(!hub.isForeground)
		sync.appDidBecomeActive()
		#expect(hub.isForeground)
	}
}
