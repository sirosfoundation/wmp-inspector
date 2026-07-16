/**
 * wmp-inspector backend — Hono app with WebSocket support.
 *
 * Serves:
 *   - /.well-known/wmp-configuration
 *   - /api/invite          POST — accept an invitation URI
 *   - /api/sessions        GET  — list active sessions
 *   - /api/sessions/:id    GET  — session detail + log
 *   - /api/decode          POST — decode a payload
 *   - /ws                  WS   — browser fan-out
 *   - /wmp/ws              WS   — WMP relay endpoint (future)
 *   - /*                   GET  — static SPA files
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

import { SessionStore } from "./session-store.js";
import { FanOut } from "./fan-out.js";
import { WMPAgent } from "./wmp-agent.js";
import { wellKnownRoutes } from "./well-known.js";
import { decodePayload } from "./decoder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(__dirname, "../../frontend/dist");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE_URL =
  process.env.BASE_URL ?? `http://localhost:${PORT}`;
const SELF_ID =
  process.env.SELF_ID ?? `https://wmp-inspector.fly.dev`;

// ---------------------------------------------------------------------------
// Core services
// ---------------------------------------------------------------------------

const store = new SessionStore();
const fanOut = new FanOut(store);
const agent = new WMPAgent(store, SELF_ID);

fanOut.start();

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// CORS for dev
app.use("/api/*", cors());

// Well-known
app.route("/", wellKnownRoutes(BASE_URL));

// --- API routes ---

app.post("/api/invite", async (c) => {
  try {
    const body = await c.req.json<{ uri: string }>();
    if (!body.uri) {
      return c.json({ error: "missing 'uri' field" }, 400);
    }
    const sessionId = await agent.acceptInvitation(body.uri);
    return c.json({ sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

app.get("/api/sessions", (c) => {
  const sessions = store.allSessions().map((s) => ({
    sessionId: s.sessionId,
    createdAt: s.createdAt,
    provider: s.provider,
    sender: s.sender,
    securityMode: s.securityMode,
    mlsGroupId: s.mlsGroupId,
    mlsEpoch: s.mlsEpoch,
    memberCount: s.members.size,
  }));
  return c.json({ sessions });
});

app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = store.getSession(id);
  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }
  return c.json({
    ...session,
    members: [...session.members.values()],
    log: store.getLog(id),
  });
});

app.post("/api/decode", async (c) => {
  const body = await c.req.json<{ payload: string }>();
  if (!body.payload) {
    return c.json({ error: "missing 'payload' field" }, 400);
  }
  const result = decodePayload(body.payload);
  return c.json(result);
});

app.get("/api/status", (c) => {
  return c.json({
    uptime: process.uptime(),
    sessions: store.allSessions().length,
    clients: fanOut.clientCount,
  });
});

// --- Browser WebSocket (fan-out) ---

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      fanOut.addClient(ws);
    },
    onClose(_event, ws) {
      fanOut.removeClient(ws);
    },
  })),
);

// --- Static files (SPA) ---

app.use(
  "/*",
  serveStatic({ root: STATIC_ROOT }),
);

// SPA fallback — serve index.html for any path not matched above
app.get("*", serveStatic({ root: STATIC_ROOT, path: "index.html" }));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const server = serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, (info) => {
  console.log(`wmp-inspector listening on http://0.0.0.0:${info.port}`);
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Self ID:  ${SELF_ID}`);
});

injectWebSocket(server);
