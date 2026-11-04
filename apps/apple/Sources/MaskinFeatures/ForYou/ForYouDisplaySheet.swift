import MaskinCore
import MaskinDesign
import SwiftUI

/// The For you Display sheet (handoff v3), one design with Items, Flows, Chats and Agents:
/// Layout and Sort by are saved settings only (no effect on the feed yet); the Filter bar and
/// Handled today rows change what the feed shows. Reset puts all four back.
struct ForYouDisplaySheet: View {
	let store: ForYouStore

	var body: some View {
		@Bindable var store = store
		DisplaySheet(canReset: !store.options.isDefaultDisplay, onReset: { store.options.resetDisplay() }) {
			DisplaySection(title: nil, showsDivider: false) {
				DisplayChoice(
					label: "Layout",
					options: [(ForYouDisplayOptions.Mode.cards, "Cards"), (.list, "List")],
					selection: $store.options.mode)
			}
			DisplaySection(title: "Ordering") {
				DisplayChoice(
					label: "Sort by",
					options: [(ForYouDisplayOptions.Sort.attention, "Attention"), (.latest, "Latest")],
					selection: $store.options.sort)
			}
			DisplaySection(title: "Filters") {
				DisplayChoice(
					label: "Filter bar",
					options: [(false, "Hidden"), (true, "Shown")],
					selection: Binding(
						get: { store.options.filterBarOn },
						set: { on in
							store.options.filterBarOn = on
							if !on { store.options.intent = nil }
						}))
			}
			DisplaySection(title: "Show") {
				DisplayChoice(
					label: "Handled today",
					options: [(true, "Show"), (false, "Hide")],
					selection: $store.options.showsHandled)
			}
		}
	}
}
