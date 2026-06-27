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
    controller.on("changed", () =>
      this.broadcast(guildId, { type: "state", state: controller.snapshot() }),
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

    socket.on("message", (raw) => {
      void (async () => {
        let msg: { subscribe?: string; unsubscribe?: string };
        try {
          msg = JSON.parse(raw.toString()) as { subscribe?: string; unsubscribe?: string };
        } catch {
          return;
        }
        if (msg.subscribe) {
          const gid = msg.subscribe;
          if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
            send({ type: "error", guildId: gid, reason: "forbidden" });
            return;
          }
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
          if (!(await canControl(deps.client, userId, gid, deps.adminIds))) {
            deps.broadcaster.unsubscribe(gid, send);
            subscribed.delete(gid);
            send({ type: "revoked", guildId: gid });
          }
        }
      })();
    }, deps.revalidateMs ?? 30_000);

    socket.on("close", () => {
      clearInterval(iv);
      for (const gid of subscribed) deps.broadcaster.unsubscribe(gid, send);
    });
  });
}
