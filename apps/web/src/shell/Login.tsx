import { FormEvent, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';

export function Login() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const config = useQuery({ queryKey: keys.config, queryFn: () => api.config() });
    const [userId, setUserId] = useState('');
    const [name, setName] = useState('');

    async function onDev(event: FormEvent) {
        event.preventDefault();
        try {
            await api.devSession(userId.trim(), name.trim() || 'dev user');
            await queryClient.invalidateQueries({ queryKey: keys.me });
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    const cfg = config.data;
    return (
        <div className="login">
            <div className="login-glow" aria-hidden="true" />
            <div className="login-card">
                <img className="login-logo" src="/app/icons/goobster.svg" alt="" width={72} height={72} />
                <h1>Goobster</h1>
                <p className="login-sub">Come in. Same brain as Discord — memory, parlor, and the tools he built you.</p>
                {cfg?.loginAvailable && (
                    <a className="btn primary big" href="/api/app/auth/login">Sign in with Discord</a>
                )}
                {cfg && !cfg.loginAvailable && !cfg.devMode && (
                    <div className="hint">Discord login isn&apos;t configured on this server yet.</div>
                )}
                {cfg?.devMode && (
                    <form className="dev-login" onSubmit={onDev}>
                        <div className="hint">Dev mode — mint a local identity</div>
                        <input className="input" inputMode="numeric" placeholder="Discord user id (digits)"
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
