import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket as WsWebSocket } from "@fastify/websocket";
import { canControl } from "../auth/authz.js";

type Send = (payload: unknown) => void;

interface ControllerLike {
  on(event: "changed", listener: () => void): unknown;
  snapshot(): unknown;
}

export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  return !!origin && allowed.includes(origin);
}

export class GuildBroadcaster {
  private readonly subs = new Map<string, Set<Send>>();
  private readonly wired = new Set<string>();

  subscribe(guildId: string, send: Send): void {
    let set = this.subs.get(guildId);
    if (!set) this.subs.set(guildId, (set = new Set()));
    set.add(send);
  }
  unsubscribe(guildId: string, send: Send): void {
    this.subs.get(guildId)?.delete(send);
  }
  broadcast(guildId: string, payload: unknown): void {
    for (const send of this.subs.get(guildId) ?? []) send(payload);
  }
  attach(guildId: string, controller: ControllerLike): void {
    if (this.wired.has(guildId)) return;
    this.wired.add(guildId);
    // The controller re-emits "changed" for every relevant change: queue
    // mutations (add/remove/reorder/advance) AND playback state (pause/resume/stop).
    // Include guildId so every pushed state frame is self-describing and consistent with
    // the subscribe-response below — a single socket may subscribe to multiple guilds, so
    // the client needs a discriminator to know which guild an update belongs to.
    controller.on("changed", () =>
      this.broadcast(guildId, { type: "state", guildId, state: controller.snapshot() }),
    );
  }
}

export interface WsDeps {
  broadcaster: GuildBroadcaster;
  hub: { get(guildId: string): ControllerLike };
  client: Parameters<typeof canControl>[0];
  adminIds: ReadonlySet<string>;
  allowedOrigins: readonly string[];
  revalidateMs?: number;
}

// Glue: registers the /ws route (manual-verify with a real browser).
export function registerWebsocket(app: FastifyInstance, deps: WsDeps): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") {
      if (!isAllowedOrigin(req.headers.origin, deps.allowedOrigins)) {
        await reply.code(403).send({ error: "bad_origin" });
      }
    }
  });

  app.get("/ws", { websocket: true }, (socket: WsWebSocket, req: FastifyRequest) => {
    const userId = (req as { session?: { userId?: string } }).session?.userId;
    if (!userId) {
      socket.close(1008, "unauthenticated");
      return;
    }
    const send: Send = (p) => socket.send(JSON.stringify(p));
    const subscribed = new Set<string>();
    // Guards the subscribe-after-close race: the async authz check below yields, so the
    // socket can close (running the cleanup loop while `subscribed` is still empty) before
    // canControl resolves. Without this flag the late subscribe would register an orphaned
    // `send` in the broadcaster that nothing ever removes.
    let closed = false;

    socket.on("message", (raw) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // JSON.parse("null"), "123", "[]", '"x"' are all valid JSON but not control
        // messages. Silently ignore any non-object payload — otherwise `msg.subscribe`
        // below would throw (e.g. on null) and reject the IIFE as an unhandled rejection.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
        const msg = parsed as { subscribe?: string; unsubscribe?: string };
        if (msg.subscribe) {
          const gid = msg.subscribe;
          if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
            send({ type: "error", guildId: gid, reason: "forbidden" });
            return;
          }
          if (closed) return;
          const ctrl = deps.hub.get(gid);
          deps.broadcaster.attach(gid, ctrl);
          deps.broadcaster.subscribe(gid, send);
          subscribed.add(gid);
          send({ type: "state", guildId: gid, state: ctrl.snapshot() });
        }
        if (msg.unsubscribe) {
          deps.broadcaster.unsubscribe(msg.unsubscribe, send);
          subscribed.delete(msg.unsubscribe);
        }
      })();
    });

    const iv = setInterval(() => {
      void (async () => {
        for (const gid of subscribed) {
          if (closed) return;
          if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
            if (closed) return;
            deps.broadcaster.unsubscribe(gid, send);
            subscribed.delete(gid);
            send({ type: "revoked", guildId: gid });
          }
        }
      })();
    }, deps.revalidateMs ?? 30_000);

    socket.on("close", () => {
      closed = true;
      clearInterval(iv);
      for (const gid of subscribed) deps.broadcaster.unsubscribe(gid, send);
    });
  });
}
