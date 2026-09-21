import { useState } from "react";
import type { FormEvent } from "react";
import { t } from "../i18n";
import { login } from "../api/client";

interface LoginPageProps {
  onSuccess: () => void;
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = username.trim() !== "" && password !== "" && !submitting;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Sign in failed"));
      setSubmitting(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm text-text outline-none focus:border-accent";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-surface-elevated p-6"
        aria-label={t("Sign in")}
      >
        <h1 className="text-lg font-semibold text-text">{t("Sign in")}</h1>
        <div>
          <label htmlFor="login-username" className="mb-1 block text-xs text-muted">
            {t("Username")}
          </label>
          <input
            id="login-username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="login-password" className="mb-1 block text-xs text-muted">
            {t("Password")}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? t("Signing in…") : t("Sign in")}
        </button>
      </form>
    </div>
  );
}
