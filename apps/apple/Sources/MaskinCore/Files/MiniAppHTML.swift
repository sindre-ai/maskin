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
