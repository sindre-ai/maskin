import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Sign in and create account, one calm screen: the mark, one headline, a short form, a primary
/// button, and text links. A centred readable column on iPad and Mac, full width on a phone.
///
/// Autofill: the email field is `.username` and the password is `.password` when signing in and
/// `.newPassword` when creating an account, so iCloud Keychain offers saved logins, suggests a
/// strong password, and offers to save the new one.
public struct AuthView: View {
	private let auth: AuthSession
	@State private var model: AuthScreenModel
	@State private var showPassword = false
	@FocusState private var focus: AuthScreenModel.Field?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.openURL) private var openURL

	public init(environment: AppEnvironment) {
		auth = environment.auth
		_model = State(initialValue: AuthScreenModel())
	}

	init(auth: AuthSession, model: AuthScreenModel) {
		self.auth = auth
		_model = State(initialValue: model)
	}

	private static let columnWidth: CGFloat = 440

	public var body: some View {
		GeometryReader { proxy in
			ScrollViewReader { scroller in
				ScrollView {
					content
						.padding(.horizontal, MaskinSpace.s12)
						.padding(.vertical, MaskinSpace.s14)
						.frame(maxWidth: Self.columnWidth)
						.frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .center)
				}
				.scrollDismissesKeyboard(.interactively)
				.onChange(of: focus) { old, field in
					if let old { model.touch(old) }
					guard let field else { return }
					withAnimation(reduceMotion ? nil : MaskinMotion.panel) {
						scroller.scrollTo(field, anchor: .center)
					}
				}
			}
		}
		.background(MaskinSurface.grouped.ignoresSafeArea())
		.onAppear { focus = model.fields.first }
		.onChange(of: auth.lastError) { _, new in if new != nil { MaskinHaptics.play(.error) } }
		.onChange(of: auth.lastSignUpError) { _, new in if new != nil { MaskinHaptics.play(.error) } }
	}

	// MARK: Layout

	private var content: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s13) {
			header

			if model.config.signUpEnabled {
				AuthModeSwitch(selection: model.mode) { mode in
					withAnimation(reduceMotion ? nil : MaskinMotion.panel) { model.switchTo(mode) }
					showPassword = false
					focus = model.fields.first
					MaskinHaptics.play(.selection)
				}
			}

			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				ForEach(model.fields, id: \.self) { field in
					fieldView(field).id(field)
				}
			}

			if model.mode == .createAccount, model.serverFieldErrors[.email] != nil,
				auth.lastSignUpError == .emailTaken
			{
				Button("Sign in instead") {
					withAnimation(reduceMotion ? nil : MaskinMotion.panel) { model.switchTo(.signIn) }
					focus = .password
				}
				.buttonStyle(.plain)
				.maskinText(.subhead)
				.fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
			}

			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				if let banner = model.banner(for: auth) { bannerView(banner) }

				Button(action: submit) {
					ZStack {
						Text(model.mode.title).opacity(model.isBusy(auth) ? 0 : 1)
						if model.isBusy(auth) { ProgressView() }
					}
				}
				.buttonStyle(PrimaryActionButtonStyle())
				.disabled(!model.canSubmit || model.isBusy(auth))
				.keyboardShortcut(.defaultAction)
				.accessibilityLabel(model.isBusy(auth) ? "\(model.mode.title), working" : model.mode.title)

				if model.mode == .createAccount { legal }
			}
		}
		.animation(reduceMotion ? nil : MaskinMotion.fade, value: model.mode)
	}

	private var header: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			BrandMark(size: 56)
				.padding(.bottom, MaskinSpace.s3)
			Text(model.mode == .signIn ? "Sign in to Maskin" : "Create your account")
				.maskinText(.largeTitle)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityAddTraits(.isHeader)
			Text(
				model.mode == .signIn
					? "Your workspace and agents, where you left them."
					: "You get a workspace and agents ready to work."
			)
			.maskinText(.body)
			.foregroundStyle(MaskinColor.ink4)
		}
	}

	@ViewBuilder
	private func fieldView(_ field: AuthScreenModel.Field) -> some View {
		let busy = model.isBusy(auth)
		switch field {
		case .name:
			AuthField(
				label: "Name", problem: model.message(for: .name), isFocused: focus == .name
			) {
				TextField("Your name", text: $model.name)
					.focused($focus, equals: .name)
					.submitLabel(.next)
					.onSubmit { advance(from: .name) }
					.autocorrectionDisabled()
					#if os(iOS)
						.textContentType(.name)
						.textInputAutocapitalization(.words)
					#endif
					.disabled(busy)
			}
		case .email:
			AuthField(
				label: "Email", problem: model.message(for: .email), isFocused: focus == .email
			) {
				TextField("you@company.com", text: $model.email)
					.focused($focus, equals: .email)
					.submitLabel(.next)
					.onSubmit { advance(from: .email) }
					.textContentType(.username)
					.autocorrectionDisabled()
					#if os(iOS)
						.keyboardType(.emailAddress)
						.textInputAutocapitalization(.never)
					#endif
					.disabled(busy)
			}
		case .password:
			AuthField(
				label: "Password",
				help: model.mode == .createAccount ? "At least \(SignUpForm.minPasswordLength) characters." : nil,
				problem: model.message(for: .password), isFocused: focus == .password
			) {
				passwordInput
			} trailing: {
				Button {
					showPassword.toggle()
					focus = .password
				} label: {
					Image(systemName: showPassword ? "eye.slash" : "eye")
						.foregroundStyle(MaskinColor.ink4)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel(showPassword ? "Hide password" : "Show password")
			}
		}
	}

	@ViewBuilder
	private var passwordInput: some View {
		let busy = model.isBusy(auth)
		Group {
			if showPassword {
				TextField("Password", text: $model.password)
					.autocorrectionDisabled()
					#if os(iOS)
						.textInputAutocapitalization(.never)
					#endif
			} else {
				SecureField("Password", text: $model.password)
			}
		}
		.focused($focus, equals: .password)
		.submitLabel(model.mode == .signIn ? .go : .done)
		.onSubmit(submit)
		#if os(iOS)
			.textContentType(model.mode == .signIn ? .password : .newPassword)
		#else
			.textContentType(.password)
		#endif
		.disabled(busy)
	}

	private func bannerView(_ banner: AuthBanner) -> some View {
		let isError: Bool = if case .error = banner { true } else { false }
		return HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.gapDefault) {
			Image(systemName: isError ? "exclamationmark.circle.fill" : "info.circle")
			Text(banner.text)
		}
		.maskinText(.subhead)
		.foregroundStyle(isError ? MaskinColor.danger : MaskinColor.ink3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s8)
		.background(
			isError ? MaskinColor.danger.opacity(0.08) : MaskinColor.surfaceAlt,
			in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
		)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(isError ? "Error. \(banner.text)" : banner.text)
		.onAppear { AccessibilityNotification.Announcement(banner.text).post() }
	}

	/// "By creating an account you agree to the Terms and Privacy Policy." Links only for the
	/// pages the build is configured with; with neither, the line is omitted.
	@ViewBuilder
	private var legal: some View {
		if let text = Self.legalText(terms: model.config.termsURL, privacy: model.config.privacyURL) {
			Text(text)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.tint(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
		}
	}

	static func legalText(terms: URL?, privacy: URL?) -> AttributedString? {
		var parts: [AttributedString] = []
		for (title, url) in [("Terms", terms), ("Privacy Policy", privacy)] {
			guard let url else { continue }
			var link = AttributedString(title)
			link.link = url
			link.underlineStyle = .single
			parts.append(link)
		}
		guard !parts.isEmpty else { return nil }
		var out = AttributedString("By creating an account you agree to the ")
		out += parts[0]
		if parts.count > 1 {
			out += AttributedString(" and ")
			out += parts[1]
		}
		out += AttributedString(".")
		return out
	}

	// MARK: Actions

	private func advance(from field: AuthScreenModel.Field) {
		model.touch(field)
		if let next = model.next(after: field) { focus = next } else { submit() }
	}

	private func submit() {
		guard !model.isBusy(auth) else { return }
		Task {
			let sent = await { () -> Bool in
				focus = nil
				return await model.submit(auth: auth)
			}()
			if sent, auth.session != nil { MaskinHaptics.play(.success) }
		}
	}
}

#Preview("Sign in") { AuthView(environment: .preview(signedIn: false)) }
