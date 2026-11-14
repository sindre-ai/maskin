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

	/// The flag behind the percent view and the 100% screen. Same id as the web's.
	public static let percentFlag = "trial-card-percent"

	public private(set) var usage: BillingUsage?
	/// Whether usage reads as a percent of the plan. Off: the view is exactly as before.
	public private(set) var percentDisplay = false
	public private(set) var phase: Phase = .idle

	@ObservationIgnored private let api: any BillingAPI

	public init(api: any BillingAPI) { self.api = api }

	public func load() async {
		if usage == nil { phase = .loading }
		do {
			let percentOn = await api.isFeatureEnabled(Self.percentFlag)
			usage = try await api.usage()
			percentDisplay = percentOn
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load your plan."
			if usage == nil { phase = .failed(message) }
		}
	}
}
