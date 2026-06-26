import { EventEmitter } from "node:events";

export interface VoicePlayerLike extends EventEmitter {
  play(resource: unknown): void;
  pause(): boolean;
  unpause(): boolean;
  stop(force?: boolean): boolean;
}
export interface VoiceConnectionLike extends EventEmitter {
  destroy(): void;
  readonly state: { status: string };
}
export interface VoiceSessionOptions {
  channelId: string;
  idleTimeoutMs: number;
}

const IDLE = "idle";

export class VoiceSession extends EventEmitter {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private readonly onStateChange = (
    oldState: { status: string },
    newState: { status: string },
  ): void => {
    if (newState.status === IDLE && oldState.status !== IDLE) {
      this.emit("trackEnd");
    }
  };

  private readonly onPlayerError = (err: unknown): void => {
    this.emit("error", err);
  };

  constructor(
    private readonly connection: VoiceConnectionLike,
    private readonly player: VoicePlayerLike,
    private readonly opts: VoiceSessionOptions,
  ) {
    super();
    this.player.on("stateChange", this.onStateChange);
    this.player.on("error", this.onPlayerError);
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  play(resource: unknown): void {
    this.cancelIdleTimer();
    this.player.play(resource);
  }
  pause(): void {
    this.player.pause();
  }
  resume(): void {
    this.player.unpause();
  }
  skip(): void {
    this.player.stop();
  }
  stop(): void {
    this.player.stop(true);
  }

  startIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.emit("idle");
    }, this.opts.idleTimeoutMs);
  }
  cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelIdleTimer();
    this.player.removeListener("stateChange", this.onStateChange);
    this.player.removeListener("error", this.onPlayerError);
    if (this.connection.state.status !== "destroyed") {
      this.connection.destroy();
    }
  }
}
