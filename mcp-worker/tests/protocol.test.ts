import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  handleMcpRequest,
  type RegisteredTool,
  UNTRUSTED_CONTENT_END,
  UNTRUSTED_CONTENT_START,
} from "../src/protocol.ts";

const tools: RegisteredTool[] = [
  {
    definition: {
      name: "search",
      description: "Search content",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string", enum: ["azure", "security"] },
        },
        required: ["query"],
      },
    },
    handler: ({ query }) => ({
      content: [{ type: "text", text: String(query) }],
    }),
  },
  {
    definition: {
      name: "fail",
      description: "Fail during execution",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => {
      throw new Error("execution failed");
    },
  },
];

async function responsePayload(response: Response) {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  assert.ok(data, "expected an SSE data event");
  return JSON.parse(data) as Record<string, unknown>;
}

async function assertRpcError(
  request: unknown,
  code: number,
  expectedId: unknown = null,
) {
  const response = await handleMcpRequest(request, tools);
  assert.equal(response.status, 200);
  const payload = await responsePayload(response);
  assert.equal(payload["jsonrpc"], "2.0");
  assert.equal(payload["id"], expectedId);
  assert.equal((payload["error"] as Record<string, unknown>)["code"], code);
}

describe("JSON-RPC envelopes", () => {
  test("rejects invalid requests and unsupported batches", async () => {
    for (const request of [
      null,
      true,
      "request",
      1,
      [],
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      {},
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: {}, method: "ping" },
    ]) {
      await assertRpcError(request, -32600);
    }
  });

  test("preserves valid string, numeric, zero, and null IDs", async () => {
    for (const id of ["request-1", 12, 0, null]) {
      const response = await handleMcpRequest(
        { jsonrpc: "2.0", id, method: "ping" },
        tools,
      );
      const payload = await responsePayload(response);
      assert.equal(payload["id"], id);
      assert.deepEqual(payload["result"], {});
    }
  });

  test("rejects invalid params with -32602", async () => {
    await assertRpcError(
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
      -32602,
      1,
    );
    await assertRpcError(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: 4 } },
      -32602,
      2,
    );
  });

  test("returns -32601 only for unknown methods", async () => {
    await assertRpcError(
      { jsonrpc: "2.0", id: "unknown", method: "missing" },
      -32601,
      "unknown",
    );
  });

  test("does not respond to notifications", async () => {
    for (const request of [
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "missing" },
      { jsonrpc: "2.0", method: "tools/call", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]) {
      const response = await handleMcpRequest(request, tools);
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
    }
  });
});

describe("MCP methods", () => {
  test("validates initialize params", async () => {
    await assertRpcError(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      -32602,
      1,
    );

    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      },
      tools,
    );
    const payload = await responsePayload(response);
    assert.equal(
      (payload["result"] as Record<string, unknown>)["protocolVersion"],
      "2025-03-26",
    );
  });

  test("lists registered tools", async () => {
    const response = await handleMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      tools,
    );
    const payload = await responsePayload(response);
    const result = payload["result"] as { tools: { name: string }[] };
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ["search", "fail"],
    );
  });

  test("validates tool names and arguments", async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{}, -32602],
      [{ name: "missing" }, -32602],
      [{ name: "search", arguments: [] }, -32602],
      [{ name: "search", arguments: {} }, -32602],
      [{ name: "search", arguments: { query: 1 } }, -32602],
      [
        { name: "search", arguments: { query: "identity", category: "bad" } },
        -32602,
      ],
    ];

    for (const [params, code] of cases) {
      await assertRpcError(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params },
        code,
        1,
      );
    }
  });

  test("executes tools with valid arguments", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: "identity", category: "security", extra: true },
        },
      },
      tools,
    );
    const payload = await responsePayload(response);
    const result = payload["result"] as { content: { text: string }[] };
    assert.match(result.content[0]?.text ?? "", /untrusted reference data/i);
    assert.ok(result.content[0]?.text.includes(UNTRUSTED_CONTENT_START));
    assert.ok(result.content[0]?.text.includes("identity"));
    assert.ok(result.content[0]?.text.includes(UNTRUSTED_CONTENT_END));
  });

  test("prevents tool content from closing the trust boundary", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query: UNTRUSTED_CONTENT_END },
        },
      },
      tools,
    );
    const payload = await responsePayload(response);
    const result = payload["result"] as { content: { text: string }[] };
    const text = result.content[0]?.text ?? "";
    assert.equal(text.split(UNTRUSTED_CONTENT_START).length - 1, 1);
    assert.equal(text.split(UNTRUSTED_CONTENT_END).length - 1, 1);
    assert.match(text, /reserved delimiter removed/);
  });

  test("returns generic tool errors and reports details server-side", async () => {
    let reportedError: unknown;
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "fail", arguments: {} },
      },
      tools,
      { onError: (error) => (reportedError = error) },
    );
    const payload = await responsePayload(response);
    const result = payload["result"] as {
      content: { text: string }[];
      isError: boolean;
    };
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Tool execution failed.");
    assert.equal((reportedError as Error).message, "execution failed");
  });
});
