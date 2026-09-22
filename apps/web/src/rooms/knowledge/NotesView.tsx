import { useState } from 'react';
import { NotesTab } from '../../components/NotesTab';
import type { CurationView } from '../../lib/types';
import { useKnowledgeScope } from './scope';

/**
 * Knowledge → Notes: the landing view. The projection toggle (Your notes /
 * All retained knowledge) is state the server applies, never a browser
 * filter, so the Map and the counts see exactly the same rows.
 */
export function NotesView() {
    const { scopeId } = useKnowledgeScope();
    const [view, setView] = useState<CurationView>('knowledge');
    return (
        <div className="pane-body" data-tour="knowledge-notes">
            <NotesTab scope={scopeId} view={view} onView={setView} />
        </div>
    );
}
