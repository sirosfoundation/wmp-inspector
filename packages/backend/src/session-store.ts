/**
 * In-memory store for WMP sessions and message logs.
 * Purely ephemeral — restarts clear everything.
 */

export interface LogEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  direction: "in" | "out";
  method?: string;
  /** Full JSON-RPC message */
  raw: unknown;
  /** Decoded payload (if applicable) */
  decoded?: unknown;
}

export interface MemberInfo {
  participant: string;
  joinedAt: string;
  identityAssertions?: unknown[];
  trustHints?: unknown[];
  capabilities?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: string;
  provider?: string;
  sender?: string;
  securityMode?: string;
  mlsGroupId?: string;
  mlsEpoch?: number;
  cipherSuite?: number;
  members: Map<string, MemberInfo>;
}

export type StoreEvent =
  | { type: "session"; session: SessionInfo }
  | { type: "message"; entry: LogEntry }
  | { type: "member"; sessionId: string; member: MemberInfo }
  | { type: "epoch"; sessionId: string; epoch: number };

export type StoreListener = (event: StoreEvent) => void;

let counter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++counter}`;
}

export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private logs = new Map<string, LogEntry[]>();
  private listeners = new Set<StoreListener>();
  /** Global log (all sessions) capped at maxEntries */
  private maxEntries = 10_000;

  // --- Listeners ---

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  // --- Sessions ---

  createSession(sessionId: string, opts?: Partial<SessionInfo>): SessionInfo {
    const info: SessionInfo = {
      sessionId,
      createdAt: new Date().toISOString(),
      members: new Map(),
      ...opts,
    };
    this.sessions.set(sessionId, info);
    this.logs.set(sessionId, []);
    this.emit({ type: "session", session: info });
    return info;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  allSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  // --- Members ---

  addMember(sessionId: string, member: MemberInfo): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.members.set(member.participant, member);
      this.emit({ type: "member", sessionId, member });
    }
  }

  updateEpoch(sessionId: string, epoch: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.mlsEpoch = epoch;
      this.emit({ type: "epoch", sessionId, epoch });
    }
  }

  // --- Message log ---

  log(
    sessionId: string,
    direction: "in" | "out",
    raw: unknown,
    method?: string,
    decoded?: unknown,
  ): LogEntry {
    const entry: LogEntry = {
      id: nextId(),
      timestamp: new Date().toISOString(),
      sessionId,
      direction,
      method,
      raw,
      decoded,
    };

    let list = this.logs.get(sessionId);
    if (!list) {
      list = [];
      this.logs.set(sessionId, list);
    }
    list.push(entry);

    // Cap per-session log
    if (list.length > this.maxEntries) {
      list.splice(0, list.length - this.maxEntries);
    }

    this.emit({ type: "message", entry });
    return entry;
  }

  getLog(sessionId: string): LogEntry[] {
    return this.logs.get(sessionId) ?? [];
  }

  allLogs(): LogEntry[] {
    const all: LogEntry[] = [];
    for (const entries of this.logs.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return all;
  }

  // --- Snapshot for new browser connections ---

  snapshot(): {
    sessions: Array<{
      sessionId: string;
      createdAt: string;
      provider?: string;
      sender?: string;
      securityMode?: string;
      mlsGroupId?: string;
      mlsEpoch?: number;
      cipherSuite?: number;
      members: Array<MemberInfo>;
    }>;
    logs: LogEntry[];
  } {
    const sessions = this.allSessions().map((s) => ({
      ...s,
      members: [...s.members.values()],
    }));
    return { sessions, logs: this.allLogs() };
  }
}
