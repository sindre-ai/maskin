import Foundation
import Observation

/// The small figures beside the Settings rows (Members 2, Skills 3, Billing Team). Each one loads
/// on its own: a figure whose request fails stays nil and its row shows no detail, never a dash.
@MainActor
@Observable
public final class SettingsCountsStore {
	public private(set) var members: Int?
	public private(set) var integrationsConnected: Int?
	public private(set) var files: Int?
	public private(set) var skills: Int?
	public private(set) var triggers: Int?
	public private(set) var itemTypes: Int?
	public private(set) var plan: String?

	/// A file list is fetched one page deep; past this it is shown without a number, not a wrong one.
	public static let filesPageSize = 100

	@ObservationIgnored private let workspaceId: String
	@ObservationIgnored private let membersAPI: any MembersAPI
	@ObservationIgnored private let integrationsAPI: any IntegrationsAPI
	@ObservationIgnored private let skillsAPI: any SkillsAPI
	@ObservationIgnored private let schemaAPI: any SchemaAPI
	@ObservationIgnored private let billingAPI: any BillingAPI
	@ObservationIgnored private let triggerCount: @Sendable () async throws -> Int
	@ObservationIgnored private let fileCount: @Sendable (Int) async throws -> Int

	public init(
		workspaceId: String, members: any MembersAPI, integrations: any IntegrationsAPI,
		skills: any SkillsAPI, schema: any SchemaAPI, billing: any BillingAPI,
		triggerCount: @escaping @Sendable () async throws -> Int,
		fileCount: @escaping @Sendable (Int) async throws -> Int
	) {
		self.workspaceId = workspaceId
		self.membersAPI = members
		self.integrationsAPI = integrations
		self.skillsAPI = skills
		self.schemaAPI = schema
		self.billingAPI = billing
		self.triggerCount = triggerCount
		self.fileCount = fileCount
	}

	public func load() async {
		async let m = try? membersAPI.list(workspaceId: workspaceId).count
		async let i = try? integrationsAPI.connected().filter { $0.state == .connected }.count
		async let s = try? skillsAPI.list(workspaceId: workspaceId).count
		async let t = try? schemaAPI.load().types.count
		async let b = try? billingAPI.usage().planLabel
		async let g = try? triggerCount()
		async let f = try? fileCount(Self.filesPageSize)
		let (mm, ii, ss, tt, bb, gg, ff) = await (m, i, s, t, b, g, f)
		if let mm { members = mm }
		if let ii { integrationsConnected = ii }
		if let ss { skills = ss }
		if let tt { itemTypes = tt }
		if let bb { plan = bb }
		if let gg { triggers = gg }
		if let ff, ff < Self.filesPageSize { files = ff }
	}

	/// "3 connected", or nil when there is nothing connected or the count is unknown.
	public var integrationsDetail: String? {
		guard let integrationsConnected, integrationsConnected > 0 else { return nil }
		return "\(integrationsConnected) connected"
	}

	/// A count as row detail; zero and unknown both hide it.
	public static func detail(_ count: Int?) -> String? {
		guard let count, count > 0 else { return nil }
		return String(count)
	}
}
