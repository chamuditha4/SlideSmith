// Frontend API client. All calls go to the local Slidesmith server (proxied at
// /api in dev, same-origin in production). The server holds the keys and talks
// to Claude + post-bridge — the browser never sees the secrets in a request.
import type {
  AppConfig,
  Project,
  Slideshow,
  SocialAccount,
  ScheduledPost,
  PostResult,
  ModelOption,
  LibraryImage,
  LibraryPack,
} from '../types';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    cache: 'no-store', // always hit the server — never a stale Schedule/Results list
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || res.statusText);
  return body as T;
}

export const getConfig = () => req<AppConfig>('/config');

// Global settings only (keys + model + scraper config).
export const saveConfig = (patch: { keys?: AppConfig['keys']; model?: string; scrapeMethod?: string; proxy?: string; pinterestActor?: string }) =>
  req<AppConfig>('/config', { method: 'PUT', body: JSON.stringify(patch) });

// Projects — each has its own Brain + default post-bridge accounts.
export const createProject = (name?: string) =>
  req<AppConfig>('/projects', { method: 'POST', body: JSON.stringify({ name }) });

export const updateProject = (
  id: string,
  patch: Partial<Pick<Project, 'name' | 'brain' | 'defaults' | 'imagePacks'>>
) => req<AppConfig>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(patch) });

export const deleteProject = (id: string) =>
  req<AppConfig>(`/projects/${id}`, { method: 'DELETE' });

export const activateProject = (id: string) =>
  req<AppConfig>(`/projects/${id}/activate`, { method: 'POST' });

export const testKeys = () =>
  req<{ postbridge: boolean; openrouter: boolean; apify: boolean; errors: Record<string, string> }>(
    '/config/test',
    { method: 'POST' }
  );

export const getModels = () => req<ModelOption[]>('/models');

export const getQueue = () => req<Slideshow[]>('/queue');

export const generate = (count = 4, packs?: string[]) =>
  req<Slideshow[]>('/generate', { method: 'POST', body: JSON.stringify({ count, packs }) });

export const removeFromQueue = (id: string) =>
  req<Slideshow[]>(`/queue/${id}`, { method: 'DELETE' });

export const updateSlideshow = (
  id: string,
  patch: Partial<Pick<Slideshow, 'slides' | 'caption' | 'hashtags' | 'hook'>>
) => req<Slideshow[]>(`/queue/${id}`, { method: 'PUT', body: JSON.stringify(patch) });

// ── Image library ─────────────────────────────────────────────────────────────
export const getLibrary = () => req<LibraryImage[]>('/library');

export const getPacks = () => req<LibraryPack[]>('/library/packs');

export const scrapePinterest = (searches: string[], count: number) =>
  req<{ added: number; found: number }>('/library/scrape', {
    method: 'POST',
    body: JSON.stringify({ searches, count }),
  });

export const deleteLibraryImage = (id: string) =>
  req<LibraryImage[]>(`/library/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getAccounts = () => req<SocialAccount[]>('/accounts');

export interface SchedulePayload {
  id: string;
  caption: string;
  slides: string[]; // PNG data URLs
  socialAccounts: number[];
  scheduledAt: string | null;
  mode: 'draft' | 'schedule';
}

export const schedule = (payload: SchedulePayload) =>
  req<unknown>('/schedule', { method: 'POST', body: JSON.stringify(payload) });

// post-bridge → ScheduledPost. post-bridge stores caption + media + schedule;
// it has no concept of our per-slide text, so the Schedule view shows the
// rendered images + caption + status.
export async function getScheduledPosts(): Promise<ScheduledPost[]> {
  const raw = await req<Array<Record<string, unknown>>>('/posts');
  return raw.map((p) => ({
    id: String(p.id),
    caption: String(p.caption || ''),
    status: String(p.status || (p.is_draft ? 'draft' : 'scheduled')),
    scheduledAt: (p.scheduled_at as string) || null,
    // The server resolves post-bridge's nested media (media.object.url) into a
    // flat string[] under `media_urls` — fall back to raw media for safety.
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
  const raw = await req<Array<Record<string, unknown>>>('/results');
  return raw.map(mapResult);
}

// Trigger a post-bridge analytics sync, then return the refreshed results.
export async function syncResults(): Promise<PostResult[]> {
  const raw = await req<Array<Record<string, unknown>>>('/results/sync', { method: 'POST' });
  return raw.map(mapResult);
}
