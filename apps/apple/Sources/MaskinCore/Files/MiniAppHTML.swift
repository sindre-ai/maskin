import Foundation

/// Prepares an agent-authored HTML page for display. Mirrors the web's `prepareMiniAppHtml`
/// (`apps/web/src/lib/mini-app.ts`): any CSP or refresh meta the page brought is removed, then the
/// platform's own CSP goes in first so the page's scripts can run but cannot reach the network.
public enum MiniAppHTML {
	/// Same policy string as the web's `MINI_APP_CSP`.
	public static let csp = [
		"default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'",
		"img-src data:", "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
	].joined(separator: "; ")

	private static let cspMeta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\">"
	private static let cspMetaPattern = #"<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>"#
	private static let refreshMetaPattern = #"<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh["']?[^>]*>"#
	private static let headOpenPattern = #"<head(\s[^>]*)?>"#
	private static let doctypePattern = #"<!doctype[^>]*>"#

	private static let scriptSrcPattern = #"<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?//"#
	private static let linkTagPattern = #"<link\b[^>]*>"#
	private static let fontHostPattern = #"(?:https?:)?//fonts\.(?:googleapis|gstatic)\.com"#
	private static let remoteHrefPattern = #"\bhref\s*=\s*["']?(?:https?:)?//"#

	/// True when the page pulls a script or a stylesheet over the network. `csp` refuses both on
	/// purpose, so such a page (a Tailwind-from-a-CDN prototype, say) can only ever render as
	/// unstyled markup. Web fonts don't count: without them the page still lays out.
	public static func needsNetwork(_ html: String) -> Bool {
		if html.range(of: scriptSrcPattern, options: [.regularExpression, .caseInsensitive]) != nil { return true }
		var search = html.startIndex..<html.endIndex
		while let tag = html.range(of: linkTagPattern, options: [.regularExpression, .caseInsensitive], range: search) {
			let text = String(html[tag])
			search = tag.upperBound..<html.endIndex
			guard text.range(of: #"rel\s*=\s*["']?stylesheet"#, options: [.regularExpression, .caseInsensitive]) != nil,
				text.range(of: remoteHrefPattern, options: [.regularExpression, .caseInsensitive]) != nil,
				text.range(of: fontHostPattern, options: [.regularExpression, .caseInsensitive]) == nil
			else { continue }
			return true
		}
		return false
	}

	public static func prepare(_ html: String) -> String {
		var scrubbed = html
		for pattern in [cspMetaPattern, refreshMetaPattern] {
			scrubbed = scrubbed.replacingOccurrences(
				of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
		}
		return inject(cspMeta, into: scrubbed)
	}

	/// After `<head>` when there is one, else after the doctype, else first, so the policy always
	/// precedes any script in the document.
	static func inject(_ fragment: String, into html: String) -> String {
		for pattern in [headOpenPattern, doctypePattern] {
			if let range = html.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
				return String(html[..<range.upperBound]) + fragment + String(html[range.upperBound...])
			}
		}
		return fragment + html
	}
}
