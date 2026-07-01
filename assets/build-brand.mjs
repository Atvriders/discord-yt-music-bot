// Brand-asset builder. Renders the VU-console marks to PNG via sharp.
//   bot-avatar.png       1024x1024  (bot 1 icon)
//   banner.png            680x240   (bot 1 Discord profile banner)
//   bot2-avatar.png      1024x1024  (bot 2 icon — carries a red "2" badge)
//   bot2-banner.png       680x240   (bot 2 banner — "2" badge + "No. 2")
// Run: node assets/build-brand.mjs
/* global console, Buffer */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const FONT = "Fraunces, Georgia, 'Times New Roman', serif";

const DEFS = `
 <radialGradient id="panel" cx="18%" cy="34%" r="115%">
  <stop offset="0%" stop-color="#1c1310"/><stop offset="55%" stop-color="#130d0b"/><stop offset="100%" stop-color="#0a0707"/>
 </radialGradient>
 <radialGradient id="bg" cx="50%" cy="40%" r="80%">
  <stop offset="0%" stop-color="#211412"/><stop offset="52%" stop-color="#140c0b"/><stop offset="100%" stop-color="#080505"/>
 </radialGradient>
 <radialGradient id="glow" cx="50%" cy="43%" r="50%">
  <stop offset="0%" stop-color="#ff4a3d" stop-opacity="0.6"/><stop offset="46%" stop-color="#ff3b3b" stop-opacity="0.18"/><stop offset="100%" stop-color="#ff3b3b" stop-opacity="0"/>
 </radialGradient>
 <radialGradient id="iconglow" cx="50%" cy="50%" r="50%">
  <stop offset="0%" stop-color="#ff4a3d" stop-opacity="0.5"/><stop offset="55%" stop-color="#ff3b3b" stop-opacity="0.12"/><stop offset="100%" stop-color="#ff3b3b" stop-opacity="0"/>
 </radialGradient>
 <radialGradient id="face" cx="50%" cy="34%" r="80%">
  <stop offset="0%" stop-color="#251a18"/><stop offset="60%" stop-color="#140d0c"/><stop offset="100%" stop-color="#0a0606"/>
 </radialGradient>
 <linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">
  <stop offset="0%" stop-color="#ff7a00"/><stop offset="55%" stop-color="#ff2a00"/><stop offset="100%" stop-color="#ff0000"/>
 </linearGradient>
 <radialGradient id="badge" cx="42%" cy="34%" r="80%">
  <stop offset="0%" stop-color="#ff6a4a"/><stop offset="46%" stop-color="#ff2a12"/><stop offset="100%" stop-color="#c8130a"/>
 </radialGradient>
 <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="11"/></filter>
 <filter id="barglow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`;

// The circular VU/equalizer console mark in a 512x512 coordinate space (center 256,256).
// `rings` adds the concentric faceplate rings (used on the round avatar); the banner icon
// keeps just the outer ring so it reads cleanly at small size.
function consoleMark({ rings }) {
  return `
 <circle cx="256" cy="256" r="170" fill="url(#iconglow)"/>
 <circle cx="256" cy="256" r="208" fill="url(#face)"/>
 <circle cx="256" cy="256" r="198" fill="none" stroke="#ec938a" stroke-opacity="0.32" stroke-width="2.8"/>
 ${rings ? `<circle cx="256" cy="256" r="206" fill="none" stroke="#e8877e" stroke-opacity="0.08" stroke-width="1.8"/><circle cx="256" cy="256" r="150" fill="none" stroke="#e8877e" stroke-opacity="0.10" stroke-width="2"/>` : ``}
 <ellipse cx="256" cy="258" rx="140" ry="120" fill="#ff3b1f" opacity="0.16" filter="url(#soft)"/>
 <g filter="url(#barglow)">
  <rect x="138" y="240" width="34" height="110" rx="13" fill="url(#bar)"/>
  <rect x="190" y="190" width="34" height="160" rx="13" fill="url(#bar)"/>
  <rect x="242" y="146" width="34" height="204" rx="13" fill="url(#bar)"/>
  <rect x="294" y="206" width="34" height="144" rx="13" fill="url(#bar)"/>
  <rect x="346" y="262" width="34" height="88"  rx="13" fill="url(#bar)"/>
 </g>
 <g opacity="0.9">
  <rect x="138" y="240" width="34" height="13" rx="6.5" fill="#ffd9b0"/>
  <rect x="190" y="190" width="34" height="13" rx="6.5" fill="#ffd9b0"/>
  <rect x="242" y="146" width="34" height="13" rx="6.5" fill="#ffe7cc"/>
  <rect x="294" y="206" width="34" height="13" rx="6.5" fill="#ffd9b0"/>
  <rect x="346" y="262" width="34" height="13" rx="6.5" fill="#ffd9b0"/>
 </g>
 <rect x="128" y="350" width="256" height="5" rx="2.5" fill="#e8877e" opacity="0.34"/>`;
}

// The "2" badge in the SAME 512 space, seated in the lower-right of the console mark.
const badge2 = `
 <circle cx="372" cy="366" r="80" fill="#0a0606"/>
 <circle cx="372" cy="366" r="67" fill="url(#badge)"/>
 <circle cx="372" cy="366" r="67" fill="none" stroke="#ffd9b0" stroke-opacity="0.40" stroke-width="2.4"/>
 <text x="372" y="401" font-family="${FONT}" font-weight="700" font-size="99" fill="#fff3e6" text-anchor="middle">2</text>`;

function avatarSvg({ two }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>${DEFS}</defs>
<rect width="512" height="512" fill="url(#bg)"/>
<rect width="512" height="512" fill="url(#glow)"/>
<circle cx="256" cy="256" r="208" fill="url(#face)"/>
${consoleMark({ rings: true })}
${two ? badge2 : ``}
<rect width="512" height="512" filter="url(#grain)" opacity="0.04"/>
</svg>`;
}

function bannerSvg({ two }) {
  // Icon: the 512-space mark scaled to ~192px, vertically centered in the 240-tall banner.
  const icon = `<g transform="translate(40,25) scale(0.375)">${consoleMark({ rings: false })}${two ? badge2 : ``}</g>`;
  const title = `<text x="256" y="110" font-family="${FONT}" font-weight="600" font-size="43" fill="#f4ece2" letter-spacing="-1">YouTube Music Bot</text>`;
  // Tagline row. Bot 1: the little VU marker + tagline. Bot 2: a red "No. 2" leads the tagline
  // (the icon already carries the "2" badge), so nothing overlaps the wordmark.
  const taglineRow = two
    ? `<text x="256" y="167" font-family="${FONT}" font-weight="700" font-size="22" fill="#ff5036" letter-spacing="0.5">No. 2</text>
<text x="330" y="167" font-family="${FONT}" font-weight="500" font-size="19" fill="#b7a896">· the exact track — never a mirror</text>`
    : `<g>
 <rect x="257" y="150" width="6" height="17" rx="3" fill="#ff5036"/>
 <rect x="267" y="142" width="6" height="25" rx="3" fill="#ff5036"/>
 <rect x="277" y="154" width="6" height="13" rx="3" fill="#ff5036"/>
</g>
<text x="295" y="167" font-family="${FONT}" font-weight="500" font-size="20" fill="#b7a896">the exact track — never a mirror</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="240" viewBox="0 0 680 240">
<defs>${DEFS}</defs>
<rect width="680" height="240" fill="url(#panel)"/>
<rect x="0.75" y="0.75" width="678.5" height="238.5" fill="none" stroke="#e8877e" stroke-opacity="0.09" stroke-width="1.5"/>
${icon}
${title}
${taglineRow}
<rect width="680" height="240" filter="url(#grain)" opacity="0.04"/>
</svg>`;
}

async function emit(name, svg, w, h) {
  const svgPath = join(DIR, `${name}.svg`);
  const pngPath = join(DIR, `${name}.png`);
  await writeFile(svgPath, svg + "\n");
  await sharp(Buffer.from(svg)).resize(w, h).png().toFile(pngPath);
  console.log(`  ${name}.png  ${w}x${h}`);
}

console.log("Rendering brand assets:");
await emit("bot-avatar", avatarSvg({ two: false }), 1024, 1024);
await emit("bot2-avatar", avatarSvg({ two: true }), 1024, 1024);
await emit("banner", bannerSvg({ two: false }), 680, 240);
await emit("bot2-banner", bannerSvg({ two: true }), 680, 240);
console.log("Done.");
