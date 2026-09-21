import assert from "node:assert/strict";
import { describe, test } from "node:test";
import app from "../src/index.ts";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

const allowBindings = {
  MCP_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

function post(
  body: string,
  bindings = allowBindings,
  requestHeaders: Record<string, string> = headers,
) {
  return app.request(
    "/mcp",
    { method: "POST", headers: requestHeaders, body },
    bindings,
  );
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
      }, allowBindings);
      assert.equal(response.status, 406);
    }
  });

  test("requires JSON request content", async () => {
    const response = await post(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      allowBindings,
      { ...headers, "content-type": "text/plain" },
    );
    assert.equal(response.status, 415);
  });

  test("rejects cross-origin browser requests", async () => {
    const response = await post(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      allowBindings,
      { ...headers, origin: "https://attacker.example" },
    );
    assert.equal(response.status, 403);
  });

  test("rejects oversized request bodies", async () => {
    const response = await post(`{"padding":"${"x".repeat(65_536)}"}`);
    assert.equal(response.status, 413);
    const payload = (await response.json()) as { error: { message: string } };
    assert.equal(payload.error.message, "Request body too large");
  });

  test("rate limits repeated calls", async () => {
    let calls = 0;
    const bindings = {
      MCP_RATE_LIMITER: {
        limit: async () => ({ success: ++calls <= 2 }),
      },
    };
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';

    assert.equal((await post(body, bindings)).status, 200);
    assert.equal((await post(body, bindings)).status, 200);
    const response = await post(body, bindings);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
  });

  test("does not write request bodies or credentials to logs", async () => {
    const original = console.info;
    const messages: string[] = [];
    console.info = (message) => messages.push(String(message));

    try {
      const response = await post(
        '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"token":"endpoint-secret"}}',
      );
      assert.equal(response.status, 200);
    } finally {
      console.info = original;
    }

    assert.doesNotMatch(messages.join("\n"), /endpoint-secret|"token"/);
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
