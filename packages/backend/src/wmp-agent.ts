/**
 * WMP Agent — the inspector's WMP peer that joins sessions and logs everything.
 *
 * Uses wmp-js Peer + WebSocketTransport or HttpSseTransport. When an
 * invitation is accepted, the agent connects to the inviter's relay and
 * establishes a WMP session.
 */

import { EventSource } from "eventsource";

import {
  Peer,
  WebSocketTransport,
  HttpSseTransport,
  parseInvitationURI,
  type Handler,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionResumeResult,
  type SessionCloseParams,
  type MessageDeliverParams,
  type MessageAckParams,
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
  invitation?: Invitation;
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
    let discovered:
      | Awaited<ReturnType<typeof discoverEndpoint>>
      | undefined;
    if (!relayUrl) {
      discovered = await discoverEndpoint(invitation.provider);
      relayUrl =
        discovered.endpoints.rpc ??
        discovered.endpoints.websocket ??
        discovered.endpoints.relay;
      if (!relayUrl) {
        throw new Error(
          `No relay endpoint found for provider ${invitation.provider}`,
        );
      }
    }

    const handler = this.createHandler({
      sessionId: invitation.session_id,
      sender: invitation.sender,
    });
    const { peer } = await this.connect(relayUrl, discovered, handler);

    // Create session (include invitation nonce for correlation)
    const result = await peer.createSession({
      sender: this.selfIdentifier,
      capabilities: { inspector: true },
      security: { mode: "tls" },
      invitationNonce: invitation.nonce,
    });
    return this.finishJoin(peer, result, {
      provider: invitation.provider,
      sender: invitation.sender,
      invitation,
    });
  }

  /**
   * Resume an existing WMP session on a relay. Used when the inspector is
   * given a resumption token (e.g. from wmp-cli) to observe traffic.
   */
  async resumeSession(opts: {
    relayUrl: string;
    sessionId: string;
    resumptionToken: string;
  }): Promise<string> {
    const { relayUrl, sessionId, resumptionToken } = opts;
    const handler = this.createHandler({ sessionId, sender: this.selfIdentifier });
    const discovered = relayUrl.startsWith("https://")
      ? await discoverEndpoint(relayUrl)
      : undefined;
    const { peer } = await this.connect(relayUrl, discovered, handler, sessionId);

    const result = await peer.call<SessionResumeResult>("wmp.session.resume", {
      wmp: { version: VERSION, session_id: sessionId, sender: this.selfIdentifier },
      session_id: sessionId,
      resumption_token: resumptionToken,
    });

    return this.finishJoin(peer, result, {
      provider: relayUrl,
      sender: this.selfIdentifier,
    });
  }

  private async connect(
    relayUrl: string,
    discovered:
      | Awaited<ReturnType<typeof discoverEndpoint>>
      | undefined,
    handler: Handler,
    sessionId?: string,
  ): Promise<{ peer: Peer; transport: WebSocketTransport | HttpSseTransport }> {
    // HTTP+SSE relay (e.g. go-wmp HTTPSSE relay)
    if (
      relayUrl.startsWith("http://") ||
      relayUrl.startsWith("https://") ||
      discovered?.endpoints?.rpc
    ) {
      let rpcUrl = relayUrl;
      let eventsUrl = relayUrl.endsWith("/")
        ? relayUrl + "events"
        : relayUrl + "/events";
      if (discovered?.endpoints?.rpc && discovered?.endpoints?.events) {
        rpcUrl = discovered.endpoints.rpc;
        eventsUrl = discovered.endpoints.events;
      } else if (discovered?.endpoints?.relay) {
        // Legacy HTTPSSE endpoint advertised as "relay" without separate rpc/events.
        rpcUrl = discovered.endpoints.relay;
        eventsUrl = discovered.endpoints.relay.endsWith("/")
          ? discovered.endpoints.relay + "events"
          : discovered.endpoints.relay + "/events";
      }
      const sseTransport = new HttpSseTransport(rpcUrl, eventsUrl, {
        EventSource: EventSource as unknown as typeof globalThis.EventSource,
      });
      const peer = new Peer(sseTransport, { handler });
      if (sessionId) {
        sseTransport.setSessionId(sessionId);
      }
      sseTransport.connectSSE();
      await this.waitForTransportOpen(sseTransport);
      return { peer, transport: sseTransport };
    }

    // WebSocket relay
    const wsTransport = new WebSocketTransport(relayUrl);
    const peer = new Peer(wsTransport, { handler });
    await this.waitForTransportOpen(wsTransport);
    return { peer, transport: wsTransport };
  }

  private waitForTransportOpen(
    transport: WebSocketTransport | HttpSseTransport,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
  }

  private finishJoin(
    peer: Peer,
    result: SessionCreateResult | SessionResumeResult,
    opts: {
      provider?: string;
      sender?: string;
      invitation?: Invitation;
    },
  ): string {
    const sessionId = result.wmp?.session_id ?? `inspector-${Date.now()}`;

    // Store session info
    this.store.createSession(sessionId, {
      provider: opts.provider,
      sender: opts.sender,
      securityMode: "tls",
    });

    // Add inviter/sender as member
    if (opts.sender) {
      this.store.addMember(sessionId, {
        participant: opts.sender,
        joinedAt: new Date().toISOString(),
      });
    }

    // Add self as member
    this.store.addMember(sessionId, {
      participant: this.selfIdentifier,
      joinedAt: new Date().toISOString(),
      capabilities: { inspector: true },
    });

    // Log the session creation/resumption
    const method = "resumption_token" in result ? "wmp.session.resume" : "wmp.session.create";
    this.store.log(sessionId, "out", { method }, method);
    this.store.log(sessionId, "in", result, `${method} (response)`);

    this.sessions.set(sessionId, { peer, sessionId, invitation: opts.invitation });

    return sessionId;
  }

  private createHandler(context: {
    sessionId?: string;
    sender?: string;
  }): Handler {
    const store = this.store;
    const sessionIdRef = { current: context.sessionId ?? "" };

    // Helper to resolve session ID (may not be known at handler creation time)
    const sid = () => sessionIdRef.current || context.sessionId || "unknown";

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

      onMessageDeliver(params: MessageDeliverParams): void {
        const sessionId = params.wmp?.session_id ?? sid();
        sessionIdRef.current = sessionId;
        store.log(sessionId, "in", params, "wmp.message.deliver");
      },

      onMessageAck(params: MessageAckParams): void {
        const sessionId = params.wmp?.session_id ?? sid();
        sessionIdRef.current = sessionId;
        store.log(sessionId, "in", params, "wmp.message.ack");
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
