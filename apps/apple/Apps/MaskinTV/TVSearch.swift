import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Search, voice first: the system search field takes dictation from the Siri Remote mic. Results
/// are grouped by kind and read only; opening one is for the phone.
struct TVSearch: View {
	let environment: AppEnvironment
	@State private var store: SearchStore?
	@State private var text = ""

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 32) {
					if let store {
						results(store)
					} else {
						ProgressView().frame(maxWidth: .infinity, minHeight: 300)
					}
				}
				.padding(.horizontal, 96)
				.padding(.top, 24)
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.navigationTitle("Search")
		}
		.searchable(text: $text, prompt: "Hold the mic and speak")
		.onChange(of: text) { _, new in store?.setQuery(new) }
		.task(id: environment.workspaceId) {
			guard environment.auth.session != nil else {
				store = nil
				return
			}
			let auth = environment.auth
			store = SearchStore(
				remote: APISearchRemote(client: environment.client, credentials: auth.credentialsProvider),
				recents: SearchRecents(actorId: auth.session?.actorId ?? ""),
				workspaceId: { auth.session?.workspaceId })
		}
	}

	@ViewBuilder private func results(_ store: SearchStore) -> some View {
		if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			if store.recents.isEmpty {
				EmptyState(symbol: "mic", title: "Say what you're looking for", message: "Hold the mic on the remote.")
			} else {
				Text("RECENT").font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				ForEach(store.recents, id: \.self) { recent in
					Button { text = recent } label: { TVSearchRow(title: recent, subtitle: "", symbol: "clock") }
						.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
				}
			}
		} else if store.sections.isEmpty, store.phase != .searching {
			EmptyState(symbol: "magnifyingglass", title: "Nothing matches that yet")
		} else {
			ForEach(store.sections) { section in
				Text(section.group.title.uppercased())
					.font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				ForEach(section.results) { result in
					TVSearchRow(title: result.title, subtitle: result.subtitle, symbol: symbol(for: result.kind))
						.focusable()
				}
			}
		}
	}

	private func symbol(for kind: SearchKind) -> String {
		switch kind {
		case .object: "square.stack.3d.up"
		case .chat: "bubble.left"
		case .agent: "person.2"
		case .file: "doc.text"
		}
	}
}

private struct TVSearchRow: View {
	let title: String
	let subtitle: String
	let symbol: String

	var body: some View {
		HStack(spacing: 24) {
			Image(systemName: symbol).font(.system(size: 30)).frame(width: 48)
			Text(title).font(.system(size: 32, weight: .semibold)).lineLimit(1)
			if !subtitle.isEmpty {
				Text(subtitle).font(.system(size: 26)).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.padding(.horizontal, 32)
		.frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
	}
}
