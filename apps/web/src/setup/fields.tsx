import { Fragment, useEffect } from 'react';
import type { HostConfigField, HostConfigReport } from '../lib/types';
import { FieldControl, PROBE_FIELD } from '../rooms/host/FieldControl';
import { useAnswers } from './answers';
import { useConfigReport } from './data';

const ENV_READONLY = (field: HostConfigField) =>
    `Set by the environment variable ${field.envName || 'for this field'}. Change the environment and restart the manager; it cannot be changed here.`;

/**
 * Catalog fields rendered with the Host pages' own control. A secret that was
 * typed and already handed to the manager shows an "enter again" note; the
 * input is empty, never refilled.
 */
export function FieldList({ ids, scope = 'fields', report, hide }: {
    ids: string[]; scope?: 'fields' | 'instanceDefaults'; report: HostConfigReport; hide?: (field: HostConfigField) => boolean;
}) {
    const { answers, setField, setDefault, registerSecrets } = useAnswers();
    const { fields } = useConfigReport();
    useEffect(() => { registerSecrets([...fields.values()].filter((field) => field.secret).map((field) => field.id)); }, [fields, registerSecrets]);
    const drafts = scope === 'fields' ? answers.fields : answers.instanceDefaults;
    const set = scope === 'fields' ? setField : setDefault;
    const shown = ids.map((id) => fields.get(id)).filter((field): field is HostConfigField => Boolean(field) && !(hide && hide(field as HostConfigField)));
    if (shown.length === 0) return <p className="hint">This installation does not offer these settings.</p>;
    return (
        <ul className="list-card wizard-fields" style={{ listStyle: 'none', padding: 0 }}>
            {shown.map((field) => {
                const target = PROBE_FIELD[field.id];
                const again = field.secret && answers.reenter.includes(field.id);
                return (
                    <Fragment key={field.id}>
                        {again && (
                            <li className="wizard-again" role="note" data-testid="enter-again" data-field={field.id}>
                                Enter <code>{field.id}</code> again: it was handed to the manager when you checked the plan, and this page does not keep keys.
                            </li>
                        )}
                        <FieldControl field={field} draft={drafts[field.id]} setDraft={(draft) => set(field.id, draft)}
                            readOnly={field.envControlled ? ENV_READONLY(field) : (field.editable === false ? 'This setting is not editable here.' : null)}
                            probe={target ? report.probes.find((probe) => probe.target === target) : undefined} />
                    </Fragment>
                );
            })}
        </ul>
    );
}
