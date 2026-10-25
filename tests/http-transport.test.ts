import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, MAX_TOOL_INPUT_ELEMENTS } from "../src/server.js";
import { FailedAuthLimiter } from "../src/http/security.js";
import { createHttpRequestHandler, MAX_BODY_BYTES, startHttpServer, type RunningHttpServer } from "../src/http/server.js";

const TOKEN = "test-token-0123456789abcdef0123456789abcdef";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; chunks?: string[] } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-transport-test", version: "1" },
  },
});

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

async function withServer(
  run: (server: RunningHttpServer) => Promise<void>,
  limiter = new FailedAuthLimiter(),
  createMcpServer = createServer,
): Promise<void> {
  const server = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    authToken: TOKEN,
    allowedHosts: ["garmin.example.org"],
    createMcpServer,
    limiter,
  });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

test("HTTP mode refuses to start without a strong token", () => {
  for (const authToken of ["", "too-short"]) {
    assert.throws(
      () => createHttpRequestHandler({ authToken, allowedHosts: [], createMcpServer: createServer }),
      /MCP_AUTH_TOKEN/
    );
  }
});

test("healthz answers without a token and exposes no data", async () => {
  await withServer(async ({ url }) => {
    const res = await request(`${url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: "ok" });
  });
});

test("unknown paths return 404", async () => {
  await withServer(async ({ url }) => {
    const res = await request(`${url}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404);
  });
});

test("MCP endpoint rejects missing and wrong tokens with a bare 401", async () => {
  await withServer(async ({ url }) => {
    for (const headers of [mcpHeaders(), mcpHeaders({ authorization: "Bearer wrong-token" })]) {
      const res = await request(`${url}/mcp`, { method: "POST", headers, body: initializeBody });
      assert.equal(res.status, 401);
      assert.equal(res.body, "");
      assert.match(String(res.headers["www-authenticate"]), /^Bearer/);
    }
  });
});

test("initialize round-trip succeeds with the correct token", async () => {
  await withServer(async ({ url }) => {
    const res = await request(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }),
      body: initializeBody,
    });
    assert.equal(res.status, 200);
    const message = JSON.parse(res.body);
    assert.equal(message.id, 1);
    assert.equal(message.result.serverInfo.name, "garmin-connect-mcp");
    assert.equal(res.headers["mcp-session-id"], undefined);
  });
});

test("SDK client lists tools over the authenticated HTTP transport", async () => {
  await withServer(async ({ url }) => {
    const client = new Client({ name: "http-transport-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes("garmin_get_activities"));
      assert.ok(names.includes("analyze_run_performance"));
    } finally {
      await client.close();
    }
  });
});

test("foreign Host and Origin headers are rejected even with a valid token", async () => {
  await withServer(async ({ url }) => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const badHost = await request(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ ...auth, host: "evil.example" }),
      body: initializeBody,
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await request(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ ...auth, origin: "https://evil.example" }),
      body: initializeBody,
    });
    assert.equal(badOrigin.status, 403);

    const publicHost = await request(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ ...auth, host: "garmin.example.org", origin: "https://garmin.example.org" }),
      body: initializeBody,
    });
    assert.equal(publicHost.status, 200);
  });
});

test("repeated failed tokens are rate-limited", async () => {
  await withServer(async ({ url }) => {
    const wrong = mcpHeaders({ authorization: "Bearer wrong-token" });
    for (let i = 0; i < 2; i++) {
      const res = await request(`${url}/mcp`, { method: "POST", headers: wrong, body: initializeBody });
      assert.equal(res.status, 401);
    }
    const blocked = await request(`${url}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ authorization: `Bearer ${TOKEN}` }),
      body: initializeBody,
    });
    assert.equal(blocked.status, 429);
  }, new FailedAuthLimiter(2, 60_000));
});

test("stateless endpoint rejects GET and malformed JSON", async () => {
  await withServer(async ({ url }) => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const get = await request(`${url}/mcp`, { headers: mcpHeaders(auth) });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST");

    const malformed = await request(`${url}/mcp`, { method: "POST", headers: mcpHeaders(auth), body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error.code, -32700);
  });
});

test("HTTP JSON body limit accepts exactly 256 KiB and rejects one byte more with a readable 413", async () => {
  assert.equal(MAX_BODY_BYTES, 256 * 1024);
  await withServer(async ({ url }) => {
    const unicodeBody = initializeBody.replace("http-transport-test", "HTTP grænsetest");
    const boundary = unicodeBody + " ".repeat(MAX_BODY_BYTES - Buffer.byteLength(unicodeBody));
    assert.equal(Buffer.byteLength(boundary), MAX_BODY_BYTES);
    const headers = mcpHeaders({ authorization: `Bearer ${TOKEN}` });
    const accepted = await request(`${url}/mcp`, { method: "POST", headers, body: boundary });
    assert.equal(accepted.status, 200, accepted.body);

    const rejected = await request(`${url}/mcp`, {
      method: "POST", headers, chunks: [boundary, " "],
    });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.headers.connection, "close");
    assert.equal(JSON.parse(rejected.body).error.message, "Request body too large");
    assert.equal((await request(`${url}/healthz`)).status, 200);
  });
});

test("the real server enforces the tool element budget before schema validation", async () => {
  assert.equal(MAX_TOOL_INPUT_ELEMENTS, 10_000);
  await withServer(async ({ url }) => {
    const client = new Client({ name: "input-budget-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }));
    try {
      // One object member plus 9,999 array entries is exactly the 10,000-element limit.
      const accepted = await client.callTool({
        name: "input_budget_test", arguments: { values: Array(MAX_TOOL_INPUT_ELEMENTS - 1).fill(0) },
      });
      assert.equal(Boolean(accepted.isError), false);
      assert.deepEqual(accepted.content, [{ type: "text", text: "9999" }]);
      const rejected = await client.callTool({
        name: "input_budget_test", arguments: { values: Array(MAX_TOOL_INPUT_ELEMENTS).fill(0) },
      });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected.content), /maximum of 10000 elements/);
      const invalid = await client.callTool({
        name: "input_budget_test", arguments: { values: Array(MAX_TOOL_INPUT_ELEMENTS).fill({}) },
      });
      assert.equal(invalid.isError, true);
      assert.match(JSON.stringify(invalid.content), /maximum of 10000 elements/);
    } finally {
      await client.close();
    }
  }, new FailedAuthLimiter(), () => {
    const server = createServer();
    server.registerTool("input_budget_test", { inputSchema: { values: z.array(z.number()) } },
      async ({ values }) => ({ content: [{ type: "text", text: String(values.length) }] }));
    return server;
  });
});
