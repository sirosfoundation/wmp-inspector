/**
 * /.well-known/wmp-configuration endpoint.
 */

import { Hono } from "hono";

export function wellKnownRoutes(baseUrl: string): Hono {
  const app = new Hono();

  app.get("/.well-known/wmp-configuration", (c) => {
    const wsUrl = baseUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://");

    return c.json({
      supported_versions: ["0.1"],
      endpoints: {
        websocket: `${wsUrl}/wmp/ws`,
        relay: `${wsUrl}/wmp/ws`,
        rpc: `${baseUrl}/wmp/rpc`,
        events: `${baseUrl}/wmp/events`,
      },
      security_modes: ["tls"],
      capabilities: {
        inspector: true,
      },
    });
  });

  return app;
}
