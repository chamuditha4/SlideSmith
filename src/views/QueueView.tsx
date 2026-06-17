import { Check, X, Sparkles, RefreshCw, Loader2, Pencil } from 'lucide-react';
import type { Slideshow } from '../types';
import { ViewHeader } from '../components/ViewHeader';
import { SlidePreview } from '../components/SlidePreview';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';

interface QueueViewProps {
  slideshows: Slideshow[];
  generating: boolean;
  canGenerate: boolean;
  selectedIds: string[];
  onGenerate: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkSchedule: () => void;
}

export function QueueView({
  slideshows,
  generating,
  canGenerate,
  selectedIds,
  onGenerate,
  onApprove,
  onReject,
  onEdit,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onBulkSchedule,
}: QueueViewProps) {
  const selectedCount = selectedIds.length;
  return (
    <>
      <ViewHeader
        title="Queue"
        subtitle={`${slideshows.length} slideshows waiting for your review. Approve to send to the scheduler.`}
        right={
          <>
            {selectedCount > 0 ? (
              <>
                <span className="text-[12px] text-ink-5">{selectedCount} selected</span>
                <Button variant="primary" icon={<Check size={13} />} onClick={onBulkSchedule}>
                  Schedule {selectedCount}
                </Button>
                <Button variant="ghost" onClick={onClearSelection}>Clear</Button>
              </>
            ) : (
              slideshows.length > 0 && (
                <Button variant="secondary" onClick={onSelectAll}>Select all</Button>
              )
            )}
            <Button
              variant="primary"
              icon={generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              onClick={onGenerate}
              disabled={generating || !canGenerate}
            >
              {generating ? 'Generating…' : 'Generate more'}
            </Button>
          </>
        }
      />

      {slideshows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <div className="w-12 h-12 rounded-full bg-raised flex items-center justify-center mx-auto mb-4">
              <Check size={20} className="text-ink-5" />
            </div>
            <h2 className="text-[15px] font-semibold text-ink">
              {canGenerate ? 'Queue empty' : 'Add your OpenRouter key to start'}
            </h2>
            <p className="text-[13px] text-ink-5 mt-1">
              {canGenerate
                ? 'Generate a fresh batch of slideshows with AI.'
                : 'Head to Settings, paste your OpenRouter API key, and tune the Brain.'}
            </p>
            {canGenerate && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="secondary"
                  icon={generating ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  onClick={onGenerate}
                  disabled={generating}
                >
                  {generating ? 'Generating…' : 'Generate now'}
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl mx-auto">
            {slideshows.map((s) => (
              <SlideshowCard
                key={s.id}
                slideshow={s}
                selected={selectedIds.includes(s.id)}
                onToggleSelect={() => onToggleSelect(s.id)}
                onApprove={() => onApprove(s.id)}
                onReject={() => onReject(s.id)}
                onEdit={() => onEdit(s.id)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

interface CardProps {
  slideshow: Slideshow;
  selected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}

function SlideshowCard({ slideshow, selected, onToggleSelect, onApprove, onReject, onEdit }: CardProps) {
  return (
    <div className={`bg-card border rounded-xl overflow-hidden animate-fadeIn transition-colors ${selected ? 'border-ink ring-1 ring-ink' : 'border-line'}`}>
      {/* Slide strip */}
      <div className="relative p-4 bg-surface border-b border-line">
        <label className="absolute top-2 left-2 z-10 w-6 h-6 rounded-md bg-card/90 border border-line flex items-center justify-center cursor-pointer shadow-sm">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} className="cursor-pointer" />
        </label>
        <div className="grid grid-cols-6 gap-1.5">
          {slideshow.slides.map((slide) => (
            <SlidePreview key={slide.id} slide={slide} />
          ))}
        </div>
      </div>

      {/* Meta */}
      <div className="p-4">
        <div className="flex items-start gap-2 mb-2">
          <Sparkles size={12} className="text-ink-6 mt-1 shrink-0" />
          <span className="text-[11px] text-ink-5 leading-snug">
            {slideshow.rationale}
          </span>
        </div>

        <h3 className="text-[14px] font-semibold text-ink leading-snug mb-1.5">
          {slideshow.hook}
        </h3>
        <p className="text-[12px] text-ink-4 leading-snug line-clamp-2">
          {slideshow.caption}
        </p>

        <div className="flex flex-wrap gap-1 mt-2">
          {slideshow.hashtags.map((tag) => (
            <span key={tag} className="text-[10px] text-ink-5 px-1.5 py-0.5 rounded bg-raised">
              #{tag}
            </span>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-4 pt-3 border-t border-line">
          <Button variant="secondary" icon={<Pencil size={13} />} onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="primary"
            icon={<Check size={13} />}
            onClick={onApprove}
            fullWidth
          >
            Approve
          </Button>
          <IconButton
            variant="secondary"
            icon={<X size={13} />}
            label="Reject"
            onClick={onReject}
          />
        </div>
      </div>
    </div>
  );
}
