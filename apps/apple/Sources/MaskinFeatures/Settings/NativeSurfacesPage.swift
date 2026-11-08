import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings > Advanced > Native surfaces: the places Maskin shows up outside the app, with how to
/// turn each on. Widgets, the share extension, Siri and Apple TV are set up by the system or on
/// another device, so each row opens a page that says how, plus the one action the app can take.
struct NativeSurfacesPage: View {
	let environment: AppEnvironment

	private struct Surface: Identifiable {
		let id: String
		let symbol: String
		let title: String
		let summary: String
		let steps: [String]
	}

	private static let outside: [Surface] = [
		Surface(
			id: "share", symbol: "square.and.arrow.up", title: "Share extension",
			summary: "Send a link, photo or file to Maskin",
			steps: [
				"Open any app and tap Share.",
				"Choose Maskin. If it is not in the row, scroll to the end, tap More and switch Maskin on.",
				"Pick the chat or flow it goes to. Offline, it waits and sends when the connection returns.",
			]),
		Surface(
			id: "siri", symbol: "mic", title: "Siri and Shortcuts",
			summary: "Ask, add an item, read decisions",
			steps: [
				"Say \u{201C}Hey Siri\u{201D} and ask Maskin: what needs me, add an item, or read the decisions.",
				"Every phrase also shows in the Shortcuts app under Maskin, where you can build it into your own shortcut.",
			]),
		Surface(
			id: "widgets", symbol: "square.grid.2x2", title: "Widgets",
			summary: "Home screen and lock screen",
			steps: [
				"Touch and hold the Home Screen, tap Edit, then Add Widget and choose Maskin.",
				"On the Lock Screen, touch and hold, tap Customize, then add a Maskin widget.",
			]),
		Surface(
			id: "tv", symbol: "appletv", title: "Apple TV",
			summary: "Wall display and briefing player",
			steps: [
				"Install Maskin on the Apple TV.",
				"The TV shows a short code. Open Settings > Sign in a device here and enter it to approve.",
			]),
	]

	private static let links: [Surface] = [
		Surface(
			id: "links", symbol: "link", title: "Deep links",
			summary: "maskin:// routes from notifications, widgets and Siri",
			steps: [
				"Tapping a notification, widget or Siri answer opens the exact chat, item or decision.",
				"A link someone sends you that starts with maskin:// opens the same place.",
			])
	]

	var body: some View {
		List {
			Section("Outside the app") {
				ForEach(Self.outside) { row($0) }
			}
			Section("Links") {
				ForEach(Self.links) { row($0) }
			}
		}
		.settingsListStyle()
		.navigationTitle("Native surfaces")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	private func row(_ surface: Surface) -> some View {
		NavigationLink {
			SurfaceInfoPage(title: surface.title, summary: surface.summary, steps: surface.steps)
		} label: {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Label(surface.title, systemImage: surface.symbol).foregroundStyle(MaskinColor.ink)
				Text(surface.summary).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
		}
	}
}

/// How to turn one native surface on.
private struct SurfaceInfoPage: View {
	let title: String
	let summary: String
	let steps: [String]

	var body: some View {
		List {
			Section {
				ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s6) {
						Text("\(index + 1)").maskinText(.subhead).fontWeight(.bold).foregroundStyle(MaskinColor.ink4)
							.frame(width: MaskinSpace.s10)
						Text(step).foregroundStyle(MaskinColor.ink)
					}
					.padding(.vertical, MaskinSpace.s2)
				}
			} header: {
				Text(summary)
			}
		}
		.settingsListStyle()
		.navigationTitle(title)
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
	}
}
