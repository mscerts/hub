/**
 * protocol.ts — minimal stateless MCP JSON-RPC 2.0 handler
 *
 * Implements just what's needed for a read-only tools server:
 *   initialize, notifications/initialized, tools/list, tools/call
 *
 * Always responds with SSE-formatted events (text/event-stream) per the
 * MCP Streamable HTTP spec, which all compliant clients expect.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult> | ToolResult;

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseEvent(data: unknown): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return sseEvent({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return sseEvent({ jsonrpc: "2.0", id, error: { code, message } });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleMcpRequest(
  body: unknown,
  tools: RegisteredTool[],
): Promise<Response> {
  if (!body || typeof body !== "object") {
    return sseResponse(jsonRpcError(null, -32700, "Parse error"));
  }

  const req = body as Record<string, unknown>;
  const method = req["method"] as string | undefined;
  const id = req["id"] ?? null;
  const params = (req["params"] ?? {}) as Record<string, unknown>;

  // ── initialize ─────────────────────────────────────────────────────────────
  if (method === "initialize") {
    return sseResponse(
      jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "msfthub", version: "0.1.0" },
      }),
    );
  }

  // ── notifications/initialized (no response needed) ─────────────────────────
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204 });
  }

  // ── tools/list ─────────────────────────────────────────────────────────────
  if (method === "tools/list") {
    return sseResponse(
      jsonRpcResult(id, {
        tools: tools.map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.inputSchema,
        })),
      }),
    );
  }

  // ── tools/call ─────────────────────────────────────────────────────────────
  if (method === "tools/call") {
    const name = params["name"] as string | undefined;
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;

    if (!name) {
      return sseResponse(jsonRpcError(id, -32602, "Missing tool name"));
    }

    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) {
      return sseResponse(jsonRpcError(id, -32601, `Tool not found: '${name}'`));
    }

    try {
      const result = await tool.handler(args);
      return sseResponse(jsonRpcResult(id, result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return sseResponse(
        jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool error: ${msg}` }],
          isError: true,
        }),
      );
    }
  }

  // ── ping ───────────────────────────────────────────────────────────────────
  if (method === "ping") {
    return sseResponse(jsonRpcResult(id, {}));
  }

  return sseResponse(jsonRpcError(id, -32601, `Method not found: '${method}'`));
}
