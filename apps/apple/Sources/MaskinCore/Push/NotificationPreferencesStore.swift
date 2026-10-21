import Foundation
import Observation

/// The signed-in person's push preferences.
///
/// - Changes show at once and are sent as a PATCH-style PUT (only the field that changed, with an
///   `Idempotency-Key`). Saves go one at a time, in order. A refused save drops just that change;
///   changes still waiting stay applied on top of the last value the server confirmed.
/// - `syncTimezone` keeps the server's idea of the device's timezone current without ever surfacing
///   an error: the briefing scheduler will not guess one, so it matters, but nobody can act on a
///   failure. It is retried by the next call (launch, foreground, a timezone change).
@MainActor
@Observable
public final class NotificationPreferencesStore {
	public enum Phase: Equatable, Sendable { case idle, loading, loaded, failed }

	/// What the screens show: the confirmed value with any unsent changes on top.
	public private(set) var preferences = NotificationPreferences()
	public private(set) var phase: Phase = .idle
	/// A sentence for the last refused change; cleared by `dismissError()` or the next change.
	public private(set) var error: String?

	@ObservationIgnored private let api: any NotificationPreferencesAPI
	@ObservationIgnored private let makeKey: @Sendable () -> String
	/// The last value the server confirmed. Nil until the first load or save.
	@ObservationIgnored private var confirmed: NotificationPreferences?
	@ObservationIgnored private var queue: [Pending] = []
	@ObservationIgnored private var isDraining = false
	@ObservationIgnored private var loading: Task<Void, Never>?

	private struct Pending {
		var patch: NotificationPreferencesPatch
		var key: String
	}

	public init(api: any NotificationPreferencesAPI, makeKey: @escaping @Sendable () -> String = { UUID().uuidString }) {
		self.api = api
		self.makeKey = makeKey
	}

	// MARK: Loading

	public func load() async {
		if let loading { return await loading.value }
		let task = Task { @MainActor in
			if phase != .loaded { phase = .loading }
			do {
				confirmed = try await api.load()
				phase = .loaded
			} catch {
				phase = confirmed == nil ? .failed : .loaded
			}
			recompute()
		}
		loading = task
		await task.value
		loading = nil
	}

	/// Changes are still on their way to the server.
	public var isSaving: Bool { !queue.isEmpty }

	public func dismissError() { error = nil }

	// MARK: Changes

	public func setCategory(_ category: Category, enabled: Bool) {
		var patch = NotificationPreferencesPatch()
		switch category {
		case .needsYou: patch.needsYou = enabled
		case .conversation: patch.conversation = enabled
		case .digest: patch.digest = enabled
		case .tips: patch.tips = enabled
		}
		submit(patch)
	}

	public enum Category: String, CaseIterable, Sendable { case needsYou, conversation, digest, tips }

	public func isEnabled(_ category: Category) -> Bool {
		switch category {
		case .needsYou: preferences.categories.needsYou
		case .conversation: preferences.categories.conversation
		case .digest: preferences.categories.digest
		case .tips: preferences.categories.tips
		}
	}

	public func setQuietHours(enabled: Bool) {
		var patch = NotificationPreferencesPatch()
		patch.quietHours = enabled ? .set(preferences.quietHours ?? .evening) : .clear
		submit(patch)
	}

	public func setQuietHours(start: Int? = nil, end: Int? = nil) {
		guard let current = preferences.quietHours else { return }
		var patch = NotificationPreferencesPatch()
		patch.quietHours = .set(.init(start: start ?? current.start, end: end ?? current.end))
		submit(patch)
	}

	public func setBriefing(enabled: Bool) {
		var patch = NotificationPreferencesPatch()
		patch.briefingEnabled = enabled
		submit(patch)
	}

	public func setBriefingTime(_ minutes: Int) {
		var patch = NotificationPreferencesPatch()
		patch.briefingTime = NotificationPreferences.clamp(minutes: minutes)
		submit(patch)
	}

	public func isMuted(workspaceId: String) -> Bool { preferences.mutedWorkspaceIds.contains(workspaceId) }

	public func setMuted(_ muted: Bool, workspaceId: String) {
		var ids = preferences.mutedWorkspaceIds.filter { $0 != workspaceId }
		if muted { ids.append(workspaceId) }
		var patch = NotificationPreferencesPatch()
		patch.mutedWorkspaceIds = ids
		submit(patch)
	}

	// MARK: Timezone

	/// PUT `identifier` only when it differs from what the server holds. Reads the server first
	/// (cached after that), never throws, never sets `error`.
	public func syncTimezone(_ identifier: String = TimeZone.current.identifier) async {
		guard !identifier.isEmpty else { return }
		if confirmed == nil { await load() }
		guard let confirmed, confirmed.timezone != identifier else { return }
		var patch = NotificationPreferencesPatch()
		patch.timezone = .set(identifier)
		// Unlike a person's change this is not shown optimistically (nothing displays it) and is
		// not rolled back; it simply tries again on the next call.
		do {
			let saved = try await api.save(patch, idempotencyKey: makeKey())
			self.confirmed = saved
			recompute()
		} catch {}
	}

	// MARK: Saving

	private func submit(_ patch: NotificationPreferencesPatch) {
		guard !patch.isEmpty else { return }
		error = nil
		queue.append(Pending(patch: patch, key: makeKey()))
		recompute()
		guard !isDraining else { return }
		isDraining = true
		Task { await drain() }
	}

	private func drain() async {
		defer { isDraining = false }
		// Nothing to send a patch onto until the server's value is known.
		if confirmed == nil { await load() }
		while let next = queue.first {
			do {
				let saved = try await api.save(next.patch, idempotencyKey: next.key)
				queue.removeFirst()
				confirmed = saved
			} catch {
				queue.removeFirst()
				self.error = (error as? SettingsError)?.message ?? "Couldn't save that change. It was put back."
			}
			recompute()
		}
	}

	private func recompute() {
		var value = confirmed ?? NotificationPreferences()
		for item in queue { value = item.patch.applied(to: value) }
		preferences = value
	}
}
