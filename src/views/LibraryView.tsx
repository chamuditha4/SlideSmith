import { useEffect, useMemo, useState } from 'react';
import { Loader2, Download, Trash2, CheckSquare, Square } from 'lucide-react';
import type { LibraryImage } from '../types';
import { ViewHeader } from '../components/ViewHeader';
import { Button } from '../components/Button';
import { getLibrary, deleteLibraryImage, deleteLibraryImages } from '../lib/api';

type Progress =
  | { phase: 'search'; message: string }
  | { phase: 'download'; downloaded: number; total: number };

export function LibraryView() {
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [searches, setSearches] = useState('');
  const [count, setCount] = useState(40);
  const [scraping, setScraping] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const load = () => getLibrary().then((imgs) => { setImages(imgs); setSelected(new Set()); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const scrape = async () => {
    setError(null);
    setNote(null);
    setProgress(null);
    setScraping(true);
    try {
      const queries = searches.split(',').map((s) => s.trim()).filter(Boolean);
      const res = await fetch('/api/library/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searches: queries, count }),
      });
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === 'done') {
            setNote(`Added ${data.added} image${data.added === 1 ? '' : 's'} from ${data.found} found.`);
            await load();
          } else if (data.type === 'error') {
            setError(data.message);
          } else if (data.phase) {
            setProgress(data as Progress);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScraping(false);
      setProgress(null);
    }
  };

  const remove = async (id: string) => {
    // Optimistic: hide immediately, then sync from server response.
    setImages((prev) => prev?.filter((img) => img.id !== id) ?? prev);
    setSelected((prev) => { const s = new Set(prev); s.delete(id); return s; });
    try {
      const updated = await deleteLibraryImage(id);
      setImages(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  };

  const bulkDelete = async () => {
    if (!selected.size) return;
    const ids = [...selected];
    setBulkDeleting(true);
    // Optimistic remove
    setImages((prev) => prev?.filter((img) => !selected.has(img.id)) ?? prev);
    setSelected(new Set());
    try {
      const updated = await deleteLibraryImages(ids);
      setImages(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    } finally {
      setBulkDeleting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  const scrapedImages = useMemo(() => (images || []).filter((img) => img.source === 'scraped'), [images]);
  const allSelected = scrapedImages.length > 0 && scrapedImages.every((img) => selected.has(img.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(scrapedImages.map((img) => img.id)));
    }
  };

  // Group by pack, scraped packs first.
  const groups = useMemo(() => {
    const map = new Map<string, LibraryImage[]>();
    for (const img of images || []) {
      if (!map.has(img.pack)) map.set(img.pack, []);
      map.get(img.pack)!.push(img);
    }
    return [...map.entries()];
  }, [images]);

  return (
    <>
      <ViewHeader
        title="Library"
        subtitle="Background images for your slides. Ships with curated aesthetic packs — scrape more directly from Pinterest."
      />

      <div className="flex-1 overflow-y-auto">
        {/* Scrape bar */}
        <div className="border-b border-line bg-surface">
          <div className="px-4 py-4 sm:px-6 md:px-8">
            <div className="flex items-end gap-2 flex-wrap max-w-3xl">
              <div className="flex-1 min-w-[200px]">
                <label className="text-[11px] text-ink-5 mb-1 block">Pinterest searches</label>
                <input
                  value={searches}
                  onChange={(e) => setSearches(e.target.value)}
                  placeholder="e.g. dark moody aesthetic, cozy bedroom, foggy mountain"
                  className="w-full h-9 bg-card border border-line rounded-lg px-3 text-[13px] text-ink placeholder:text-ink-6 outline-none focus:border-ink-7 focus:ring-2 focus:ring-ink/10"
                />
              </div>
              <div className="w-24">
                <label className="text-[11px] text-ink-5 mb-1 block">Max</label>
                <input
                  type="number"
                  value={count}
                  min={1}
                  max={200}
                  onChange={(e) => setCount(Number(e.target.value))}
                  onBlur={() => setCount((c) => Math.min(Math.max(c || 1, 1), 200))}
                  className="w-full h-9 bg-card border border-line rounded-lg px-3 text-[13px] text-ink outline-none focus:border-ink-7 focus:ring-2 focus:ring-ink/10"
                />
              </div>
              <Button
                variant="primary"
                size="lg"
                icon={scraping ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                onClick={scrape}
                disabled={scraping || !searches.trim()}
              >
                {scraping ? 'Scraping…' : 'Scrape Pinterest'}
              </Button>
            </div>
            <p className="text-[11px] text-ink-6 mt-1">1–200 images per search</p>
            <p className="text-[12px] text-ink-5 mt-2">
              Scrapes Pinterest directly — no third-party API needed. If you get blocked, add a proxy in Settings.
            </p>
            {scraping && progress && (
              <div className="mt-3 max-w-xs">
                <p className="text-[11px] text-ink-5 mb-1">
                  {progress.phase === 'download'
                    ? `Downloading ${progress.downloaded} / ${progress.total}…`
                    : progress.message}
                </p>
                {progress.phase === 'download' && (
                  <div className="h-1.5 rounded-full bg-raised overflow-hidden">
                    <div
                      className="h-full bg-ink rounded-full transition-all duration-200"
                      style={{ width: `${Math.round((progress.downloaded / progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}
            {note && <p className="text-[12px] text-emerald-600 mt-2">{note}</p>}
            {error && <p className="text-[12px] text-red-600 mt-2">{error}</p>}
          </div>
        </div>

        {/* Bulk-select toolbar — only shown when scraped images exist */}
        {images !== null && scrapedImages.length > 0 && (
          <div className="border-b border-line bg-surface px-4 py-2 sm:px-6 md:px-8 flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1.5 text-[12px] text-ink-5 hover:text-ink transition-colors"
            >
              {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
              {allSelected ? 'Deselect all' : 'Select all scraped'}
            </button>
            {selected.size > 0 && (
              <Button
                variant="danger-ghost"
                size="sm"
                icon={bulkDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                onClick={bulkDelete}
                disabled={bulkDeleting}
              >
                Delete {selected.size} image{selected.size === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        )}

        {/* Packs */}
        <div className="p-4 sm:p-6 md:p-8">
          <div className="space-y-8">
            {images === null ? (
              <div className="flex items-center justify-center py-16 text-ink-5 text-[13px] gap-2">
                <Loader2 size={14} className="animate-spin" /> Loading library…
              </div>
            ) : (
              groups.map(([pack, imgs]) => (
                <div key={pack}>
                  <div className="flex items-baseline gap-3 mb-3">
                    <h2 className="text-[13px] font-semibold text-ink uppercase tracking-widest">{pack}</h2>
                    <span className="text-[11px] text-ink-6">{imgs.length}</span>
                  </div>
                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
                    {imgs.map((img) => (
                      <div
                        key={img.id}
                        className={`group relative aspect-[9/16] rounded-lg overflow-hidden bg-raised cursor-pointer ring-2 transition-all ${
                          selected.has(img.id) ? 'ring-ink' : 'ring-transparent'
                        }`}
                        onClick={img.source === 'scraped' ? () => toggleSelect(img.id) : undefined}
                      >
                        <img src={img.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                        {img.source === 'scraped' && (
                          <>
                            {selected.has(img.id) ? (
                              <div className="absolute top-1 left-1 w-5 h-5 rounded bg-ink flex items-center justify-center">
                                <CheckSquare size={11} className="text-white" />
                              </div>
                            ) : (
                              <div className="absolute top-1 left-1 w-5 h-5 rounded bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <Square size={11} className="text-white" />
                              </div>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); remove(img.id); }}
                              aria-label="Remove image"
                              className="absolute top-1 right-1 w-6 h-6 rounded-md bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
