import assert from "node:assert/strict";
import { describe, test } from "node:test";
import app from "../src/index.ts";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

function post(body: string) {
  return app.request("/mcp", { method: "POST", headers, body });
}

async function ssePayload(response: Response) {
  const body = await response.text();
  const data = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  assert.ok(data, "expected an SSE data event");
  return JSON.parse(data) as {
    id: unknown;
    error?: { code: number };
    result?: unknown;
  };
}

describe("MCP HTTP endpoint", () => {
  test("rejects unsupported standalone SSE streams", async () => {
    const response = await app.request("/mcp");
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  });

  test("requires both Streamable HTTP response media types", async () => {
    for (const accept of ["application/json", "text/event-stream", "*/*"]) {
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { ...headers, accept },
        body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      });
      assert.equal(response.status, 406);
    }
  });

  test("returns -32700 for malformed JSON", async () => {
    for (const body of ["", "{", '{"jsonrpc":']) {
      const response = await post(body);
      assert.equal(response.status, 400);
      const payload = (await response.json()) as {
        id: unknown;
        error: { code: number };
      };
      assert.equal(payload.id, null);
      assert.equal(payload.error.code, -32700);
    }
  });

  test("returns -32600 for parsed non-request values and batches", async () => {
    for (const body of ["null", "true", "1", '"request"', "[]", "[{}]"]) {
      const response = await post(body);
      assert.equal(response.status, 200);
      const payload = await ssePayload(response);
      assert.equal(payload.id, null);
      assert.equal(payload.error?.code, -32600);
    }
  });

  test("returns no body for notifications", async () => {
    const response = await post('{"jsonrpc":"2.0","method":"ping"}');
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  });

  test("handles a valid MCP request", async () => {
    const response = await post(
      '{"jsonrpc":"2.0","id":"test","method":"tools/list"}',
    );
    assert.equal(response.status, 200);
    const payload = await ssePayload(response);
    assert.equal(payload.id, "test");
    assert.ok(payload.result);
  });
});
