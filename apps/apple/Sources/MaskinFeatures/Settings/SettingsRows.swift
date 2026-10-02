import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if canImport(UIKit)
	import UIKit
	import UniformTypeIdentifiers
#elseif canImport(AppKit)
	import AppKit
#endif

/// Copying a secret: never leaves the device, never lingers.
@MainActor
enum SecretPasteboard {
	static let lifetime: TimeInterval = 60

	/// Returns false on platforms without a pasteboard (tvOS, watchOS).
	@discardableResult
	static func copy(_ text: String) -> Bool {
		#if canImport(UIKit) && !os(tvOS) && !os(watchOS)
			// `localOnly` keeps it off Universal Clipboard; the expiry removes it from the board.
			UIPasteboard.general.setItems(
				[[UTType.utf8PlainText.identifier: text]],
				options: [
					.localOnly: true, .expirationDate: Date().addingTimeInterval(lifetime),
				])
			return true
		#elseif canImport(AppKit) && os(macOS)
			let board = NSPasteboard.general
			board.clearContents()
			board.setString(text, forType: .string)
			// Marks it as concealed for clipboard managers.
			board.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
			let count = board.changeCount
			Task { @MainActor in
				try? await Task.sleep(for: .seconds(lifetime))
				// Only clear what we put there; if something else was copied since, leave it.
				if board.changeCount == count { board.clearContents() }
			}
			return true
		#else
			return false
		#endif
	}
}

/// A hub row: tinted symbol, title, optional value, chevron added by `NavigationLink`.
struct SettingsRow: View {
	let symbol: String
	let title: String
	var detail: String?

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			Image(systemName: symbol)
				.foregroundStyle(MaskinColor.accent)
				.frame(width: MaskinSpace.s12)
				.accessibilityHidden(true)
			Text(title).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: MaskinSpace.s4)
			if let detail {
				Text(detail).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.accessibilityElement(children: .combine)
	}
}

struct MemberRow: View {
	let member: WorkspaceMember
	var busy = false

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			ActorAvatar(name: member.name, kind: member.isAgent ? .agent : .human)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(member.name).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Text(member.isAgent ? "Agent" : member.role.label)
					.font(.footnote).foregroundStyle(MaskinColor.ink4)
			}
			Spacer(minLength: MaskinSpace.s4)
			if busy { ProgressView() }
			else if member.isAgent { Text(member.role.label).font(.footnote).foregroundStyle(MaskinColor.ink4) }
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.accessibilityElement(children: .combine)
	}
}

/// One integration, connected or available. Shows the provider's display name; the account
/// only when it is an email. Never a provider-side id.
struct IntegrationRow: View {
	enum Status: Equatable {
		case available
		case connected(account: String?)
		case needsReconnect(missingScopes: Int)
		case incomplete
		case disconnected
	}

	let name: String
	let status: Status

	private var tint: Color {
		switch status {
		case .available: MaskinColor.ink5
		case .connected: MaskinColor.success
		case .needsReconnect, .incomplete: MaskinColor.warning
		case .disconnected: MaskinColor.danger
		}
	}

	private var detail: String {
		switch status {
		case .available: "Not connected"
		case .connected(let account): account.map { "Connected as \($0)" } ?? "Connected"
		case .needsReconnect(let n):
			"Update needed: reconnect to grant \(n) new permission\(n == 1 ? "" : "s")"
		case .incomplete: "Setup not finished"
		case .disconnected: "Disconnected: connect again"
		}
	}

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			Circle().fill(tint).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(name).foregroundStyle(MaskinColor.ink)
				Text(detail).font(.footnote).foregroundStyle(MaskinColor.ink4)
			}
			Spacer(minLength: 0)
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.accessibilityElement(children: .combine)
	}
}

struct SkillRow: View {
	let skill: WorkspaceSkill

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			HStack {
				Text(skill.name).foregroundStyle(MaskinColor.ink)
				if !skill.isValid {
					Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(MaskinColor.warning)
						.accessibilityLabel("Needs attention")
				}
			}
			if let summary = skill.summary, !summary.isEmpty {
				Text(summary).font(.footnote).foregroundStyle(MaskinColor.ink4).lineLimit(2)
			}
		}
		.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}

/// The freshly regenerated key: masked until asked.
struct SecretKeyCard: View {
	let text: String
	let isRevealed: Bool
	let onToggle: () -> Void
	let onCopy: () -> Void

	/// VoiceOver must not read masked bullets aloud, nor announce the key unless it is revealed.
	static func accessibilityText(_ text: String, isRevealed: Bool) -> String {
		isRevealed ? text : "API key hidden"
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text(text)
				.font(.system(.callout, design: .monospaced))
				.foregroundStyle(MaskinColor.ink)
				.textSelection(.disabled)
				.lineLimit(isRevealed ? nil : 1)
				.minimumScaleFactor(0.6)
				.frame(maxWidth: .infinity, alignment: .leading)
				.privacySensitive()
				.accessibilityLabel(Self.accessibilityText(text, isRevealed: isRevealed))
			HStack(spacing: MaskinSpace.s7) {
				Button(isRevealed ? "Hide" : "Reveal", action: onToggle)
				Button("Copy", action: onCopy)
			}
			.buttonStyle(.secondaryAction)
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card))
	}
}
