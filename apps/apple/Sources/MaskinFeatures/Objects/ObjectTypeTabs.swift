import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One pill in the type tab row.
struct ObjectTypeTab: Identifiable, Equatable {
	var scope: ObjectsScope
	var label: String
	/// Shown after the label; `nil` hides it.
	var count: String?
	/// The count is a signal (Needs you), so it reads in Patina when the tab is inactive.
	var isSignal = false

	var id: ObjectsScope { scope }

	/// Needs you · All · Favourites (when any) · one tab per type present, from the store.
	@MainActor
	static func tabs(for store: ObjectsStore) -> [ObjectTypeTab] {
		var tabs = [
			ObjectTypeTab(
				scope: .needsYou, label: "Needs you",
				count: store.needsYouCount > 0 ? "\(store.needsYouCount)" : nil, isSignal: true),
			ObjectTypeTab(scope: .all, label: "All", count: nil),
		]
		// Starred objects get their own tab once there are any, so they are one tap away.
		if store.favouritesCount > 0 || store.scope == .favourites {
			tabs.append(ObjectTypeTab(scope: .favourites, label: "Favourites", count: "\(store.favouritesCount)"))
		}
		tabs += store.typeSummaries.filter { $0.count > 0 || store.typeFilter == $0.id }.map {
			ObjectTypeTab(scope: .type($0.id), label: $0.label, count: $0.count > 0 ? $0.countLabel : nil)
		}
		return tabs
	}
}

/// The horizontal tab row under the title. The active tab is an ink pill and scrolls to the
/// centre when chosen.
struct ObjectTypeTabs: View {
	let tabs: [ObjectTypeTab]
	let selected: ObjectsScope
	var onSelect: (ObjectsScope) -> Void

	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: MaskinSpace.s1) {
					ForEach(tabs) { tab in
						pill(tab)
							.id(tab.id)
					}
				}
				.padding(.horizontal, MaskinSpace.s8)
			}
			.onChange(of: selected, initial: true) { _, scope in
				guard tabs.contains(where: { $0.scope == scope }) else { return }
				if reduceMotion {
					proxy.scrollTo(scope, anchor: .center)
				} else {
					withAnimation(reduceMotion ? nil : MaskinMotion.standard) { proxy.scrollTo(scope, anchor: .center) }
				}
			}
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Object types")
	}

	private func pill(_ tab: ObjectTypeTab) -> some View {
		let active = tab.scope == selected
		return Button {
			MaskinHaptics.play(.selection)
			onSelect(tab.scope)
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(tab.label)
					.maskinText(.subhead)
					.fontWeight(.semibold)
				if let count = tab.count {
					Text(count)
						.maskinText(.caption)
						.fontWeight(.bold)
						.monospacedDigit()
						.foregroundStyle(
							active ? MaskinSurface.onInverse : (tab.isSignal ? MaskinColor.sigInk : MaskinColor.ink5))
				}
			}
			.foregroundStyle(active ? MaskinSurface.onInverse : MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s7 + 1)
			.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
			.background(active ? MaskinSurface.inverse : Color.clear, in: Capsule())
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(tab.count.map { "\(tab.label), \($0)" } ?? tab.label)
		.accessibilityAddTraits(active ? [.isSelected] : [])
	}
}
