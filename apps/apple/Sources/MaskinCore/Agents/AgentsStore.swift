import Foundation
import Observation

/// A labelled bucket of the Agents list.
public struct AgentGroup: Identifiable, Equatable, Sendable {
	public var status: AgentStatus
	public var items: [AgentSummary]
	public var id: AgentStatus { status }
	public var label: String { status.label }
}

/// The Agents list: every agent in the workspace with its live state, grouped like the web
/// (working, paused, idle, failed). Refetches on actor/session events (events carry ids only).
@MainActor
@Observable
public final class AgentsStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var agents: [AgentSummary] = []
	public private(set) var phase: Phase = .idle
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let api: any AgentsAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false

	@ObservationIgnored private let debouncer: RefreshDebouncer

	public init(api: any AgentsAPI, events: EventHub?, cache: SnapshotCache? = nil) {
		self.api = api
		self.events = events
		self.debouncer = RefreshDebouncer()
		self.cache = cache
		hydrateIfNeeded()
	}

	static let cacheName = "agents.list"

	private func hydrateIfNeeded() {
		guard phase == .idle, agents.isEmpty,
			let entry = cache?.read([AgentSummary].self, Self.cacheName)
		else { return }
		agents = entry.value
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	/// Test seam: a custom wait between a live event and the refetch it causes.
	init(
		api: any AgentsAPI, events: EventHub?, debounce: Duration,
		sleep: @escaping RefreshDebouncer.Sleep, cache: SnapshotCache? = nil
	) {
		self.api = api
		self.events = events
		self.debouncer = RefreshDebouncer(delay: debounce, sleep: sleep)
		self.cache = cache
		hydrateIfNeeded()
	}

	public var workingCount: Int { agents.filter { $0.status == .running }.count }

	public func agent(id: String) -> AgentSummary? { agents.first { $0.id == id } }

	public func groups(query: String = "") -> [AgentGroup] {
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		let filtered =
			needle.isEmpty
			? agents
			: agents.filter {
				$0.name.lowercased().contains(needle) || $0.role.lowercased().contains(needle)
			}
		return AgentStatus.allCases.sorted { $0.sortRank < $1.sortRank }.compactMap { status in
			let items = filtered.filter { $0.status == status }
				.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
			return items.isEmpty ? nil : AgentGroup(status: status, items: items)
		}
	}

	// MARK: - Loading

	/// Initial load plus the live subscription. Safe to call repeatedly.
	public func start() async {
		hydrateIfNeeded()
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event) where event.entityType == .actor || event.entityType == .session:
						await self.scheduleRefresh()
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

	/// A burst of events becomes one reload.
	private func scheduleRefresh() {
		debouncer.schedule { [weak self] in await self?.refresh() }
	}

	/// Overlapping calls coalesce into one trailing reload.
	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if agents.isEmpty { phase = .loading }
			let started = ContinuousClock.now
			do {
				async let actors = api.agents()
				async let sessions = api.recentSessions(limit: 100)
				let (rows, recent) = try await (actors, sessions)
				var merged = Self.merge(rows, sessions: recent)
				await fillQuietAgents(&merged)
				agents = merged
				phase = .loaded
				freshness.refreshed(at: cache?.now() ?? Date())
				SyncLog.revalidated(Self.cacheName, ok: true, since: started)
				cache?.write(agents, Self.cacheName)
			} catch {
				freshness.revalidateFailed()
				SyncLog.revalidated(Self.cacheName, ok: false, since: started)
				if agents.isEmpty { phase = .failed(Self.message(error)) }
			}
		} while refreshQueued
	}

	/// The workspace-wide window only covers the busiest agents, so a quiet agent would read as
	/// "never ran" and an old failure as "Idle". Ask for those agents' own latest session.
	/// `sessionCount` stays "runs inside the recent window", with a floor of 1 once a latest
	/// session is known.
	private func fillQuietAgents(_ rows: inout [AgentSummary]) async {
		let missing = rows.filter { $0.latestSession == nil }.map(\.id)
		guard !missing.isEmpty else { return }
		let api = api
		let found = await withTaskGroup(of: (String, AgentSession?).self) { group in
			for id in missing { group.addTask { (id, try? await api.latestSession(agentID: id)) } }
			var out: [String: AgentSession] = [:]
			for await (id, session) in group { if let session { out[id] = session } }
			return out
		}
		for index in rows.indices {
			if let session = found[rows[index].id] {
				rows[index].latestSession = session
				rows[index].sessionCount = max(rows[index].sessionCount, 1)
			}
		}
	}

	/// Attach each agent's latest session (a live one wins, else the newest) and run count.
	static func merge(_ rows: [AgentSummary], sessions: [AgentSession]) -> [AgentSummary] {
		let byActor = Dictionary(grouping: sessions, by: \.actorID)
		return rows.map { row in
			var row = row
			let mine = (byActor[row.id] ?? []).sorted {
				($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast)
			}
			row.latestSession = mine.first(where: \.isActive) ?? mine.first
			row.sessionCount = mine.count
			return row
		}
	}

	static func message(_ error: Error) -> String {
		(error as? AgentsError)?.message ?? error.localizedDescription
	}
}
