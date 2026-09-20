import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';

export function Login() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const config = useQuery({ queryKey: keys.config, queryFn: () => api.config() });
    const [userId, setUserId] = useState('');
    const [name, setName] = useState('');
    const [loginName, setLoginName] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onDev(event: FormEvent) {
        event.preventDefault();
        try {
            await api.devSession(userId.trim(), name.trim() || 'dev user');
            await queryClient.invalidateQueries({ queryKey: keys.me });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function onNative(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await api.nativeLogin(loginName.trim(), password);
            setPassword('');
            await queryClient.invalidateQueries({ queryKey: keys.me });
        } catch (err) {
            const apiError = err as ApiError;
            setError(apiError.code === 'TOO_MANY_ATTEMPTS'
                ? 'Too many attempts. Wait a few minutes and try again.'
                : apiError.message);
        } finally {
            setBusy(false);
        }
    }

    const cfg = config.data;
    const nothingConfigured = cfg && !cfg.loginAvailable && !cfg.nativeLogin && !cfg.devMode;
    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                <h1>{cfg?.installationName || 'Goobster'}</h1>
                <p className="login-sub">Come in. Same brain as Discord — memory, parlor, and the tools he built you.</p>
                {cfg?.nativeLogin && (
                    <form className="native-login" onSubmit={onNative} aria-label="Sign in with a login name and password">
                        <label className="hint" htmlFor="login-name">{cfg.emailRecovery ? 'Login name or email' : 'Login name'}</label>
                        <input id="login-name" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false}
                            required value={loginName} onChange={(e) => setLoginName(e.target.value)} />
                        <label className="hint" htmlFor="login-password">Password</label>
                        <input id="login-password" className="input" type="password" autoComplete="current-password"
                            required value={password} onChange={(e) => setPassword(e.target.value)} />
                        {error && <div className="login-error" role="alert">{error}</div>}
                        <button className="btn primary big" type="submit" disabled={busy || !loginName.trim() || !password}>
                            {busy ? 'Signing in…' : 'Sign in'}
                        </button>
                        <div className="hint login-links">
                            {cfg.emailRecovery
                                ? <Link to="/forgot">Forgot your password?</Link>
                                : <span>Forgot your password? Ask the host of this installation for a reset link.</span>}
                            {cfg.registration === 'open' && <Link to="/register">Create an account</Link>}
                        </div>
                    </form>
                )}
                {cfg?.loginAvailable && (
                    <>
                        {cfg.nativeLogin && <div className="login-or hint" aria-hidden="true">or</div>}
                        <a className={`btn ${cfg.nativeLogin ? '' : 'primary '}big`} href="/api/app/auth/login">Sign in with Discord</a>
                    </>
                )}
                {nothingConfigured && (
                    <div className="hint">No sign-in method is configured on this server yet.</div>
                )}
                {cfg?.devMode && (
                    <form className="dev-login" onSubmit={onDev}>
                        <div className="hint">Dev mode — mint a local identity</div>
                        <input className="input" placeholder="Principal id (digits or usr_…)"
                            value={userId} onChange={(e) => setUserId(e.target.value)} />
                        <input className="input" maxLength={32} placeholder="Display name"
                            value={name} onChange={(e) => setName(e.target.value)} />
                        <button className="btn primary" type="submit">Enter</button>
                    </form>
                )}
            </div>
        </div>
    );
}
