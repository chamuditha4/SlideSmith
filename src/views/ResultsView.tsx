import { useCallback, useEffect, useState } from 'react';
import { Eye, Heart, MessageCircle, Share2, Loader2, RefreshCw } from 'lucide-react';
import type { PostResult } from '../types';
import { ViewHeader } from '../components/ViewHeader';
import { getResults, syncResults } from '../lib/api';

interface ResultsViewProps {
  configured: boolean;
}

function formatNumber(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function ResultsView({ configured }: ResultsViewProps) {
  const [results, setResults] = useState<PostResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!configured) return;
    getResults()
      .then(setResults)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [configured]);

  // Refresh pulls fresh metrics from the platforms (post-bridge sync) first,
  // which is also what backfills cover thumbnails once a post goes live.
  const refresh = useCallback(async () => {
    if (!configured) return;
    setRefreshing(true);
    setError(null);
    try {
      setResults(await syncResults());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [configured]);

  const totalViews = results?.reduce((s, r) => s + r.views, 0) ?? 0;
  const totalLikes = results?.reduce((s, r) => s + r.likes, 0) ?? 0;

  return (
    <>
      <ViewHeader
        title="Results"
        subtitle="Live analytics from post-bridge for everything you've published."
        right={
          configured && (
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-line text-[12px] text-ink-4 hover:text-ink hover:border-line-2 disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Syncing…' : 'Refresh'}
            </button>
          )
        }
      />
      <div className="flex-1 overflow-y-auto">
        {results && results.length > 0 && (
          <div className="border-b border-line bg-surface">
            <div className="px-4 py-4 sm:px-6 md:px-8 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
              <Stat label="Total views" value={formatNumber(totalViews)} />
              <Stat label="Total likes" value={formatNumber(totalLikes)} />
              <Stat label="Posts tracked" value={String(results.length)} />
            </div>
          </div>
        )}

        <div className="p-4 sm:p-6 md:p-8">
          <div className="flex flex-col gap-3">
            {!configured ? (
              <Empty text="Add your post-bridge API key in Settings to see analytics." />
            ) : error ? (
              <Empty text={error} />
            ) : results === null ? (
              <Loading />
            ) : results.length === 0 ? (
              <Empty text="No analytics yet. Once your posts go live, post-bridge syncs their performance here." />
            ) : (
              results.map((r) => <ResultCard key={r.id} result={r} />)
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-ink-6 uppercase tracking-widest">{label}</div>
      <div className="text-[22px] font-semibold text-ink leading-none mt-1">{value}</div>
    </div>
  );
}

function ResultCard({ result }: { result: PostResult }) {
  return (
    <div className="bg-card border border-line rounded-xl p-4 flex gap-3 sm:gap-4">
      <div className="shrink-0 w-20 aspect-[9/16] rounded-md overflow-hidden bg-raised">
        {result.coverImageUrl && (
          <img src={result.coverImageUrl} alt="" className="w-full h-full object-cover" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-line bg-raised uppercase tracking-wide text-ink-4">
            {result.platform || 'post'}
          </span>
          {result.lastSyncedAt && (
            <span className="text-[11px] text-ink-6">
              synced {new Date(result.lastSyncedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        {result.description && (
          <h3 className="text-[14px] font-semibold text-ink leading-snug mb-2 line-clamp-2">
            {result.description}
          </h3>
        )}
        <div className="flex items-center gap-4 text-[12px] text-ink-4">
          <Metric icon={Eye} value={formatNumber(result.views)} />
          <Metric icon={Heart} value={formatNumber(result.likes)} />
          <Metric icon={MessageCircle} value={formatNumber(result.comments)} />
          <Metric icon={Share2} value={formatNumber(result.shares)} />
          {result.shareUrl && (
            <a href={result.shareUrl} target="_blank" rel="noreferrer" className="text-ink-5 underline">
              view post
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, value }: { icon: typeof Eye; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <Icon size={11} className="text-ink-6" />
      {value}
    </span>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-16 text-ink-5 text-[13px] gap-2">
      <Loader2 size={14} className="animate-spin" /> Loading analytics…
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-center py-16 text-[13px] text-ink-5 max-w-md mx-auto">{text}</div>;
}
