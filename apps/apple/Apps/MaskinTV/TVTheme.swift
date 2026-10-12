import MaskinDesign
import SwiftUI

/// The dark page with a Patina glow in the top-left corner that every TV screen sits on.
struct TVBackdrop: View {
	var body: some View {
		ZStack {
			Color.black
			RadialGradient(
				colors: [MaskinColor.patina800.opacity(0.85), MaskinColor.patina900.opacity(0.35), .clear],
				center: .topLeading, startRadius: 0, endRadius: 1100)
		}
		.ignoresSafeArea()
	}
}

/// The top bar: the Maskin mark, the four tabs with their counts, then Search and the profile.
struct TVTopBar<Tab: Hashable>: View {
	struct Item: Identifiable {
		let tab: Tab
		let title: String
		var count = 0
		var id: String { title }
	}

	let items: [Item]
	@Binding var selection: Tab
	let search: Tab
	let profile: Tab
	let initials: String

	var body: some View {
		HStack(spacing: 12) {
			Image("LaunchMark")
				.resizable().scaledToFit().padding(14)
				.frame(width: 56, height: 56)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
				.padding(.trailing, 20)
				.accessibilityHidden(true)
			ForEach(items) { item in
				Button { selection = item.tab } label: { TVTabLabel(item: item, selected: selection == item.tab) }
					.buttonStyle(TVBarButtonStyle())
			}
			Spacer(minLength: 0)
			Button { selection = search } label: {
				Image(systemName: "magnifyingglass").font(.system(size: 30, weight: .semibold))
					.frame(width: 72, height: 72)
					.background(MaskinSurface.card, in: Circle())
			}
			.buttonStyle(TVBarButtonStyle())
			.accessibilityLabel("Search")
			Button { selection = profile } label: {
				Text(initials).font(.system(size: 28, weight: .bold)).foregroundStyle(MaskinColor.avFg)
					.frame(width: 72, height: 72)
					.background(MaskinGradient.avatar, in: Circle())
			}
			.buttonStyle(TVBarButtonStyle())
			.accessibilityLabel("Profile")
		}
		.foregroundStyle(MaskinColor.ink)
		.padding(.horizontal, 96)
		.padding(.top, 56)
		.focusSection()
	}
}

private struct TVTabLabel<Tab: Hashable>: View {
	let item: TVTopBar<Tab>.Item
	let selected: Bool

	var body: some View {
		HStack(spacing: 14) {
			Text(item.title).font(.system(size: 34, weight: selected ? .bold : .regular))
			if item.count > 0 {
				Text("\(item.count)").font(.system(size: 24, weight: .bold))
					.foregroundStyle(MaskinColor.badgeFg)
					.frame(minWidth: 40, minHeight: 40)
					.background(MaskinGradient.badge, in: Circle())
			}
		}
		.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
		.padding(.horizontal, 30).frame(height: 64)
		.background(selected ? MaskinSurface.fillStrong : .clear, in: Capsule())
	}
}

/// Bar controls lift on focus (no ring): scale and a deep shadow, like the rest of the TV app.
private struct TVBarButtonStyle: ButtonStyle {
	@Environment(\.isFocused) private var isFocused
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.scaleEffect(isFocused && !reduceMotion ? 1.08 : 1)
			.shadow(color: .black.opacity(isFocused ? 0.5 : 0), radius: 24, y: 16)
			.opacity(configuration.isPressed ? 0.85 : 1)
			.animation(reduceMotion ? nil : .timingCurve(0.32, 0.72, 0, 1, duration: 0.3), value: isFocused)
	}
}
