import Foundation
import Observation

/// "Later" on a For you card: the reader defers the ask until a time they pick. The card leaves the
/// open list, sits in the LATER section meanwhile, and comes back at the time with a "Back from
/// Later" note.
///
/// DEVICE-LOCAL. The server has no snooze: nothing tells the agent the ask was deferred, and a
/// deferral does not follow the reader to another device. (Blocked on a snooze endpoint; see the
/// area report.) What the reader does keep is honest: the card is still unread on the server, so
/// deciding it elsewhere still works.
public enum LaterPreset: String, Sendable, CaseIterable, Codable {
	case thisEvening
	case tomorrowMorning

	public var label: String {
		switch self {
		case .thisEvening: "This evening"
		case .tomorrowMorning: "Tomorrow 08:00"
		}
	}

	/// When the card comes back. "This evening" is 18:00 today; once that is under half an hour
	/// away (or past) it means two hours from now, so the choice never resolves to the past.
	public func resolve(from now: Date, calendar: Calendar = .current) -> Date {
		switch self {
		case .thisEvening:
			let evening = calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now) ?? now
			return evening.timeIntervalSince(now) > 30 * 60 ? evening : now.addingTimeInterval(2 * 3600)
		case .tomorrowMorning:
			let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
			return calendar.date(bySettingHour: 8, minute: 0, second: 0, of: tomorrow) ?? tomorrow
		}
	}

	/// The single Later a notification button offers: the evening while it is early, otherwise
	/// tomorrow morning.
	public static func suggested(at now: Date, calendar: Calendar = .current) -> LaterPreset {
		calendar.component(.hour, from: now) < 15 ? .thisEvening : .tomorrowMorning
	}
}

public struct LaterEntry: Codable, Sendable, Equatable {
	public var until: Date
	public var label: String

	public init(until: Date, label: String) {
		self.until = until
		self.label = label
	}
}

@MainActor
@Observable
public final class LaterStore {
	public private(set) var entries: [String: LaterEntry] = [:]
	/// Bumped when a deferral comes due, so views re-read `isDeferred`.
	private var tick = 0

	@ObservationIgnored private let defaults: UserDefaults
	@ObservationIgnored private let workspaceId: @MainActor () -> String?
	@ObservationIgnored private let now: @Sendable () -> Date
	@ObservationIgnored private var wake: Task<Void, Never>?
	@ObservationIgnored private var loadedWorkspace: String?

	public init(
		defaults: UserDefaults = .standard, workspaceId: @escaping @MainActor () -> String?,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.defaults = defaults
		self.workspaceId = workspaceId
		self.now = now
		reload()
	}

	deinit { wake?.cancel() }

	nonisolated static func key(workspace: String) -> String { "foryou.later.v1.\(workspace)" }

	/// Re-reads the saved deferrals: on launch, on a workspace change, and when the app comes back
	/// to the foreground (a notification button may have added one while it was away).
	public func reload() {
		guard let ws = workspaceId() else {
			entries = [:]
			loadedWorkspace = nil
			return
		}
		loadedWorkspace = ws
		entries = Self.read(defaults: defaults, workspace: ws)
		scheduleWake()
	}

	// MARK: Reading

	/// Hidden from the open list: deferred and not yet due.
	public func isDeferred(_ id: String) -> Bool {
		_ = tick
		guard let entry = entries[id] else { return false }
		return entry.until > now()
	}

	/// Due, and the reader has not acted on it since: the card carries a "Back again" note.
	public func isBackFromLater(_ id: String) -> Bool {
		_ = tick
		guard let entry = entries[id] else { return false }
		return entry.until <= now()
	}

	public func entry(for id: String) -> LaterEntry? { entries[id] }

	// MARK: Acting

	public func `defer`(_ id: String, preset: LaterPreset) {
		`defer`(id, until: preset.resolve(from: now()), label: preset.label)
	}

	public func `defer`(_ id: String, until: Date, label: String) {
		entries[id] = LaterEntry(until: until, label: label)
		save()
	}

	/// "Bring back", or the reader acted on the card: forget the deferral.
	public func clear(_ id: String) {
		guard entries[id] != nil else { return }
		entries[id] = nil
		save()
	}

	/// Puts back what an Undo captured.
	public func restore(_ id: String, to entry: LaterEntry?) {
		entries[id] = entry
		save()
	}

	/// Drops deferrals that came due long ago for cards that no longer exist.
	public func prune(keeping ids: Set<String>) {
		let stale = now().addingTimeInterval(-7 * 86_400)
		let kept = entries.filter { ids.contains($0.key) || $0.value.until > stale }
		if kept.count != entries.count {
			entries = kept
			save()
		}
	}

	// MARK: Persistence

	private func save() {
		if let ws = loadedWorkspace ?? workspaceId() {
			Self.write(entries, defaults: defaults, workspace: ws)
		}
		scheduleWake()
	}

	nonisolated static func read(defaults: UserDefaults, workspace: String) -> [String: LaterEntry] {
		guard let data = defaults.data(forKey: key(workspace: workspace)),
			let saved = try? JSONDecoder().decode([String: LaterEntry].self, from: data)
		else { return [:] }
		return saved
	}

	nonisolated static func write(
		_ entries: [String: LaterEntry], defaults: UserDefaults, workspace: String
	) {
		if let data = try? JSONEncoder().encode(entries) {
			defaults.set(data, forKey: key(workspace: workspace))
		}
	}

	/// Defers a card without a running store: the notification button's path, which runs in the
	/// background before any view exists. The store picks it up on its next `reload()`.
	public nonisolated static func record(
		entityId: String, workspace: String, preset: LaterPreset, now: Date = Date(),
		defaults: UserDefaults = .standard
	) {
		var saved = read(defaults: defaults, workspace: workspace)
		saved[entityId] = LaterEntry(until: preset.resolve(from: now), label: preset.label)
		write(saved, defaults: defaults, workspace: workspace)
	}

	// MARK: Coming due

	/// Sleeps until the next deferral is due, then bumps `tick` so views re-read.
	private func scheduleWake() {
		wake?.cancel()
		let current = now()
		guard let next = entries.values.map(\.until).filter({ $0 > current }).min() else { return }
		let delay = next.timeIntervalSince(current) + 0.05
		wake = Task { [weak self] in
			try? await Task.sleep(for: .seconds(delay))
			guard !Task.isCancelled else { return }
			self?.tick += 1
			self?.scheduleWake()
		}
	}
}
