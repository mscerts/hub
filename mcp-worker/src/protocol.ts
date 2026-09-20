/**
 * Minimal stateless MCP JSON-RPC 2.0 handler for a read-only tools server.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";

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

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sseEvent(data: unknown): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
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

function notificationResponse(): Response {
  return new Response(null, { status: 202 });
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return sseResponse(sseEvent({ jsonrpc: "2.0", id, result }));
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Response {
  return sseResponse(sseEvent({ jsonrpc: "2.0", id, error: { code, message } }));
}

function validateInitializeParams(params: Record<string, unknown>): string | null {
  if (!isNonEmptyString(params["protocolVersion"])) {
    return "Invalid initialize protocolVersion";
  }
  if (!isRecord(params["capabilities"])) {
    return "Invalid initialize capabilities";
  }

  const clientInfo = params["clientInfo"];
  if (
    !isRecord(clientInfo) ||
    !isNonEmptyString(clientInfo["name"]) ||
    !isNonEmptyString(clientInfo["version"])
  ) {
    return "Invalid initialize clientInfo";
  }

  return null;
}

function validateToolArguments(
  tool: RegisteredTool,
  args: Record<string, unknown>,
): string | null {
  const { properties, required = [] } = tool.definition.inputSchema;

  for (const property of required) {
    if (!hasOwn(args, property)) return `Missing required argument: ${property}`;
  }

  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (!isRecord(schema)) continue;

    if (schema["type"] === "string" && typeof value !== "string") {
      return `Argument '${name}' must be a string`;
    }

    const allowed = schema["enum"];
    if (
      Array.isArray(allowed) &&
      !allowed.some((candidate) => candidate === value)
    ) {
      return `Invalid value for argument '${name}'`;
    }
  }

  return null;
}

export async function handleMcpRequest(
  body: unknown,
  tools: RegisteredTool[],
): Promise<Response> {
  if (!isRecord(body)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const hasId = hasOwn(body, "id");
  const rawId = body["id"];
  if (
    body["jsonrpc"] !== "2.0" ||
    typeof body["method"] !== "string" ||
    (hasId && !isValidId(rawId))
  ) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const id = hasId ? (rawId as JsonRpcId) : null;
  const isNotification = !hasId;
  const respondWithResult = (result: unknown) =>
    isNotification ? notificationResponse() : jsonRpcResult(id, result);
  const respondWithError = (code: number, message: string) =>
    isNotification
      ? notificationResponse()
      : jsonRpcError(id, code, message);

  if (hasOwn(body, "params") && !isRecord(body["params"])) {
    return respondWithError(-32602, "Invalid params");
  }

  const method = body["method"];
  const params = (body["params"] ?? {}) as Record<string, unknown>;

  if (method === "initialize") {
    const validationError = validateInitializeParams(params);
    if (validationError) return respondWithError(-32602, validationError);

    return respondWithResult({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "msfthub", version: "0.1.0" },
    });
  }

  if (method === "notifications/initialized") {
    return respondWithResult({});
  }

  if (method === "tools/list") {
    if (hasOwn(params, "cursor") && typeof params["cursor"] !== "string") {
      return respondWithError(-32602, "Invalid cursor");
    }

    return respondWithResult({
      tools: tools.map((tool) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = params["name"];
    if (!isNonEmptyString(name)) {
      return respondWithError(-32602, "Invalid tool name");
    }

    const rawArgs = params["arguments"] ?? {};
    if (!isRecord(rawArgs)) {
      return respondWithError(-32602, "Invalid tool arguments");
    }

    const tool = tools.find((candidate) => candidate.definition.name === name);
    if (!tool) {
      return respondWithError(-32602, `Tool not found: '${name}'`);
    }

    const validationError = validateToolArguments(tool, rawArgs);
    if (validationError) return respondWithError(-32602, validationError);

    try {
      return respondWithResult(await tool.handler(rawArgs));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return respondWithResult({
        content: [{ type: "text", text: `Tool error: ${message}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return respondWithResult({});
  }

  return respondWithError(-32601, `Method not found: '${method}'`);
}
