const SNOWFLAKE = /^\d{17,20}$/;

export function parseAdminIds(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => SNOWFLAKE.test(s)),
  );
}

interface MinimalGuild {
  members: { fetch(userId: string): Promise<unknown> };
}
interface MinimalClient {
  guilds: { cache: Map<string, MinimalGuild> };
}

export async function canControl(
  client: MinimalClient,
  userId: string,
  guildId: string,
  adminIds: ReadonlySet<string>,
): Promise<boolean> {
  if (!SNOWFLAKE.test(userId) || !SNOWFLAKE.test(guildId)) return false;
  if (adminIds.has(userId)) return true;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  try {
    const member = await guild.members.fetch(userId);
    return member != null;
  } catch {
    return false;
  }
}
