import assert from "node:assert/strict";
import test from "node:test";
import {
  FailedAuthLimiter,
  MIN_AUTH_TOKEN_LENGTH,
  assertValidAuthToken,
  bearerTokenMatches,
  hostnameFromHostHeader,
  isAllowedHost,
  isAllowedOrigin,
} from "../src/http/security.js";

const TOKEN = "a".repeat(MIN_AUTH_TOKEN_LENGTH);

test("auth token must be present and long enough", () => {
  assert.throws(() => assertValidAuthToken(undefined), /MCP_AUTH_TOKEN/);
  assert.throws(() => assertValidAuthToken(""), /MCP_AUTH_TOKEN/);
  assert.throws(() => assertValidAuthToken("short"), /at least 32/);
  assert.equal(assertValidAuthToken(TOKEN), TOKEN);
});

test("bearer token comparison accepts only the exact token", () => {
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerTokenMatches(`Bearer  ${TOKEN} `, TOKEN), true);
  assert.equal(bearerTokenMatches(undefined, TOKEN), false);
  assert.equal(bearerTokenMatches("", TOKEN), false);
  assert.equal(bearerTokenMatches(TOKEN, TOKEN), false);
  assert.equal(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN), false);
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN} extra`, TOKEN), false);
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN}`, ""), false);
});

test("host header parsing strips ports and handles IPv6", () => {
  assert.equal(hostnameFromHostHeader("Example.DuckDNS.org:443"), "example.duckdns.org");
  assert.equal(hostnameFromHostHeader("127.0.0.1:3000"), "127.0.0.1");
  assert.equal(hostnameFromHostHeader("[::1]:3000"), "::1");
  assert.equal(hostnameFromHostHeader("[::1]"), "::1");
  assert.equal(hostnameFromHostHeader(""), null);
  assert.equal(hostnameFromHostHeader(undefined), null);
});

test("only loopback and configured hosts are allowed", () => {
  const allowed = ["garmin.duckdns.org"];
  assert.equal(isAllowedHost("localhost:3000", []), true);
  assert.equal(isAllowedHost("127.0.0.1", []), true);
  assert.equal(isAllowedHost("[::1]:3000", []), true);
  assert.equal(isAllowedHost("garmin.duckdns.org", allowed), true);
  assert.equal(isAllowedHost("GARMIN.duckdns.org:443", allowed), true);
  assert.equal(isAllowedHost("garmin.duckdns.org", []), false);
  assert.equal(isAllowedHost("evil.example", allowed), false);
  assert.equal(isAllowedHost("garmin.duckdns.org.evil.example", allowed), false);
  assert.equal(isAllowedHost(undefined, allowed), false);
});

test("origin is optional but must match an allowed host when sent", () => {
  const allowed = ["garmin.duckdns.org"];
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin("https://garmin.duckdns.org", allowed), true);
  assert.equal(isAllowedOrigin("http://localhost:6274", allowed), true);
  assert.equal(isAllowedOrigin("https://evil.example", allowed), false);
  assert.equal(isAllowedOrigin("null", allowed), false);
});

test("failed-auth limiter blocks after the threshold and recovers after the window", () => {
  let now = 0;
  const limiter = new FailedAuthLimiter(3, 1_000, () => now);
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.isBlocked("ip"), false);
    limiter.recordFailure("ip");
  }
  assert.equal(limiter.isBlocked("ip"), true);
  assert.equal(limiter.isBlocked("other"), false);

  now = 1_001;
  assert.equal(limiter.isBlocked("ip"), false);

  limiter.recordFailure("ip");
  limiter.reset("ip");
  assert.equal(limiter.isBlocked("ip"), false);
});
