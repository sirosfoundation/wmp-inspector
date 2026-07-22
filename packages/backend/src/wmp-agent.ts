/**
 * WMP Agent — the inspector's WMP peer that joins sessions and logs everything.
 *
 * Uses wmp-js Peer + WebSocketTransport. When an invitation is accepted,
 * the agent connects to the inviter's relay and establishes a WMP session.
 */

import {
  Peer,
  WebSocketTransport,
  parseInvitationURI,
  type Handler,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionCloseParams,
  type FlowStartParams,
  type FlowStartResult,
  type FlowProgressParams,
  type FlowActionParams,
  type FlowActionResult,
  type FlowCompleteParams,
  type FlowErrorParams,
  type FlowCancelParams,
  type FlowCancelResult,
  type ResolveParams,
  type ResolveResult,
  type Invitation,
  discoverEndpoint,
  VERSION,
} from "@sirosfoundation/wmp-js";
import type { SessionStore } from "./session-store.js";

export interface AgentSession {
  peer: Peer;
  sessionId: string;
  invitation: Invitation;
}

export class WMPAgent {
  private sessions = new Map<string, AgentSession>();

  constructor(
    private store: SessionStore,
    private selfIdentifier: string,
  ) {}

  /**
   * Accept an invitation URI and join the session.
   * Returns the session ID on success.
   */
  async acceptInvitation(uri: string): Promise<string> {
    // Parse invitation from either wmp:// or https:// URI
    let invitation: Invitation;
    if (uri.startsWith("wmp://")) {
      invitation = parseInvitationURI(uri);
    } else if (uri.startsWith("https://") && uri.includes("/wmp/invite#")) {
      // HTTPS fallback URI: https://<domain>/wmp/invite#<base64url>
      const fragment = uri.split("#")[1];
      if (!fragment) throw new Error("Missing invitation data in HTTPS URI fragment");
      const padded = fragment.replace(/-/g, "+").replace(/_/g, "/");
      const pad = padded.length % 4;
      const final = pad ? padded + "=".repeat(4 - pad) : padded;
      invitation = JSON.parse(atob(final)) as Invitation;
    } else {
      // Try as raw base64url JSON
      try {
        const padded = uri.replace(/-/g, "+").replace(/_/g, "/");
        const pad = padded.length % 4;
        const final = pad ? padded + "=".repeat(4 - pad) : padded;
        const json = atob(final);
        invitation = JSON.parse(json) as Invitation;
      } catch {
        throw new Error("Unrecognised invitation format");
      }
    }

    // Discover relay endpoint
    let relayUrl = invitation.relay;
    if (!relayUrl) {
      const config = await discoverEndpoint(invitation.provider);
      relayUrl = config.endpoints.websocket ?? config.endpoints.relay;
      if (!relayUrl) {
        throw new Error(
          `No relay endpoint found for provider ${invitation.provider}`,
        );
      }
    }

    // Ensure WebSocket URL
    if (relayUrl.startsWith("https://")) {
      relayUrl = relayUrl.replace("https://", "wss://");
    } else if (relayUrl.startsWith("http://")) {
      relayUrl = relayUrl.replace("http://", "ws://");
    }

    // Connect via WebSocket
    const transport = new WebSocketTransport(relayUrl);

    const handler = this.createHandler(invitation);
    const peer = new Peer(transport, { handler });

    // Wait for transport open
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        transport.off("open", onOpen);
        transport.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        transport.off("open", onOpen);
        transport.off("error", onError);
        reject(err);
      };
      transport.on("open", onOpen);
      transport.on("error", onError);
    });

    // Create session (include invitation nonce for correlation)
    const result = await peer.createSession({
      sender: this.selfIdentifier,
      capabilities: { inspector: true },
      security: { mode: "tls" },
      invitationNonce: invitation.nonce,
    });

    const sessionId = result.wmp?.session_id ?? `inspector-${Date.now()}`;

    // Store session info
    this.store.createSession(sessionId, {
      provider: invitation.provider,
      sender: invitation.sender,
      securityMode: "tls",
    });

    // Add inviter as member
    this.store.addMember(sessionId, {
      participant: invitation.sender,
      joinedAt: new Date().toISOString(),
    });

    // Add self as member
    this.store.addMember(sessionId, {
      participant: this.selfIdentifier,
      joinedAt: new Date().toISOString(),
      capabilities: { inspector: true },
    });

    // Log the session creation
    this.store.log(sessionId, "out", { method: "wmp.session.create" }, "wmp.session.create");
    this.store.log(sessionId, "in", result, "wmp.session.create (response)");

    this.sessions.set(sessionId, { peer, sessionId, invitation });

    return sessionId;
  }

  private createHandler(invitation: Invitation): Handler {
    const store = this.store;
    const sessionIdRef = { current: "" };

    // Helper to resolve session ID (may not be known at handler creation time)
    const sid = () => sessionIdRef.current || invitation.session_id || "unknown";

    return {
      async onSessionCreate(
        params: SessionCreateParams,
      ): Promise<SessionCreateResult> {
        const sessionId = params.wmp?.session_id ?? `s-${Date.now()}`;
        sessionIdRef.current = sessionId;
        store.log(sessionId, "in", params, "wmp.session.create");
        return {
          wmp: { version: VERSION, session_id: sessionId },
          security: { mode: "tls" },
        } as SessionCreateResult;
      },

      onSessionClose(params: SessionCloseParams): void {
        store.log(sid(), "in", params, "wmp.session.close");
      },

      async onFlowStart(params: FlowStartParams): Promise<FlowStartResult> {
        store.log(sid(), "in", params, "wmp.flow.start");
        return {
          wmp: { version: VERSION },
          flow_id: params.flow_id ?? `flow-${Date.now()}`,
          flow_type: params.flow_type ?? "unknown",
        } as FlowStartResult;
      },

      onFlowProgress(params: FlowProgressParams): void {
        store.log(sid(), "in", params, "wmp.flow.progress");
      },

      async onFlowAction(
        params: FlowActionParams,
      ): Promise<FlowActionResult> {
        store.log(sid(), "in", params, "wmp.flow.action");
        return { wmp: { version: VERSION } } as FlowActionResult;
      },

      onFlowComplete(params: FlowCompleteParams): void {
        store.log(sid(), "in", params, "wmp.flow.complete");
      },

      onFlowError(params: FlowErrorParams): void {
        store.log(sid(), "in", params, "wmp.flow.error");
      },

      async onFlowCancel(
        params: FlowCancelParams,
      ): Promise<FlowCancelResult> {
        store.log(sid(), "in", params, "wmp.flow.cancel");
        return { wmp: { version: VERSION } } as FlowCancelResult;
      },

      async onResolve(params: ResolveParams): Promise<ResolveResult> {
        store.log(sid(), "in", params, "wmp.resolve");
        return { wmp: { version: VERSION } } as ResolveResult;
      },
    };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  allSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        await session.peer.close();
      } catch {
        // ignore close errors
      }
      this.sessions.delete(sessionId);
    }
  }
}
