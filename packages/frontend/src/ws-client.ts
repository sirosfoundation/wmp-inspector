/**
 * WebSocket client — connects to the backend fan-out WS and dispatches events.
 */

export type StoreEvent =
  | { type: "snapshot"; sessions: SessionSummary[]; logs: LogEntry[] }
  | { type: "session"; session: SessionSummary }
  | { type: "message"; entry: LogEntry }
  | { type: "member"; sessionId: string; member: MemberInfo }
  | { type: "epoch"; sessionId: string; epoch: number };

export interface LogEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  direction: "in" | "out";
  method?: string;
  raw: unknown;
  decoded?: unknown;
}

export interface MemberInfo {
  participant: string;
  joinedAt: string;
  identityAssertions?: unknown[];
  trustHints?: unknown[];
  capabilities?: Record<string, unknown>;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  provider?: string;
  sender?: string;
  securityMode?: string;
  mlsGroupId?: string;
  mlsEpoch?: number;
  cipherSuite?: number;
  members: MemberInfo[];
}

export type EventHandler = (event: StoreEvent) => void;

export class InspectorClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url?: string) {}

  connect(): void {
    const wsUrl =
      this.url ??
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data as string) as StoreEvent;
        for (const handler of this.handlers) {
          handler(event);
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      // Auto-reconnect after 2s
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
