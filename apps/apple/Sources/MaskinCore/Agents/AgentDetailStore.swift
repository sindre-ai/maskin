import Foundation
import Observation

/// One agent's screen: profile, recent sessions, and the run/pause/reset/stop actions. Every
/// action is optimistic and rolls back (with a `notice`) when the server refuses.
@MainActor
@Observable
public final class AgentDetailStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public let agentID: String
	public private(set) var profile: AgentProfile?
	public private(set) var sessions: [AgentSession] = []
	public private(set) var phase: Phase = .idle
	/// Which action is in flight, so the screen can disable its buttons.
	public private(set) var busy: Action?
	/// Last action failure, surfaced by the screen as a transient notice.
	public var notice: String?

	public enum Action: Equatable, Sendable { case run, pause, reset, stop(String), save, delete }
	/// Set once the server confirmed the delete; the screen pops itself.
	public private(set) var isDeleted = false

	@ObservationIgnored private let api: any AgentDetailAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	/// Bumped by every local mutation so a refetch that started before it can't overwrite it.
	@ObservationIgnored private var mutationEpoch = 0
	@ObservationIgnored private var intents = IntentKeys()

	public init(agentID: String, api: any AgentDetailAPI, events: EventHub?) {
		self.agentID = agentID
		self.api = api
		self.events = events
	}

	public var storedState: AgentStatus { profile?.storedState ?? .idle }

	public var status: AgentStatus {
		AgentStatusResolver.resolve(stored: storedState, latest: liveSession ?? sessions.first)
	}

	/// The session currently alive for this agent, if any.
	public var liveSession: AgentSession? { sessions.first(where: \.isActive) ?? sessions.first(where: \.isPaused) }

	public var canRun: Bool { AgentActions.canRun(status) && busy == nil }
	public var canPause: Bool { AgentActions.canPause(status) && busy == nil }
	public var canReset: Bool { AgentActions.canReset(isSystem: profile?.isSystem ?? false) && busy == nil }

	// MARK: - Loading

	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			let id = agentID
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected:
						await self.refresh()
					case .event(let event):
						let relevant =
							(event.entityType == .actor && event.entityId == id)
							|| event.entityType == .session
						if relevant { await self.refresh() }
					}
				}
			}
		}
		await refresh()
	}

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	public func refresh() async {
		if refreshing {
			refreshQueued = true
			return
		}
		refreshing = true
		defer { refreshing = false }
		repeat {
			refreshQueued = false
			if profile == nil { phase = .loading }
			let epoch = mutationEpoch
			do {
				async let loadedProfile = api.profile(agentID: agentID)
				async let loadedSessions = api.sessions(agentID: agentID, limit: 20)
				let (fresh, runs) = try await (loadedProfile, loadedSessions)
				// A local action landed while this was in flight: its result is newer than ours.
				if epoch == mutationEpoch {
					profile = fresh
					sessions = runs
					SessionActivityController.shared.sync(
						agentID: agentID, isLive: runs.contains { $0.isStoppable },
						isPaused: runs.contains { $0.isPaused } && !runs.contains { $0.isActive })
				} else {
					refreshQueued = true
				}
				phase = .loaded
			} catch {
				if profile == nil { phase = .failed(AgentsStore.message(error)) }
			}
		} while refreshQueued
	}

	// MARK: - Actions

	/// Start a fresh session with `prompt`, or resume a paused one (the server decides).
	@discardableResult
	public func run(prompt: String?) async -> Bool {
		guard canRun else { return false }
		let trimmed = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
		let text = (trimmed?.isEmpty ?? true) ? nil : trimmed
		let started = await perform(.run, intent: "run:\(text ?? "")", to: .running) { key in
			try await self.api.run(agentID: self.agentID, prompt: text, idempotencyKey: key)
		}
		if started {
			SessionActivityController.shared.start(
				agentID: agentID, agentName: profile?.name ?? "Agent", task: text ?? "Running")
		}
		return started
	}

	@discardableResult
	public func pause() async -> Bool {
		guard canPause else { return false }
		return await perform(.pause, intent: "pause", to: .paused) { key in
			try await self.api.pause(agentID: self.agentID, idempotencyKey: key)
		}
	}

	@discardableResult
	public func reset() async -> Bool {
		guard canReset else { return false }
		return await perform(.reset, intent: "reset", to: .idle) { key in
			try await self.api.reset(agentID: self.agentID, idempotencyKey: key)
		}
	}

	/// Stop one session; it leaves the live set immediately and returns if the server refuses.
	@discardableResult
	public func stopSession(_ sessionID: String) async -> Bool {
		guard busy == nil, let index = sessions.firstIndex(where: { $0.id == sessionID }),
			sessions[index].isStoppable
		else { return false }
		let before = sessions
		mutationEpoch += 1
		busy = .stop(sessionID)
		sessions[index].status = "stopped"
		sessions[index].completedAt = Date()
		defer { busy = nil }
		let intent = "stop:\(sessionID)"
		do {
			try await api.stop(sessionID: sessionID, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			await refresh()
			return true
		} catch {
			sessions = before
			notice = AgentsStore.message(error)
			return false
		}
	}

	// MARK: - Editing

	/// Save changed fields. The profile updates at once; if the server refuses, it goes back and
	/// `notice` says why. A refetch that was already in flight can't overwrite the edit.
	@discardableResult
	public func save(_ edit: AgentEdit) async -> Bool {
		guard !edit.isEmpty, let before = profile, busy == nil else { return false }
		mutationEpoch += 1
		busy = .save
		profile = edit.applied(to: before)
		defer { busy = nil }
		let intent = "save:\(String(describing: edit))"
		do {
			let saved = try await api.update(
				agentID: agentID, edit: edit, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			mutationEpoch += 1
			profile = saved
			return true
		} catch {
			profile = before
			notice = AgentsStore.message(error)
			return false
		}
	}

	/// Add one MCP server (a no-op when the name is taken).
	@discardableResult
	public func addTool(_ tool: AgentTool) async -> Bool {
		guard let profile, !profile.tools.contains(where: { $0.name == tool.name }) else { return false }
		return await save(AgentEdit(tools: profile.tools + [tool]))
	}

	@discardableResult
	public func removeTool(named name: String) async -> Bool {
		guard let profile, profile.tools.contains(where: { $0.name == name }) else { return false }
		return await save(AgentEdit(tools: profile.tools.filter { $0.name != name }))
	}

	public var canDelete: Bool { !(profile?.isSystem ?? true) && busy == nil && !isDeleted }

	/// Delete the agent for good. `isDeleted` flips only once the server agrees, so the screen
	/// can leave without a flash of an agent that is still there.
	@discardableResult
	public func delete() async -> Bool {
		guard canDelete else { return false }
		busy = .delete
		defer { busy = nil }
		do {
			try await api.delete(agentID: agentID, idempotencyKey: intents.key(for: "delete"))
			intents.succeeded("delete")
			isDeleted = true
			return true
		} catch {
			notice = AgentsStore.message(error)
			return false
		}
	}

	private func perform(
		_ action: Action, intent: String, to optimistic: AgentStatus,
		request: (String) async throws -> AgentStatus
	) async -> Bool {
		let before = profile
		let sessionsBefore = sessions
		mutationEpoch += 1
		busy = action
		profile?.storedState = optimistic
		if optimistic == .paused {
			for index in sessions.indices where sessions[index].isActive { sessions[index].status = "paused" }
		}
		defer { busy = nil }
		do {
			let confirmed = try await request(intents.key(for: intent))
			intents.succeeded(intent)
			profile?.storedState = confirmed
			// Pause/run change the live session; pull the truth.
			await refresh()
			return true
		} catch {
			profile = before
			sessions = sessionsBefore
			notice = AgentsStore.message(error)
			return false
		}
	}
}
