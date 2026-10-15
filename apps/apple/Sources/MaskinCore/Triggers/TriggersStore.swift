import Foundation
import Observation

/// The Triggers list: every trigger in the workspace, live updates, inline enable/disable
/// (optimistic, rolled back on failure) and creating a scheduled trigger.
@MainActor
@Observable
public final class TriggersStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public struct Section: Identifiable, Equatable, Sendable {
		public var id: String { label }
		public var label: String
		public var items: [Trigger]
	}

	public private(set) var triggers: [Trigger] = []
	public private(set) var phase: Phase = .idle
	public private(set) var directory = ActorDirectory()
	/// Last mutation error, surfaced by the screen as a transient notice.
	public var notice: String?
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let cache: SnapshotCache?
	@ObservationIgnored private let api: any TriggersAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var refreshing = false
	@ObservationIgnored private var refreshQueued = false
	/// Triggers with an enable/disable write in flight; a refresh must not flip them back.
	@ObservationIgnored private var inFlight: [String: Bool] = [:]
	/// Triggers with a delete in flight; a refresh must not bring them back on screen.
	@ObservationIgnored private var deleting: Set<String> = []
	@ObservationIgnored private var intents = IntentKeys()

	public init(api: any TriggersAPI, events: EventHub?, cache: SnapshotCache? = nil) {
		self.api = api
		self.events = events
		self.cache = cache
		hydrateIfNeeded()
	}

	/// What the list keeps on disk: the triggers and the agent names their rows resolve.
	struct Snapshot: Codable, Sendable {
		var triggers: [Trigger]
		var actors: [AutomationActor]
	}
	static let cacheName = "triggers.list"

	private func hydrateIfNeeded() {
		guard phase == .idle, triggers.isEmpty, let entry = cache?.read(Snapshot.self, Self.cacheName)
		else { return }
		triggers = entry.value.triggers
		directory = ActorDirectory(entry.value.actors)
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
	}

	private func persist() {
		cache?.write(Snapshot(triggers: triggers, actors: directory.all), Self.cacheName)
	}

	public func trigger(id: String) -> Trigger? { triggers.first { $0.id == id } }

	/// Agent name for a trigger's row; never the id.
	public func agentName(for trigger: Trigger) -> String {
		directory.name(trigger.targetActorID) ?? "Unknown agent"
	}

	public func sections(query: String = "") -> [Section] {
		let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
		let matching = triggers.filter { trigger in
			text.isEmpty || trigger.name.localizedCaseInsensitiveContains(text)
				|| trigger.summary.localizedCaseInsensitiveContains(text)
				|| agentName(for: trigger).localizedCaseInsensitiveContains(text)
		}
		let on = matching.filter(\.enabled)
		let off = matching.filter { !$0.enabled }
		return [Section(label: "On", items: on), Section(label: "Off", items: off)]
			.filter { !$0.items.isEmpty }
	}

	// MARK: Loading

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
					case .event(let event) where event.entityType == .trigger:
						await self.refresh()
					case .event(let event) where event.entityType == .actor:
						await self.loadActors(force: true)
					case .event:
						break
					}
				}
			}
		}
		async let names: Void = loadActors()
		await refresh()
		await names
	}

	public func stop() {
		listener?.cancel()
		listener = nil
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
			if triggers.isEmpty { phase = .loading }
			let started = ContinuousClock.now
			do {
				var fresh = try await api.list()
				for (id, enabled) in inFlight {
					if let i = fresh.firstIndex(where: { $0.id == id }) { fresh[i].enabled = enabled }
				}
				triggers = fresh.filter { !deleting.contains($0.id) }
				phase = .loaded
				freshness.refreshed(at: cache?.now() ?? Date())
				SyncLog.revalidated(Self.cacheName, ok: true, since: started)
				persist()
			} catch {
				freshness.revalidateFailed()
				SyncLog.revalidated(Self.cacheName, ok: false, since: started)
				if triggers.isEmpty { phase = .failed(AutomationError.message(error)) }
			}
		} while refreshQueued
	}

	public func loadActors(force: Bool = false) async {
		guard force || directory.byID.isEmpty else { return }
		if let actors = try? await api.actors() {
			directory = ActorDirectory(actors)
			if phase == .loaded { persist() }
		}
	}

	// MARK: Writes

	/// Flip a trigger on or off right away; restore it and set `notice` if the server refuses.
	public func setEnabled(_ id: String, _ enabled: Bool) async {
		guard let index = triggers.firstIndex(where: { $0.id == id }),
			triggers[index].enabled != enabled
		else { return }
		let previous = triggers[index].enabled
		triggers[index].enabled = enabled
		inFlight[id] = enabled
		defer { inFlight[id] = nil }
		let intent = "enable:\(id):\(enabled)"
		do {
			let saved = try await api.update(
				id: id, patch: TriggerPatch(enabled: enabled), idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			replace(saved)
		} catch {
			if let i = triggers.firstIndex(where: { $0.id == id }) { triggers[i].enabled = previous }
			notice = "Couldn't turn \(enabled ? "on" : "off") this trigger. \(AutomationError.message(error))"
		}
	}

	/// Creates the trigger and adds it to the list. Throws so the sheet can show the failure.
	@discardableResult
	public func create(_ draft: TriggerDraft) async throws -> Trigger {
		guard draft.isValid else { throw AutomationError("Choose when it starts, then an agent and what it should do.") }
		// The same draft retried after a lost response reuses its key, so it can't create twice.
		let intent = "create:\(draft.trimmedName)|\(draft.trimmedPrompt)|\(draft.targetActorID ?? "")|\(draft.whenFingerprint)"
		let created = try await api.create(draft, idempotencyKey: intents.key(for: intent))
		intents.succeeded(intent)
		replace(created)
		return created
	}

	public func delete(_ id: String) async {
		guard !deleting.contains(id), let index = triggers.firstIndex(where: { $0.id == id })
		else { return }
		let removed = triggers.remove(at: index)
		deleting.insert(id)
		defer { deleting.remove(id) }
		let intent = "delete:\(id)"
		do {
			try await api.delete(id: id, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
		} catch {
			if !triggers.contains(where: { $0.id == id }) {
				triggers.insert(removed, at: min(index, triggers.count))
			}
			notice = "Couldn't delete this trigger. \(AutomationError.message(error))"
		}
	}

	/// Put a server-returned trigger in the list (detail screens call this after saving).
	public func replace(_ trigger: Trigger) {
		if let i = triggers.firstIndex(where: { $0.id == trigger.id }) {
			triggers[i] = trigger
		} else {
			triggers.insert(trigger, at: 0)
		}
	}
}
