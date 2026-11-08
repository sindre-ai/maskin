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
	@ObservationIgnored private let now: RefreshDebouncer.Clock
	/// What the last per-agent latest-session lookup found, so a quiet agent is asked about at most
	/// once per `quietLookupInterval`, however often the list reloads.
	@ObservationIgnored private var quietLookups: [String: (at: ContinuousClock.Instant, session: AgentSession?)] = [:]

	/// Events reload the list at most this often.
	static let refetchInterval: Duration = .seconds(5)
	static let quietLookupInterval: Duration = .seconds(60)

	public init(api: any AgentsAPI, events: EventHub?, cache: SnapshotCache? = nil) {
		self.api = api
		self.events = events
		self.now = { ContinuousClock.now }
		self.debouncer = RefreshDebouncer(minInterval: Self.refetchInterval)
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
		api: any AgentsAPI, events: EventHub?, debounce: Duration, minInterval: Duration = .zero,
		sleep: @escaping RefreshDebouncer.Sleep, now: @escaping RefreshDebouncer.Clock = { ContinuousClock.now },
		cache: SnapshotCache? = nil
	) {
		self.api = api
		self.events = events
		self.now = now
		self.debouncer = RefreshDebouncer(delay: debounce, minInterval: minInterval, sleep: sleep, now: now)
		self.cache = cache
		hydrateIfNeeded()
	}

	public var workingCount: Int { agents.filter { $0.status == .running }.count }

	public func agent(id: String) -> AgentSummary? { agents.first { $0.id == id } }

	// MARK: - Teams

	/// The workspace's flows, from which each agent's team is read. Set by the screen after its
	/// own best-effort load; empty until then (every agent reads "No team", and no team chip
	/// shows).
	public private(set) var flows: [LoopSummary] = []

	public func setFlows(_ flows: [LoopSummary]) { self.flows = flows }

	/// Every flow that lists the agent, A to Z.
	public func teams(of agentID: String) -> [String] {
		flows.filter { $0.agentIDs.contains(agentID) }.map(AgentTeams.name(of:))
			.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}

	/// The agent's team: its first flow A to Z, or "No team".
	public func team(of agentID: String) -> String { teams(of: agentID).first ?? AgentTeams.none }

	/// The team chips: each team with its agent count, A to Z, "No team" last. Teams nobody
	/// belongs to are left out.
	public func teamChips() -> [AgentChipCount] {
		var counts: [String: Int] = [:]
		for agent in agents { counts[team(of: agent.id), default: 0] += 1 }
		return counts.map { AgentChipCount(id: $0.key, label: $0.key, count: $0.value) }
			.sorted {
				if ($0.id == AgentTeams.none) != ($1.id == AgentTeams.none) { return $1.id == AgentTeams.none }
				return $0.label.localizedStandardCompare($1.label) == .orderedAscending
			}
	}

	/// The status chips, scoped to the chosen team: All, then Working, Idle, Failed. Disabled
	/// shows only when something is disabled.
	public func statusChips(team: String?) -> [AgentChipCount] {
		let scoped = agents.filter { team == nil || self.team(of: $0.id) == team }
		func count(_ status: AgentStatus) -> Int { scoped.filter { $0.status == status }.count }
		var chips = [AgentChipCount(id: "all", label: "All", count: scoped.count)]
		for status in [AgentStatus.running, .idle, .failed] {
			chips.append(AgentChipCount(id: status.rawValue, label: status.label, count: count(status)))
		}
		if count(.paused) > 0 {
			chips.append(AgentChipCount(id: AgentStatus.paused.rawValue, label: AgentStatus.paused.label, count: count(.paused)))
		}
		return chips
	}

	/// The list: filtered by search, status and team, ordered, then grouped.
	public func sections(query: String = "", display: AgentsDisplay = .default) -> [AgentSection] {
		let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
		var rows = agents.filter { agent in
			(display.status == nil || agent.status == display.status)
				&& (display.team == nil || team(of: agent.id) == display.team)
				&& (needle.isEmpty
					|| agent.name.lowercased().contains(needle) || agent.role.lowercased().contains(needle))
		}
		func byName(_ a: AgentSummary, _ b: AgentSummary) -> Bool {
			a.name.localizedStandardCompare(b.name) == .orderedAscending
		}
		rows.sort { a, b in
			switch display.sort {
			case .name: return byName(a, b)
			case .sessions:
				return a.sessionCount != b.sessionCount ? a.sessionCount > b.sessionCount : byName(a, b)
			case .status:
				let (x, y) = (a.status.attentionRank, b.status.attentionRank)
				return x != y ? x < y : byName(a, b)
			}
		}
		if display.reversed { rows.reverse() }
		guard !rows.isEmpty else { return [] }

		// One team picked: its header would say what the chip already does.
		let grouping = display.grouping == .team && display.team != nil ? AgentsGrouping.none : display.grouping
		switch grouping {
		case .none:
			return [AgentSection(id: "all", title: nil, items: rows)]
		case .status:
			return AgentStatus.allCases.sorted { $0.attentionRank < $1.attentionRank }.compactMap { status in
				let items = rows.filter { $0.status == status }
				return items.isEmpty ? nil : AgentSection(id: status.rawValue, title: status.groupTitle, items: items)
			}
		case .team:
			let grouped = Dictionary(grouping: rows) { team(of: $0.id) }
			let names = grouped.keys.sorted {
				if ($0 == AgentTeams.none) != ($1 == AgentTeams.none) { return $1 == AgentTeams.none }
				return $0.localizedStandardCompare($1) == .orderedAscending
			}
			return names.map { AgentSection(id: $0, title: $0, items: grouped[$0] ?? []) }
		}
	}

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

	// MARK: - Creating

	/// Last create failure, shown by the sheet that asked.
	public var notice: String?
	public private(set) var isCreating = false
	@ObservationIgnored private var createKeys = IntentKeys()

	/// Create an agent and put it in the list at once. Returns its id, or nil (with `notice`)
	/// when the server refused. A retry of the same draft reuses its idempotency key, so a lost
	/// response can't make two agents.
	public func create(_ draft: AgentDraft) async -> String? {
		guard draft.isValid, !isCreating else { return nil }
		isCreating = true
		notice = nil
		defer { isCreating = false }
		let intent = "create:\(draft.trimmedName):\(draft.trimmedDescription):\(draft.systemPrompt)"
		do {
			let row = try await api.create(draft: draft, idempotencyKey: createKeys.key(for: intent))
			createKeys.succeeded(intent)
			if !agents.contains(where: { $0.id == row.id }) { agents.append(row) }
			cache?.write(agents, Self.cacheName)
			Task { await refresh() }
			return row.id
		} catch {
			notice = Self.message(error)
			return nil
		}
	}

	/// Drop an agent the detail screen just deleted, without waiting for the refetch.
	public func remove(id: String) {
		agents.removeAll { $0.id == id }
		cache?.write(agents, Self.cacheName)
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
						await self.debouncer.runIfStale { await self.refresh() }
					case .event(let event) where event.entityType == .actor || event.entityType == .session:
						self.scheduleRefresh()
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

	/// A burst of events becomes one reload, at most once per `refetchInterval`, and none while the
	/// app is in the background (the hub asks for one reload when it returns).
	private func scheduleRefresh() {
		if let events, !events.isForeground {
			events.noteSkippedInBackground()
			return
		}
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
			debouncer.noteRan()
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
	/// "never ran" and an old failure as "Idle". Ask for those agents' own latest session, at most
	/// once per agent per `quietLookupInterval`; in between, the last answer is reused.
	/// `sessionCount` stays "runs inside the recent window", with a floor of 1 once a latest
	/// session is known.
	private func fillQuietAgents(_ rows: inout [AgentSummary]) async {
		let missing = rows.filter { $0.latestSession == nil }.map(\.id)
		quietLookups = quietLookups.filter { id, _ in missing.contains(id) }
		guard !missing.isEmpty else { return }
		let asked = now()
		let stale = missing.filter { id in
			guard let last = quietLookups[id] else { return true }
			return asked - last.at >= Self.quietLookupInterval
		}
		let api = api
		let looked = await withTaskGroup(of: (String, AgentSession?, Bool).self) { group in
			for id in stale {
				group.addTask {
					do { return (id, try await api.latestSession(agentID: id), true) } catch { return (id, nil, false) }
				}
			}
			var out: [String: AgentSession?] = [:]
			for await (id, session, ok) in group where ok { out[id] = .some(session) }
			return out
		}
		for (id, session) in looked { quietLookups[id] = (asked, session) }
		var found: [String: AgentSession] = [:]
		for id in missing { if let session = quietLookups[id]?.session { found[id] = session } }
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
		(error as? AgentsError)?.message ?? "Couldn't reach the server. Check your connection."
	}
}
