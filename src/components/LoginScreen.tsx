import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { setStoredPassword } from '../lib/api';

export function LoginScreen({ onUnlock }: { onUnlock: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/config', {
        headers: { Authorization: `Bearer ${password}` },
        cache: 'no-store',
      });
      if (res.status === 401) {
        setError('Wrong password.');
        return;
      }
      setStoredPassword(password);
      onUnlock();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full w-full flex items-center justify-center bg-bg">
      <form
        onSubmit={submit}
        className="bg-card border border-line rounded-xl p-8 w-full max-w-sm flex flex-col gap-4"
      >
        <div>
          <h1 className="text-[16px] font-semibold text-ink">Slidesmith</h1>
          <p className="text-[13px] text-ink-5 mt-0.5">Enter your password to continue.</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          className="h-9 bg-bg border border-line rounded-lg px-3 text-[13px] text-ink placeholder:text-ink-6 outline-none focus:border-ink-7 focus:ring-2 focus:ring-ink/10"
        />
        {error && <p className="text-[12px] text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={loading || !password}
          className="h-9 bg-ink text-bg rounded-lg text-[13px] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Checking…
            </span>
          ) : 'Continue'}
        </button>
      </form>
    </div>
  );
}
