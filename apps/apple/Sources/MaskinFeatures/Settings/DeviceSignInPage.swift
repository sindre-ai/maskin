import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// MARK: Store

struct DevicePreview: Equatable, Sendable {
	var deviceName: String?
	var createdAt: Date?
}

protocol DeviceApprovalAPI: Sendable {
	func preview(code: String) async throws -> DevicePreview
	func approve(code: String) async throws
	func deny(code: String) async throws
}

struct HTTPDeviceApprovalSource: DeviceApprovalAPI {
	let http: SettingsHTTP

	func preview(code: String) async throws -> DevicePreview {
		let reply = try await http.send(
			"GET", "api/device-auth/preview", query: [.init(name: "user_code", value: code)])
		guard reply.ok, let row = reply.json as? [String: Any] else { throw Self.failure(reply.status) }
		return DevicePreview(
			deviceName: row["device_name"] as? String, createdAt: SettingsHTTP.date(row["created_at"]))
	}

	func approve(code: String) async throws { try await post("api/device-auth/approve", code) }
	func deny(code: String) async throws { try await post("api/device-auth/deny", code) }

	private func post(_ path: String, _ code: String) async throws {
		let reply = try await http.send("POST", path, body: ["user_code": code])
		guard reply.ok else { throw Self.failure(reply.status) }
	}

	static func failure(_ status: Int) -> SettingsError {
		switch status {
		case 404, 410: SettingsError("That code isn't valid, or it has expired. Check your device for a new one.")
		case 429: SettingsError("Too many tries. Wait a minute and try again.")
		case 403: SettingsError("Only a person can approve a device.")
		default: SettingsError("Couldn't reach the sign-in. Try again.")
		}
	}
}

@MainActor
@Observable
final class DeviceApprovalStore {
	enum Phase: Equatable {
		case enterCode, checking
		case confirm(DevicePreview)
		case working
		case approved, refused
	}

	private(set) var codeText: String
	private(set) var phase: Phase = .enterCode
	private(set) var error: String?
	@ObservationIgnored private let api: any DeviceApprovalAPI

	init(api: any DeviceApprovalAPI, initialCode: String? = nil) {
		self.api = api
		self.codeText = initialCode.map(Self.normalize) ?? ""
	}

	/// "bcdf2345" and "BCDF-2345" both become "BCDF-2345"; at most eight characters are kept.
	static func normalize(_ raw: String) -> String {
		let chars = raw.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(8)
		guard chars.count > 4 else { return String(chars) }
		return "\(chars.prefix(4))-\(chars.dropFirst(4))"
	}

	var isCodeComplete: Bool { codeText.filter { $0 != "-" }.count == 8 }

	func setCode(_ raw: String) {
		let normalized = Self.normalize(raw)
		if normalized != codeText { codeText = normalized }
	}

	func check() async {
		guard isCodeComplete, phase == .enterCode else { return }
		phase = .checking
		error = nil
		do {
			phase = .confirm(try await api.preview(code: codeText))
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't check the code."
			phase = .enterCode
		}
	}

	func approve() async { await finish(.approved) { try await self.api.approve(code: self.codeText) } }
	func deny() async { await finish(.refused) { try await self.api.deny(code: self.codeText) } }

	private func finish(_ result: Phase, _ call: () async throws -> Void) async {
		guard case .confirm(let preview) = phase else { return }
		phase = .working
		error = nil
		do {
			try await call()
			phase = result
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't finish. Try again."
			phase = .confirm(preview)
		}
	}
}

// MARK: View

/// Sign in a device (2n): type the code the TV or Mac shows, check who is asking, approve or
/// refuse. Opened from Settings, or straight onto the confirm step from `maskin://connect`.
struct DeviceSignInPage: View {
	@State private var store: DeviceApprovalStore
	let account: String?
	let workspaceName: String?
	@Environment(\.dismiss) private var dismiss
	@FocusState private var focused: Bool

	init(store: DeviceApprovalStore, account: String?, workspaceName: String?) {
		_store = State(initialValue: store)
		self.account = account
		self.workspaceName = workspaceName
	}

	var body: some View {
		WorkspacePage(title: title) {
			switch store.phase {
			case .enterCode, .checking: codeEntry
			case .confirm(let preview): confirm(preview, busy: false)
			case .working: confirm(DevicePreview(), busy: true)
			case .approved:
				result("Your device is signing in.", "You can close this. It takes a few seconds on the device.")
			case .refused: result("Sign-in refused.", "Nothing was signed in.")
			}
			if let error = store.error { FormError(error) }
		}
		.task {
			if store.isCodeComplete { await store.check() } else { focused = true }
		}
	}

	private var title: String {
		switch store.phase {
		case .confirm(let p): "Sign in \(p.deviceName ?? "a device")?"
		case .approved: "Approved"
		case .refused: "Refused"
		default: "Sign in a device"
		}
	}

	private var codeEntry: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			PageGroupLabel(text: "Code")
			TextField("XXXX-XXXX", text: Binding(get: { store.codeText }, set: { store.setCode($0) }))
				.font(MaskinTypeface.mono(MaskinFontSize.t20, relativeTo: .title3))
				#if os(iOS)
					.textInputAutocapitalization(.characters)
				#endif
				.autocorrectionDisabled()
				.focused($focused)
				.submitLabel(.go)
				.onSubmit { Task { await store.check() } }
				.padding(.horizontal, MaskinSpace.s9)
				.frame(minHeight: MaskinSpace.touchMin)
				.background(
					MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
			PageFootnote(text: "Open Maskin on your Apple TV or Mac. It shows a code to type here.")
			Button(store.phase == .checking ? "Checking" : "Continue") { Task { await store.check() } }
				.buttonStyle(.primaryAction)
				.disabled(!store.isCodeComplete || store.phase == .checking)
		}
	}

	private func confirm(_ preview: DevicePreview, busy: Bool) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			PageGroupLabel(text: "It will use your account")
			PageCard(rows: [
				PageRowModel(id: "account", title: account ?? "Your account", subtitle: workspaceName),
				PageRowModel(
					id: "code", title: "Code on your device", subtitle: store.codeText, subtitleIsMono: true,
					accessory: preview.createdAt.map {
						.state(PageState($0.formatted(date: .omitted, time: .shortened), .plain))
					} ?? .none),
			])
			PageFootnote(text: "Only approve if the code on your device is \(store.codeText).")
			Button("Approve") { Task { await store.approve() } }
				.buttonStyle(.primaryAction).disabled(busy)
			Button("This isn't me") { Task { await store.deny() } }
				.buttonStyle(.secondaryAction).disabled(busy)
		}
	}

	private func result(_ headline: String, _ detail: String) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			PageCard(rows: [PageRowModel(id: "result", title: headline, subtitle: detail)])
			Button("Done") { dismiss() }.buttonStyle(.primaryAction)
		}
	}
}
