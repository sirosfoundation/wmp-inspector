import { useState } from "react";

export function Decoder() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{
    format: string;
    decoded: unknown;
  } | null>(null);

  const handleDecode = async () => {
    if (!input.trim()) return;
    try {
      const resp = await fetch("/api/decode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: input.trim() }),
      });
      const data = await resp.json();
      setResult(data);
    } catch {
      setResult({ format: "error", decoded: "Failed to decode" });
    }
  };

  return (
    <div className="decoder">
      <h3>Payload Decoder</h3>
      <textarea
        placeholder="Paste JWT, base64url, or JSON payload…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <button onClick={handleDecode}>Decode</button>

      {result && (
        <div className="decoder-result">
          <div className="decoder-format">{result.format}</div>
          <div className="decoder-output">
            {JSON.stringify(result.decoded, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
