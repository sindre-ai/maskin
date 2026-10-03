import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the first-use screen can offer right now.
enum FirstUseReadiness: Equatable {
	/// The workspace exists: the primary action carries on into the app.
	case ready
	/// Sign-up made the account but the server couldn't set up its first workspace (or it hasn't
	/// shown up yet). The account and key are saved; "Try again" re-lists workspaces.
	case settingUp
	/// A retry is in flight.
	case retrying

	static func resolve(provisioningFailed: Bool, workspaceCount: Int, isLoading: Bool) -> Self {
		guard workspaceCount == 0, provisioningFailed else { return .ready }
		return isLoading ? .retrying : .settingUp
	}
}

/// The three beats of what Maskin does, shown once after the first sign-up. Copy follows the
/// Chief of Staff's own welcome in the First Use mockup: short, declarative, no hype.
struct FirstUseBeat: Identifiable, Equatable {
	let id: Int
	let symbol: String
	let title: String
	let detail: String

	static let all: [FirstUseBeat] = [
		.init(
			id: 1, symbol: "arrow.triangle.2.circlepath", title: "Agents do the work",
			detail: "Loops keep cycling on their own. Bets are scoped hypotheses, worked until they're settled."),
		.init(
			id: 2, symbol: "hand.raised", title: "You make the calls",
			detail: "Anything that needs a person lands in For You, one card at a time."),
		.init(
			id: 3, symbol: "tray", title: "Nothing clears itself",
			detail: "Mark a card read and it leaves. Keep it unread and it comes back tomorrow."),
	]
}

/// Shown instead of the shell until the user continues. Plain values in, closures out, so it
/// renders in snapshots without a server. The shell hand-off is the caller's.
struct FirstUseView: View {
	var name: String
	var readiness: FirstUseReadiness
	/// A seeded Chief of Staff conversation exists in this workspace.
	var hasWelcomeChat: Bool
	var onOpenWelcome: () -> Void
	var onContinue: () -> Void
	var onRetry: () -> Void

	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	private var greeting: String {
		let first = name.split(separator: " ").first.map(String.init) ?? ""
		return first.isEmpty ? "Welcome." : "Welcome, \(first)."
	}

	var body: some View {
		GeometryReader { proxy in
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s14) {
					VStack(alignment: .leading, spacing: MaskinSpace.s9) {
						BrandMark(size: 56).padding(.bottom, MaskinSpace.s3)
						Text(greeting)
							.maskinText(.largeTitle)
							.foregroundStyle(MaskinColor.ink)
							.accessibilityAddTraits(.isHeader)
						Text("Here's how this works.")
							.maskinText(.body)
							.foregroundStyle(MaskinColor.ink4)
					}

					VStack(alignment: .leading, spacing: MaskinSpace.s12) {
						ForEach(FirstUseBeat.all) { beat in
							HStack(alignment: .top, spacing: MaskinSpace.s9) {
								Image(systemName: beat.symbol)
									.font(.system(size: MaskinFontSize.t16, weight: .semibold))
									.foregroundStyle(MaskinColor.ink)
									.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
									.background(
										MaskinSurface.card,
										in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
									)
									.overlay(
										RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
											.strokeBorder(MaskinSurface.line, lineWidth: 1)
									)
									.accessibilityHidden(true)
								VStack(alignment: .leading, spacing: MaskinSpace.s2) {
									Text(beat.title)
										.maskinText(.headline)
										.foregroundStyle(MaskinColor.ink)
									Text(beat.detail)
										.maskinText(.subhead)
										.foregroundStyle(MaskinColor.ink4)
										.fixedSize(horizontal: false, vertical: true)
								}
							}
							.accessibilityElement(children: .combine)
						}
					}

					actions
				}
				.padding(.horizontal, MaskinSpace.s12)
				.padding(.vertical, MaskinSpace.s14)
				.frame(maxWidth: 440)
				.frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
			}
		}
		.background(MaskinSurface.grouped.ignoresSafeArea())
		.animation(reduceMotion ? nil : MaskinMotion.fade, value: readiness)
	}

	@ViewBuilder
	private var actions: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			switch readiness {
			case .ready:
				if hasWelcomeChat {
					Button("Open the welcome chat", action: onOpenWelcome)
						.buttonStyle(PrimaryActionButtonStyle())
					textButton("Go to For You", action: onContinue)
				} else {
					Button("Go to For You", action: onContinue)
						.buttonStyle(PrimaryActionButtonStyle())
				}
			case .settingUp, .retrying:
				Text("Your account is ready. Your first workspace isn't yet.")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink3)
					.padding(MaskinSpace.s8)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(MaskinColor.surfaceAlt, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				Button(action: onRetry) {
					ZStack {
						Text("Try again").opacity(readiness == .retrying ? 0 : 1)
						if readiness == .retrying { ProgressView() }
					}
				}
				.buttonStyle(PrimaryActionButtonStyle())
				.disabled(readiness == .retrying)
				textButton("Continue anyway", action: onContinue)
			}
		}
	}

	private func textButton(_ title: String, action: @escaping () -> Void) -> some View {
		Button(title, action: action)
			.buttonStyle(.plain)
			.maskinText(.subhead)
			.fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink3)
			.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
	}
}
