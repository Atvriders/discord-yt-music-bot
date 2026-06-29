// A square track thumbnail with a graceful placeholder. yt-dlp does not always
// return an image (older uploads, some search entries), so `url` may be null —
// in that case we render a styled placeholder box instead of a broken <img>.
export function Thumb({ url, size = 44 }: { url: string | null | undefined; size?: number }) {
  const dim = { width: size, height: size } as const;
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="rounded-md object-cover shrink-0"
        style={dim}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-testid="thumb-placeholder"
      className="rounded-md shrink-0 grid place-items-center"
      style={{
        ...dim,
        background: "var(--color-raised, rgba(255,255,255,0.06))",
        border: "1px solid var(--color-line)",
        color: "var(--color-ink-faint)",
      }}
    >
      {/* simple music-note glyph so an empty slot still reads as a track */}
      <svg width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
    </span>
  );
}
