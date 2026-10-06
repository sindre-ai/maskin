import Foundation
import Observation

/// The marketplace: the catalog of loops, which of them this workspace installed, and the
/// install / fork / remove actions.
@MainActor
@Observable
public final class MarketplaceStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var catalog: [MarketplaceLoop] = []
	public private(set) var installs: [InstalledLoop] = []
	public private(set) var phase: Phase = .idle
	/// Catalog loops with an install in flight.
	public private(set) var installing: Set<String> = []
	/// Installs with a fork or removal in flight.
	public private(set) var busyInstalls: Set<String> = []
	public var notice: String?

	@ObservationIgnored private let api: any MarketplaceAPI
	@ObservationIgnored private var intents = IntentKeys()
	/// Fired after anything that changes which loops exist, so the Loops list can reload.
	@ObservationIgnored public var onLoopsChanged: (() -> Void)?

	public init(api: any MarketplaceAPI) { self.api = api }

	// MARK: Reading

	public func load() async {
		if catalog.isEmpty { phase = .loading }
		async let rows = api.catalog()
		async let installed = api.installs()
		do {
			catalog = try await rows
			phase = .loaded
		} catch {
			if catalog.isEmpty { phase = .failed(AutomationError.message(error)) }
		}
		// "Update available" is best effort: a failure leaves the catalog browsable.
		if let list = try? await installed { installs = list }
	}

	/// Distinct use cases, for the filter chips.
	public var useCases: [String] {
		Array(Set(catalog.compactMap(\.useCase).filter { !$0.isEmpty })).sorted()
	}

	public func loops(useCase: String?, query: String) -> [MarketplaceLoop] {
		let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
		return catalog.filter { loop in
			(useCase == nil || loop.useCase == useCase)
				&& (text.isEmpty || loop.name.localizedCaseInsensitiveContains(text)
					|| loop.summary.localizedCaseInsensitiveContains(text)
					|| (loop.useCase?.localizedCaseInsensitiveContains(text) ?? false))
		}
	}

	public func install(for loopID: String) -> InstalledLoop? {
		installs.first { $0.sourceLoopID == loopID }
	}

	public func state(of loopID: String) -> MarketplaceInstallState {
		if installing.contains(loopID) { return .installing }
		if let row = install(for: loopID) { return .installed(row) }
		return .notInstalled
	}

	/// Installed loops that have a newer marketplace version.
	public var updatesAvailable: [InstalledLoop] { installs.filter(\.hasUpdate) }

	public func detail(loopID: String) async throws -> MarketplaceLoopDetail {
		try await api.detail(loopID: loopID)
	}

	// MARK: Writes

	/// Installs a loop. Returns the provisioned loop object's id so the caller can open it.
	@discardableResult
	public func installLoop(_ loopID: String) async -> String? {
		guard !installing.contains(loopID), install(for: loopID) == nil else { return nil }
		installing.insert(loopID)
		defer { installing.remove(loopID) }
		let intent = "install:\(loopID)"
		do {
			let row = try await api.install(loopID: loopID, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			installs.append(row)
			onLoopsChanged?()
			// Pick up the versions the server computes.
			if let fresh = try? await api.installs() { installs = fresh }
			return row.objectID
		} catch {
			notice = "Couldn't install this loop. \(AutomationError.message(error))"
			return nil
		}
	}

	/// Detaches an install from marketplace updates.
	public func fork(_ installID: String) async {
		guard !busyInstalls.contains(installID) else { return }
		busyInstalls.insert(installID)
		defer { busyInstalls.remove(installID) }
		let intent = "fork:\(installID)"
		do {
			try await api.fork(installID: installID, idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			if let i = installs.firstIndex(where: { $0.id == installID }) { installs[i].isForked = true }
			if let fresh = try? await api.installs() { installs = fresh }
		} catch {
			notice = "Couldn't fork this loop. \(AutomationError.message(error))"
		}
	}

	/// Removes an install and (unless `keepProvisionedItems`) the agents, triggers and skills it
	/// created. Rolled back if the server refuses.
	public func uninstall(_ installID: String, keepProvisionedItems: Bool) async {
		guard !busyInstalls.contains(installID),
			let index = installs.firstIndex(where: { $0.id == installID })
		else { return }
		busyInstalls.insert(installID)
		defer { busyInstalls.remove(installID) }
		let removed = installs[index]
		installs.remove(at: index)
		let intent = "uninstall:\(installID):\(keepProvisionedItems)"
		do {
			try await api.uninstall(
				installID: installID, keepProvisionedItems: keepProvisionedItems,
				idempotencyKey: intents.key(for: intent))
			intents.succeeded(intent)
			onLoopsChanged?()
		} catch {
			if !installs.contains(where: { $0.id == installID }) { installs.insert(removed, at: min(index, installs.count)) }
			notice = "Couldn't remove this loop. \(AutomationError.message(error))"
		}
	}
}
