/**
 * JWT helpers + Supabase token refresh.
 *
 * The browser handshake hands the CLI the user's access token (~1h) and, on
 * frontends that support it, the refresh token. With a refresh token the CLI
 * can keep itself logged in without the browser:
 *   POST {supabaseUrl}/auth/v1/token?grant_type=refresh_token
 *
 * Caveat (Supabase semantics, not ours): refresh tokens rotate on use and the
 * browser tab holds the same chain. We therefore refresh as late as possible
 * (see REFRESH_AHEAD_MS) and let the caller fall back to a browser handshake
 * when a refresh is rejected.
 */

export interface JwtPayload {
	sub?: string;
	exp?: number;
	iat?: number;
	email?: string;
	session_id?: string;
	[k: string]: unknown;
}

export function decodeJwt(jwt: string): JwtPayload | null {
	try {
		const part = jwt.split(".")[1];
		if (!part) return null;
		const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
		const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return JSON.parse(Buffer.from(pad, "base64").toString("utf-8"));
	} catch {
		return null;
	}
}

export function getJwtUserId(jwt: string): string | null {
	return decodeJwt(jwt)?.sub ?? null;
}

/** Milliseconds until the token expires (negative when already expired; Infinity when unknown). */
export function jwtExpiresInMs(jwt: string): number {
	const exp = decodeJwt(jwt)?.exp;
	return exp ? exp * 1000 - Date.now() : Number.POSITIVE_INFINITY;
}

export function isJwtExpired(jwt: string): boolean {
	return jwtExpiresInMs(jwt) < 0;
}

export function jwtExpiresAtIso(jwt: string): string | null {
	const exp = decodeJwt(jwt)?.exp;
	return exp ? new Date(exp * 1000).toISOString() : null;
}

/** Refresh when less than this much lifetime is left. */
export const REFRESH_AHEAD_MS = 5 * 60 * 1000;

export interface RefreshedTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: string;
	userId: string | null;
}

export class RefreshError extends Error {
	constructor(
		message: string,
		public status: number,
		public body?: unknown,
	) {
		super(message);
		this.name = "RefreshError";
	}
}

/** Exchange a refresh token for a new access/refresh pair. */
export async function refreshAccessToken(params: {
	supabaseUrl: string;
	supabaseKey: string;
	refreshToken: string;
}): Promise<RefreshedTokens> {
	const resp = await fetch(
		`${params.supabaseUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`,
		{
			method: "POST",
			headers: {
				apikey: params.supabaseKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ refresh_token: params.refreshToken }),
			signal: AbortSignal.timeout(20_000),
		},
	);
	const text = await resp.text().catch(() => "");
	let body: any;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	if (!resp.ok) {
		const detail =
			(body && (body.error_description || body.msg || body.error || body.message)) ||
			text ||
			`HTTP ${resp.status}`;
		throw new RefreshError(`Token refresh failed: ${detail}`, resp.status, body);
	}
	if (!body?.access_token || !body?.refresh_token) {
		throw new RefreshError("Token refresh returned no tokens", resp.status, body);
	}
	const expiresAt =
		typeof body.expires_at === "number"
			? new Date(body.expires_at * 1000).toISOString()
			: (jwtExpiresAtIso(body.access_token) ??
				new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString());
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt,
		userId: body.user?.id ?? getJwtUserId(body.access_token),
	};
}
