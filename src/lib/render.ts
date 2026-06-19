// Client-side slide renderer. Each slide becomes a 1080×1920 PNG drawn on a
// canvas — text over a gradient. No image-generation API, no cost, deterministic
// output. The resulting data URLs are sent to the server, which uploads them to
// post-bridge as the post's media.
//
// Caption geometry (font %, stroke, line-height, padding, centering) comes from
// lib/captionStyle.ts — the SAME constants the editor preview uses — so the
// scheduled PNG matches what the user saw when editing.
import type { Slide, Slideshow } from '../types';
import { FONT_SIZE_PCT, STROKE_RATIO, LINE_HEIGHT, SIDE_PAD_PCT, pct } from './captionStyle';

const W = 1080;
const H = 1920;

// Word-wrap within hard newlines, mirroring the preview's wrapping.
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { out.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });
}

// Draw an image to cover the whole canvas (object-fit: cover).
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

export async function renderSlide(slide: Slide): Promise<string> {
  // Make sure the web font is ready, otherwise the first render uses a fallback.
  if (document.fonts?.ready) await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  if (slide.imageUrl) {
    // Image background (same-origin: bundled at /library/… or scraped via /api/…).
    try {
      const img = await loadImage(slide.imageUrl);
      drawCover(ctx, img);
      // Darken so white text stays readable.
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, W, H);
    } catch {
      ctx.fillStyle = slide.bgFrom || '#0f172a';
      ctx.fillRect(0, 0, W, H);
    }
  } else {
    // Gradient background
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, slide.bgFrom || '#0f172a');
    grad.addColorStop(1, slide.bgTo || '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Subtle vignette for depth
    const vig = ctx.createRadialGradient(W / 2, H / 2, H / 3, W / 2, H / 2, H);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  // Caption: white bold text, black outline, centered — driven by the SAME
  // percentages the editor preview uses, so the two always match.
  const fontPx = Math.round(H * pct(FONT_SIZE_PCT));
  const lineHeight = Math.round(fontPx * LINE_HEIGHT);
  const strokeW = Math.max(2, Math.round(fontPx * STROKE_RATIO));

  ctx.font = `800 ${fontPx}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const maxWidth = W * (1 - 2 * pct(SIDE_PAD_PCT));
  const lines = wrap(ctx, slide.text || '', maxWidth);
  const blockH = lines.length * lineHeight;
  const startY = (H - blockH) / 2; // vertically centered, matching the preview
  const x = W / 2;

  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * lineHeight;
    // Paint stroke first, fill on top — same effect as CSS paint-order: stroke fill.
    ctx.strokeStyle = 'black';
    ctx.lineWidth = strokeW;
    ctx.strokeText(lines[i], x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(lines[i], x, y);
  }

  return canvas.toDataURL('image/png');
}

export async function renderSlideshow(show: Slideshow): Promise<string[]> {
  const out: string[] = [];
  for (const slide of show.slides) {
    out.push(await renderSlide(slide));
  }
  return out;
}
