import JSZip from 'jszip';
import type { Slideshow } from '../types';

// binary: true  → data is a base64 data URL ("data:image/png;base64,...")
// binary: false → data is a plain string written as-is
type ZipEntry = { name: string; data: string; binary?: boolean };

export async function downloadZip(filename: string, files: ZipEntry[]) {
  const zip = new JSZip();
  for (const { name, data, binary } of files) {
    if (binary) {
      zip.file(name, data.replace(/^data:[^;]+;base64,/, ''), { base64: true });
    } else {
      zip.file(name, data);
    }
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Build the caption/hashtag text for a slideshow as both .md and .txt content.
export function slideshowTextFiles(show: Slideshow, prefix = '') {
  const tags = show.hashtags.map((t) => `#${t}`).join(' ');
  const body = show.caption + (tags ? `\n\n${tags}` : '');
  return [
    { name: `${prefix}caption.md`, data: `# ${show.hook}\n\n${body}` },
    { name: `${prefix}caption.txt`, data: `${show.hook}\n\n${body}` },
  ];
}
