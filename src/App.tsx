import { useEffect, useState, useCallback } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { ScheduleModal } from './components/ScheduleModal';
import { BulkScheduleModal } from './components/BulkScheduleModal';
import { GenerateModal } from './components/GenerateModal';
import { SlideshowEditorModal } from './components/SlideshowEditorModal';
import { QueueView } from './views/QueueView';
import { LibraryView } from './views/LibraryView';
import { ScheduleView } from './views/ScheduleView';
import { ResultsView } from './views/ResultsView';
import { BrainView } from './views/BrainView';
import { SettingsView } from './views/SettingsView';
import { renderSlideshow } from './lib/render';
import * as api from './lib/api';
import { clearStoredPassword } from './lib/api';
import { LoginScreen } from './components/LoginScreen';
import type { AppConfig, Project, Slideshow, Slide, SocialAccount, BrainState, ViewKey } from './types';

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [activeView, setActiveView] = useState<ViewKey>('queue');
  const [queue, setQueue] = useState<Slideshow[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [generating, setGenerating] = useState(false);
  const [scheduling, setScheduling] = useState<Slideshow | null>(null);
  const [editing, setEditing] = useState<Slideshow | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const activeProvider = config?.provider ?? 'openrouter';
  const hasAiKey = !!(config && config.keys[activeProvider]);
  const hasPostbridge = !!config?.keys.postbridge;
  const activeProject: Project | undefined = config?.projects.find(
    (p) => p.id === config.activeProjectId
  ) ?? config?.projects[0];

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await api.getAccounts());
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.getConfig();
        setConfig(cfg);
        setQueue(await api.getQueue());
        const provider = cfg.provider ?? 'openrouter';
        if (!cfg.keys[provider] && !cfg.keys.postbridge) setActiveView('settings');
        if (cfg.keys.postbridge) loadAccounts();
      } catch (e) {
        if (e instanceof Error && e.message === '__UNAUTHORIZED__') {
          setLocked(true);
        } else {
          setError(e instanceof Error ? e.message : 'Could not reach the Slidesmith server.');
        }
      }
    })();
  }, [loadAccounts, retryKey]);

  // Lock the app globally whenever any fetch returns 401 (e.g. from LibraryView).
  useEffect(() => {
    const handler = () => {
      clearStoredPassword();
      setConfig(null);
      setQueue([]);
      setLocked(true);
    };
    window.addEventListener('slidesmith:unauthorized', handler);
    return () => window.removeEventListener('slidesmith:unauthorized', handler);
  }, []);

  const generate = async (count: number, packs: string[]) => {
    setError(null);
    setGenerating(true);
    try {
      await api.generate(count, packs);
      setQueue(await api.getQueue());
      setGenerateOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const reject = async (id: string) => {
    setQueue(await api.removeFromQueue(id));
  };

  // Keep the multi-select in sync as queue items come and go.
  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => queue.some((s) => s.id === id)));
  }, [queue]);

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const bulkDone = async () => {
    setBulkOpen(false);
    setSelectedIds([]);
    setQueue(await api.getQueue());
    setActiveView('schedule');
  };

  const saveEdits = async (patch: { slides: Slide[]; caption: string; hashtags: string[] }) => {
    if (!editing) return;
    setQueue(await api.updateSlideshow(editing.id, patch));
    setEditing(null);
  };

  const confirmSchedule = async (opts: {
    socialAccounts: number[];
    mode: 'draft' | 'schedule';
    scheduledAt: string | null;
  }) => {
    if (!scheduling) return;
    const scheduledId = scheduling.id;
    const slides = await renderSlideshow(scheduling);
    await api.schedule({
      id: scheduledId,
      caption: `${scheduling.caption}${scheduling.hashtags.length ? ' ' + scheduling.hashtags.map((t) => `#${t}`).join(' ') : ''}`,
      slides,
      socialAccounts: opts.socialAccounts,
      scheduledAt: opts.scheduledAt,
      mode: opts.mode,
    });
    // Drop the now-scheduled slideshow from the queue immediately (optimistic),
    // then reconcile with the server. The modal stays open showing its success
    // state with a link to post-bridge instead of us jumping to the Schedule tab.
    setQueue((q) => q.filter((s) => s.id !== scheduledId));
    setQueue(await api.getQueue());
  };

  // Global settings (keys/model/scraper config) + per-project edits (name/defaults), in one call.
  const saveSettings = async (patch: {
    keys?: AppConfig['keys'];
    provider?: AppConfig['provider'];
    model?: string;
    scrapeMethod?: string;
    proxy?: string;
    pinterestActor?: string;
    name?: string;
    defaults?: Project['defaults'];
    imagePacks?: string[];
  }) => {
    if (patch.keys || patch.provider !== undefined || patch.model !== undefined || patch.scrapeMethod !== undefined || patch.proxy !== undefined || patch.pinterestActor !== undefined) {
      await api.saveConfig({ keys: patch.keys, provider: patch.provider, model: patch.model, scrapeMethod: patch.scrapeMethod, proxy: patch.proxy, pinterestActor: patch.pinterestActor });
    }
    if (activeProject && (patch.name !== undefined || patch.defaults || patch.imagePacks)) {
      await api.updateProject(activeProject.id, {
        name: patch.name,
        defaults: patch.defaults,
        imagePacks: patch.imagePacks,
      });
    }
    setConfig(await api.getConfig());
  };

  const saveBrain = async (brain: BrainState) => {
    if (!activeProject) return;
    // Optimistic local update so typing stays snappy, then persist.
    setConfig((c) =>
      c
        ? { ...c, projects: c.projects.map((p) => (p.id === activeProject.id ? { ...p, brain } : p)) }
        : c
    );
    await api.updateProject(activeProject.id, { brain });
  };

  const switchProject = async (id: string) => {
    setConfig(await api.activateProject(id));
    setQueue(await api.getQueue());
  };

  const newProject = async () => {
    setConfig(await api.createProject());
    setQueue(await api.getQueue());
    setActiveView('settings');
  };

  const removeProject = async (id: string) => {
    setConfig(await api.deleteProject(id));
    setQueue(await api.getQueue());
  };

  const handleUnlock = () => {
    setLocked(false);
    setError(null);
    setConfig(null);
    setRetryKey((k) => k + 1);
  };

  if (locked) return <LoginScreen onUnlock={handleUnlock} />;

  if (!config || !activeProject) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg text-ink-5 text-[13px]">
        {error ? <span className="text-red-600 max-w-sm text-center">{error}</span> : 'Loading…'}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-bg text-ink">
      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <Sidebar
        activeView={activeView}
        onSelectView={setActiveView}
        queueCount={queue.length}
        scheduledCount={0}
        projects={config.projects}
        activeProjectId={config.activeProjectId}
        onSwitchProject={switchProject}
        onNewProject={newProject}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <main className="flex-1 h-full overflow-hidden flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-line shrink-0 bg-bg">
          <button onClick={() => setSidebarOpen(true)} className="text-ink-4 hover:text-ink">
            <Menu size={18} />
          </button>
          <span className="text-[14px] font-semibold text-ink">Slidesmith</span>
        </div>
        {error && activeView !== 'settings' && (
          <div className="px-8 py-2 bg-red-50 border-b border-red-200 text-[12px] text-red-700">
            {error}
          </div>
        )}

        {activeView === 'queue' && (
          <QueueView
            slideshows={queue}
            generating={generating}
            canGenerate={hasAiKey}
            onGenerate={() => setGenerateOpen(true)}
            selectedIds={selectedIds}
            onApprove={(id) => setScheduling(queue.find((s) => s.id === id) || null)}
            onReject={reject}
            onEdit={(id) => setEditing(queue.find((s) => s.id === id) || null)}
            onToggleSelect={toggleSelect}
            onSelectAll={() => setSelectedIds(queue.map((s) => s.id))}
            onClearSelection={() => setSelectedIds([])}
            onBulkSchedule={() => setBulkOpen(true)}
          />
        )}
        {activeView === 'library' && <LibraryView />}
        {activeView === 'schedule' && <ScheduleView configured={hasPostbridge} />}
        {activeView === 'results' && <ResultsView configured={hasPostbridge} />}
        {activeView === 'brain' && <BrainView brain={activeProject.brain} onChange={saveBrain} />}
        {activeView === 'settings' && (
          <SettingsView
            config={config}
            project={activeProject}
            accounts={accounts}
            canDelete={config.projects.length > 1}
            onSave={saveSettings}
            onDeleteProject={() => removeProject(activeProject.id)}
            onReloadAccounts={loadAccounts}
          />
        )}
      </main>

      {scheduling && (
        <ScheduleModal
          slideshow={scheduling}
          accounts={accounts}
          defaults={activeProject.defaults}
          hasPostbridge={hasPostbridge}
          onClose={() => setScheduling(null)}
          onConfirm={confirmSchedule}
          onDownloadDone={async () => {
            const id = scheduling.id;
            setScheduling(null);
            setQueue(await api.removeFromQueue(id));
          }}
        />
      )}

      {editing && (
        <SlideshowEditorModal
          slideshow={editing}
          onClose={() => setEditing(null)}
          onSave={saveEdits}
        />
      )}

      {bulkOpen && selectedIds.length > 0 && (
        <BulkScheduleModal
          slideshows={queue.filter((s) => selectedIds.includes(s.id))}
          accounts={accounts}
          defaults={activeProject.defaults}
          hasPostbridge={hasPostbridge}
          // Closing via the X/backdrop must still drop any now-scheduled items
          // from the queue — otherwise it looks stale until a browser reload.
          onClose={async () => {
            setBulkOpen(false);
            setSelectedIds([]);
            setQueue(await api.getQueue());
          }}
          onDone={bulkDone}
        />
      )}

      {generateOpen && (
        <GenerateModal
          defaultPacks={activeProject.imagePacks}
          generating={generating}
          onClose={() => setGenerateOpen(false)}
          onGenerate={generate}
        />
      )}
    </div>
  );
}

