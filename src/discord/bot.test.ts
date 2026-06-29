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
  function npController() {
    return {
      isPaused: false,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(async () => {}),
      shuffle: vi.fn(async () => {}),
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
});

describe("createBot — now-playing control buttons (InteractionCreate)", () => {
  interface NpMockController {
    isPaused: boolean;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    skip: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    shuffle: ReturnType<typeof vi.fn>;
  }

  function npDeps(): { deps: BotDeps; controller: NpMockController } {
    const controller: NpMockController = {
      isPaused: false,
      pause: vi.fn(),
      resume: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(async () => {}),
      shuffle: vi.fn(async () => {}),
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

  it("FORBIDDEN: replies ephemerally and never defers or touches the controller", async () => {
    const { deps, controller } = npDeps();
    const client = createBot(deps);
    stubGuildCache(client, { member: false });
    const { interaction, reply, deferUpdate } = npInteraction("stop");

    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true, content: expect.stringContaining("permission") }),
    );
    expect(deferUpdate).not.toHaveBeenCalled();
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

  it("records the command's text channel via onCommandChannel when a command runs", async () => {
    const controller = {
      skip: vi.fn(),
      snapshot: vi.fn(() => ({ current: null, upcoming: [], history: [] })),
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
