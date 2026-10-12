import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

private struct SnapshotFailure: Error { var reason: String }

@MainActor
private func render<V: View>(_ view: V, name: String, width: CGFloat, dark: Bool) throws {
	let framed = view
		.padding(MaskinSpace.s9)
		.frame(width: width, alignment: .topLeading)
		.background(MaskinSurface.grouped)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else { throw SnapshotFailure(reason: "render failed") }
	// Never a hard-coded path: the brief gives the scratch dir through the environment.
	let dir = URL(
		fileURLWithPath: ProcessInfo.processInfo.environment["SETTINGS_SNAPSHOT_DIR"]
			?? NSTemporaryDirectory())
	try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	let url = dir.appendingPathComponent("settings-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
	else { throw SnapshotFailure(reason: "no destination") }
	CGImageDestinationAddImage(dest, image, nil)
	guard CGImageDestinationFinalize(dest) else { throw SnapshotFailure(reason: "write failed") }
}

private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
	VStack(alignment: .leading, spacing: 0, content: content)
		.padding(.horizontal, MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card))
}

private struct HubSnapshot: View {
	var body: some View {
		card {
			SettingsRow(symbol: "person.crop.circle", title: "Profile", detail: "Alex Preview")
			Divider()
			SettingsRow(symbol: "key", title: "API key")
			Divider()
			SettingsRow(symbol: "building.2", title: "Workspace", detail: "Mesh Firm")
			Divider()
			SettingsRow(symbol: "person.2", title: "Members", detail: "4")
			Divider()
			SettingsRow(symbol: "link", title: "Integrations")
			Divider()
			SettingsRow(symbol: "wand.and.stars", title: "Skills")
		}
	}
}

private struct MembersSnapshot: View {
	var body: some View {
		card {
			MemberRow(member: member("1", "Olive Owner", .owner))
			Divider()
			MemberRow(member: member("2", "Ari Admin", .admin))
			Divider()
			MemberRow(member: member("3", "Mo Member"), busy: true)
			Divider()
			MemberRow(member: member("4", "Relay", .member, agent: true))
		}
	}

	private func member(_ id: String, _ name: String, _ role: MemberRole = .member, agent: Bool = false)
		-> WorkspaceMember
	{ WorkspaceMember(actorId: id, name: name, isAgent: agent, role: role) }
}

private struct IntegrationsSnapshot: View {
	var body: some View {
		card {
			IntegrationRow(name: "Gmail", status: .connected(account: "alex@example.com"))
			Divider()
			IntegrationRow(name: "Slack", status: .needsReconnect(missingScopes: 3))
			Divider()
			IntegrationRow(name: "Linear", status: .disconnected)
			Divider()
			IntegrationRow(name: "PostHog", status: .available)
		}
	}
}

private func snapshotMember(_ id: String, _ name: String, _ role: MemberRole = .member, agent: Bool = false)
	-> WorkspaceMember
{ WorkspaceMember(actorId: id, name: name, isAgent: agent, role: role) }

/// Members as the §10 tidy-up draws it: PEOPLE · n, then AGENTS · n ending in Hire an agent.
private struct MembersGroupsSnapshot: View {
	var body: some View {
		let groups = MembersRoster.groups(
			members: [
				snapshotMember("1", "Olive Owner", .owner), snapshotMember("2", "Ari Admin", .admin),
				snapshotMember("3", "Mo Member"), snapshotMember("ag-ghost", "Ghost", .member, agent: true),
			],
			agents: [
				AgentSummary(
					id: "ag-relay", name: "Relay", description: "Routes inbound leads",
					latestSession: AgentSession(id: "s", actorID: "ag-relay", status: "running")),
				AgentSummary(id: "ag-forge", name: "Forge", description: "Ships small fixes", storedState: .paused),
				AgentSummary(id: "ag-scout", name: "Scout", description: "Researches accounts"),
			])
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			PageGroupLabel(text: "People · \(groups.people.count)")
			PageCard(
				rows: groups.people.map {
					PageRowModel(
						id: $0.id, title: $0.name, avatar: ($0.name, false),
						accessory: .state(WorkspacePageState.member(role: $0.role)))
				})
			PageGroupLabel(text: "Agents · \(groups.agents.count)").padding(.top, MaskinSpace.s7)
			PageCard(
				rows: groups.agents.map { agent in
					PageRowModel(
						id: agent.id, title: agent.name, subtitle: agent.role, avatar: (agent.name, true),
						avatarWorking: agent.isWorking,
						accessory: MembersView.accessory(for: agent),
						showsChevron: true)
				} + [
					PageRowModel(
						id: "hire", title: "Hire an agent", subtitle: "From the marketplace",
						accessory: .state(PageState("Marketplace", .active)), showsChevron: true)
				])
		}
	}
}

/// Keys & MCP: the MCP SERVER rows (URL, tools, auth, a connected client, the unavailable line),
/// then the API KEYS row with the masked key and the footer.
private struct KeysAndMCPSnapshot: View {
	let key: SecretValue
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			PageGroupLabel(text: "MCP server")
			PageCard(rows: [
				PageRowModel(
					id: "url", title: "Server URL", subtitle: "https://api.maskin.io/mcp", subtitleIsMono: true,
					accessory: .state(PageState("Copy", .plain))),
				PageRowModel(
					id: "tools", title: "Tools exposed", subtitle: "Objects, flows, decisions, search, chat",
					accessory: .state(PageState("24", .plain))),
				PageRowModel(id: "auth", title: "Auth", subtitle: "Your API key as a bearer token"),
				PageRowModel(
					id: "c1", title: "Claude Desktop", subtitle: "Read + write · last call 4 min. ago",
					accessory: .state(WorkspacePageState.mcpClientConnected)),
				PageRowModel(
					id: "clients", title: "Connected clients", subtitle: SettingsError.mcpNotAvailable.message,
					accessory: .state(PageState("None listed", .muted))),
			])
			PageGroupLabel(text: "API keys").padding(.top, MaskinSpace.s7)
			PageCard(rows: [
				PageRowModel(
					id: "own", title: "Your API key", subtitle: key.masked, subtitleIsMono: true,
					accessory: .state(WorkspacePageState.activeKey))
			])
			PageFootnote(text: KeysPage.footer)
		}
	}
}

/// The profile sheet's three stat tiles, each a link.
private struct StatTilesSnapshot: View {
	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			ProfileStatTile(value: 3, label: "waiting on you", destination: "For you") {}
			ProfileStatTile(value: 5, label: "flows you own", destination: "Flows") {}
			ProfileStatTile(value: 2, label: "agents working", destination: "Members") {}
		}
	}
}

private struct KeySnapshot: View {
	let key: SecretValue
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			SecretKeyCard(text: key.masked, isRevealed: false, onToggle: {}, onCopy: {})
			card {
				SkillRow(skill: WorkspaceSkill(id: "1", name: "audit-copy", summary: "Checks tone and claims.", isValid: true))
				Divider()
				SkillRow(skill: WorkspaceSkill(id: "2", name: "draft-brief", summary: nil, isValid: false))
			}
		}
	}
}

@MainActor
@Suite("Settings snapshots")
struct SettingsSnapshotTests {
	@Test("rows render at phone and iPad widths in light and dark", arguments: [402.0, 820.0], [false, true])
	func renders(width: Double, dark: Bool) throws {
		let key = SecretValue("ank_SNAPSHOTSECRET0123456789abcdef")
		try render(HubSnapshot(), name: "hub", width: width, dark: dark)
		try render(MembersSnapshot(), name: "members", width: width, dark: dark)
		try render(IntegrationsSnapshot(), name: "integrations", width: width, dark: dark)
		try render(KeySnapshot(key: key), name: "apikey-skills", width: width, dark: dark)
		try render(MembersGroupsSnapshot(), name: "members-groups", width: width, dark: dark)
		try render(KeysAndMCPSnapshot(key: key), name: "keys-and-mcp", width: width, dark: dark)
		try render(StatTilesSnapshot(), name: "profile-stat-tiles", width: width, dark: dark)
	}

	@Test("the Keys & MCP footer is the handoff sentence, with no exclamation mark")
	func footerCopy() {
		#expect(KeysPage.footer == "MCP lets Claude, Cursor and other AI tools use this workspace with your permissions.")
		#expect(!KeysPage.footer.contains("!"))
	}

	@Test("the key card is fed the masked text only, so a screenshot never shows the secret")
	func maskedInScreenshots() {
		let key = SecretValue("ank_SNAPSHOTSECRET0123456789abcdef")
		#expect(!key.masked.contains("SNAPSHOTSECRET"))
	}

	@Test("version string has a value")
	func version() { #expect(!SettingsScreen.versionString.isEmpty) }
}
