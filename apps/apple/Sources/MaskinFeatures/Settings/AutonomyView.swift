import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Autonomy (2E): how far the Chief of Staff goes before asking. Three levels, a fixed list of
/// rules that always ask, and a line saying what a change means. Pushed onto the profile sheet.
struct AutonomyView: View {
	@State private var store: AutonomyStore

	init(store: AutonomyStore) { _store = State(initialValue: store) }

	var body: some View {
		WorkspacePage(title: "Autonomy") {
			Text("How far the Chief of Staff can go before asking you.")
				.maskinText(.body).foregroundStyle(MaskinColor.ink3)
				.padding(.horizontal, MaskinSpace.s2)
			PageCard(
				rows: AutonomyLevel.allCases.map { level in
					PageRowModel(
						id: level.id, title: level.title, subtitle: level.summary,
						accessory: store.level == level ? .check : .none,
						action: {
							MaskinHaptics.play(.selection)
							withAnimation(MaskinMotion.quick) { store.select(level) }
						})
				})
			if let line = store.changeLine {
				PageFootnote(text: line)
					.foregroundStyle(MaskinColor.ink2)
					.transition(.opacity)
			}
			PageGroupLabel(text: "Always ask, regardless")
			PageCard(
				rows: AutonomyAlwaysAsk.allCases.map {
					PageRowModel(id: $0.id, title: $0.title, accessory: .state(PageState("On", .plain)))
				})
			PageFootnote(
				text:
					"Per user, per workspace, saved on this device. The three \u{201C}always ask\u{201D} rules cannot be turned off below Routine only."
			)
		}
		.accessibilityElement(children: .contain)
	}
}
