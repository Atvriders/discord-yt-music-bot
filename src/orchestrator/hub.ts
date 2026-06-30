import type { GuildController } from "./index.js";

export class GuildHub {
  private readonly registry = new Map<string, GuildController>();
  constructor(private readonly factory: (guildId: string) => GuildController) {}

  get(guildId: string): GuildController {
    let c = this.registry.get(guildId);
    if (!c) {
      c = this.factory(guildId);
      this.registry.set(guildId, c);
    }
    return c;
  }

  /** Whether a controller for this guild already exists (without creating one). */
  has(guildId: string): boolean {
    return this.registry.has(guildId);
  }

  guildIds(): string[] {
    return [...this.registry.keys()];
  }
  controllers(): IterableIterator<GuildController> {
    return this.registry.values();
  }
}
