import { useState } from "react";

export function InviteBox() {
  const [uri, setUri] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!uri.trim()) return;
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const resp = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: uri.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error ?? `HTTP ${resp.status}`);
      } else {
        setSuccess(`Joined session ${data.sessionId}`);
        setUri("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="invite-box">
      <h3>Accept Invitation</h3>
      <textarea
        placeholder="Paste wmp:// or https:// invitation URI…"
        value={uri}
        onChange={(e) => setUri(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      <button onClick={handleSubmit} disabled={loading || !uri.trim()}>
        {loading ? "Joining…" : "Join Session"}
      </button>
      {error && <div className="invite-error">{error}</div>}
      {success && <div className="invite-success">{success}</div>}
    </div>
  );
}
