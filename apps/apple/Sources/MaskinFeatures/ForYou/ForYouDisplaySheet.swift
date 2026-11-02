import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The For you Display sheet (the sliders button in the top bar): Layout, Sort by, Filter bar and
/// Handled today. Every choice is a saved setting on `ForYouDisplayOptions`; layout and sort are
/// stored and read back but do not change the feed yet (the handoff leaves their effect undesigned).
struct ForYouDisplaySheet: View {
	@Bindable var store: ForYouStore
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section("Layout") {
					segmented("Layout", selection: $store.options.mode) { mode in
						mode == .cards ? "Cards" : "List"
					}
				}
				Section("Ordering") {
					segmented("Sort by", selection: $store.options.sort) { sort in
						sort == .attention ? "Attention" : "Latest"
					}
				}
				Section("Filters") {
					segmented("Filter bar", selection: $store.options.filterBarOn) { $0 ? "Shown" : "Hidden" }
				}
				Section("Show") {
					segmented("Handled today", selection: $store.options.showsHandled) { $0 ? "Show" : "Hide" }
				}
			}
			.scrollContentBackground(.hidden)
			.ambientBackground()
			.navigationTitle("Display")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
		}
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}

	/// One labelled row of a segmented control. Cases come from the value's own type so a new
	/// option shows up here without another edit.
	@ViewBuilder
	private func segmented<Value: Hashable & CaseIterable>(
		_ title: String, selection: Binding<Value>, label: @escaping (Value) -> String
	) -> some View where Value.AllCases: RandomAccessCollection {
		Picker(title, selection: selection) {
			ForEach(Array(Value.allCases), id: \.self) { Text(label($0)).tag($0) }
		}
		.pickerStyle(.segmented)
		.accessibilityLabel(title)
	}

	@ViewBuilder
	private func segmented(
		_ title: String, selection: Binding<Bool>, label: @escaping (Bool) -> String
	) -> some View {
		Picker(title, selection: selection) {
			Text(label(false)).tag(false)
			Text(label(true)).tag(true)
		}
		.pickerStyle(.segmented)
		.accessibilityLabel(title)
	}
}
