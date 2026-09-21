import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcpRequest, type RegisteredTool } from "./protocol.ts";
import {
  isAllowedOrigin,
  logEvent,
  readLimitedJson,
  RequestBodyTooLargeError,
} from "./security.ts";
import { examTools } from "./tools/exams.ts";
import { voucherTools, guideTools, labTools, blogTools } from "./tools/rest.ts";
import type { ContentBundle } from "./types.ts";

// Content bundle is imported as a static JSON module at deploy time.
// Run `pnpm bundle` before `wrangler deploy` to regenerate it.
import BUNDLE from "../content-bundle.json";

if (BUNDLE.contentTrust !== "untrusted") {
  throw new Error("Content bundle is missing its untrusted-data classification");
}
const bundle = BUNDLE as ContentBundle;

// Build the tool registry once at module load time (fast, no per-request cost).
const tools: RegisteredTool[] = [
  ...examTools(bundle),
  ...voucherTools(bundle),
  ...guideTools(bundle),
  ...labTools(bundle),
  ...blogTools(bundle),
];

const KNOWN_RPC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

interface Bindings {
  MCP_RATE_LIMITER: RateLimit;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

// ── Root info ────────────────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "msfthub MCP server",
    status: "ok",
    endpoints: {
      health: "/health",
      mcp: "/mcp",
    },
    note: "Configure MCP clients to use the /mcp endpoint.",
  })
);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({
    status: "ok",
    server: "msfthub-mcp",
    version: "0.1.0",
    tools: tools.length,
    docs: bundle.docs.length,
    blog: bundle.blog.length,
    bundledAt: bundle.generatedAt,
  }),
);

// ── MCP endpoint ──────────────────────────────────────────────────────────────
// This stateless server does not expose a standalone SSE listening stream.
app.get("/mcp", (c) => c.body(null, 405, { Allow: "POST" }));

app.post("/mcp", async (c) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let rpcMethod: string | undefined;
  let toolName: string | undefined;
  const finish = (response: Response) => {
    logEvent("info", "mcp_request_completed", {
      requestId,
      httpMethod: c.req.method,
      path: c.req.path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      ...(rpcMethod ? { rpcMethod } : {}),
      ...(toolName ? { toolName } : {}),
    });
    return response;
  };

  if (!isAllowedOrigin(c.req.header("origin"), c.req.url)) {
    logEvent("warn", "mcp_origin_rejected", { requestId });
    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Forbidden" },
        },
        403,
      ),
    );
  }

  // MCP Streamable HTTP requires Accept: application/json, text/event-stream
  const accept = c.req.header("accept") ?? "";
  if (
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: "Not Acceptable",
          },
        },
        406,
      ),
    );
  }

  const contentType = c.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Unsupported Media Type" },
        },
        415,
      ),
    );
  }

  try {
    const clientKey = c.req.header("cf-connecting-ip") ?? "unknown-client";
    const rateLimit = await c.env.MCP_RATE_LIMITER.limit({ key: clientKey });
    if (!rateLimit.success) {
      logEvent("warn", "mcp_rate_limited", { requestId });
      const response = c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Rate limit exceeded" },
        },
        429,
      );
      response.headers.set("Retry-After", "60");
      return finish(response);
    }
  } catch (error) {
    logEvent("error", "mcp_rate_limiter_failed", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        },
        503,
      ),
    );
  }

  let body: unknown;
  try {
    body = await readLimitedJson(c.req.raw);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      logEvent("warn", "mcp_body_rejected", { requestId });
      return finish(
        c.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Request body too large" },
          },
          413,
        ),
      );
    }

    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400,
      ),
    );
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    const request = body as Record<string, unknown>;
    if (
      typeof request["method"] === "string" &&
      KNOWN_RPC_METHODS.has(request["method"])
    ) {
      rpcMethod = request["method"];
    }
    const params = request["params"];
    if (
      rpcMethod === "tools/call" &&
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      typeof (params as Record<string, unknown>)["name"] === "string" &&
      tools.some(
        (tool) =>
          tool.definition.name ===
          (params as Record<string, unknown>)["name"],
      )
    ) {
      toolName = (params as Record<string, unknown>)["name"] as string;
    }
  }

  try {
    return finish(
      await handleMcpRequest(body, tools, {
        onError(error, context) {
          logEvent("error", "mcp_tool_failed", {
            requestId,
            rpcMethod: context.method,
            ...(context.toolName ? { toolName: context.toolName } : {}),
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        },
      }),
    );
  } catch (error) {
    logEvent("error", "mcp_request_failed", {
      requestId,
      ...(rpcMethod ? { rpcMethod } : {}),
      ...(toolName ? { toolName } : {}),
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return finish(
      c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        },
        500,
      ),
    );
  }
});

export default app;
