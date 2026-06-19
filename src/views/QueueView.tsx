import { useState } from 'react';
import { Check, X, Sparkles, RefreshCw, Loader2, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
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
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 max-w-4xl mx-auto">
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
  const [activeSlide, setActiveSlide] = useState(0);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const slide = slideshow.slides[activeSlide];
  const total = slideshow.slides.length;

  const prev = (e: React.MouseEvent) => { e.stopPropagation(); setActiveSlide(i => Math.max(0, i - 1)); };
  const next = (e: React.MouseEvent) => { e.stopPropagation(); setActiveSlide(i => Math.min(total - 1, i + 1)); };

  return (
    <div className={`bg-card border rounded-xl overflow-hidden animate-fadeIn transition-colors ${selected ? 'border-ink ring-1 ring-ink' : 'border-line'}`}>
      {/* TikTok-style body: slide left, caption right */}
      <div className="flex">
        {/* Slide preview column */}
        <div className="relative shrink-0 w-[200px] bg-black">
          <label className="absolute top-2 left-2 z-10 w-5 h-5 rounded bg-black/60 border border-white/20 flex items-center justify-center cursor-pointer shadow-sm">
            <input type="checkbox" checked={selected} onChange={onToggleSelect} className="cursor-pointer accent-white" />
          </label>

          <SlidePreview slide={slide} className="w-full" />

          {activeSlide > 0 && (
            <button
              onClick={prev}
              className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/55 flex items-center justify-center text-white hover:bg-black/80 transition-colors"
            >
              <ChevronLeft size={14} />
            </button>
          )}
          {activeSlide < total - 1 && (
            <button
              onClick={next}
              className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/55 flex items-center justify-center text-white hover:bg-black/80 transition-colors"
            >
              <ChevronRight size={14} />
            </button>
          )}

          <div className="absolute bottom-1.5 right-1.5 text-[9px] text-white bg-black/60 rounded px-1.5 py-0.5 font-medium">
            {activeSlide + 1}/{total}
          </div>
        </div>

        {/* Caption column */}
        <div className="flex-1 min-w-0 p-3 flex flex-col">
          {/* Hook — like TikTok username + bold first line */}
          <p className="text-[13px] font-bold text-ink leading-snug mb-2">
            {slideshow.hook}
          </p>

          {/* Caption — expandable like TikTok description */}
          <div className="flex-1 min-h-0">
            <p className={`text-[11px] text-ink-4 leading-relaxed ${captionExpanded ? '' : 'line-clamp-5'}`}>
              {slideshow.caption}
            </p>
            {!captionExpanded && slideshow.caption.length > 120 && (
              <button
                onClick={() => setCaptionExpanded(true)}
                className="text-[11px] text-ink-5 hover:text-ink mt-0.5"
              >
                more
              </button>
            )}
          </div>

          {/* Hashtags — inline like TikTok */}
          <div className="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-2">
            {slideshow.hashtags.map((tag) => (
              <span key={tag} className="text-[11px] text-blue-400 font-medium">#{tag}</span>
            ))}
          </div>

          {/* Rationale */}
          <div className="flex items-start gap-1.5 mt-2 pt-2 border-t border-line">
            <Sparkles size={10} className="text-ink-6 mt-0.5 shrink-0" />
            <span className="text-[10px] text-ink-6 leading-snug">{slideshow.rationale}</span>
          </div>
        </div>
      </div>

      {/* Slide dots + actions */}
      <div className="px-3 pb-3 pt-2 border-t border-line">
        <div className="flex justify-center gap-1 mb-3">
          {slideshow.slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveSlide(i)}
              className={`rounded-full transition-all duration-150 ${i === activeSlide ? 'w-3 h-1.5 bg-ink' : 'w-1.5 h-1.5 bg-line hover:bg-ink-5'}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Pencil size={13} />} onClick={onEdit}>Edit</Button>
          <Button variant="primary" icon={<Check size={13} />} onClick={onApprove} fullWidth>Approve</Button>
          <IconButton variant="secondary" icon={<X size={13} />} label="Reject" onClick={onReject} />
        </div>
      </div>
    </div>
  );
}
