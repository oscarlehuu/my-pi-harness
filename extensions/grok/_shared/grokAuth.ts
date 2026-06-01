/**
 * Shared Grok authentication for the reverse-engineered CLI transports.
 *
 * `grok login` stores OIDC credentials in ~/.grok/auth.json. The Grok CLI then
 * sends those bearer tokens to xAI's subscription-backed proxy
 * (https://cli-chat-proxy.grok.com/v1) with the `X-XAI-Token-Auth:
 * xai-grok-cli` marker and a current `x-grok-client-version`. Search and
 * Imagine endpoints use the same auth envelope; search adds its model override
 * header at the call site, while image/video calls intentionally do not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Subscription-backed proxy the authorized Grok CLI talks to. */
export const CLI_CHAT_PROXY_BASE_URL = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.replace(/\/$/, "") ?? "https://cli-chat-proxy.grok.com/v1";

/** Public pay-as-you-go endpoint (used by search only when an explicit API key is set). */
export const XAI_API_BASE_URL = process.env.XAI_API_BASE_URL?.replace(/\/$/, "") ?? "https://api.x.ai/v1";

/** Sent as x-grok-client-version; the proxy returns 426 for "none"/unknown. */
export const CLIENT_VERSION = process.env.GROK_CLIENT_VERSION ?? readGrokVersion() ?? "0.2.13";

/** A bearer credential plus the transport it should use. */
export interface GrokAuth {
	token: string;
	mode: "subscription" | "api-key";
	baseUrl: string;
	/** ISO expiry, when known (OIDC tokens only). */
	expiresAt?: string;
}

export class GrokAuthError extends Error {}

/** Force a specific transport via env; otherwise subscription-first with fallback. */
type AuthPreference = "subscription" | "api-key" | "auto";

function readGrokVersion(): string | null {
	for (const rel of ["version.json", ".metadata_version"]) {
		try {
			const raw = fs.readFileSync(path.join(os.homedir(), ".grok", rel), "utf-8").trim();
			if (rel.endsWith(".json")) {
				const v = JSON.parse(raw)?.version;
				if (typeof v === "string" && v) return v;
			} else if (raw) {
				return raw;
			}
		} catch {
			/* try next */
		}
	}
	return null;
}

function authPreference(): AuthPreference {
	const pref = process.env.GROK_SEARCH_AUTH?.toLowerCase();
	if (pref === "subscription" || pref === "api-key") return pref;
	return "auto";
}

function apiKeyAuth(): GrokAuth | null {
	const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
	return apiKey ? { token: apiKey, mode: "api-key", baseUrl: XAI_API_BASE_URL } : null;
}

function subscriptionAuth(): GrokAuth | null {
	const authPath = process.env.GROK_AUTH_PATH || path.join(os.homedir(), ".grok", "auth.json");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
	} catch {
		return null;
	}

	// auth.json is keyed by "<issuer>::<client_id>"; pick the freshest entry that
	// actually carries a token.
	let best: { key: string; expiresAt?: string } | null = null;
	for (const value of Object.values(parsed)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		const key = entry.key;
		if (typeof key !== "string" || !key) continue;
		const expiresAt = typeof entry.expires_at === "string" ? entry.expires_at : undefined;
		if (!best || (expiresAt && best.expiresAt && expiresAt > best.expiresAt) || (expiresAt && !best.expiresAt)) {
			best = { key, expiresAt };
		}
	}
	if (!best) return null;
	if (best.expiresAt && Date.parse(best.expiresAt) <= Date.now()) {
		throw new GrokAuthError(
			`Grok session token expired at ${best.expiresAt}. Run \`grok login\` (or \`grok\`) to refresh it.`,
		);
	}
	return { token: best.key, mode: "subscription", baseUrl: CLI_CHAT_PROXY_BASE_URL, expiresAt: best.expiresAt };
}

/**
 * Resolve a usable bearer token. Mirrors the grok CLI: prefer the subscription
 * session token from `grok login` (it keeps working when api.x.ai credits are
 * exhausted), falling back to an explicit API key for the existing search tools.
 * Pass `"subscription"` to require the CLI subscription proxy specifically.
 */
export function resolveGrokAuth(preference: AuthPreference = authPreference()): GrokAuth {
	const pref = preference;

	if (pref === "api-key") {
		const auth = apiKeyAuth();
		if (auth) return auth;
		throw new GrokAuthError("GROK_SEARCH_AUTH=api-key but no GROK_API_KEY/XAI_API_KEY is set.");
	}

	if (pref === "subscription") {
		const auth = subscriptionAuth();
		if (auth) return auth;
		throw new GrokAuthError(
			"GROK_SEARCH_AUTH=subscription but no usable ~/.grok/auth.json session token. Run `grok login`.",
		);
	}

	// auto: subscription first (what grok does + survives credit exhaustion), then API key.
	return (
		subscriptionAuth() ??
		apiKeyAuth() ??
		(() => {
			throw new GrokAuthError(
				"Grok is not authorised: no ~/.grok/auth.json (run `grok login`) and no GROK_API_KEY/XAI_API_KEY set.",
			);
		})()
	);
}

/** Build the common Grok CLI auth envelope; callers may append endpoint-specific headers. */
export function buildAuthHeaders(auth: GrokAuth, extraHeaders: Record<string, string> = {}): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${auth.token}`,
		"x-grok-client-version": CLIENT_VERSION,
		"user-agent": `xai-grok-cli/${CLIENT_VERSION}`,
	};
	if (auth.mode === "subscription") {
		// Tells the proxy auth middleware to validate the bearer as a CLI session token.
		headers["X-XAI-Token-Auth"] = "xai-grok-cli";
	}
	return { ...headers, ...extraHeaders };
}
