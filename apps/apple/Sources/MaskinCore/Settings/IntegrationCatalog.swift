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
	case accounting = "Accounting"
	case analytics = "Analytics"
	case custom = "Custom"

	public var id: String { rawValue }
	public var label: String { rawValue }

	/// A provider the catalog does not know yet is still listed, under Docs & data.
	public static func category(for providerID: String) -> IntegrationCategory {
		if providerID == IntegrationsStore.toolServerProvider { return .custom }
		return IntegrationCatalog.entries[providerID]?.category ?? .docsAndData
	}
}

/// The two companies that get a pill of their own on Settings → Integrations.
public enum IntegrationVendor: String, CaseIterable, Identifiable, Sendable {
	case google = "Google"
	case microsoft = "Microsoft"

	public var id: String { rawValue }
	public var label: String { rawValue }
}

/// One choice in the pill row: All, the two vendors, then the ten categories.
public enum IntegrationPill: Hashable, Identifiable, Sendable {
	case all
	case vendor(IntegrationVendor)
	case category(IntegrationCategory)

	public var id: String {
		switch self {
		case .all: "all"
		case .vendor(let vendor): "vendor-\(vendor.rawValue)"
		case .category(let category): "category-\(category.rawValue)"
		}
	}

	public var label: String {
		switch self {
		case .all: "All"
		case .vendor(let vendor): vendor.label
		case .category(let category): category.label
		}
	}

	/// The pills in the order the web shows them.
	public static let row: [IntegrationPill] = {
		var pills: [IntegrationPill] = [.all]
		for vendor in IntegrationVendor.allCases { pills.append(.vendor(vendor)) }
		for category in IntegrationCategory.allCases { pills.append(.category(category)) }
		return pills
	}()

	/// Whether a tool belongs under the pill. A tool sits in one category and at most one vendor.
	public func matches(providerID: String) -> Bool {
		switch self {
		case .all: true
		case .vendor(let vendor): IntegrationCatalog.vendor(for: providerID) == vendor
		case .category(let category): IntegrationCategory.category(for: providerID) == category
		}
	}
}

/// What the app knows about each tool beyond the server's provider list: its category, the company
/// behind it, its place in the Popular shelf and the day it shipped. Mirrors `CATALOG` in
/// `apps/web/src/lib/integration-catalog.ts`; change both together.
public enum IntegrationCatalog {
	struct Entry: Sendable {
		var category: IntegrationCategory
		var vendor: IntegrationVendor?
		/// Place in the Popular shelf, 1 first. Editorial, not usage data.
		var featured: Int?
		/// Day the tool first shipped (YYYY-MM-DD).
		var addedOn: String?
		/// One line on what the tool is for. Left out means the page shows the category instead.
		var description: String?

		init(
			category: IntegrationCategory, vendor: IntegrationVendor? = nil, featured: Int? = nil,
			addedOn: String? = nil, description: String? = nil
		) {
			self.category = category
			self.vendor = vendor
			self.featured = featured
			self.addedOn = addedOn
			self.description = description
		}
	}

	/// A tool counts as New for this many days after it shipped.
	public static let newWindowDays = 30

	static let entries: [String: Entry] = [
		"apollo": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"asana": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"attio": Entry(category: .salesAndPayments),
		"box": Entry(category: .files, addedOn: "2026-11-22"),
		"brevo": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"brex": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"business-central": Entry(category: .accounting, addedOn: "2026-11-24"),
		"calendly": Entry(category: .emailAndCalendar, addedOn: "2026-11-22"),
		"clay": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"cloudflare": Entry(category: .code, addedOn: "2026-11-21"),
		"coda": Entry(category: .docsAndData, addedOn: "2026-11-24"),
		"datadog": Entry(category: .analytics, addedOn: "2026-11-21"),
		"deel": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"dinero": Entry(category: .accounting, addedOn: "2026-11-22"),
		"docusign": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"drata": Entry(category: .analytics, addedOn: "2026-11-24"),
		"dropbox": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"fathom": Entry(category: .chatAndSocial, addedOn: "2026-11-21"),
		"figma": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"fireflies": Entry(category: .chatAndSocial, addedOn: "2026-11-21"),
		"framer": Entry(category: .design, addedOn: "2026-11-24"),
		"freshbooks": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"github": Entry(category: .code, featured: 4, description: "Pull requests"),
		"gmail": Entry(category: .emailAndCalendar, vendor: .google, featured: 1, description: "Drafts and sending"),
		"gong": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"google-calendar": Entry(category: .emailAndCalendar, vendor: .google, featured: 2),
		"google-drive": Entry(category: .files, vendor: .google, featured: 5, description: "Files"),
		"google-meet": Entry(category: .chatAndSocial, vendor: .google),
		"google-search-console": Entry(category: .analytics, vendor: .google),
		"granola": Entry(category: .chatAndSocial, addedOn: "2026-11-21"),
		"greenhouse": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"gusto": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"hex": Entry(category: .analytics, addedOn: "2026-11-21"),
		"hubspot": Entry(category: .salesAndPayments, featured: 8, addedOn: "2026-11-22"),
		"intercom": Entry(category: .chatAndSocial, addedOn: "2026-11-22"),
		"klaviyo": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"lattice": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"linear": Entry(category: .code, featured: 7, description: "Issues"),
		"linkedin-unipile": Entry(category: .chatAndSocial, description: "Posting and outreach"),
		"looker": Entry(category: .analytics, addedOn: "2026-11-22"),
		"mailchimp": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"make": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"mercury": Entry(category: .salesAndPayments, addedOn: "2026-11-24"),
		"microsoft": Entry(category: .chatAndSocial, vendor: .microsoft, description: "Teams transcripts"),
		"miro": Entry(category: .design),
		"monday": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"mural": Entry(category: .design, addedOn: "2026-11-24"),
		"neon": Entry(category: .docsAndData, addedOn: "2026-11-21"),
		"netlify": Entry(category: .code, addedOn: "2026-11-21"),
		"new-relic": Entry(category: .analytics, addedOn: "2026-11-21"),
		"notion": Entry(category: .docsAndData, featured: 6),
		"numina": Entry(category: .accounting, addedOn: "2026-11-22"),
		"otter": Entry(category: .chatAndSocial, addedOn: "2026-11-21"),
		"outreach": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"pagerduty": Entry(category: .analytics, addedOn: "2026-11-21"),
		"pipedrive": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"planetscale": Entry(category: .docsAndData, addedOn: "2026-11-21"),
		"posthog": Entry(category: .analytics, description: "Product analytics"),
		"power-bi": Entry(category: .analytics, vendor: .microsoft, addedOn: "2026-11-22"),
		"ramp": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"resend": Entry(category: .emailAndCalendar, description: "Email sending"),
		"retool": Entry(category: .docsAndData, addedOn: "2026-11-21"),
		"salesforce": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"skjald": Entry(category: .docsAndData),
		"slack": Entry(category: .chatAndSocial, featured: 3, description: "Channels and triggers"),
		"squarespace": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"stripe": Entry(category: .salesAndPayments),
		"supabase": Entry(category: .docsAndData, addedOn: "2026-11-21"),
		"trello": Entry(category: .docsAndData, addedOn: "2026-11-24"),
		"ubersuggest": Entry(category: .analytics),
		"uniconta": Entry(category: .accounting, addedOn: "2026-11-22"),
		"vanta": Entry(category: .analytics, addedOn: "2026-11-24"),
		"wix": Entry(category: .design, addedOn: "2026-11-24"),
		"xero": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
		"zendesk": Entry(category: .docsAndData, addedOn: "2026-11-22"),
		"zoom": Entry(category: .chatAndSocial, addedOn: "2026-11-20"),
		"zoominfo": Entry(category: .salesAndPayments, addedOn: "2026-11-22"),
	]

	public static func vendor(for providerID: String) -> IntegrationVendor? {
		entries[providerID]?.vendor
	}

	/// One line on what the tool is for, when someone has written it.
	public static func description(for providerID: String) -> String? {
		entries[providerID]?.description
	}

	/// Featured tools in shelf order. Empty when nothing is featured, so the shelf stays hidden.
	public static func popularProviderIDs() -> [String] {
		var featured: [(id: String, place: Int)] = []
		for (id, entry) in entries {
			if let place = entry.featured { featured.append((id: id, place: place)) }
		}
		featured.sort { (a: (id: String, place: Int), b: (id: String, place: Int)) -> Bool in
			a.place != b.place ? a.place < b.place : a.id < b.id
		}
		return featured.map { $0.id }
	}

	/// Tools that shipped within the last 30 days, newest first. Empty hides the shelf.
	public static func newProviderIDs(now: Date = Date()) -> [String] {
		var fresh: [(id: String, addedOn: String)] = []
		for (id, entry) in entries {
			if let addedOn = entry.addedOn, isNew(addedOn: addedOn, now: now) {
				fresh.append((id: id, addedOn: addedOn))
			}
		}
		fresh.sort { (a: (id: String, addedOn: String), b: (id: String, addedOn: String)) -> Bool in
			a.addedOn != b.addedOn ? a.addedOn > b.addedOn : a.id < b.id
		}
		return fresh.map { $0.id }
	}

	/// True when `addedOn` (YYYY-MM-DD, UTC) is no more than 30 days before `now`. No date is not new.
	static func isNew(addedOn: String?, now: Date) -> Bool {
		guard let addedOn, let added = day(addedOn) else { return false }
		let ageDays = now.timeIntervalSince(added) / 86_400
		return ageDays >= 0 && ageDays <= Double(newWindowDays)
	}

	private static let utc: Calendar = {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
		return calendar
	}()

	private static func day(_ text: String) -> Date? {
		let parts = text.split(separator: "-").compactMap { Int($0) }
		guard parts.count == 3 else { return nil }
		return utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
	}
}
