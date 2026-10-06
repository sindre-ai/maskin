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
	}

	@Test("the key card is fed the masked text only, so a screenshot never shows the secret")
	func maskedInScreenshots() {
		let key = SecretValue("ank_SNAPSHOTSECRET0123456789abcdef")
		#expect(!key.masked.contains("SNAPSHOTSECRET"))
	}

	@Test("version string has a value")
	func version() { #expect(!SettingsScreen.versionString.isEmpty) }
}
