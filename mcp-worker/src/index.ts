import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleMcpRequest, type RegisteredTool } from "./protocol.ts";
import { examTools } from "./tools/exams.ts";
import { voucherTools, guideTools, labTools, blogTools } from "./tools/rest.ts";
import type { ContentBundle } from "./types.ts";

// Content bundle is imported as a static JSON module at deploy time.
// Run `pnpm bundle` before `wrangler deploy` to regenerate it.
import BUNDLE from "../content-bundle.json";

const bundle = BUNDLE as ContentBundle;

// Build the tool registry once at module load time (fast, no per-request cost).
const tools: RegisteredTool[] = [
  ...examTools(bundle),
  ...voucherTools(bundle),
  ...guideTools(bundle),
  ...labTools(bundle),
  ...blogTools(bundle),
];

const app = new Hono();

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
// Handles GET (capability discovery) and POST (JSON-RPC requests).
app.get("/mcp", (c) => {
  // Some MCP clients do a GET first to check if the endpoint exists.
  return c.json(
    {
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "msfthub", version: "0.1.0" },
      },
    },
    200,
  );
});

app.post("/mcp", async (c) => {
  // MCP Streamable HTTP requires Accept: application/json, text/event-stream
  const accept = c.req.header("accept") ?? "";
  if (!accept.includes("text/event-stream") && !accept.includes("*/*")) {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "Not Acceptable: client must accept text/event-stream",
        },
      },
      406,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      400,
    );
  }

  return handleMcpRequest(body, tools);
});

export default app;
