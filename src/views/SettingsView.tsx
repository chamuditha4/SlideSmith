import { useEffect, useState } from 'react';
import { Check, X, Loader2, KeyRound, Trash2, Info, Download } from 'lucide-react';
import type { AppConfig, AiProvider, Project, SocialAccount, ModelOption } from '../types';
import { ViewHeader } from '../components/ViewHeader';
import { Button } from '../components/Button';
import { testKeys, getModels } from '../lib/api';
import { PackPicker } from '../components/PackPicker';

interface SettingsViewProps {
  config: AppConfig;
  project: Project;
  accounts: SocialAccount[];
  canDelete: boolean;
  onSave: (patch: {
    keys?: AppConfig['keys'];
    provider?: AiProvider;
    model?: string;
    scrapeMethod?: string;
    proxy?: string;
    pinterestActor?: string;
    name?: string;
    defaults?: Project['defaults'];
    imagePacks?: string[];
  }) => Promise<void>;
  onDeleteProject: () => void;
  onReloadAccounts: () => void;
}

const POSTBRIDGE_URL = 'https://post-bridge.com?atp=clip-factory';

const PostBridgeLink = ({ children }: { children: React.ReactNode }) => (
  <a href={POSTBRIDGE_URL} target="_blank" rel="noreferrer" className="text-ink-4 underline hover:text-ink">
    {children}
  </a>
);

const PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openrouter: 'openai/gpt-4o-mini',
  openai:     'gpt-4o-mini',
  deepseek:   'deepseek-chat',
  claude:     'claude-sonnet-4-6',
};

const inputClass =
  'w-full h-9 bg-card border border-line rounded-lg px-3 text-[13px] text-ink ' +
  'placeholder:text-ink-6 outline-none transition-colors ' +
  'focus:border-ink-7 focus:ring-2 focus:ring-ink/10';

export function SettingsView({
  config,
  project,
  accounts,
  canDelete,
  onSave,
  onDeleteProject,
  onReloadAccounts,
}: SettingsViewProps) {
  const [postbridge, setPostbridge] = useState(config.keys.postbridge);
  const [provider, setProvider] = useState<AiProvider>(config.provider ?? 'openrouter');
  const [openrouter, setOpenrouter] = useState(config.keys.openrouter);
  const [openai, setOpenai] = useState(config.keys.openai ?? '');
  const [deepseek, setDeepseek] = useState(config.keys.deepseek ?? '');
  const [claude, setClaude] = useState(config.keys.claude ?? '');
  const [apify, setApify] = useState(config.keys.apify);
  const [embeddingKey, setEmbeddingKey] = useState(config.keys.embeddingKey ?? '');
  const [scrapeMethod, setScrapeMethod] = useState<'direct' | 'apify'>(config.scrapeMethod);
  const [proxy, setProxy] = useState(config.proxy);
  const [pinterestActor, setPinterestActor] = useState(config.pinterestActor);
  const [model, setModel] = useState(config.model);
  const [name, setName] = useState(project.name);
  const [mode, setMode] = useState(project.defaults.mode);
  const [selected, setSelected] = useState<number[]>(project.defaults.socialAccountIds);
  const [imagePacks, setImagePacks] = useState<string[]>(project.imagePacks);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelFilter, setModelFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<{ postbridge: boolean; ai: boolean; apify: boolean; errors: Record<string, string> } | null>(null);

  // Re-sync editable fields when the active project changes (switching projects).
  useEffect(() => {
    setName(project.name);
    setMode(project.defaults.mode);
    setSelected(project.defaults.socialAccountIds);
    setImagePacks(project.imagePacks);
  }, [project.id, project.name, project.defaults.mode, project.defaults.socialAccountIds, project.imagePacks]);

  useEffect(() => {
    setModels([]);
    getModels(provider).then(setModels).catch(() => setModels([]));
  }, [provider]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await onSave({
        keys: { postbridge, openrouter, openai, deepseek, claude, apify, embeddingKey },
        provider,
        model,
        scrapeMethod,
        proxy,
        pinterestActor,
        name,
        defaults: { socialAccountIds: selected, mode },
        imagePacks,
      });
      onReloadAccounts();
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      await save();
      setTest(await testKeys());
      onReloadAccounts();
    } finally {
      setTesting(false);
    }
  };

  const toggleAccount = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const filtered = modelFilter
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(modelFilter.toLowerCase()) ||
          m.name.toLowerCase().includes(modelFilter.toLowerCase())
      )
    : models;

  return (
    <>
      <ViewHeader
        title="Settings"
        subtitle="Your own API keys, stored locally on this machine — never sent anywhere but the services they belong to."
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-6 md:p-8 space-y-8">
          {/* Project */}
          <Section
            title="Project"
            description="A project is one brand/account. Its Brain and default posting accounts are separate — your API keys and model are shared across all projects."
          >
            <Field label="Project name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </Field>
            {canDelete && (
              <Button variant="danger-ghost" icon={<Trash2 size={13} />} onClick={onDeleteProject}>
                Delete this project
              </Button>
            )}
          </Section>

          {/* Keys (global) */}
          <Section
            title="API keys"
            description="Shared across all projects. Stored in ~/.slidesmith/config.json on your computer."
          >
            <LocalModeNote />
            <Field
              label={<>post-bridge API key <span className="text-ink-6 font-normal normal-case tracking-normal">(optional)</span></>}
              hint={<>Cloud scheduling, multi-platform posting &amp; analytics. Leave blank to use local download mode. Get one at <PostBridgeLink>post-bridge.com</PostBridgeLink>.</>}
            >
              <input
                value={postbridge}
                onChange={(e) => setPostbridge(e.target.value)}
                placeholder="pb_..."
                className={`${inputClass} font-mono`}
              />
              <TestBadge ok={test?.postbridge} error={test?.errors?.postbridge} />
            </Field>

            <Field label="AI provider" hint="Which service runs the AI that writes your slideshows. Your keys for all providers are saved — switching just changes which one is active.">
              <div className="flex gap-2 flex-wrap">
                {(['openrouter', 'openai', 'deepseek', 'claude'] as AiProvider[]).map((p) => (
                  <Button
                    key={p}
                    variant={provider === p ? 'primary' : 'secondary'}
                    onClick={() => {
                      setProvider(p);
                      setModelFilter('');
                      setModel(PROVIDER_DEFAULT_MODELS[p]);
                    }}
                  >
                    {{ openrouter: 'OpenRouter', openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude' }[p]}
                  </Button>
                ))}
              </div>
            </Field>

            {provider === 'openrouter' && (
              <Field label="OpenRouter API key" hint="One key for any model — 300+ models available. Get one at openrouter.ai/keys.">
                <input
                  value={openrouter}
                  onChange={(e) => setOpenrouter(e.target.value)}
                  placeholder="sk-or-..."
                  className={`${inputClass} font-mono`}
                />
                <TestBadge ok={test?.ai} error={test?.errors?.ai} />
              </Field>
            )}
            {provider === 'openai' && (
              <Field label="OpenAI API key" hint="Use GPT-4o, o1, and other OpenAI models. Get one at platform.openai.com/api-keys.">
                <input
                  value={openai}
                  onChange={(e) => setOpenai(e.target.value)}
                  placeholder="sk-..."
                  className={`${inputClass} font-mono`}
                />
                <TestBadge ok={test?.ai} error={test?.errors?.ai} />
              </Field>
            )}
            {provider === 'deepseek' && (
              <Field label="DeepSeek API key" hint="Use DeepSeek Chat (V3) or Reasoner (R1). Get one at platform.deepseek.com.">
                <input
                  value={deepseek}
                  onChange={(e) => setDeepseek(e.target.value)}
                  placeholder="sk-..."
                  className={`${inputClass} font-mono`}
                />
                <TestBadge ok={test?.ai} error={test?.errors?.ai} />
              </Field>
            )}
            {provider === 'claude' && (
              <Field label="Anthropic API key" hint="Use Claude Opus, Sonnet, or Haiku. Get one at console.anthropic.com/settings/keys.">
                <input
                  value={claude}
                  onChange={(e) => setClaude(e.target.value)}
                  placeholder="sk-ant-..."
                  className={`${inputClass} font-mono`}
                />
                <TestBadge ok={test?.ai} error={test?.errors?.ai} />
              </Field>
            )}
            <Field
              label={<>OpenAI key for duplicate detection <span className="text-ink-6 font-normal normal-case tracking-normal">(optional)</span></>}
              hint="Used only for semantic dedup — not for generation. Lets you use DeepSeek or Claude for writing while still checking for similar hooks via OpenAI embeddings. Leave blank to use text-based matching instead."
            >
              <input
                value={embeddingKey}
                onChange={(e) => setEmbeddingKey(e.target.value)}
                placeholder="sk-..."
                className={`${inputClass} font-mono`}
              />
            </Field>

            <Field label="Pinterest scraping method" hint="How to source images from Pinterest when you click Scrape in the Library.">
              <div className="flex gap-2">
                <Button variant={scrapeMethod === 'direct' ? 'primary' : 'secondary'} onClick={() => setScrapeMethod('direct')}>
                  Direct (with proxy)
                </Button>
                <Button variant={scrapeMethod === 'apify' ? 'primary' : 'secondary'} onClick={() => setScrapeMethod('apify')}>
                  Apify actor
                </Button>
              </div>
            </Field>
            {scrapeMethod === 'direct' ? (
              <Field
                label="Proxy (optional)"
                hint="HTTP CONNECT proxy for Pinterest scraping. Leave blank to scrape directly — add one if Pinterest blocks your IP. Format: http://user:pass@host:port"
              >
                <input
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="http://user:pass@host:port"
                  className={`${inputClass} font-mono`}
                />
              </Field>
            ) : (
              <>
                <Field label="Apify API key" hint="Required for the Apify actor method. Get one at console.apify.com.">
                  <input
                    value={apify}
                    onChange={(e) => setApify(e.target.value)}
                    placeholder="apify_api_..."
                    className={`${inputClass} font-mono`}
                  />
                  <TestBadge ok={test?.apify} error={test?.errors?.apify} />
                </Field>
                <Field label="Actor" hint="The Apify actor to run. Change only if you prefer a different one.">
                  <input
                    value={pinterestActor}
                    onChange={(e) => setPinterestActor(e.target.value)}
                    placeholder="fatihtahta/pinterest-scraper-search"
                    className={`${inputClass} font-mono`}
                  />
                </Field>
              </>
            )}
            <Field label="Model" hint={
              provider === 'openrouter'
                ? `Pick any model OpenRouter offers${models.length ? ` (${models.length} available)` : ''}.`
                : `Pick a ${{ openai: 'OpenAI', deepseek: 'DeepSeek', claude: 'Claude' }[provider]} model.`
            }>
              {provider === 'openrouter' && (
                <input
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                  placeholder="Filter models… e.g. claude, gpt, llama"
                  className={`${inputClass} mb-2`}
                />
              )}
              <select value={model} onChange={(e) => setModel(e.target.value)} className={inputClass}>
                {model && !filtered.some((m) => m.id === model) && <option value={model}>{model}</option>}
                {filtered.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          {/* Posting defaults (per project) */}
          <Section
            title="Posting defaults"
            description="Default mode when approving a slideshow. Requires a post-bridge key for scheduling/drafts — otherwise Download locally is used."
          >
            {accounts.length === 0 ? (
              <p className="text-[12px] text-ink-5">
                No post-bridge accounts connected. Add your key above and connect accounts at{' '}
                <PostBridgeLink>post-bridge.com</PostBridgeLink> — or leave it blank and use{' '}
                <strong className="text-ink-4">Download locally</strong> to save PNGs and upload yourself.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {accounts.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line bg-card cursor-pointer hover:border-line-2"
                  >
                    <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggleAccount(a.id)} />
                    <span className="text-[13px] text-ink font-medium">{a.username}</span>
                    <span className="text-[11px] text-ink-5 uppercase tracking-wide">{a.platform}</span>
                  </label>
                ))}
              </div>
            )}

            <Field label="Default mode">
              <div className="flex gap-2">
                <Button variant={mode === 'draft' ? 'primary' : 'secondary'} onClick={() => setMode('draft')}>
                  Save as draft
                </Button>
                <Button variant={mode === 'schedule' ? 'primary' : 'secondary'} onClick={() => setMode('schedule')}>
                  Schedule directly
                </Button>
              </div>
            </Field>
            <DraftNote />
          </Section>

          {/* Background packs (per project) */}
          <Section
            title="Background packs"
            description="Which image packs new slideshows pull backgrounds from when you hit Generate. Select none to generate with plain gradients."
          >
            <PackPicker selected={imagePacks} onChange={setImagePacks} />
          </Section>

          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="primary"
              size="lg"
              icon={saving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
            <Button variant="secondary" size="lg" onClick={runTest} disabled={testing || saving}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : null}
              Test connection
            </Button>
            {saved && !saveError && (
              <span className="text-[12px] text-emerald-600 flex items-center gap-1">
                <Check size={13} /> Saved
              </span>
            )}
            {saveError && (
              <span className="text-[12px] text-red-600 flex items-center gap-1">
                <X size={13} /> {saveError}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

export function DraftNote() {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-surface border border-line">
      <Info size={13} className="text-ink-5 mt-0.5 shrink-0" />
      <p className="text-[12px] text-ink-4 leading-snug">
        <span className="font-medium text-ink-3">Drafts vs. scheduling vs. local:</span> drafts land in your
        post-bridge inbox to post by hand. Scheduling posts automatically and reports analytics.{' '}
        <span className="font-medium text-ink-3">Download locally</span> skips post-bridge entirely — slides are saved
        as PNGs to <span className="font-mono text-ink-3">~/Downloads/slidesmith/</span> for you to upload manually.
        Manual posting avoids automation detection, so reach potential is often higher.
      </p>
    </div>
  );
}

function TestBadge({ ok, error }: { ok?: boolean; error?: string }) {
  if (ok === undefined) return null;
  return ok ? (
    <p className="text-[11px] text-emerald-600 mt-1 flex items-center gap-1">
      <Check size={11} /> Connected
    </p>
  ) : (
    <p className="text-[11px] text-red-600 mt-1 flex items-center gap-1">
      <X size={11} /> {error || 'Failed'}
    </p>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-[13px] font-semibold text-ink uppercase tracking-widest">{title}</h2>
        <p className="text-[12px] text-ink-5 mt-1">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-ink-5 mb-1 block">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-ink-6 mt-1">{hint}</p>}
    </div>
  );
}

function LocalModeNote() {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-surface border border-line">
      <Download size={13} className="text-ink-5 mt-0.5 shrink-0" />
      <p className="text-[12px] text-ink-4 leading-snug">
        <span className="font-medium text-ink-3">No post-bridge key? No problem.</span> Slidesmith
        works without one — approve any slideshow and choose{' '}
        <span className="font-medium text-ink-3">Download locally</span> to save the rendered PNGs
        to <span className="font-mono text-ink-3">~/Downloads/slidesmith/</span> and upload them yourself.
      </p>
    </div>
  );
}
