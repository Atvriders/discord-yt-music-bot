export function Grain() {
  return (
    <svg aria-hidden style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: -1, opacity: 0.02, mixBlendMode: "overlay", pointerEvents: "none" }}>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" /></filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  );
}
