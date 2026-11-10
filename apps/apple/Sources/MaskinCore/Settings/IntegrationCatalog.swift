import Foundation

/// The category chips on Settings → Integrations, in the order the design shows them. Mirrors
/// `apps/web/src/lib/integration-catalog.ts`; change both together.
public enum IntegrationCategory: String, CaseIterable, Identifiable, Sendable {
	case emailAndCalendar = "Email & calendar"
	case files = "Files"
	case docsAndData = "Docs & data"
	case chatAndSocial = "Chat & social"
	case code = "Code"
	case design = "Design"
	case salesAndPayments = "Sales & payments"
	case analytics = "Analytics"
	case custom = "Custom"

	public var id: String { rawValue }
	public var label: String { rawValue }

	private static let byProvider: [String: IntegrationCategory] = [
		"github": .code,
		"gmail": .emailAndCalendar,
		"google-calendar": .emailAndCalendar,
		"google-drive": .files,
		"google-meet": .chatAndSocial,
		"google-search-console": .analytics,
		"linear": .code,
		"linkedin-unipile": .chatAndSocial,
		"miro": .design,
		"notion": .docsAndData,
		"posthog": .analytics,
		"resend": .emailAndCalendar,
		"skjald": .docsAndData,
		"slack": .chatAndSocial,
		"ubersuggest": .analytics,
	]

	/// A provider the catalog does not know yet is still listed, under Docs & data.
	public static func category(for providerID: String) -> IntegrationCategory {
		if providerID == IntegrationsStore.toolServerProvider { return .custom }
		return byProvider[providerID] ?? .docsAndData
	}
}
