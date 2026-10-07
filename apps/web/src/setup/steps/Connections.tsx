import { useState } from 'react';
import { OWNER_PASSWORD, useAnswers } from '../answers';
import { useConfigReport } from '../data';
import { FieldList } from '../fields';
import { fieldProblems, hasDiscordToken, ownerProblems, PASSWORD_MIN } from '../model';
import { describeError, ErrorSummary, StepFrame, StepNav, type Problem } from '../ui';
import type { StepProps } from './order';

const DISCORD = ['discord.token', 'discord.clientId', 'discord.guildIds'];
const CLOUD_AI = ['ai.provider', 'ai.openai.apiKey', 'ai.anthropic.apiKey', 'ai.gemini.apiKey'];
const LOCAL_AI = ['ollama.host', 'ollama.model'];

/** The owner account: native sign-in with a name and a password, no Discord needed. */
export function OwnerForm() {
    const { answers, update } = useAnswers();
    const owner = answers.owner;
    const again = answers.reenter.includes(OWNER_PASSWORD);
    const set = (change: Partial<typeof owner>) => update((previous) => ({
        ...previous,
        owner: { ...previous.owner, ...change },
        reenter: change.password ? previous.reenter.filter((id) => id !== OWNER_PASSWORD) : previous.reenter
    }));
    return (
        <fieldset className="wizard-fieldset" data-testid="owner-form">
            <legend>Owner account</legend>
            <label className="wizard-choice">
                <input id="owner-create" type="checkbox" checked={owner.create} onChange={(event) => set({ create: event.target.checked })} data-testid="owner-create" />
                {' '}Create the owner account (sign in with a name and password, no Discord needed)
            </label>
            {owner.create && (
                <>
                    {again && <p className="wizard-again" role="note" data-testid="enter-again" data-field="owner.password">Enter the password again: it was handed to the manager when you checked the plan, and this page does not keep it.</p>}
                    <div className="wizard-field">
                        <label htmlFor="owner-login">Login name</label>
                        <input id="owner-login" className="input" value={owner.loginName} autoComplete="username" spellCheck={false}
                            onChange={(event) => set({ loginName: event.target.value })} data-testid="owner-login" />
                    </div>
                    <div className="wizard-field">
                        <label htmlFor="owner-display">Display name <span className="hint">(optional)</span></label>
                        <input id="owner-display" className="input" value={owner.displayName} onChange={(event) => set({ displayName: event.target.value })} data-testid="owner-display" />
                    </div>
                    <div className="wizard-field">
                        <label htmlFor="owner-password">Password</label>
                        <input id="owner-password" className="input" type="password" autoComplete="new-password" value={owner.password}
                            onChange={(event) => set({ password: event.target.value })} data-testid="owner-password" aria-describedby="owner-password-hint" />
                        <span id="owner-password-hint" className="hint">At least {PASSWORD_MIN} characters; a phrase works well. It goes to the manager once, to create the account, and is not kept on this page.</span>
                    </div>
                    <div className="wizard-field">
                        <label htmlFor="owner-repeat">Password again</label>
                        <input id="owner-repeat" className="input" type="password" autoComplete="new-password" value={owner.repeat}
                            onChange={(event) => set({ repeat: event.target.value })} data-testid="owner-repeat" />
                    </div>
                </>
            )}
        </fieldset>
    );
}

/** Discord, an AI provider (cloud keys or a local model) and the owner account. Every connection is optional. */
export function Connections({ go }: StepProps) {
    const { answers } = useAnswers();
    const { query, fields, report } = useConfigReport();
    const [problems, setProblems] = useState<Problem[]>([]);
    const hasDiscord = hasDiscordToken(answers, fields);

    function next() {
        const found = [
            ...fieldProblems(answers, fields, [...DISCORD, ...CLOUD_AI, ...LOCAL_AI]),
            ...ownerProblems(answers, fields)
        ];
        setProblems(found);
        if (found.length === 0) go('database');
    }

    return (
        <StepFrame id="connections" title="Connect what you use"
            lead="Every connection here is optional and can be added later from the Host room. Keys are typed once, sent once and never shown again.">
            <ErrorSummary problems={problems} />
            {query.isPending && <p role="status" className="hint">Reading the settings…</p>}
            {query.isError && <p role="alert" className="settings-danger">{describeError(query.error).message}</p>}
            {report && (
                <>
                    <h3 className="section-title">Discord <span className="hint">(optional)</span></h3>
                    <p className="hint">
                        With a bot token Goobster joins your Discord server and serves the portal itself. Without one it runs as a web portal only{hasDiscord ? '' : ' (this is what you get now)'}.
                    </p>
                    <FieldList ids={DISCORD} report={report} />
                    <h3 className="section-title">AI provider <span className="hint">(optional)</span></h3>
                    <p className="hint">A cloud key, or a model on this machine (below). With neither, Goobster still runs and falls back to local rules where it can.</p>
                    <FieldList ids={CLOUD_AI} report={report} />
                    <h3 className="section-title">Local AI with Ollama <span className="hint">(optional, no cloud key)</span></h3>
                    <p className="hint">If Ollama runs on this machine, point Goobster at it and test the connection.</p>
                    <FieldList ids={LOCAL_AI} report={report} />
                    <h3 className="section-title">Sign in</h3>
                    <OwnerForm />
                </>
            )}
            <StepNav onBack={() => go('features')} onNext={next} nextDisabled={!report} />
        </StepFrame>
    );
}
