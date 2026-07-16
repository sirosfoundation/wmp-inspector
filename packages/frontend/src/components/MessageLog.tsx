import { useState } from "react";
import type { LogEntry } from "../ws-client.js";

export function MessageLog({ entries }: { entries: LogEntry[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (entries.length === 0) {
    return (
      <div className="empty-state">
        No messages yet. Paste an invitation URI to get started.
      </div>
    );
  }

  return (
    <div className="message-log">
      <div className="message-log-header">
        <span style={{ width: 90 }}>Time</span>
        <span style={{ width: 30, textAlign: "center" }}>Dir</span>
        <span style={{ flex: 1 }}>Method</span>
        <span style={{ width: 120, textAlign: "right" }}>Session</span>
      </div>
      {entries.map((entry) => (
        <div key={entry.id}>
          <div
            className={`log-entry ${expandedId === entry.id ? "expanded" : ""}`}
            onClick={() =>
              setExpandedId(expandedId === entry.id ? null : entry.id)
            }
          >
            <span className="log-time">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span className={`log-direction ${entry.direction}`}>
              {entry.direction === "in" ? "◀" : "▶"}
            </span>
            <span className="log-method">{entry.method ?? "—"}</span>
            <span className="log-session">
              {entry.sessionId.slice(0, 12)}…
            </span>
          </div>
          {expandedId === entry.id && (
            <div className="log-expanded">
              <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
              {entry.decoded != null && (
                <>
                  <div
                    style={{
                      marginTop: 8,
                      color: "var(--accent-yellow)",
                      fontSize: 11,
                    }}
                  >
                    DECODED
                  </div>
                  <pre>{JSON.stringify(entry.decoded as object, null, 2)}</pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
