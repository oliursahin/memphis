import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

interface OnboardingProps {
  onComplete: () => void;
}

export default function Onboarding(props: OnboardingProps) {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const startAuth = async () => {
    setLoading(true);
    setError(null);
    try {
      await invoke("start_oauth_flow");
      props.onComplete();
    } catch (e: any) {
      setError(typeof e === "string" ? e : e?.message ?? "Sign-in failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="h-screen w-screen bg-white flex items-center justify-center" data-tauri-drag-region>
      <div class="text-center max-w-sm">
        <h1 class="text-[22px] font-semibold text-zinc-900">memphis</h1>
        <p class="text-[14px] text-zinc-400 mt-2">the email client you deserve.</p>

        <button
          onClick={startAuth}
          disabled={loading()}
          class="mt-8 w-full flex items-center justify-center gap-3 px-5 py-2.5 rounded-lg border border-zinc-200 text-[14px] text-zinc-700 hover:bg-zinc-50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          {loading() ? "Signing in…" : "Sign in with Google"}
        </button>

        {error() && (
          <p class="text-[12px] text-red-500 mt-3">{error()}</p>
        )}

        <p class="text-[11px] text-zinc-300 mt-6">
          your data stays on this device. memphis never touches a server.
        </p>
      </div>
    </div>
  );
}
