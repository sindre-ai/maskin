import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct SkillsView: View {
	@State private var store: SkillsStore

	init(store: SkillsStore) { _store = State(initialValue: store) }

	var body: some View {
		List {
			ForEach(store.skills) { SkillRow(skill: $0) }
		}
		.overlay {
			switch store.phase {
			case .loading: ProgressView()
			case .failed(let message):
				ContentUnavailableView(
					"Couldn't load skills", systemImage: "wifi.exclamationmark",
					description: Text(message))
			case .loaded where store.skills.isEmpty:
				ContentUnavailableView(
					"No skills yet", systemImage: "wand.and.stars",
					description: Text("Skills you add on the web show up here."))
			default: EmptyView()
			}
		}
		.navigationTitle("Skills")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.load() }
		.refreshable { await store.load() }
	}
}
