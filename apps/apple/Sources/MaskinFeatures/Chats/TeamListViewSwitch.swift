import MaskinCore
import SwiftUI

/// The Agents / Recent switch under the Chats title: one row per agent with its chats folded
/// under it, or the list by date. The choice is part of the Display options, so it is remembered
/// per person.
struct TeamListViewSwitch: View {
	@Binding var selection: TeamDisplayOptions.ListView

	var body: some View {
		Picker("Chat list view", selection: $selection) {
			ForEach(TeamDisplayOptions.ListView.allCases, id: \.self) { view in
				Text(view.label).tag(view)
			}
		}
		.pickerStyle(.segmented)
		.labelsHidden()
	}
}
