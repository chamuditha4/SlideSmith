// Browser-side persistence for the Vercel deployment.
// All state (config, queue, scraped library images) lives in localStorage.
// The Express server's file-based store is replaced by this module.
import type { AppConfig, Project, Slideshow, LibraryImage } from '../types';

const CONFIG_KEY  = 'slidesmith:config';
const QUEUE_KEY   = 'slidesmith:queue';
const LIBRARY_KEY = 'slidesmith:library';

const DEFAULT_BRAIN = {
  niche: '', appName: '', appDescription: '', audience: '', styleMemory: '',
};
const DEFAULT_DEFAULTS = { socialAccountIds: [] as number[], mode: 'draft' as const };

export async function fetchBundledPackNames(): Promise<string[]> {
  try {
    const r = await fetch('/library/manifest.json');
    const m = await r.json();
    return (m.packs || []).map((p: { name: string }) => p.name);
  } catch {
    return [];
  }
}

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): T {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  return value;
}

// ── Config ────────────────────────────────────────────────────────────────────

export async function getConfig(): Promise<AppConfig> {
  const saved = readJson<AppConfig | null>(CONFIG_KEY, null);
  if (saved?.projects?.length) return saved;

  const packNames = await fetchBundledPackNames();
  const project: Project = {
    id: newId('p'),
    name: 'Project 1',
    brain: { ...DEFAULT_BRAIN },
    defaults: { ...DEFAULT_DEFAULTS },
    imagePacks: packNames,
  };
  const cfg: AppConfig = {
    keys: { postbridge: '', openrouter: '', openai: '', deepseek: '', claude: '', apify: '' },
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    scrapeMethod: 'direct',
    proxy: '',
    pinterestActor: 'fatihtahta/pinterest-scraper-search',
    projects: [project],
    activeProjectId: project.id,
  };
  return writeJson(CONFIG_KEY, cfg);
}

export function saveConfig(cfg: AppConfig): AppConfig {
  return writeJson(CONFIG_KEY, cfg);
}

export function saveGlobal(
  cfg: AppConfig,
  patch: Partial<Pick<AppConfig, 'keys' | 'provider' | 'model' | 'scrapeMethod' | 'proxy' | 'pinterestActor'>>
): AppConfig {
  return saveConfig({
    ...cfg,
    provider:       patch.provider       ?? cfg.provider,
    model:          patch.model          ?? cfg.model,
    scrapeMethod:   patch.scrapeMethod   ?? cfg.scrapeMethod,
    proxy:          patch.proxy          ?? cfg.proxy,
    pinterestActor: patch.pinterestActor ?? cfg.pinterestActor,
    keys: patch.keys ? { ...cfg.keys, ...patch.keys } : cfg.keys,
  });
}

export function createProject(cfg: AppConfig, name?: string): AppConfig {
  const project: Project = {
    id: newId('p'),
    name: name || `Project ${cfg.projects.length + 1}`,
    brain: { ...DEFAULT_BRAIN },
    defaults: { ...DEFAULT_DEFAULTS },
    imagePacks: cfg.projects[0]?.imagePacks ?? [],
  };
  return saveConfig({ ...cfg, projects: [...cfg.projects, project], activeProjectId: project.id });
}

export function updateProject(
  cfg: AppConfig,
  id: string,
  patch: Partial<Pick<Project, 'name' | 'brain' | 'defaults' | 'imagePacks'>>
): AppConfig {
  const projects = cfg.projects.map((p) =>
    p.id !== id ? p : {
      ...p,
      name:       patch.name       ?? p.name,
      brain:      patch.brain      ? { ...p.brain, ...patch.brain }           : p.brain,
      defaults:   patch.defaults   ? { ...p.defaults, ...patch.defaults }     : p.defaults,
      imagePacks: patch.imagePacks ?? p.imagePacks,
    }
  );
  return saveConfig({ ...cfg, projects });
}

export function deleteProject(cfg: AppConfig, id: string): AppConfig {
  let projects = cfg.projects.filter((p) => p.id !== id);
  if (!projects.length) {
    projects = [{
      id: newId('p'), name: 'Project 1',
      brain: { ...DEFAULT_BRAIN }, defaults: { ...DEFAULT_DEFAULTS },
      imagePacks: [],
    }];
  }
  const activeProjectId = cfg.activeProjectId === id ? projects[0].id : cfg.activeProjectId;
  removeQueueFor(id);
  return saveConfig({ ...cfg, projects, activeProjectId });
}

export function setActiveProject(cfg: AppConfig, id: string): AppConfig {
  if (!cfg.projects.some((p) => p.id === id)) throw new Error('Unknown project');
  return saveConfig({ ...cfg, activeProjectId: id });
}

// ── Queue ─────────────────────────────────────────────────────────────────────

type QueueMap = Record<string, Slideshow[]>;

function readQueueMap(): QueueMap {
  return readJson<QueueMap>(QUEUE_KEY, {});
}

function writeQueueMap(m: QueueMap) {
  writeJson(QUEUE_KEY, m);
}

export function getQueue(projectId: string): Slideshow[] {
  return readQueueMap()[projectId] || [];
}

export function setQueue(projectId: string, items: Slideshow[]): Slideshow[] {
  const m = readQueueMap();
  m[projectId] = items;
  writeQueueMap(m);
  return items;
}

export function addToQueue(projectId: string, items: Slideshow[]): Slideshow[] {
  return setQueue(projectId, [...items, ...getQueue(projectId)]);
}

export function removeFromQueue(projectId: string, id: string): Slideshow[] {
  return setQueue(projectId, getQueue(projectId).filter((s) => s.id !== id));
}

export function updateInQueue(
  projectId: string,
  id: string,
  patch: Partial<Pick<Slideshow, 'slides' | 'caption' | 'hashtags' | 'hook'>>
): Slideshow[] {
  return setQueue(
    projectId,
    getQueue(projectId).map((s) => {
      if (s.id !== id) return s;
      const merged = { ...s };
      const allowed = ['slides', 'caption', 'hashtags', 'hook'] as const;
      for (const k of allowed) if (patch[k] !== undefined) (merged as Record<string, unknown>)[k] = patch[k];
      return merged;
    })
  );
}

function removeQueueFor(projectId: string) {
  const m = readQueueMap();
  delete m[projectId];
  writeQueueMap(m);
}

// ── Library (scraped images only — bundled packs come from /library/manifest.json) ──

export function getScrapedImages(): LibraryImage[] {
  return readJson<LibraryImage[]>(LIBRARY_KEY, []);
}

export function addScrapedImages(images: LibraryImage[]): LibraryImage[] {
  const existing = getScrapedImages();
  const existingUrls = new Set(existing.map((i) => i.url));
  const fresh = images.filter((i) => !existingUrls.has(i.url));
  const updated = [...fresh, ...existing];
  writeJson(LIBRARY_KEY, updated);
  return updated;
}

export function removeScrapedImage(id: string): LibraryImage[] {
  const updated = getScrapedImages().filter((i) => i.id !== id);
  writeJson(LIBRARY_KEY, updated);
  return updated;
}
