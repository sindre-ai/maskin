import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

/// A file viewer: header, content routed by type, and read-only review comments.
///
///     FileScreen(environment: env, fileId: id)
public struct FileScreen: View {
	@State private var store: FileStore

	public init(environment: AppEnvironment, fileId: String) {
		_store = State(
			initialValue: FileStore(fileId: fileId, remote: APIFilesRemote(client: environment.client)))
	}

	init(store: FileStore) {
		_store = State(initialValue: store)
	}

	public var body: some View {
		FileScreenBody(store: store)
			.background(MaskinSurface.grouped)
			.navigationTitle(store.file?.name ?? "File")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				if let file = store.file {
					ToolbarItem(placement: .primaryAction) {
						// The bytes are written only when the person actually shares.
						ShareLink(item: FileExport(file: file), preview: SharePreview(file.name)) {
							Label("Share", systemImage: "square.and.arrow.up")
						}
					}
				}
			}
			.onDisappear { FileStore.clearExports() }
			.task { await store.load() }
			.refreshable { await store.load() }
	}
}

/// Everything under the navigation chrome, so snapshots can render it without a stack.
struct FileScreenBody: View {
	let store: FileStore
	/// Snapshots render without the scroll view, which `ImageRenderer` can't draw.
	var scrolls = true
	@State private var showsSource = false

	var body: some View {
		switch store.phase {
		case .idle, .loading:
			LoadingSkeleton(rows: 6).padding(MaskinSpace.s9)
		case .failed(let message):
			EmptyState(
				symbol: store.isNotFound ? "questionmark.folder" : store.isOffline ? "wifi.slash" : "exclamationmark.triangle",
				title: store.isNotFound ? "File not found" : "Couldn't open this file", message: message
			) {
				if !store.isNotFound {
					Button("Try again") { Task { await store.load() } }
						.buttonStyle(SecondaryActionButtonStyle())
				}
			}
		case .loaded:
			if let file = store.file { loaded(file) }
		}
	}

	private func loaded(_ file: FileDetail) -> some View {
		let content = FileLoadedContent(
			file: file, showsSource: $showsSource, text: store.text, revision: store.contentRevision)
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 760, alignment: .leading)
			.frame(maxWidth: .infinity)
		return Group {
			if scrolls { ScrollView { content } } else { content }
		}
	}
}

/// A loaded file's header, content and review comments, without a scroll view (snapshot-friendly).
struct FileLoadedContent: View {
	let file: FileDetail
	@Binding var showsSource: Bool
	var text: String?
	var revision = 0

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			header(file)
			if file.kind == .markdown {
				Picker("View", selection: $showsSource) {
					Text("Rendered").tag(false)
					Text("Source").tag(true)
				}
				.pickerStyle(.segmented)
			}
			FileContentView(file: file, showsSource: showsSource, text: text, revision: revision)
			if !file.annotations.isEmpty { FileReviewComments(annotations: file.annotations) }
		}
	}

	private func header(_ file: FileDetail) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(file.name).maskinText(.title).foregroundStyle(MaskinColor.ink)
			HStack(spacing: MaskinSpace.s3) {
				MonoLabel(FileContentKind.label(forMime: file.mimeType))
				Text("·")
				Text(FileStore.sizeText(file.sizeBytes))
				if file.updatedAt != nil {
					Text("·")
					RelativeTime(file.updatedAt)
				}
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink4)
			if let description = file.description, !description.isEmpty {
				Text(description).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
		}
	}
}

/// Hands the file to the share sheet lazily: the temp file is created only if a share happens.
struct FileExport: Transferable {
	let file: FileDetail

	static var transferRepresentation: some TransferRepresentation {
		FileRepresentation(exportedContentType: .data) { export in
			SentTransferredFile(try FileExporter.write(export.file))
		}
	}
}
