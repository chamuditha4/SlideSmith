// Frontend API client for the Vercel deployment.
// State (config, queue, scraped library) lives in localStorage via store.ts.
// External calls (AI generation, post-bridge, Pinterest) hit Vercel serverless
// functions in /api/ — which receive API keys per-request from this module.
import type {
  AppConfig,
  Project,
  Slideshow,
  Slide,
  SocialAccount,
  ScheduledPost,
  PostResult,
  ModelOption,
  LibraryImage,
  LibraryPack,
} from '../types';
import * as store from './store';

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

// ── Config & Projects (localStorage) ─────────────────────────────────────────

export const getConfig = () => store.getConfig();

export const saveConfig = async (
  patch: Partial<Pick<AppConfig, 'keys' | 'provider' | 'model' | 'scrapeMethod' | 'proxy' | 'pinterestActor'>>
): Promise<AppConfig> => {
  const cfg = await store.getConfig();
  return store.saveGlobal(cfg, patch);
};

export const createProject = async (name?: string): Promise<AppConfig> => {
  const cfg = await store.getConfig();
  return store.createProject(cfg, name);
};

export const updateProject = async (
  id: string,
  patch: Partial<Pick<Project, 'name' | 'brain' | 'defaults' | 'imagePacks'>>
): Promise<AppConfig> => {
  const cfg = await store.getConfig();
  return store.updateProject(cfg, id, patch);
};

export const deleteProject = async (id: string): Promise<AppConfig> => {
  const cfg = await store.getConfig();
  return store.deleteProject(cfg, id);
};

export const activateProject = async (id: string): Promise<AppConfig> => {
  const cfg = await store.getConfig();
  return store.setActiveProject(cfg, id);
};

// ── Queue (localStorage) ──────────────────────────────────────────────────────

export const getQueue = async (): Promise<Slideshow[]> => {
  const cfg = await store.getConfig();
  const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) || cfg.projects[0];
  return store.getQueue(active.id);
};

export const removeFromQueue = async (id: string): Promise<Slideshow[]> => {
  const cfg = await store.getConfig();
  const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) || cfg.projects[0];
  return store.removeFromQueue(active.id, id);
};

export const updateSlideshow = async (
  id: string,
  patch: Partial<Pick<Slideshow, 'slides' | 'caption' | 'hashtags' | 'hook'>>
): Promise<Slideshow[]> => {
  const cfg = await store.getConfig();
  const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) || cfg.projects[0];
  return store.updateInQueue(active.id, id, patch);
};

// ── AI Generation (serverless) ────────────────────────────────────────────────

export const generate = async (count = 4, packs?: string[]): Promise<Slideshow[]> => {
  const cfg = await store.getConfig();
  const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) || cfg.projects[0];
  const selectedPacks = packs ?? active.imagePacks ?? [];

  // Build background pool from the library, filtered by selected packs.
  // Scraped images are proxied through /api/library/img so canvas rendering works.
  let pool: { url: string }[] = [];
  if (selectedPacks.length) {
    const allImages = await getLibrary();
    pool = allImages
      .filter((img) => selectedPacks.includes(img.pack))
      .map((img) => ({ url: img.url }));
  }

  const slideshows = await req<Slideshow[]>('/generate', {
    method: 'POST',
    body: JSON.stringify({
      apiKey:   cfg.keys[cfg.provider],
      model:    cfg.model,
      provider: cfg.provider,
      brain:    active.brain,
      count,
      pool,
    }),
  });

  store.addToQueue(active.id, slideshows);
  return slideshows;
};

// ── Image Library ─────────────────────────────────────────────────────────────

// Fetch bundled packs from the static manifest and combine with scraped URLs.
// Scraped images are served via the /api/library/img proxy so they're
// same-origin for canvas rendering (avoids cross-origin taint).
export const getLibrary = async (): Promise<LibraryImage[]> => {
  let bundled: LibraryImage[] = [];
  try {
    const manifest = await fetch('/library/manifest.json').then((r) => r.json());
    bundled = (manifest.packs || []).flatMap((pack: { name: string; images: string[] }) =>
      (pack.images || []).map((path: string) => ({
        id: `bundled:${path}`,
        url: `/library/${path}`,
        pack: pack.name,
        source: 'bundled' as const,
      }))
    );
  } catch {}

  const scraped = store.getScrapedImages().map((img) => ({
    ...img,
    // Proxy scraped images so they're same-origin for canvas rendering.
    url: `/api/library/img?url=${encodeURIComponent(img.url)}`,
  }));

  return [...scraped, ...bundled];
};

export const getPacks = async (): Promise<LibraryPack[]> => {
  const images = await getLibrary();
  const map = new Map<string, LibraryPack>();
  for (const img of images) {
    if (!map.has(img.pack)) {
      map.set(img.pack, { name: img.pack, source: img.source, count: 0, covers: [] });
    }
    const p = map.get(img.pack)!;
    p.count++;
    if (p.covers.length < 4) p.covers.push(img.url);
  }
  return [...map.values()];
};

export const deleteLibraryImage = async (id: string): Promise<LibraryImage[]> => {
  store.removeScrapedImage(id);
  return getLibrary();
};

// scrapePinterest is handled directly in LibraryView (SSE streaming).

// ── Models (serverless — OpenRouter needs a proxy, others return static lists) ─

export const getModels = (provider?: string) =>
  req<ModelOption[]>(`/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`);

// ── Key test (serverless — validates keys against each provider's API) ─────────

export const testKeys = async () => {
  const cfg = await store.getConfig();
  return req<{ postbridge: boolean; ai: boolean; apify: boolean; errors: Record<string, string> }>(
    '/config/test',
    { method: 'POST', body: JSON.stringify({ keys: cfg.keys, provider: cfg.provider }) }
  );
};

// ── post-bridge: Accounts ─────────────────────────────────────────────────────

export const getAccounts = async (): Promise<SocialAccount[]> => {
  const cfg = await store.getConfig();
  if (!cfg.keys.postbridge) return [];
  return req<SocialAccount[]>('/accounts', {
    method: 'POST',
    body: JSON.stringify({ postbridgeKey: cfg.keys.postbridge }),
  });
};

// ── post-bridge: Schedule ─────────────────────────────────────────────────────

export interface SchedulePayload {
  id: string;
  caption: string;
  slides: string[];
  socialAccounts: number[];
  scheduledAt: string | null;
  mode: 'draft' | 'schedule';
}

export const schedule = async (payload: SchedulePayload): Promise<unknown> => {
  const cfg = await store.getConfig();
  const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) || cfg.projects[0];
  const result = await req<unknown>('/schedule', {
    method: 'POST',
    body: JSON.stringify({ ...payload, postbridgeKey: cfg.keys.postbridge }),
  });
  // Remove from local queue now that it's been sent to post-bridge.
  if (payload.id) store.removeFromQueue(active.id, payload.id);
  return result;
};

// ── post-bridge: Posts / Analytics ───────────────────────────────────────────

export async function getScheduledPosts(): Promise<ScheduledPost[]> {
  const cfg = await store.getConfig();
  if (!cfg.keys.postbridge) return [];
  const raw = await req<Array<Record<string, unknown>>>('/posts', {
    method: 'POST',
    body: JSON.stringify({ postbridgeKey: cfg.keys.postbridge }),
  });
  return raw.map((p) => ({
    id: String(p.id),
    caption: String(p.caption || ''),
    status: String(p.status || (p.is_draft ? 'draft' : 'scheduled')),
    scheduledAt: (p.scheduled_at as string) || null,
    mediaUrls: Array.isArray(p.media_urls)
      ? (p.media_urls as unknown[]).map(String).filter(Boolean)
      : Array.isArray(p.media)
      ? (p.media as Array<{ url?: string; object?: { url?: string } } | string>)
          .map((m) => (typeof m === 'string' ? m : m.object?.url || m.url || ''))
          .filter(Boolean)
      : [],
    socialAccounts: (p.social_accounts as number[]) || [],
    isDraft: !!p.is_draft,
  }));
}

function mapResult(a: Record<string, unknown>): PostResult {
  return {
    id: String(a.id),
    platform: String(a.platform || ''),
    views: Number(a.view_count || 0),
    likes: Number(a.like_count || 0),
    comments: Number(a.comment_count || 0),
    shares: Number(a.share_count || 0),
    coverImageUrl: (a.cover_image_url as string) || null,
    shareUrl: (a.share_url as string) || null,
    description: (a.video_description as string) || null,
    lastSyncedAt: (a.last_synced_at as string) || null,
  };
}

export async function getResults(): Promise<PostResult[]> {
  const cfg = await store.getConfig();
  if (!cfg.keys.postbridge) return [];
  const raw = await req<Array<Record<string, unknown>>>('/results', {
    method: 'POST',
    body: JSON.stringify({ postbridgeKey: cfg.keys.postbridge }),
  });
  return raw.map(mapResult);
}

export async function syncResults(): Promise<PostResult[]> {
  const cfg = await store.getConfig();
  if (!cfg.keys.postbridge) return [];
  const raw = await req<Array<Record<string, unknown>>>('/results/sync', {
    method: 'POST',
    body: JSON.stringify({ postbridgeKey: cfg.keys.postbridge }),
  });
  return raw.map(mapResult);
}

// Re-export Slide type so callers that imported it from api.ts keep working.
export type { Slide };
