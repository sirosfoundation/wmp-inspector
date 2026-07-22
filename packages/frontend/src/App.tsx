import { useState, useEffect, useCallback, useRef } from "react";
import { InspectorClient } from "./ws-client.js";
import type {
  StoreEvent,
  LogEntry,
  SessionSummary,
  MemberInfo,
} from "./ws-client.js";
import { MessageLog } from "./components/MessageLog.js";
import { SessionPanel } from "./components/SessionPanel.js";
import { InviteBox } from "./components/InviteBox.js";
import { Decoder } from "./components/Decoder.js";
import "./app.css";

export function App() {
  const clientRef = useRef<InspectorClient | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const client = new InspectorClient();
    clientRef.current = client;

    const unsub = client.subscribe((event: StoreEvent) => {
      switch (event.type) {
        case "snapshot":
          setSessions(event.sessions);
          setLogs(event.logs);
          break;

        case "session":
          setSessions((prev) => {
            const exists = prev.find(
              (s) => s.sessionId === event.session.sessionId,
            );
            if (exists) {
              return prev.map((s) =>
                s.sessionId === event.session.sessionId ? event.session : s,
              );
            }
            return [...prev, event.session];
          });
          break;

        case "message":
          setLogs((prev) => [...prev, event.entry]);
          break;

        case "member":
          setSessions((prev) =>
            prev.map((s) => {
              if (s.sessionId !== event.sessionId) return s;
              const memberExists = s.members.some(
                (m) => m.participant === event.member.participant,
              );
              return {
                ...s,
                members: memberExists
                  ? s.members.map((m) =>
                      m.participant === event.member.participant
                        ? event.member
                        : m,
                    )
                  : [...s.members, event.member],
              };
            }),
          );
          break;

        case "epoch":
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === event.sessionId
                ? { ...s, mlsEpoch: event.epoch }
                : s,
            ),
          );
          break;
      }
    });

    client.connect();

    const interval = setInterval(() => {
      setConnected(client.connected);
    }, 1000);

    return () => {
      unsub();
      clearInterval(interval);
      client.disconnect();
    };
  }, []);

  const filteredLogs = selectedSession
    ? logs.filter((l) => l.sessionId === selectedSession)
    : logs;

  const selectedSessionInfo = selectedSession
    ? sessions.find((s) => s.sessionId === selectedSession) ?? null
    : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>WMP Inspector</h1>
        <span className={`status ${connected ? "connected" : "disconnected"}`}>
          {connected ? "● Connected" : "○ Disconnected"}
        </span>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <InviteBox />

          <div className="session-list">
            <h3>Sessions ({sessions.length})</h3>
            <button
              className={`session-item ${!selectedSession ? "active" : ""}`}
              onClick={() => setSelectedSession(null)}
            >
              All sessions
            </button>
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                className={`session-item ${selectedSession === s.sessionId ? "active" : ""}`}
                onClick={() => setSelectedSession(s.sessionId)}
              >
                <span className="session-id">
                  {s.sessionId.slice(0, 16)}…
                </span>
                <span className="session-meta">
                  {s.provider ?? "unknown"} · {s.members?.length ?? 0} members
                </span>
              </button>
            ))}
          </div>

          {selectedSessionInfo && (
            <SessionPanel session={selectedSessionInfo} />
          )}
        </aside>

        <main className="main-content">
          <MessageLog entries={filteredLogs} />
        </main>

        <aside className="right-panel">
          <Decoder />
        </aside>
      </div>

      <footer className="app-footer">
        <span>wmp-inspector</span>
        <span>{__BUILD_SHA__}</span>
        <span>{__BUILD_TIME__}</span>
      </footer>
    </div>
  );
}
