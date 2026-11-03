import Foundation
import Observation

/// Plan and usage, read-only. Changing the plan or buying credits stays on the web.
@MainActor
@Observable
public final class BillingStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var usage: BillingUsage?
	public private(set) var phase: Phase = .idle

	@ObservationIgnored private let api: any BillingAPI

	public init(api: any BillingAPI) { self.api = api }

	public func load() async {
		if usage == nil { phase = .loading }
		do {
			usage = try await api.usage()
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load your plan."
			if usage == nil { phase = .failed(message) }
		}
	}
}
