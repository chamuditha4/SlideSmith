import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CalendarClock, CheckCircle2, ExternalLink, Download } from 'lucide-react';
import type { Slideshow, SocialAccount, ProjectDefaults } from '../types';
import { Button } from './Button';
import { renderSlideshow } from '../lib/render';
import { schedule as scheduleOne, getScheduledPosts } from '../lib/api';
import { downloadZip, slideshowTextFiles } from '../lib/zip';
import type { ZipEntry } from '../lib/zip';

// post-bridge dashboard — where the user reviews what we just sent over.
const PB_SCHEDULED_URL = 'https://www.post-bridge.com/dashboard/posts/scheduled';
const PB_DRAFTS_URL = 'https://www.post-bridge.com/dashboard/posts/drafts';

interface BulkScheduleModalProps {
  slideshows: Slideshow[];
  accounts: SocialAccount[];
  defaults: ProjectDefaults;
  hasPostbridge: boolean;
  onClose: () => void;
  onDone: () => void;
}

const INTERVAL_PRESETS = [1, 3, 6, 12, 24];

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BulkScheduleModal({ slideshows, accounts, defaults, hasPostbridge, onClose, onDone }: BulkScheduleModalProps) {
  const [selectedAccounts, setSelectedAccounts] = useState<number[]>(defaults.socialAccountIds);
  const [mode, setMode] = useState<'schedule' | 'draft' | 'download'>(!hasPostbridge ? 'download' : defaults.mode === 'draft' ? 'draft' : 'schedule');
  const [hours, setHours] = useState(6);
  const [startLocal, setStartLocal] = useState(() => toLocalInput(new Date(Date.now() + 6 * 3600_000)));
  const [lastScheduledMs, setLastScheduledMs] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default the start time to AFTER the last thing already scheduled in post-bridge.
  useEffect(() => {
    if (!hasPostbridge) return;
    getScheduledPosts()
      .then((posts) => {
        const future = posts
          .map((p) => (p.scheduledAt ? new Date(p.scheduledAt).getTime() : 0))
          .filter((t) => t > Date.now());
        const last = future.length ? Math.max(...future) : null;
        setLastScheduledMs(last);
        const base = last ?? Date.now();
        setStartLocal(toLocalInput(new Date(base + 6 * 3600_000)));
      })
      .catch(() => {});
  }, [hasPostbridge]);

  const resetStartAfterLast = (h: number) => {
    const base = lastScheduledMs ?? Date.now();
    setStartLocal(toLocalInput(new Date(base + h * 3600_000)));
  };

  const toggleAccount = (id: number) =>
    setSelectedAccounts((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const lastFireLabel = useMemo(() => {
    const start = new Date(startLocal).getTime();
    if (Number.isNaN(start) || !slideshows.length) return null;
    return new Date(start + (slideshows.length - 1) * hours * 3600_000).toLocaleString();
  }, [startLocal, hours, slideshows.length]);

  const submit = async () => {
    setError(null);
    if (mode !== 'download' && !selectedAccounts.length) return setError('Pick at least one account.');
    if (mode === 'schedule') {
      const start = new Date(startLocal).getTime();
      if (Number.isNaN(start)) return setError('Pick a valid start time.');
      if (start < Date.now() - 60_000) return setError('Start time is in the past.');
    }

    if (mode === 'download') {
      setProgress({ done: 0, total: slideshows.length });
      const allFiles: ZipEntry[] = [];
      let ok = 0;
      for (let i = 0; i < slideshows.length; i++) {
        try {
          const rendered = await renderSlideshow(slideshows[i]);
          const prefix = `slideshow-${i + 1}/`;
          rendered.forEach((data, j) => {
            allFiles.push({ name: `${prefix}slide-${j + 1}.png`, data, binary: true as const });
          });
          allFiles.push(...slideshowTextFiles(slideshows[i], prefix));
          ok++;
        } catch (e) {
          console.error('[bulk-download] failed for', slideshows[i].id, e);
        }
        setProgress({ done: i + 1, total: slideshows.length });
      }
      if (allFiles.length) await downloadZip('slideshows.zip', allFiles);
      setDoneCount(ok);
      return;
    }

    const startMs = new Date(startLocal).getTime();
    const stepMs = hours * 3600_000;
    setProgress({ done: 0, total: slideshows.length });

    const CONCURRENCY = 3;
    let ok = 0;
    let done = 0;
    let next = 0;

    const worker = async () => {
      while (next < slideshows.length) {
        const i = next++;
        const show = slideshows[i];
        try {
          const slides = await renderSlideshow(show);
          const caption = `${show.caption}${show.hashtags.length ? ' ' + show.hashtags.map((t) => `#${t}`).join(' ') : ''}`;
          await scheduleOne({
            id: show.id,
            caption,
            slides,
            socialAccounts: selectedAccounts,
            scheduledAt: mode === 'schedule' ? new Date(startMs + i * stepMs).toISOString() : null,
            mode,
          });
          ok++;
        } catch (e) {
          console.error('[bulk] failed for', show.id, e);
        }
        setProgress({ done: ++done, total: slideshows.length });
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slideshows.length) }, worker));
    setDoneCount(ok);
  };

  const busy = progress !== null && doneCount === null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={busy ? undefined : onClose}>
      <div className="bg-card border border-line rounded-2xl w-full max-w-md max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="text-[15px] font-semibold text-ink">Schedule {slideshows.length} slideshow{slideshows.length === 1 ? '' : 's'}</h2>
          {!busy && <button onClick={onClose} className="text-ink-5 hover:text-ink"><X size={18} /></button>}
        </div>

        {doneCount !== null ? (
          <div className="px-5 py-8 text-center space-y-2">
            <CheckCircle2 size={28} className="text-emerald-600 mx-auto" />
            <p className="text-[14px] font-medium text-ink">
              {doneCount} of {slideshows.length}{' '}
              {mode === 'download' ? 'downloaded' : mode === 'schedule' ? 'scheduled' : 'saved as drafts'}
            </p>
            <p className="text-[12px] text-ink-5">
              {mode === 'download'
                ? 'slideshows.zip downloaded — open it and upload each folder\'s slides to your platforms.'
                : mode === 'schedule'
                ? 'post-bridge will publish them at their times.'
                : 'Find them in your post-bridge drafts.'}
            </p>
            {mode !== 'download' && (
              <a
                href={mode === 'schedule' ? PB_SCHEDULED_URL : PB_DRAFTS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-1.5 h-9 px-4 mt-2 rounded-lg bg-ink text-bg text-[13px] font-medium hover:opacity-90"
              >
                View on post-bridge <ExternalLink size={13} />
              </a>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Accounts — only relevant when posting via post-bridge */}
            {mode !== 'download' && (
              <div>
                <label className="text-[11px] text-ink-5 uppercase tracking-widest font-semibold mb-1.5 block">Post to</label>
                {accounts.length === 0 ? (
                  <p className="text-[12px] text-ink-5">No connected accounts. Add your post-bridge key and connect accounts in Settings.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {accounts.map((a) => (
                      <label key={a.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line cursor-pointer hover:border-line-2">
                        <input type="checkbox" checked={selectedAccounts.includes(a.id)} onChange={() => toggleAccount(a.id)} disabled={busy} />
                        <span className="text-[13px] text-ink font-medium">{a.username}</span>
                        <span className="text-[11px] text-ink-5 uppercase">{a.platform}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Mode */}
            <div>
              <label className="text-[11px] text-ink-5 uppercase tracking-widest font-semibold mb-1.5 block">What to do</label>
              <div className="flex gap-2 flex-wrap">
                <Button variant={mode === 'download' ? 'primary' : 'secondary'} icon={<Download size={13} />} onClick={() => setMode('download')} disabled={busy}>Download locally</Button>
                {hasPostbridge && (
                  <>
                    <Button variant={mode === 'schedule' ? 'primary' : 'secondary'} onClick={() => setMode('schedule')} disabled={busy}>Schedule</Button>
                    <Button variant={mode === 'draft' ? 'primary' : 'secondary'} onClick={() => setMode('draft')} disabled={busy}>Save all as drafts</Button>
                  </>
                )}
              </div>
            </div>

            {mode === 'schedule' && (
              <div className="rounded-lg border border-line bg-surface p-3 space-y-3">
                <div>
                  <label className="text-[10px] text-ink-6 uppercase tracking-wider mb-1 block">Start at</label>
                  <input
                    type="datetime-local"
                    value={startLocal}
                    onChange={(e) => setStartLocal(e.target.value)}
                    disabled={busy}
                    className="w-full h-9 bg-card border border-line rounded-lg px-3 text-[13px] text-ink outline-none focus:border-ink-7"
                  />
                  {lastScheduledMs && (
                    <p className="text-[11px] text-ink-6 mt-1">
                      Last scheduled post is {new Date(lastScheduledMs).toLocaleString()} — defaulting to after it.
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-[10px] text-ink-6 uppercase tracking-wider mb-1 block">Space each one</label>
                  <div className="flex flex-wrap gap-1.5">
                    {INTERVAL_PRESETS.map((h) => (
                      <button
                        key={h}
                        onClick={() => { setHours(h); resetStartAfterLast(h); }}
                        disabled={busy}
                        className={`px-2.5 h-8 rounded-lg border text-[12px] font-medium transition-colors ${
                          hours === h ? 'border-ink bg-ink text-bg' : 'border-line bg-card text-ink-5 hover:border-line-2'
                        }`}
                      >
                        {h}h
                      </button>
                    ))}
                  </div>
                </div>
                {lastFireLabel && (
                  <p className="text-[11px] text-ink-6 leading-snug">
                    {slideshows.length} posts, {hours}h apart — last one fires <strong className="text-ink-3">{lastFireLabel}</strong>.
                  </p>
                )}
              </div>
            )}

            {error && <p className="text-[12px] text-red-600">{error}</p>}
            {progress && (
              <p className="text-[12px] text-ink-5 flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" />
                {mode === 'download' ? 'Rendering' : 'Uploading'} {progress.done} / {progress.total}…
              </p>
            )}
          </div>
        )}

        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          {doneCount !== null ? (
            <Button variant="primary" onClick={onDone}>Done</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button
                variant="primary"
                icon={busy ? <Loader2 size={13} className="animate-spin" /> : mode === 'download' ? <Download size={13} /> : <CalendarClock size={13} />}
                onClick={submit}
                disabled={busy}
              >
                {busy
                  ? mode === 'download' ? 'Rendering…' : 'Scheduling…'
                  : mode === 'download' ? `Download ${slideshows.length}`
                  : mode === 'schedule' ? `Schedule ${slideshows.length}`
                  : `Draft ${slideshows.length}`}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
