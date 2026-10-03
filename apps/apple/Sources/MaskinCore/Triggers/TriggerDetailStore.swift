import Foundation
import Observation

/// One trigger on its detail screen: an editable copy, save, enable/disable and delete.
@MainActor
@Observable
public final class TriggerDetailStore {
	public private(set) var trigger: Trigger
	public var edit: TriggerEdit
	public private(set) var directory: ActorDirectory
	public private(set) var isSaving = false
	public private(set) var isDeleted = false
	/// Last failure, shown inline by the screen.
	public var error: String?

	@ObservationIgnored private let api: any TriggersAPI
	@ObservationIgnored private let events: EventHub?
	@ObservationIgnored private var listener: Task<Void, Never>?
	@ObservationIgnored private var intents = IntentKeys()
	/// Called with every server-confirmed copy so the list can show it without refetching.
	@ObservationIgnored public var onSaved: ((Trigger) -> Void)?
	@ObservationIgnored public var onDeleted: ((String) -> Void)?

	public init(
		trigger: Trigger, directory: ActorDirectory = ActorDirectory(), api: any TriggersAPI,
		events: EventHub?
	) {
		self.trigger = trigger
		self.edit = TriggerEdit(trigger)
		self.directory = directory
		self.api = api
		self.events = events
	}

	public var isDirty: Bool { !edit.patch(from: trigger).isEmpty }
	public var canSave: Bool { isDirty && edit.isValid && !isSaving }
	public var agentName: String { directory.name(trigger.targetActorID) ?? "Unknown agent" }

	/// When a scheduled trigger fires next, from its stored schedule (evaluated in UTC, like the
	/// server).
	public func nextRun(now: Date = Date()) -> Date? {
		guard trigger.enabled else { return nil }
		return trigger.schedule?.nextFire(after: now)
	}

	/// The next run's clock time in the viewer's zone, shown beside the UTC schedule; `nil` when
	/// there is nothing to add (same as UTC, hourly, off, or not editable).
	public func nextRunLocalEquivalent(now: Date = Date(), timeZone: TimeZone = .current) -> String? {
		guard trigger.enabled else { return nil }
		return trigger.schedule?.localEquivalent(after: now, timeZone: timeZone)
	}

	// MARK: Loading

	public func start() async {
		if listener == nil, let events {
			let stream = events.subscribe()
			listener = Task { [weak self] in
				for await signal in stream {
					guard let self else { return }
					switch signal {
					case .reconnected: await self.refresh()
					case .event(let e) where e.entityType == .trigger && e.entityId == self.trigger.id:
						await self.refresh()
					default: break
					}
				}
			}
		}
		if directory.byID.isEmpty, let actors = try? await api.actors() {
			directory = ActorDirectory(actors)
		}
	}

	public func stop() {
		listener?.cancel()
		listener = nil
	}

	/// Re-read the trigger. An unsaved edit is kept; a clean one follows the server.
	public func refresh() async {
		guard !isSaving, let listing = try? await api.listPage() else { return }
		guard let fresh = listing.triggers.first(where: { $0.id == trigger.id }) else {
			// Missing from a list that stopped early is unknown, not deleted.
			if listing.isComplete { isDeleted = true }
			return
		}
		let wasClean = !isDirty
		trigger = fresh
		if wasClean { edit = TriggerEdit(fresh) }
	}

	// MARK: Writes

	public func save() async {
		let patch = edit.patch(from: trigger)
		guard !patch.isEmpty, edit.isValid, !isSaving else { return }
		isSaving = true
		error = nil
		defer { isSaving = false }
		do {
			// Saving the same edit again after a lost response reuses its key.
			let intent = "save:\(trigger.id):\(Self.fingerprint(patch))"
			let saved = try await api.update(
				id: trigger.id, patch: patch, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			trigger = saved
			edit = TriggerEdit(saved)
			onSaved?(saved)
		} catch {
			self.error = AutomationError.message(error)
		}
	}

	public func discardChanges() {
		edit = TriggerEdit(trigger)
		error = nil
	}

	public func setEnabled(_ enabled: Bool) async {
		guard trigger.enabled != enabled else { return }
		let previous = trigger.enabled
		trigger.enabled = enabled
		error = nil
		do {
			let intent = "enable:\(trigger.id):\(enabled)"
			let saved = try await api.update(
				id: trigger.id, patch: TriggerPatch(enabled: enabled),
				idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			trigger.enabled = saved.enabled
			onSaved?(trigger)
		} catch {
			trigger.enabled = previous
			self.error = "Couldn't turn \(enabled ? "on" : "off") this trigger. \(AutomationError.message(error))"
		}
	}

	public func delete() async {
		do {
			let intent = "delete:\(trigger.id)"
			try await api.delete(id: trigger.id, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			isDeleted = true
			onDeleted?(trigger.id)
		} catch {
			self.error = "Couldn't delete this trigger. \(AutomationError.message(error))"
		}
	}

	private static func fingerprint(_ patch: TriggerPatch) -> String {
		"\(patch.name ?? "-")|\(patch.actionPrompt ?? "-")|\(patch.targetActorID ?? "-")|"
			+ "\(patch.enabled.map(String.init) ?? "-")|\(String(describing: patch.config))"
	}
}
