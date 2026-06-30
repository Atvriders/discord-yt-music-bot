import { describe, it, expect, vi } from "vitest";
import { canControl, parseAdminIds } from "./authz.js";

const SNOW = "123456789012345678";
const GUILD = "234567890123456789";

function clientWith(opts: { hasGuild: boolean; isMember: boolean }) {
  const guild = {
    members: {
      fetch: vi.fn(async (id: string) =>
        opts.isMember ? { id } : Promise.reject(new Error("Unknown Member")),
      ),
    },
  };
  return { guilds: { cache: new Map(opts.hasGuild ? [[GUILD, guild]] : []) } } as never;
}

describe("parseAdminIds", () => {
  it("keeps valid snowflakes, drops junk", () => {
    expect([...parseAdminIds({ ADMIN_USER_IDS: `${SNOW}, 99, ${GUILD}` })]).toEqual([SNOW, GUILD]);
  });
  it("enforces the 17–20 digit snowflake length boundaries", () => {
    const tooShort = "1234567890123456"; // 16 digits (one below min)
    const tooLong = "123456789012345678901"; // 21 digits (one above max)
    const result = [
      ...parseAdminIds({ ADMIN_USER_IDS: `${tooShort}, ${SNOW}, ${tooLong}, ${GUILD}` }),
    ];
    // Pins {17,20}: a regression to {16,20} or {17,} would let a boundary value slip in.
    expect(result).toEqual([SNOW, GUILD]);
    expect(result).not.toContain(tooShort);
    expect(result).not.toContain(tooLong);
  });
});

describe("canControl", () => {
  it("true when the bot verifies the user is a member of the guild", async () => {
    expect(
      await canControl(clientWith({ hasGuild: true, isMember: true }), SNOW, GUILD, new Set()),
    ).toBe(true);
  });
  it("false when the user is not a member", async () => {
    expect(
      await canControl(clientWith({ hasGuild: true, isMember: false }), SNOW, GUILD, new Set()),
    ).toBe(false);
  });
  it("false when the bot is not in the guild", async () => {
    expect(
      await canControl(clientWith({ hasGuild: false, isMember: true }), SNOW, GUILD, new Set()),
    ).toBe(false);
  });
  it("true for an admin even if not a member (admin allowlist)", async () => {
    expect(
      await canControl(
        clientWith({ hasGuild: false, isMember: false }),
        SNOW,
        GUILD,
        new Set([SNOW]),
      ),
    ).toBe(true);
  });
  it("false for a malformed userId", async () => {
    expect(
      await canControl(clientWith({ hasGuild: true, isMember: true }), "bad", GUILD, new Set()),
    ).toBe(false);
  });
  it("false for a malformed guildId (symmetric snowflake guard)", async () => {
    expect(
      await canControl(
        clientWith({ hasGuild: true, isMember: true }),
        SNOW,
        "bad-guild",
        new Set(),
      ),
    ).toBe(false);
  });
});
