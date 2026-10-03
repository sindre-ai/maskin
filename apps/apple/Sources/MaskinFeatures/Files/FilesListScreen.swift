import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

private struct FileRoute: Hashable { var id: String }

/// Browse the workspace's files, newest first, with search:
///
///     FilesListScreen(environment: env)
///     FilesListScreen(environment: env) { id in route(id) }   // shell presents the viewer itself
///
/// Without `open`, a tapped file pushes `FileScreen` inside this screen's own stack.
public struct FilesListScreen: View {
	private let environment: AppEnvironment
	private let open: ((String) -> Void)?
	private let onDone: (() -> Void)?

	/// `onDone` adds a Done button for when the screen is shown in a sheet.
	public init(
		environment: AppEnvironment, open: ((String) -> Void)? = nil, onDone: (() -> Void)? = nil
	) {
		self.environment = environment
		self.open = open
		self.onDone = onDone
	}

	public var body: some View {
		// Keyed on person and workspace so a switch rebuilds the store.
		FilesListContent(environment: environment, open: open, onDone: onDone)
			.id("\(environment.auth.session?.actorId ?? "")/\(environment.workspaceId ?? "")")
	}
}

private struct FilesListContent: View {
	@State private var store: FilesListStore
	@State private var search = ""
	private let environment: AppEnvironment
	private let open: ((String) -> Void)?
	private let onDone: (() -> Void)?

	init(environment: AppEnvironment, open: ((String) -> Void)?, onDone: (() -> Void)?) {
		self.environment = environment
		self.open = open
		self.onDone = onDone
		_store = State(
			initialValue: FilesListStore(
				remote: APIFilesRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider)))
	}

	var body: some View {
		NavigationStack {
			FilesListView(store: store, search: search, onOpen: open)
			.background(MaskinSurface.grouped)
			.navigationTitle("Files")
			.toolbar {
				if let onDone {
					ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
				}
			}
			.searchable(text: $search, prompt: "Search files")
			.navigationDestination(for: FileRoute.self) { FileScreen(environment: environment, fileId: $0.id) }
			.task { await store.load() }
			.refreshable { await store.load() }
			// Debounced: each keystroke restarts the wait, so only the pause hits the server.
			.task(id: search) {
				try? await Task.sleep(for: .milliseconds(250))
				guard !Task.isCancelled else { return }
				await store.setQuery(search)
			}
		}
	}
}

/// The list itself, without navigation chrome (snapshot-friendly).
struct FilesListView: View {
	let store: FilesListStore
	var search = ""
	/// When set the row calls it (the shell presents the viewer); otherwise the row pushes `FileScreen`.
	var onOpen: ((String) -> Void)?

	var body: some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 6).padding(MaskinSpace.s9)
		case .failed(let message):
			EmptyState(
				symbol: store.isOffline ? "wifi.slash" : "exclamationmark.triangle",
				title: "Couldn't load files", message: message
			) {
				Button("Try again") { Task { await store.load() } }
					.buttonStyle(SecondaryActionButtonStyle())
			}
		case .loaded:
			if store.files.isEmpty {
				EmptyState(
					symbol: "doc.on.doc",
					title: search.isEmpty ? "No files yet" : "No matching files",
					message: search.isEmpty ? "Files your agents and teammates add show up here." : "Try a different name.")
			} else {
				list
			}
		}
	}

	private var list: some View {
		ScrollView {
			LazyVStack(spacing: 0) {
				ForEach(store.files) { file in
					row(file)
						.task { await store.loadMoreIfNeeded(current: file) }
					if file.id != store.files.last?.id {
						Divider().overlay(MaskinSurface.separator).padding(.leading, MaskinSpace.s14 + MaskinSpace.s13)
					}
				}
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 760)
			.frame(maxWidth: .infinity)
		}
	}

	@ViewBuilder
	private func row(_ file: FileSummary) -> some View {
		let content = HStack(spacing: MaskinSpace.s8) {
			Image(systemName: FileKindIcon.symbol(for: file.kind))
				.font(.system(size: MaskinSpace.s11, weight: .regular))
				.foregroundStyle(MaskinColor.accentDeep)
				.frame(width: MaskinSpace.s14 + MaskinSpace.s4, height: MaskinSpace.s14 + MaskinSpace.s4)
				.background(MaskinColor.accentTint, in: RoundedRectangle(cornerRadius: MaskinRadius.cardLg, style: .continuous))
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(file.name).maskinText(.headline).foregroundStyle(MaskinColor.ink).lineLimit(1)
				HStack(spacing: MaskinSpace.s3) {
					Text(FileContentKind.label(forMime: file.mimeType))
					Text("·")
					Text(FileStore.sizeText(file.sizeBytes))
					if file.updatedAt != nil {
						Text("·")
						RelativeTime(file.updatedAt)
					}
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(1)
			}
			Spacer(minLength: 0)
			Image(systemName: "chevron.right")
				.font(.system(size: MaskinSpace.s7, weight: .semibold))
				.foregroundStyle(MaskinColor.ink5)
				.accessibilityHidden(true)
		}
		.padding(MaskinSpace.s9)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s7)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isButton)
		if let onOpen {
			Button { onOpen(file.id) } label: { content }.buttonStyle(.plain)
		} else {
			NavigationLink(value: FileRoute(id: file.id)) { content }.buttonStyle(.plain)
		}
	}
}

/// SF Symbol for each kind of file.
enum FileKindIcon {
	static func symbol(for kind: FileContentKind) -> String {
		switch kind {
		case .markdown: "doc.richtext"
		case .text: "doc.plaintext"
		case .source: "chevron.left.forwardslash.chevron.right"
		case .html: "globe"
		case .image: "photo"
		case .pdf: "doc.text"
		case .other: "doc"
		}
	}
}
