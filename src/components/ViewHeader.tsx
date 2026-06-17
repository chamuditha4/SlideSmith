import type { ReactNode } from 'react';

interface ViewHeaderProps {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export function ViewHeader({ title, subtitle, right }: ViewHeaderProps) {
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5 md:px-8 border-b border-line flex items-start justify-between gap-3 shrink-0 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[16px] sm:text-[18px] font-semibold text-ink leading-tight">{title}</h1>
        {subtitle && (
          <p className="text-[12px] sm:text-[13px] text-ink-5 mt-1">{subtitle}</p>
        )}
      </div>
      {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
    </div>
  );
}
