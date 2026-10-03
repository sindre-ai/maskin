import Foundation
import Observation

/// Where the trace for each turn goes in a thread.
public struct ActivityAnchors: Equatable, Sendable {
	/// Finished turn shown collapsed above the agent's reply (keyed by the reply's server id).
	public var aboveReply: [Int: ActivityTurn] = [:]
	/// Finished turn with no reply (it failed midway): shown right after the message that
	/// triggered it (keyed by that message's server id).
	public var afterTrigger: [Int: ActivityTurn] = [:]

	public init() {}
}

/// Activity traces for one conversation's agent sessions: live while a session runs, loaded
/// once (and cached on disk) for finished ones. Payload is bounded for cellular: live polls ask
/// for the newest turn only, history asks once per finished session for a few turns, finished
/// sessions are cached so reopening a thread costs no request, and the HTTP source declines
/// Low Data Mode for history.
@MainActor
@Observable
public final class ActivityStore {
	static let cacheVersion = 1
	static let liveTurns = 1
	static let historyTurns = 5
	/// Only the newest few finished sessions get history; older threads stay one-line.
	static let historySessions = 4

	public private(set) var turnsBySession: [String: [ActivityTurn]] = [:]

	@ObservationIgnored private let source: any SessionActivitySource
	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let activeInterval: Duration
	@ObservationIgnored private let idleInterval: Duration
	@ObservationIgnored private var liveIDs: Set<String> = []
	@ObservationIgnored private var everLive: Set<String> = []
	@ObservationIgnored private var settled: Set<String> = []
	@ObservationIgnored private var inFlight: Set<String> = []
	@ObservationIgnored private var poller: Task<Void, Never>?

	public init(
		source: any SessionActivitySource, cache: SnapshotCache? = nil,
		activeInterval: Duration = .seconds(2), idleInterval: Duration = .seconds(5)
	) {
		self.source = source
		self.cache = cache
		self.activeInterval = activeInterval
		self.idleInterval = idleInterval
	}

	deinit { MainActor.assumeIsolated { poller?.cancel() } }

	public func stop() {
		poller?.cancel()
		poller = nil
	}

	// MARK: - Reading

	/// The turn the session is working on right now.
	public func liveTurn(sessionID: String) -> ActivityTurn? {
		turnsBySession[sessionID]?.last(where: \.isRunning)
	}

	/// Places every finished turn in the thread. A turn with no steps and no failure is left out
	/// (nothing to show); a reply claimed by one turn is never shown a second trace.
	public func anchors(messages: [ChatMessage], sessions: [ChatAgentSession]) -> ActivityAnchors {
		var out = ActivityAnchors()
		var claimed: Set<Int> = []
		for session in sessions {
			let turns = (turnsBySession[session.id] ?? []).sorted { $0.messageID < $1.messageID }
			for (index, turn) in turns.enumerated() where !turn.isRunning {
				guard !turn.steps.isEmpty || turn.failed else { continue }
				let nextTrigger = turns.dropFirst(index + 1).first?.messageID ?? Int.max
				let reply = messages.first { message in
					guard let id = message.serverID, !claimed.contains(id) else { return false }
					return message.author == .agent && message.actorID == session.actorID
						&& id > turn.messageID && id < nextTrigger
				}
				if turn.containsReply, let id = reply?.serverID {
					claimed.insert(id)
					out.aboveReply[id] = turn
				} else {
					out.afterTrigger[turn.messageID] = turn
				}
			}
		}
		return out
	}

	// MARK: - Loading

	/// Called whenever the conversation's sessions change (newest first, as `ChatStore` keeps them).
	public func update(sessions: [ChatAgentSession]) async {
		let live = Set(sessions.filter { $0.status.isLive }.map(\.id))
		// A session that just stopped needs one last read to pick up its closing turn.
		let justEnded = liveIDs.subtracting(live)
		liveIDs = live
		everLive.formUnion(live)
		for id in justEnded { settled.remove(id) }

		let history = sessions.filter { !live.contains($0.id) }.prefix(Self.historySessions)
		for session in history where !settled.contains(session.id) {
			settled.insert(session.id)
			if !everLive.contains(session.id), loadFromCache(session.id) { continue }
			await fetch(session.id, turns: Self.historyTurns, background: !justEnded.contains(session.id))
		}
		if !live.isEmpty { startPolling() }
	}

	private func startPolling() {
		guard poller == nil else { return }
		poller = Task { [weak self] in
			var quiet = 0
			while !Task.isCancelled {
				guard let self, !self.liveIDs.isEmpty else { break }
				var changed = false
				for id in self.liveIDs.sorted() {
					let before = self.turnsBySession[id]
					await self.fetch(id, turns: Self.liveTurns, background: false)
					if self.turnsBySession[id] != before { changed = true }
				}
				quiet = changed ? 0 : quiet + 1
				let delay = quiet >= 3 ? self.idleInterval : self.activeInterval
				try? await Task.sleep(for: delay)
			}
			self?.poller = nil
		}
	}

	private func fetch(_ sessionID: String, turns: Int, background: Bool) async {
		guard inFlight.insert(sessionID).inserted else { return }
		defer { inFlight.remove(sessionID) }
		guard
			let page = try? await source.activity(
				sessionID: sessionID, limitTurns: turns, background: background)
		else { return }
		merge(page.turns, into: sessionID)
		writeCache(sessionID)
	}

	/// Newer reads replace older ones by trigger message; turns the page didn't cover stay.
	private func merge(_ incoming: [ActivityTurn], into sessionID: String) {
		var byMessage = Dictionary(
			(turnsBySession[sessionID] ?? []).map { ($0.messageID, $0) }, uniquingKeysWith: { $1 })
		for turn in incoming { byMessage[turn.messageID] = turn }
		turnsBySession[sessionID] = byMessage.values.sorted { $0.messageID < $1.messageID }
	}

	// MARK: - Disk (finished sessions only; running turns would go stale)

	private func cacheName(_ sessionID: String) -> String { "activity.\(sessionID)" }

	private func loadFromCache(_ sessionID: String) -> Bool {
		guard
			let entry = cache?.read(
				[ActivityTurn].self, cacheName(sessionID), version: Self.cacheVersion)
		else { return false }
		turnsBySession[sessionID] = entry.value
		return true
	}

	private func writeCache(_ sessionID: String) {
		guard let turns = turnsBySession[sessionID], !turns.isEmpty,
			!liveIDs.contains(sessionID), !turns.contains(where: \.isRunning)
		else { return }
		cache?.write(turns, cacheName(sessionID), version: Self.cacheVersion)
	}
}
