import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_AUTH_TOKEN_LENGTH = 32;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

export function assertValidAuthToken(token: string | undefined): string {
  if (!token || token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be set to at least ${MIN_AUTH_TOKEN_LENGTH} characters in HTTP mode. ` +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return match ? match[1] : null;
}

/** Constant-time comparison of an `Authorization: Bearer <token>` header. */
export function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  const token = extractBearerToken(header);
  if (!token || !expected) return false;
  return timingSafeEqual(digest(token), digest(expected));
}

/** Hostname of a Host header without the port, lower-cased. */
export function hostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : null;
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/** DNS-rebinding guard: loopback names plus explicitly configured public hostnames. */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  return LOOPBACK_HOSTS.includes(hostname) || allowedHosts.includes(hostname);
}

/** Browser requests carry an Origin; it must point at an allowed host. */
export function isAllowedOrigin(origin: string | undefined, allowedHosts: string[]): boolean {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK_HOSTS.includes(hostname) || allowedHosts.includes(hostname);
  } catch {
    return false;
  }
}

/** Blocks a client after repeated failed auth attempts within a sliding window. */
export class FailedAuthLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const kept = this.recent(key);
    kept.push(this.now());
    this.failures.set(key, kept);
    if (this.failures.size > 10_000) {
      for (const tracked of [...this.failures.keys()]) this.recent(tracked);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
