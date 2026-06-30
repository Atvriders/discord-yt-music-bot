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
  // Mutable so the idle timeout can be reconfigured at runtime (per-guild panel setting).
  private idleTimeoutMs: number;

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

  // A do-nothing PERMANENT "error" listener (see constructor). It is never removed, so the
  // AudioPlayer always retains at least one "error" handler — even after destroy() removes
  // onPlayerError, or in the window between stop() and that removal. AudioPlayer has no
  // internal self-listener, so without this a stray "error" with zero listeners is converted
  // by Node into an unhandled exception that crashes the whole process.
  private readonly onPlayerErrorGuard = (): void => {};

  constructor(
    private readonly connection: VoiceConnectionLike,
    private readonly player: VoicePlayerLike,
    private readonly opts: VoiceSessionOptions,
  ) {
    super();
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.player.on("stateChange", this.onStateChange);
    this.player.on("error", this.onPlayerError);
    this.player.on("error", this.onPlayerErrorGuard);
  }

  /**
   * Update the idle-disconnect timeout. If a timer is currently running it is
   * restarted with the new value so a change takes effect immediately; otherwise
   * only the next startIdleTimer() picks it up.
   */
  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
    if (this.idleTimer) this.startIdleTimer();
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

  /**
   * Signal that the underlying voice CONNECTION has been permanently lost (an unrecoverable
   * Disconnected/closeCode, or a fatal connection "error") and the session should be torn
   * down. Emits "idle" so the controller runs its normal idle teardown (stop playback, unpin
   * cache, clear state) under its lock, exactly as a real idle timeout would — instead of
   * leaving a dead player and leaked pins with playback silently hung. Idempotent.
   */
  signalConnectionLost(): void {
    if (this.destroyed) return;
    this.cancelIdleTimer();
    this.emit("idle");
  }

  startIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.emit("idle");
    }, this.idleTimeoutMs);
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
    // Detach our stateChange forwarder BEFORE the forced stop so the Playing->Idle transition
    // it causes does NOT emit a spurious trackEnd to the controller.
    this.player.removeListener("stateChange", this.onStateChange);
    // Force-stop the player while it STILL has an "error" listener attached. The forced stop
    // synchronously transitions the player to Idle: @discordjs/voice then attaches a noop
    // "error" guard to the old resource's playStream and destroys it, so the orphaned ffmpeg
    // stream can no longer crash the process. It also propagates through the ffmpeg pipeline to
    // ff.stdout 'close' → the SIGKILL reaper in createTranscodedResource, so tearing the
    // session down (moveTo/leave) mid-playback never orphans the ffmpeg child holding the
    // input file open.
    this.player.stop(true);
    // Now detach our forwarding error listener. The permanent onPlayerErrorGuard stays
    // attached, so the player is never left with zero "error" listeners (a listener-less
    // "error" would crash the process).
    this.player.removeListener("error", this.onPlayerError);
    if (this.connection.state.status !== "destroyed") {
      this.connection.destroy();
    }
  }
}
