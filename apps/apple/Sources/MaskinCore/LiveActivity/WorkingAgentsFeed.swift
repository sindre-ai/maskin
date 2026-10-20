import Foundation

/// The workspace-wide half of the "Agents working" activity: which agents have a session running
/// right now, from the same two requests the Agents list makes (`GET /api/actors`,
/// `GET /api/sessions?verbose=true`). Refetches on session and actor events, debounced, and on
/// demand from the foreground and background refresh hooks.
///
/// Interactive (chat) sessions are left out on purpose: they stay `running` between turns, so
/// the list cannot tell a thinking agent from an idle one. The open thread knows, and reports
/// through `AgentsActivityCoordinator.reconcile(_:)` instead.
@MainActor
public final class WorkingAgentsFeed {
	public static let sessionWindow = 100

	private let api: any AgentsAPI
	private let events: EventHub?
	private let onChange: @MainActor ([WorkingAgent]) async -> Void
	private let now: () -> Date
	private let debouncer: RefreshDebouncer
	private var listener: Task<Void, Never>?
	private var refreshing = false
	private var refreshQueued = false
	public private(set) var agents: [WorkingAgent] = []

	public init(
		api: any AgentsAPI, events: EventHub?, now: @escaping () -> Date = Date.init,
		onChange: @escaping @MainActor ([WorkingAgent]) async -> Void
	) {
		self.api = api
		self.events = events
		self.now = now
		self.onChange = onChange
		self.debouncer = RefreshDebouncer()
	}

	/// Test seam: a custom wait between a live event and the refetch it causes.
	init(
		api: any AgentsAPI, events: EventHub?, debounce: Duration, sleep: @escaping RefreshDebouncer.Sleep,
		now: @escaping () -> Date = Date.init, onChange: @escaping @MainActor ([WorkingAgent]) async -> Void
	) {
		self.api = api
		self.events = events
		self.now = now
		self.onChange = onChange
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
	}

	/// Initial load plus the live subscription. Safe to call repeatedly.
	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event) where event.entityType == .session || event.entityType == .actor:
						self.debouncer.schedule { [weak self] in await self?.refresh() }
					case .event:
						break
					}
				}
			}
		}
		await refresh()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
		debouncer.cancel()
	}

	/// Overlapping calls coalesce into one trailing reload. A failed fetch keeps the last result:
	/// a network blip must not make every agent vanish from the card.
	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			do {
				async let rows = api.agents()
				async let sessions = api.recentSessions(limit: Self.sessionWindow)
				let (agentRows, sessionRows) = try await (rows, sessions)
				let names = Dictionary(agentRows.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
				let next = Self.agents(from: sessionRows, names: names, now: now())
				if next != agents || agents.isEmpty {
					agents = next
					await onChange(next)
				}
			} catch {
				// Keep what we have.
			}
		} while refreshQueued
	}

	/// One row per agent with a live, non-interactive session; when an agent has several, the
	/// one that started first is the row (it is the one furthest along). Names come from the
	/// actor list; an unknown actor reads "Agent", never an id.
	static func agents(from sessions: [AgentSession], names: [String: String], now: Date) -> [WorkingAgent] {
		let live = sessions.filter { $0.isActive && !$0.interactive }
		let byActor = Dictionary(grouping: live, by: \.actorID)
		return byActor.map { actorID, runs in
			let session = runs.min {
				($0.startedAt ?? $0.createdAt ?? now) < ($1.startedAt ?? $1.createdAt ?? now)
			}!
			return WorkingAgent(
				id: actorID, sessionId: session.id, name: names[actorID] ?? "Agent",
				doing: session.currentActivity, startedAt: session.startedAt ?? session.createdAt ?? now)
		}
		.sorted { $0.id < $1.id }
	}
}
