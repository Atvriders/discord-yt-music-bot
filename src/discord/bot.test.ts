import { describe, it, expect, vi } from "vitest";
import { GatewayIntentBits, GuildMember, Events, Routes } from "discord.js";
import { createBot, setBotBio, applyNpAction, REQUIRED_INTENTS, type BotDeps } from "./bot.js";
import { encodeNpAction } from "./np-message.js";
import { YtError, YtErrorKind } from "../youtube/errors.js";
import type { TrackMeta } from "../types/index.js";

describe("bot intents", () => {
  // Smoke-only: this is a literal snapshot of the four intents the gateway connection
  // requests. It cannot fail unless someone edits REQUIRED_INTENTS by hand.
  it("requests exactly the four required intents", () => {
    expect(REQUIRED_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
  });
});

const meta = (id: string, title = id): TrackMeta => ({
  videoId: id,
  title,
  channel: "c",
  durationSec: 100,
  isLive: false,
  thumbnailUrl: null,
});

interface MockController {
  moveTo: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
}

function makeDeps(): { deps: BotDeps; controller: MockController } {
  const controller: MockController = {
    moveTo: vi.fn(async () => {}),
    ensureConnected: vi.fn(async () => {}),
    enqueue: vi.fn(async () => ({ id: "i1" })),
  };
  const deps: BotDeps = {
    hub: { get: vi.fn(() => controller) } as never,
    youtube: { resolve: vi.fn(async () => meta("aaaaaaaaaaa", "Song")) } as never,
    prefix: "?",
    searchLimit: 5,
    adminUserIds: new Set<string>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps, controller };
}

/**
 * Build a synthetic button interaction. `inVoice` controls whether the member is a real
 * GuildMember instance with a voice channel (so selectVoiceChannel succeeds) or a plain
 * object (failing the `instanceof GuildMember` guard -> requesterChannelId = null).
 */
function buttonInteraction(opts: {
  customId?: string;
  inVoice?: boolean;
  botChannelId?: string | null;
}) {
  const reply = vi.fn(async () => {});
  const deferUpdate = vi.fn(async () => {});
  const editReply = vi.fn(async (_payload?: unknown) => {});

  let member: unknown;
  if (opts.inVoice) {
    // Must pass `instanceof GuildMember` for requesterChannelId to be read. `voice` is a
    // prototype getter on GuildMember, so override it on the instance via defineProperty.
    member = Object.create(GuildMember.prototype) as GuildMember;
    Object.defineProperty(member, "voice", {
      value: { channelId: "A" },
      configurable: true,
    });
  } else {
    member = { voice: { channelId: "A" } }; // NOT a GuildMember -> guard yields null
  }

  const interaction = {
    isButton: () => true,
    inGuild: () => true,
    customId: opts.customId ?? "pick:aaaaaaaaaaa",
    guildId: "g1",
    guild: { members: { me: { voice: { channelId: opts.botChannelId ?? null } } } },
    user: {
      id: "u1",
      username: "user",
      displayAvatarURL: () => "http://avatar",
    },
    member,
    reply,
    deferUpdate,
    editReply,
  };
  return { interaction, reply, deferUpdate, editReply };
}

describe("createBot — InteractionCreate", () => {
  it("replies ephemerally and does NOT defer when the requester is not in voice", async () => {
    const { deps } = makeDeps();
    const client = createBot(deps);
    const { interaction, reply, deferUpdate } = buttonInteraction({ inVoice: false });

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: expect.stringContaining("voice") }),
    );
    expect(deferUpdate).not.toHaveBeenCalled();
  });

  it("happy path: defers, ensureConnected, enqueue, then editReply with the queued title", async () => {
    const { deps, controller } = makeDeps();
    const client = createBot(deps);
    const { interaction, deferUpdate, editReply } = buttonInteraction({ inVoice: true });

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalled());

    expect(deferUpdate).toHaveBeenCalled();
    expect(controller.ensureConnected).toHaveBeenCalledWith("A");
    expect(controller.moveTo).not.toHaveBeenCalled();
    expect(controller.enqueue).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "➕ Queued **Song**.",
      components: [],
    });
  });

  it("admin in a different channel calls moveTo, not ensureConnected", async () => {
    const { deps, controller } = makeDeps();
    deps.adminUserIds = new Set(["u1"]);
    const client = createBot(deps);
    const { interaction } = buttonInteraction({ inVoice: true, botChannelId: "B" });

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.enqueue).toHaveBeenCalled());

    expect(controller.moveTo).toHaveBeenCalledWith("A");
    expect(controller.ensureConnected).not.toHaveBeenCalled();
  });

  it("surfaces the verbatim message for a TooLong YtError from resolve", async () => {
    const { deps } = makeDeps();
    deps.youtube.resolve = vi.fn(async () => {
      throw new YtError(YtErrorKind.TooLong, "Too long — max 2h");
    }) as never;
    const client = createBot(deps);
    const { interaction, editReply } = buttonInteraction({ inVoice: true });

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalled());

    expect(editReply).toHaveBeenCalledWith({
      content: "❌ Too long — max 2h",
      components: [],
    });
  });

  it("surfaces the error kind for a generic YtError from resolve", async () => {
    const { deps } = makeDeps();
    deps.youtube.resolve = vi.fn(async () => {
      throw new YtError(YtErrorKind.Private, "private");
    }) as never;
    const client = createBot(deps);
    const { interaction, editReply } = buttonInteraction({ inVoice: true });

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalled());

    const arg = editReply.mock.calls[0]![0] as { content: string };
    expect(arg.content).toContain(`(${YtErrorKind.Private})`);
  });

  it("does not throw or call editReply when deferUpdate itself rejects", async () => {
    const { deps, controller } = makeDeps();
    const client = createBot(deps);
    const { interaction, deferUpdate, editReply } = buttonInteraction({ inVoice: true });
    deferUpdate.mockRejectedValueOnce(new Error("token expired"));

    // Emitting must not produce an unhandled rejection; the handler bails after the
    // failed defer rather than editing an unacknowledged interaction.
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(deferUpdate).toHaveBeenCalled());
    // Give the microtask queue a chance to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(editReply).not.toHaveBeenCalled();
    expect(controller.enqueue).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("does not crash when a failed editReply rejects on the error-recovery path", async () => {
    const { deps } = makeDeps();
    deps.youtube.resolve = vi.fn(async () => {
      throw new YtError(YtErrorKind.Private, "private");
    }) as never;
    const client = createBot(deps);
    const { interaction, editReply } = buttonInteraction({ inVoice: true });
    editReply.mockRejectedValue(new Error("token expired"));

    // The editReply rejection must be swallowed and never escape the async handler.
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(editReply).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.log.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "[bot] interaction handler crashed",
    );
  });

  it("ignores non-button and foreign-customId interactions", async () => {
    const { deps, controller } = makeDeps();
    const client = createBot(deps);
    const { interaction: foreign } = buttonInteraction({ customId: "other:x", inVoice: true });

    client.emit(Events.InteractionCreate, foreign as never);
    client.emit(Events.InteractionCreate, { isButton: () => false } as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.enqueue).not.toHaveBeenCalled();
  });
});

describe("applyNpAction — customId -> controller action mapping", () => {
  function npController(
    over: Partial<{
      repeat: "off" | "one" | "all";
      autoplay: boolean;
      volume: number;
    }> = {},
  ) {
    const settings = {
      repeat: over.repeat ?? "off",
      autoplay: over.autoplay ?? false,
      volume: over.volume ?? 100,
    };
    return {
      isPaused: false,
      settings,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(async () => {}),
      shuffle: vi.fn(async () => {}),
      updateSettings: vi.fn((patch: Record<string, unknown>) => ({ ...settings, ...patch })),
      setVolume: vi.fn((v: number) => ({ ...settings, volume: v })),
    };
  }

  it("pauseresume pauses when playing, resumes when paused", async () => {
    const c = npController();
    await applyNpAction(c as never, "pauseresume");
    expect(c.pause).toHaveBeenCalledOnce();
    expect(c.resume).not.toHaveBeenCalled();

    const paused = { ...npController(), isPaused: true };
    await applyNpAction(paused as never, "pauseresume");
    expect(paused.resume).toHaveBeenCalledOnce();
    expect(paused.pause).not.toHaveBeenCalled();
  });

  it("maps skip/stop/shuffle to their controller methods", async () => {
    const c = npController();
    await applyNpAction(c as never, "skip");
    await applyNpAction(c as never, "stop");
    await applyNpAction(c as never, "shuffle");
    expect(c.skip).toHaveBeenCalledOnce();
    expect(c.stop).toHaveBeenCalledOnce();
    expect(c.shuffle).toHaveBeenCalledOnce();
  });

  it("repeat cycles off → one → all → off via updateSettings({ repeat })", async () => {
    const off = npController({ repeat: "off" });
    await applyNpAction(off as never, "repeat");
    expect(off.updateSettings).toHaveBeenCalledWith({ repeat: "one" });

    const one = npController({ repeat: "one" });
    await applyNpAction(one as never, "repeat");
    expect(one.updateSettings).toHaveBeenCalledWith({ repeat: "all" });

    const all = npController({ repeat: "all" });
    await applyNpAction(all as never, "repeat");
    expect(all.updateSettings).toHaveBeenCalledWith({ repeat: "off" });
  });

  it("autodiscover toggles autoplay on/off via updateSettings({ autoplay })", async () => {
    const offC = npController({ autoplay: false });
    await applyNpAction(offC as never, "autodiscover");
    expect(offC.updateSettings).toHaveBeenCalledWith({ autoplay: true });

    const onC = npController({ autoplay: true });
    await applyNpAction(onC as never, "autodiscover");
    expect(onC.updateSettings).toHaveBeenCalledWith({ autoplay: false });
  });

  it("voldown / volup step volume by 10% via setVolume", async () => {
    const c = npController({ volume: 100 });
    await applyNpAction(c as never, "volup");
    expect(c.setVolume).toHaveBeenCalledWith(110);

    const d = npController({ volume: 100 });
    await applyNpAction(d as never, "voldown");
    expect(d.setVolume).toHaveBeenCalledWith(90);
  });

  it("volume buttons clamp to 0–200", async () => {
    const high = npController({ volume: 195 });
    await applyNpAction(high as never, "volup");
    expect(high.setVolume).toHaveBeenCalledWith(200); // clamped at the ceiling

    const low = npController({ volume: 5 });
    await applyNpAction(low as never, "voldown");
    expect(low.setVolume).toHaveBeenCalledWith(0); // clamped at the floor
  });
});

describe("createBot — now-playing control buttons (InteractionCreate)", () => {
  interface NpMockController {
    isPaused: boolean;
    settings: { repeat: "off" | "one" | "all"; autoplay: boolean; volume: number };
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    skip: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    shuffle: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
    setVolume: ReturnType<typeof vi.fn>;
  }

  function npDeps(): { deps: BotDeps; controller: NpMockController } {
    const settings: NpMockController["settings"] = { repeat: "off", autoplay: false, volume: 100 };
    const controller: NpMockController = {
      isPaused: false,
      settings,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(async () => {}),
      shuffle: vi.fn(async () => {}),
      // Honor the real GuildController contract: updateSettings/setVolume mutate the live
      // settings IN PLACE (the real impl writes this._settings = applySettingsPatch(...)), so
      // npConfirmation's read of controller.settings AFTER applyNpAction reflects the new state.
      updateSettings: vi.fn((patch: Record<string, unknown>) => {
        Object.assign(settings, patch);
        return { ...settings };
      }),
      setVolume: vi.fn((v: number) => {
        settings.volume = v;
        return { ...settings };
      }),
    };
    const deps: BotDeps = {
      hub: { get: vi.fn(() => controller) } as never,
      youtube: { resolve: vi.fn() } as never,
      prefix: "?",
      searchLimit: 5,
      adminUserIds: new Set<string>(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    return { deps, controller };
  }

  function npInteraction(action: Parameters<typeof encodeNpAction>[0]) {
    const reply = vi.fn(async () => {});
    const deferUpdate = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const interaction = {
      isButton: () => true,
      inGuild: () => true,
      customId: encodeNpAction(action),
      guildId: "100000000000000000",
      user: { id: "200000000000000000", username: "user", displayAvatarURL: () => "http://a" },
      reply,
      deferUpdate,
      followUp,
    };
    return { interaction, reply, deferUpdate, followUp };
  }

  // Force canControl(client, …) to resolve allowed/forbidden by stubbing the client's
  // guild cache + member fetch (the membership path), independent of admin ids.
  function stubGuildCache(client: object, opts: { member: boolean }): void {
    const guild = {
      members: {
        fetch: vi.fn(async (_id: string) => {
          if (!opts.member) throw new Error("Unknown Member");
          return {};
        }),
      },
    };
    Object.defineProperty(client, "guilds", {
      value: { cache: new Map([["100000000000000000", guild]]) },
      configurable: true,
    });
  }

  it("acks (deferUpdate) BEFORE running the auth member-fetch, so the 3s token can't expire on a slow fetch", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    // A member fetch that never resolves models a slow/cold-cache guild. If the handler awaited
    // canControl() before deferring, the token would expire; ack-first must defer regardless.
    const guild = { members: { fetch: vi.fn(() => new Promise<never>(() => {})) } };
    Object.defineProperty(client, "guilds", {
      value: { cache: new Map([["100000000000000000", guild]]) },
      configurable: true,
    });
    const { interaction, deferUpdate } = npInteraction("skip");

    client.emit(Events.InteractionCreate, interaction as never);
    // The defer happens up front even though canControl() is still pending on the hung fetch.
    await vi.waitFor(() => expect(deferUpdate).toHaveBeenCalledOnce());
    // Auth is still in flight → the controller action hasn't run yet.
    expect(controller.skip).not.toHaveBeenCalled();
  });

  it("logs and bails when deferUpdate itself rejects (button stuck case is diagnosable)", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, deferUpdate, followUp } = npInteraction("skip");
    deferUpdate.mockRejectedValueOnce(new Error("Unknown interaction"));

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(deps.log.warn).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // After a failed defer the handler bails: no controller action, no followUp, no crash.
    expect(controller.skip).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  it("ALLOWED (guild member): defers and routes skip to the controller", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, deferUpdate, reply } = npInteraction("skip");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.skip).toHaveBeenCalled());

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled(); // no ephemeral error
  });

  it("ALLOWED via admin id even when guild cache is empty", async () => {
    const { deps, controller } = npDeps();
    deps.adminUserIds = new Set(["200000000000000000"]);
    const client = createBot(deps);
    // no guild cache stub -> membership path would fail, but admin short-circuits
    const { interaction, deferUpdate } = npInteraction("stop");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.stop).toHaveBeenCalled());
    expect(deferUpdate).toHaveBeenCalledOnce();
  });

  it("FORBIDDEN: defers (ack-first), denies via followUp, and never touches the controller", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: false });
    const { interaction, deferUpdate, followUp } = npInteraction("stop");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());

    // Ack-first discipline: the token is consumed up front, independent of the (slow) auth
    // member fetch, so the button can never get stuck. The denial is surfaced via followUp
    // (reply is unusable after deferUpdate).
    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: expect.stringContaining("permission") }),
    );
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it("pauseresume routes to pause when playing and resume when paused", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });

    const a = npInteraction("pauseresume");
    client.emit(Events.InteractionCreate, a.interaction as never);
    await vi.waitFor(() => expect(controller.pause).toHaveBeenCalled());

    controller.isPaused = true;
    const b = npInteraction("pauseresume");
    client.emit(Events.InteractionCreate, b.interaction as never);
    await vi.waitFor(() => expect(controller.resume).toHaveBeenCalled());
  });

  it("ALLOWED: repeat button routes to updateSettings({ repeat }) and confirms ephemerally", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, deferUpdate, followUp } = npInteraction("repeat");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.updateSettings).toHaveBeenCalled());

    expect(controller.updateSettings).toHaveBeenCalledWith({ repeat: "one" });
    expect(deferUpdate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());
    // npConfirmation reads controller.settings AFTER applyNpAction; with the in-place-mutation
    // mock this is the RESULTING state, not the stale pre-action "off".
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "🔁 Repeat: **one**.", ephemeral: true }),
    );
  });

  it("ALLOWED: autodiscover button toggles autoplay via updateSettings({ autoplay }) and confirms on", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, followUp } = npInteraction("autodiscover");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.updateSettings).toHaveBeenCalled());
    expect(controller.updateSettings).toHaveBeenCalledWith({ autoplay: true });
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "🔮 Auto-discover: **on**.", ephemeral: true }),
    );
  });

  it("ALLOWED: volup button steps volume up via setVolume and confirms the resulting value", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, followUp } = npInteraction("volup");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.setVolume).toHaveBeenCalled());
    expect(controller.setVolume).toHaveBeenCalledWith(110);
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());
    // With the in-place-mutation mock, npConfirmation reads the post-action volume (110).
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "🔊 Volume: **110%**.", ephemeral: true }),
    );
  });

  it("ALLOWED: voldown button steps volume down via setVolume and confirms the resulting value", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: true });
    const { interaction, followUp } = npInteraction("voldown");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(controller.setVolume).toHaveBeenCalled());
    expect(controller.setVolume).toHaveBeenCalledWith(90);
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "🔊 Volume: **90%**.", ephemeral: true }),
    );
  });

  it("FORBIDDEN: a new button (repeat) denies via followUp and never touches the controller", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: false });
    const { interaction, deferUpdate, followUp } = npInteraction("repeat");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(followUp).toHaveBeenCalled());

    expect(deferUpdate).toHaveBeenCalledOnce();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: expect.stringContaining("permission") }),
    );
    expect(controller.updateSettings).not.toHaveBeenCalled();
  });

  it("records the command's text channel via onCommandChannel when a command runs", async () => {
    const controller = {
      skip: vi.fn(),
      snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
      settings: { commandChannelId: null },
    };
    const onCommandChannel = vi.fn();
    const deps: BotDeps = {
      hub: { get: vi.fn(() => controller) } as never,
      youtube: { resolve: vi.fn(), search: vi.fn() } as never,
      prefix: "?",
      searchLimit: 5,
      adminUserIds: new Set<string>(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onCommandChannel,
    };
    const client = createBot(deps);
    const reply = vi.fn(async () => {});
    const message = {
      author: { bot: false, id: "u1", username: "u", displayAvatarURL: () => "a" },
      inGuild: () => true,
      guildId: "g1",
      channelId: "text-chan-1",
      content: "?skip",
      member: { displayName: "U", voice: { channelId: null } },
      guild: { members: { me: { voice: { channelId: null } } } },
      reply,
    };

    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(onCommandChannel).toHaveBeenCalledWith("g1", "text-chan-1");
  });
});

describe("setBotBio", () => {
  function fakeClient(opts: {
    edit?: ReturnType<typeof vi.fn>;
    hasApplication?: boolean;
    patch?: ReturnType<typeof vi.fn>;
  }) {
    const patch = opts.patch ?? vi.fn(async () => ({}));
    const application =
      opts.hasApplication === false ? null : { edit: opts.edit ?? vi.fn(async () => ({})) };
    return {
      client: { application, rest: { patch } } as never,
      patch,
      application,
    };
  }

  it("calls application.edit with the bio as the description and returns true", async () => {
    const edit = vi.fn(async () => ({}));
    const { client, patch } = fakeClient({ edit });
    const log = { warn: vi.fn() };

    const ok = await setBotBio(client, "my bio", log);

    expect(ok).toBe(true);
    expect(edit).toHaveBeenCalledWith({ description: "my bio" });
    expect(patch).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("falls back to the raw REST route when application is unavailable", async () => {
    const { client, patch } = fakeClient({ hasApplication: false });
    const log = { warn: vi.fn() };

    const ok = await setBotBio(client, "my bio", log);

    expect(ok).toBe(true);
    expect(patch).toHaveBeenCalledWith(Routes.currentApplication(), {
      body: { description: "my bio" },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("swallows errors, logs a warning, and returns false (never throws)", async () => {
    const edit = vi.fn(async () => {
      throw new Error("missing access");
    });
    const { client } = fakeClient({ edit });
    const log = { warn: vi.fn() };

    const ok = await setBotBio(client, "my bio", log);

    expect(ok).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

describe("createBot — ClientReady sets the About Me", () => {
  it("on ready, edits the application description with a bio built from prefix + baseUrl", async () => {
    const { deps } = makeDeps();
    deps.prefix = "?";
    deps.baseUrl = "https://ytbot.waterburp.com";
    const client = createBot(deps);

    const edit = vi.fn(async (_opts: { description: string }) => ({}));
    // Attach a fake application so the ready handler's setBotBio can edit it.
    Object.defineProperty(client, "application", {
      value: { edit },
      configurable: true,
    });

    client.emit(Events.ClientReady, client as never);
    await vi.waitFor(() => expect(edit).toHaveBeenCalled());

    const arg = edit.mock.calls[0]![0];
    expect(arg.description).toContain("Prefix: ?");
    expect(arg.description).toContain("?play <url|search>");
    expect(arg.description).toContain("Panel: https://ytbot.waterburp.com");
  });

  it("on ready without a baseUrl, builds a bio with no Panel line", async () => {
    const { deps } = makeDeps();
    deps.prefix = "?";
    deps.baseUrl = undefined;
    const client = createBot(deps);

    const edit = vi.fn(async (_opts: { description: string }) => ({}));
    Object.defineProperty(client, "application", {
      value: { edit },
      configurable: true,
    });

    client.emit(Events.ClientReady, client as never);
    await vi.waitFor(() => expect(edit).toHaveBeenCalled());

    const arg = edit.mock.calls[0]![0];
    expect(arg.description).not.toContain("Panel:");
  });

  it("a failed edit on ready does not crash and is swallowed (logged at warn)", async () => {
    const { deps } = makeDeps();
    const client = createBot(deps);

    const edit = vi.fn(async () => {
      throw new Error("missing access");
    });
    Object.defineProperty(client, "application", {
      value: { edit },
      configurable: true,
    });

    client.emit(Events.ClientReady, client as never);
    await vi.waitFor(() => expect(deps.log.warn).toHaveBeenCalled());

    // The failure must not surface as an "interaction/message handler crashed" error.
    expect(deps.log.error).not.toHaveBeenCalled();
  });
});

describe("createBot — command channel restriction (MessageCreate)", () => {
  // A controller mock that carries a configurable commandChannelId restriction plus the
  // surface handleCommand touches for the commands exercised here (?skip and ?channel).
  function restrictedDeps(commandChannelId: string | null) {
    const controller = {
      skip: vi.fn(),
      snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
      settings: { commandChannelId },
      updateSettings: vi.fn((patch: Record<string, unknown>) => ({
        commandChannelId,
        ...patch,
      })),
    };
    const deps: BotDeps = {
      hub: { get: vi.fn(() => controller) } as never,
      youtube: { resolve: vi.fn(), search: vi.fn() } as never,
      prefix: "?",
      searchLimit: 5,
      adminUserIds: new Set<string>(["u1"]),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    return { deps, controller };
  }

  function msg(content: string, channelId: string) {
    const reply = vi.fn(async () => {});
    return {
      reply,
      message: {
        author: { bot: false, id: "u1", username: "u", displayAvatarURL: () => "a" },
        inGuild: () => true,
        guildId: "g1",
        channelId,
        content,
        member: { displayName: "U", voice: { channelId: null } },
        guild: { members: { me: { voice: { channelId: null } } } },
        reply,
      },
    };
  }

  it("ignores a command sent in the WRONG channel when a restriction is set", async () => {
    const { deps, controller } = restrictedDeps("allowed-chan");
    const client = createBot(deps);
    const { message, reply } = msg("?skip", "other-chan");

    client.emit(Events.MessageCreate, message as never);
    // Give the async handler a few microtasks to run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.skip).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("accepts a command sent in the CONFIGURED channel when a restriction is set", async () => {
    const { deps, controller } = restrictedDeps("allowed-chan");
    const client = createBot(deps);
    const { message, reply } = msg("?skip", "allowed-chan");

    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(controller.skip).toHaveBeenCalled();
  });

  it("accepts a command in ANY channel when no restriction is set (default)", async () => {
    const { deps, controller } = restrictedDeps(null);
    const client = createBot(deps);
    const { message, reply } = msg("?skip", "wherever");

    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(controller.skip).toHaveBeenCalled();
  });

  it("ALWAYS allows `?channel` even from a non-configured channel (admin can't lock out)", async () => {
    const { deps, controller } = restrictedDeps("allowed-chan");
    const client = createBot(deps);
    const { message, reply } = msg("?channel", "other-chan");

    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    // The admin re-points the restriction to the channel they're in.
    expect(controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: "other-chan" });
  });

  it("ALWAYS allows `?channel off` from anywhere to clear the restriction", async () => {
    const { deps, controller } = restrictedDeps("allowed-chan");
    const client = createBot(deps);
    const { message, reply } = msg("?channel off", "other-chan");

    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(controller.updateSettings).toHaveBeenCalledWith({ commandChannelId: null });
  });
});
