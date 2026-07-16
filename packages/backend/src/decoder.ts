/**
 * Payload decoder — JWT, CBOR, base64url JSON.
 */

/**
 * Attempt to decode a string payload.
 * Tries JWT (dot-separated), then base64url JSON, then returns as-is.
 */
export function decodePayload(input: string): {
  format: string;
  decoded: unknown;
} {
  // JWT: three dot-separated base64url parts
  const parts = input.split(".");
  if (parts.length === 3) {
    try {
      const header = JSON.parse(b64urlDecode(parts[0]));
      const payload = JSON.parse(b64urlDecode(parts[1]));
      return {
        format: "jwt",
        decoded: { header, payload, signature: parts[2] },
      };
    } catch {
      // not a valid JWT
    }
  }

  // SD-JWT: contains ~ separators
  if (input.includes("~")) {
    try {
      const sdParts = input.split("~").filter(Boolean);
      const decoded: unknown[] = [];
      for (const part of sdParts) {
        const dotParts = part.split(".");
        if (dotParts.length === 3) {
          // JWT component
          const header = JSON.parse(b64urlDecode(dotParts[0]));
          const payload = JSON.parse(b64urlDecode(dotParts[1]));
          decoded.push({ type: "jwt", header, payload });
        } else {
          // Disclosure
          try {
            const disc = JSON.parse(b64urlDecode(part));
            decoded.push({ type: "disclosure", value: disc });
          } catch {
            decoded.push({ type: "raw", value: part });
          }
        }
      }
      return { format: "sd-jwt", decoded };
    } catch {
      // not SD-JWT
    }
  }

  // Base64url-encoded JSON
  try {
    const json = JSON.parse(b64urlDecode(input));
    return { format: "base64url-json", decoded: json };
  } catch {
    // not base64url JSON
  }

  // Raw JSON
  try {
    const json = JSON.parse(input);
    return { format: "json", decoded: json };
  } catch {
    // not JSON
  }

  return { format: "text", decoded: input };
}

function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const final = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(final);
}
