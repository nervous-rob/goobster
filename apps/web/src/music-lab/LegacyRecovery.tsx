import { useState } from 'react';
import { useMe } from '../hooks/useSession';
import { recoverLegacyLab } from './lib/legacyStorage';

export function LegacyRecovery() {
    const me = useMe();
    const [confirmed, setConfirmed] = useState(false);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    if (!['migration', 'bootstrap'].includes(me.identity?.account?.entitlement || '')) return null;
    const recover = async (importData: boolean) => {
        setBusy(true); setMessage('');
        try { await recoverLegacyLab(importData); }
        catch (error) { setMessage((error as Error).message); }
        finally { setBusy(false); }
    };
    return <details className="panel">
        <summary>Recover older Music Lab data on this device</summary>
        <p>Older compositions and samples have no recorded account owner. They stay separate until you explicitly import them. Sign in again first if asked to confirm your identity. The original data is retained.</p>
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I confirm the older Music Lab data on this device is mine.</label>
        <div className="actions">
            <button className="btn" disabled={!confirmed || busy} onClick={() => void recover(false)}>Export older data</button>
            <button className="btn" disabled={!confirmed || busy} onClick={() => void recover(true)}>Import into my account</button>
        </div>
        {message && <p role="alert">{message}</p>}
    </details>;
}
