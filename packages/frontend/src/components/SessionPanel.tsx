import type { SessionSummary } from "../ws-client.js";

export function SessionPanel({ session }: { session: SessionSummary }) {
  return (
    <div className="session-panel">
      <h3>Session Detail</h3>

      <dl className="session-detail">
        <dt>Session ID</dt>
        <dd>{session.sessionId}</dd>

        <dt>Created</dt>
        <dd>{new Date(session.createdAt).toLocaleString()}</dd>

        {session.provider && (
          <>
            <dt>Provider</dt>
            <dd>{session.provider}</dd>
          </>
        )}

        {session.sender && (
          <>
            <dt>Sender</dt>
            <dd>{session.sender}</dd>
          </>
        )}

        {session.securityMode && (
          <>
            <dt>Security</dt>
            <dd>{session.securityMode}</dd>
          </>
        )}

        {session.mlsGroupId && (
          <>
            <dt>MLS Group</dt>
            <dd>{session.mlsGroupId}</dd>
          </>
        )}

        {session.mlsEpoch !== undefined && (
          <>
            <dt>MLS Epoch</dt>
            <dd>{session.mlsEpoch}</dd>
          </>
        )}

        {session.cipherSuite !== undefined && (
          <>
            <dt>Cipher Suite</dt>
            <dd>0x{session.cipherSuite.toString(16).padStart(4, "0")}</dd>
          </>
        )}
      </dl>

      <h3>Members ({session.members.length})</h3>
      <div className="member-list">
        {session.members.map((m) => (
          <div key={m.participant} className="member-item">
            <div>{m.participant}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
              joined {new Date(m.joinedAt).toLocaleTimeString()}
            </div>
            {m.capabilities && (
              <div style={{ color: "var(--text-muted)", fontSize: 10 }}>
                caps: {Object.keys(m.capabilities).join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
