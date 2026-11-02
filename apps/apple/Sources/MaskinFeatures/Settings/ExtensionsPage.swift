import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// MARK: Model

/// One custom extension as Settings shows it. The signing secret is never part of it: the API
/// only says whether one is set.
struct ExtensionSummary: Identifiable, Hashable, Sendable {
	enum Status: String, Sendable { case active, disabled, draft }

	var id: String
	var name: String
	var status: Status
	var webhookURL: String?
	var hasSigningSecret: Bool
	var toolGrantCount: Int
	var lastError: String?
	var lastDeliveryAt: Date?
	var committedDeliveries: Int

	var state: PageState {
		switch status {
		case .active: PageState("On", .active)
		case .disabled: PageState("Off", .muted)
		case .draft: PageState("Draft", .notice)
		}
	}

	static func parse(_ row: [String: Any]) -> ExtensionSummary? {
		guard let id = row["id"] as? String, let name = row["name"] as? String else { return nil }
		let grants = row["toolGrants"] as? [String: Any]
		return ExtensionSummary(
			id: id, name: name, status: Status(rawValue: row["status"] as? String ?? "") ?? .draft,
			webhookURL: row["webhookUrl"] as? String,
			hasSigningSecret: row["hasSigningSecret"] as? Bool ?? false,
			toolGrantCount: grants?.count ?? 0, lastError: row["mcpLastError"] as? String,
			lastDeliveryAt: SettingsHTTP.date(row["lastDeliveryAt"]),
			committedDeliveries: row["committedDeliveries"] as? Int ?? 0)
	}

	static func parseList(_ json: Any?) -> [ExtensionSummary] {
		let rows = json as? [[String: Any]] ?? []
		return rows.compactMap(parse)
			.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
	}
}

struct ExtensionDelivery: Identifiable, Equatable, Sendable {
	var id: String
	var receivedAt: Date?
}

struct ExtensionDeliveries: Equatable, Sendable {
	var windowDays: Int
	var committed: Int
	var recent: [ExtensionDelivery]

	static func parse(_ json: Any?) -> ExtensionDeliveries? {
		guard let root = json as? [String: Any] else { return nil }
		let rows = (root["deliveries"] as? [[String: Any]] ?? []).compactMap { row -> ExtensionDelivery? in
			guard let id = row["id"] as? String else { return nil }
			return ExtensionDelivery(id: id, receivedAt: SettingsHTTP.date(row["receivedAt"]))
		}
		return ExtensionDeliveries(
			windowDays: root["windowDays"] as? Int ?? 14, committed: root["committed"] as? Int ?? rows.count,
			recent: rows.sorted { ($0.receivedAt ?? .distantPast) > ($1.receivedAt ?? .distantPast) })
	}
}

// MARK: Store

protocol ExtensionsAPI: Sendable {
	func list() async throws -> [ExtensionSummary]
	func deliveries(id: String) async throws -> ExtensionDeliveries
}

struct HTTPExtensionsSource: ExtensionsAPI {
	let http: SettingsHTTP

	func list() async throws -> [ExtensionSummary] {
		let reply = try await http.send("GET", "api/extensions")
		guard reply.ok else { throw SettingsError("Couldn't load extensions.") }
		return ExtensionSummary.parseList(reply.json)
	}

	func deliveries(id: String) async throws -> ExtensionDeliveries {
		let reply = try await http.send("GET", "api/extensions/\(id)/deliveries")
		guard reply.ok, let parsed = ExtensionDeliveries.parse(reply.json) else {
			throw SettingsError("Couldn't load deliveries.")
		}
		return parsed
	}
}

@MainActor
@Observable
final class ExtensionsStore {
	enum Phase: Equatable { case idle, loading, loaded, failed(String) }

	private(set) var extensions: [ExtensionSummary] = []
	private(set) var phase: Phase = .idle
	private(set) var deliveries: [String: ExtensionDeliveries] = [:]
	private(set) var deliveriesFailed: Set<String> = []
	@ObservationIgnored private let api: any ExtensionsAPI

	init(api: any ExtensionsAPI) { self.api = api }

	func load() async {
		if extensions.isEmpty { phase = .loading }
		do {
			extensions = try await api.list()
			phase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load extensions."
			if extensions.isEmpty { phase = .failed(message) }
		}
	}

	func loadDeliveries(id: String) async {
		do {
			deliveries[id] = try await api.deliveries(id: id)
			deliveriesFailed.remove(id)
		} catch {
			deliveriesFailed.insert(id)
		}
	}

	func summary(id: String) -> ExtensionSummary? { extensions.first { $0.id == id } }
}

// MARK: Views

/// Extensions (2h list): every custom extension with On / Off / Draft. A row opens its detail.
struct ExtensionsPage: View {
	@State private var store: ExtensionsStore
	let webURL: URL?
	@Environment(\.openURL) private var openURL
	@State private var detail: ExtensionSummary?

	init(store: ExtensionsStore, webURL: URL?) {
		_store = State(initialValue: store)
		self.webURL = webURL
	}

	var body: some View {
		WorkspacePage(title: "Extensions") {
			if store.extensions.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "No extensions yet.")
				default: PageStatus(text: "Loading extensions")
				}
			} else {
				PageCard(
					rows: store.extensions.map { ext in
						PageRowModel(
							id: ext.id, title: ext.name, subtitle: Self.subtitle(ext), accessory: .state(ext.state),
							showsChevron: true, action: { detail = ext })
					})
			}
			PageFootnote(text: "Extensions add triggers, properties and tools to this workspace.")
			if let webURL {
				Button("Add or change on web") { openURL(webURL) }.buttonStyle(.secondaryAction)
			}
		}
		.navigationDestination(item: $detail) { ext in
			ExtensionDetailPage(store: store, extensionID: ext.id, webURL: webURL)
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}

	static func subtitle(_ ext: ExtensionSummary) -> String {
		guard let last = ext.lastDeliveryAt else { return "No deliveries yet" }
		return "Last delivery \(last.formatted(.relative(presentation: .named)))"
	}
}

/// Extension detail (2h): status, webhook endpoint, secret and delivery history. The secret is
/// never sent to the app, so there is no Reveal; the page says whether one is set.
struct ExtensionDetailPage: View {
	let store: ExtensionsStore
	let extensionID: String
	let webURL: URL?
	@Environment(\.openURL) private var openURL
	@State private var copied = false

	var body: some View {
		if let ext = store.summary(id: extensionID) {
			WorkspacePage(title: ext.name) {
				PageGroupLabel(text: "Status")
				PageCard(rows: statusRows(ext))
				PageGroupLabel(text: "Webhook")
				PageCard(rows: webhookRows(ext))
				if ext.hasSigningSecret {
					PageFootnote(text: "Deliveries are signed. The secret is only shown when it is made; make a new one on the web.")
				}
				PageGroupLabel(text: "Deliveries")
				PageCard(rows: deliveryRows(ext))
				if let webURL {
					Button("Manage on web") { openURL(webURL) }.buttonStyle(.secondaryAction)
				}
			}
			.task { await store.loadDeliveries(id: extensionID) }
			.refreshable { await store.loadDeliveries(id: extensionID) }
		} else {
			PageStatus(text: "This extension is gone.")
		}
	}

	private func statusRows(_ ext: ExtensionSummary) -> [PageRowModel] {
		var rows = [
			PageRowModel(
				id: "status", title: "Status",
				subtitle: ext.toolGrantCount == 0
					? "No tools shared with agents"
					: "\(ext.toolGrantCount) \(ext.toolGrantCount == 1 ? "tool" : "tools") shared with agents",
				accessory: .state(ext.state))
		]
		if let error = ext.lastError, !error.isEmpty {
			rows.append(
				PageRowModel(
					id: "error", title: "Last problem", subtitle: error,
					accessory: .state(PageState("Needs a look", .notice))))
		}
		return rows
	}

	private func webhookRows(_ ext: ExtensionSummary) -> [PageRowModel] {
		var rows: [PageRowModel] = []
		if let url = ext.webhookURL {
			rows.append(
				PageRowModel(
					id: "endpoint", title: "Endpoint", subtitle: url, subtitleIsMono: true,
					accessory: .state(PageState(copied ? "Copied" : "Copy", .plain)),
					action: { copied = PlainPasteboard.copy(url) }))
		} else {
			rows.append(
				PageRowModel(id: "endpoint", title: "Endpoint", subtitle: "This extension has no webhook."))
		}
		rows.append(
			PageRowModel(
				id: "secret", title: "Secret",
				subtitle: ext.hasSigningSecret ? "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}" : nil,
				accessory: .state(ext.hasSigningSecret ? PageState("Set", .active) : PageState("Not set", .muted))))
		return rows
	}

	private func deliveryRows(_ ext: ExtensionSummary) -> [PageRowModel] {
		guard let deliveries = store.deliveries[extensionID] else {
			return [
				PageRowModel(
					id: "deliveries", title: "Last 14 days",
					subtitle: store.deliveriesFailed.contains(extensionID)
						? "Couldn't load deliveries" : "Loading",
					accessory: .state(PageState("\(ext.committedDeliveries) processed", .plain)))
			]
		}
		var rows = [
			PageRowModel(
				id: "deliveries", title: "Last \(deliveries.windowDays) days",
				accessory: .state(PageState("\(deliveries.committed) processed", .plain)))
		]
		for delivery in deliveries.recent.prefix(5) {
			rows.append(
				PageRowModel(
					id: delivery.id, title: "Delivered",
					subtitle: delivery.receivedAt?.formatted(date: .abbreviated, time: .shortened),
					accessory: .state(PageState("Processed", .active))))
		}
		return rows
	}
}
