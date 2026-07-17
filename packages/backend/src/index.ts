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
import { InspectorMlsProvider } from "./mls-provider.js";

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
const mlsProvider = new InspectorMlsProvider(SELF_ID);

fanOut.start();

// ---------------------------------------------------------------------------
// WMP response builder — generates valid responses for incoming requests
// ---------------------------------------------------------------------------

function buildResponse(
  id: string | number,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string,
): Record<string, unknown> {
  const wmpMeta = { version: "0.1", session_id: sessionId };

  switch (method) {
    case "wmp.session.create":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          wmp: wmpMeta,
          security: (params as Record<string, unknown>)?.security ?? { mode: "tls" },
        },
      };

    case "wmp.flow.start":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          wmp: wmpMeta,
          flow_id:
            (params as Record<string, unknown>)?.flow_id ?? `flow-${Date.now()}`,
          flow_type:
            (params as Record<string, unknown>)?.flow_type ?? "unknown",
        },
      };

    case "wmp.resolve":
      return {
        jsonrpc: "2.0",
        id,
        result: { wmp: wmpMeta },
      };

    default:
      return {
        jsonrpc: "2.0",
        id,
        result: { wmp: wmpMeta },
      };
  }
}

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

// --- MLS API ---

app.post("/api/mls/key-package", async (c) => {
  try {
    const body = await c.req.json<{ cipher_suite?: number }>().catch(() => ({ cipher_suite: undefined }));
    const kp = await mlsProvider.generateKeyPackage(body.cipher_suite);
    return c.json(kp);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mls/group", async (c) => {
  try {
    const body = await c.req.json<{ cipher_suite?: number }>().catch(() => ({ cipher_suite: undefined }));
    const group = await mlsProvider.createMlsGroup(body.cipher_suite);
    return c.json(group);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mls/group/:id/add", async (c) => {
  try {
    const groupId = c.req.param("id");
    const body = await c.req.json<{ key_package: string }>();
    const result = await mlsProvider.addMember(groupId, body.key_package);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mls/group/:id/encrypt", async (c) => {
  try {
    const groupId = c.req.param("id");
    const body = await c.req.json<{ plaintext: string }>();
    const plaintext = new TextEncoder().encode(body.plaintext);
    const result = await mlsProvider.encrypt(groupId, plaintext);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mls/group/:id/decrypt", async (c) => {
  try {
    const groupId = c.req.param("id");
    const body = await c.req.json<{ ciphertext: string }>();
    const result = await mlsProvider.decrypt(groupId, body.ciphertext);
    return c.json({
      plaintext: new TextDecoder().decode(result.plaintext),
      epoch: result.epoch,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post("/api/mls/welcome", async (c) => {
  try {
    const body = await c.req.json<{ welcome: string }>();
    const result = await mlsProvider.processWelcome(body.welcome);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/status", (c) => {
  return c.json({
    uptime: process.uptime(),
    sessions: store.allSessions().length,
    clients: fanOut.clientCount,
    mls: {
      groups: mlsProvider.groupCount,
      keyPackages: mlsProvider.keyPackageCount,
    },
  });
});

// --- HTTP+SSE transport (WMP spec §4.5) ---

// SSE clients keyed by session ID
const sseClients = new Map<string, Set<WritableStreamDefaultWriter<Uint8Array>>>();

// POST /wmp/rpc — receive JSON-RPC requests, return responses synchronously
app.post("/wmp/rpc", async (c) => {
  try {
    const raw = await c.req.json();
    const method: string = raw.method ?? "(response)";
    const sessionIdHeader = c.req.header("Wmp-Session-Id");
    const sid: string = raw.params?.wmp?.session_id ?? sessionIdHeader ?? `rpc-${Date.now()}`;

    // Log inbound
    store.log(sid, "in", raw, method);

    // Ensure session exists
    if (!store.getSession(sid)) {
      store.createSession(sid, { securityMode: "tls" });
    }

    // Track sender as member
    if (raw.params?.wmp?.sender) {
      store.addMember(sid, {
        participant: raw.params.wmp.sender,
        joinedAt: new Date().toISOString(),
      });
    }

    // If it's a request (has id and method), return a JSON-RPC response
    if (raw.id !== undefined && raw.method) {
      const response = buildResponse(raw.id, method, raw.params, sid);
      store.log(sid, "out", response, `${method} (response)`);
      return c.json(response);
    }

    // Notifications: accepted, push to SSE if anyone is listening
    const writers = sseClients.get(sid);
    if (writers) {
      const eventData = `event: wmp\ndata: ${JSON.stringify(raw)}\n\n`;
      const encoded = new TextEncoder().encode(eventData);
      for (const writer of writers) {
        try { await writer.write(encoded); } catch { writers.delete(writer); }
      }
    }

    return c.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

// GET /wmp/events — SSE stream for server→client messages
app.get("/wmp/events", (c) => {
  const sessionId = c.req.query("session_id") ?? "unknown";

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  // Register this SSE client
  let clients = sseClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    sseClients.set(sessionId, clients);
  }
  clients.add(writer);

  // Subscribe to store events for this session
  const unsub = store.subscribe((event) => {
    if (event.type === "message" && event.entry.sessionId === sessionId && event.entry.direction === "out") {
      const data = `event: wmp\ndata: ${JSON.stringify(event.entry.raw)}\n\n`;
      writer.write(new TextEncoder().encode(data)).catch(() => {});
    }
  });

  // Send initial comment to keep connection alive
  writer.write(new TextEncoder().encode(": connected\n\n")).catch(() => {});

  // Cleanup on close
  c.req.raw.signal.addEventListener("abort", () => {
    unsub();
    clients?.delete(writer);
    if (clients?.size === 0) sseClients.delete(sessionId);
    writer.close().catch(() => {});
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
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

// --- WMP WebSocket endpoint (protocol peer) ---

app.get(
  "/wmp/ws",
  upgradeWebSocket(() => {
    let sessionId = `ws-${Date.now()}`;

    return {
      onOpen() {
        store.createSession(sessionId, {
          securityMode: "tls",
        });
      },

      onMessage(evt, ws) {
        try {
          const raw = JSON.parse(typeof evt.data === "string" ? evt.data : evt.data.toString());
          const method: string = raw.method ?? "(response)";
          const sid: string = raw.params?.wmp?.session_id ?? sessionId;
          const sender: string = raw.params?.wmp?.sender ?? "unknown";

          // Log inbound
          store.log(sid, "in", raw, method);

          // Track session ID from session.create
          if (method === "wmp.session.create") {
            sessionId = sid || sessionId;
            if (raw.params?.wmp?.sender) {
              store.addMember(sessionId, {
                participant: raw.params.wmp.sender,
                joinedAt: new Date().toISOString(),
              });
            }
          }

          // If it's a request (has id), send a response
          if (raw.id !== undefined && raw.method) {
            const response = buildResponse(raw.id, method, raw.params, sessionId);
            store.log(sessionId, "out", response, `${method} (response)`);
            ws.send(JSON.stringify(response));
          }
        } catch {
          // ignore malformed messages
        }
      },

      onClose() {
        // session stays in store for review
      },
    };
  }),
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
