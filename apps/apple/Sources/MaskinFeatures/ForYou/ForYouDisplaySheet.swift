import MaskinCore
import MaskinDesign
import SwiftUI

/// The For you Display sheet (handoff v3), one design with Items, Flows, Chats and Agents:
/// Cards sets how the rows start (compact or expanded); the Filter bar row shows or hides the
/// intent pills. Reset puts both back.
struct ForYouDisplaySheet: View {
	let store: ForYouStore

	var body: some View {
		@Bindable var store = store
		DisplaySheet(canReset: !store.options.isDefaultDisplay, onReset: { store.options.resetDisplay() }) {
			DisplaySection(title: nil, showsDivider: false) {
				DisplayChoice(
					label: "Cards",
					options: [(ForYouDisplayOptions.Opening.compact, "Compact"), (.expanded, "Expanded")],
					selection: $store.options.opening)
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
		}
	}
}
