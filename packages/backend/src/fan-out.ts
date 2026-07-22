/**
 * Fan-out: broadcast store events to all connected browser WebSocket clients.
 */

import type { WSContext } from "hono/ws";
import type { SessionStore, StoreEvent, StoreListener } from "./session-store.js";

export class FanOut {
  private clients = new Set<WSContext>();
  private unsub: (() => void) | undefined;

  constructor(private store: SessionStore) {}

  start(): void {
    const listener: StoreListener = (event: StoreEvent) => {
      this.broadcast(event);
    };
    this.unsub = this.store.subscribe(listener);
  }

  stop(): void {
    this.unsub?.();
  }

  addClient(ws: WSContext): void {
    this.clients.add(ws);

    // Send snapshot on connect
    const snapshot = this.store.snapshot();
    try {
      ws.send(
        JSON.stringify({ type: "snapshot", ...snapshot }),
      );
    } catch {
      // client may have disconnected immediately
    }
  }

  removeClient(ws: WSContext): void {
    this.clients.delete(ws);
  }

  private broadcast(event: StoreEvent): void {
    // Convert Map members to arrays for JSON serialization
    let serializable: unknown = event;
    if (event.type === "session") {
      serializable = {
        ...event,
        session: {
          ...event.session,
          members: [...event.session.members.values()],
        },
      };
    }
    const data = JSON.stringify(serializable);
    for (const client of this.clients) {
      try {
        client.send(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
