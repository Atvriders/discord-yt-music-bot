import type { GuildController } from "./index.js";

export class GuildHub {
  private readonly controllers = new Map<string, GuildController>();
  constructor(private readonly factory: (guildId: string) => GuildController) {}

  get(guildId: string): GuildController {
    let c = this.controllers.get(guildId);
    if (!c) {
      c = this.factory(guildId);
      this.controllers.set(guildId, c);
    }
    return c;
  }
}
