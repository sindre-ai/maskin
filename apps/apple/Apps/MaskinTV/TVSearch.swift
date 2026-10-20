import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Search, voice first: the system search field takes dictation from the Siri Remote mic. Results
/// are grouped by kind; Team rooms, Flows and Objects open their detail, the rest are listed only.
struct TVSearch: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	let loops: LoopsStore?
	@State private var store: SearchStore?
	@State private var text = ""

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 32) {
					searchField
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
			.navigationDestination(for: TVSearchRoute.self) { route in
				switch route {
				case .chat(let id):
					TVThread(environment: environment, conversationID: id)
				case .flow(let id):
					if let loops, let flow = loops.loop(id: id) {
						TVFlowDetail(environment: environment, flow: flow, directory: loops.directory)
					} else {
						EmptyState(symbol: "arrow.triangle.2.circlepath", title: "That flow isn't available")
					}
				case .object(let id):
					TVSearchObjectDetail(environment: environment, forYou: forYou, id: id)
				}
			}
		}
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

	/// The voice-first field: 112 pt tall, a mic glyph, and the prompt. Selecting it opens the tvOS
	/// entry sheet, whose mic button on the Siri Remote dictates into it.
	private var searchField: some View {
		HStack(spacing: 28) {
			Image(systemName: "mic.fill").font(.system(size: 44, weight: .semibold))
				.foregroundStyle(MaskinColor.ink3)
				.accessibilityHidden(true)
			TextField("Hold the mic and speak", text: $text)
				.font(.system(size: 44, weight: .semibold))
				.submitLabel(.search)
		}
		.padding(.horizontal, 44)
		.frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
		.background(MaskinSurface.card, in: Capsule())
	}

	@ViewBuilder private func results(_ store: SearchStore) -> some View {
		if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			chips
			if store.recents.isEmpty {
				EmptyState(symbol: "mic", title: "Say what you're looking for", message: "Press and hold the mic button on your remote and ask. No typing needed.")
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
			if let understood = TVSearchGuide.understoodAs(query: text, sections: store.sections) {
				VStack(alignment: .leading, spacing: 10) {
					Text("UNDERSTOOD AS")
						.font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
					Text(understood).font(.system(size: 34, weight: .semibold))
				}
				.padding(36).frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
			}
			ForEach(store.sections) { section in
				Text(section.group.title.uppercased())
					.font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				ForEach(section.results) { result in
					if let route = route(for: result) {
						NavigationLink(value: route) {
							TVSearchRow(title: result.title, subtitle: result.subtitle, symbol: symbol(for: result.kind))
						}
						.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
					} else {
						TVSearchRow(title: result.title, subtitle: result.subtitle, symbol: symbol(for: result.kind))
							.focusable()
					}
				}
			}
		}
	}

	/// Suggestions to pick with the remote: the spoken or chosen query fills the field.
	private var chips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: 16) {
				ForEach(TVSearchGuide.suggestions, id: \.self) { suggestion in
					Button { text = suggestion } label: { TVCapsuleLabel(title: suggestion, slim: true) }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 36))
				}
			}
			.padding(.vertical, 12)
		}
		.scrollClipDisabled()
	}

	private func route(for result: SearchResult) -> TVSearchRoute? {
		switch result.group {
		case .team: .chat(result.entityId)
		case .flows: .flow(result.entityId)
		case .objects: .object(result.entityId)
		case .agents, .files: nil
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

/// Where a selectable search result goes.
private enum TVSearchRoute: Hashable {
	case chat(String), flow(String), object(String)
}

/// An object opened from Search: fetches it (with the workspace's type names) and shows the same
/// read-only detail the Objects tab does.
private struct TVSearchObjectDetail: View {
	let environment: AppEnvironment
	let forYou: ForYouRuntime?
	let id: String
	@State private var loaded: (object: WorkObject, schema: ObjectsSchema?)?
	@State private var failed = false

	var body: some View {
		Group {
			if let loaded {
				TVObjectDetail(environment: environment, forYou: forYou, object: loaded.object, schema: loaded.schema)
			} else if failed {
				EmptyState(symbol: "square.stack.3d.up", title: "Couldn't open that object")
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.task(id: id) {
			let remote = APIObjectsRemote(
				client: environment.client, credentials: environment.auth.credentialsProvider)
			do {
				let graph = try await remote.graph(objectId: id)
				var schema: ObjectsSchema?
				if let workspace = environment.workspaceId { schema = try? await remote.schema(workspaceId: workspace) }
				loaded = (graph.object, schema)
			} catch {
				failed = true
			}
		}
	}
}
