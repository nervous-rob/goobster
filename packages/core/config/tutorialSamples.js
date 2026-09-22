/**
 * Weekend field notebook — isolated tutorial sample content (Increment F2).
 *
 * Demonstrations read from here. Nothing is written into kg_nodes, memory,
 * projects, or retrieval unless the person explicitly chooses
 * **Keep this example**. Tour events never touch this module's side effects;
 * only tutorialService.keepExample does, and only after a clear preview.
 *
 * Contract: documentation/guided_tutorials_spec.md.
 */

const SAMPLE_SCENARIO_ID = 'weekend-field-notebook';

const SAMPLE = {
    id: SAMPLE_SCENARIO_ID,
    title: 'Weekend field notebook',
    question: 'What did we notice on the Saturday coastal walk?',
    answer: {
        heading: 'Coastal walk observations',
        body:
            'The tide pools held three kinds of anemone. The wind shifted west after noon, '
            + 'and the tide chart matched what we saw at the north spit. Keep the anemone '
            + 'counts with the photo notes for Monday.'
    },
    notes: [
        {
            id: 'note-anemones',
            label: 'Tide-pool anemones',
            content: 'Three kinds visible at low tide on the north spit. Counts in the photo roll.',
            tags: ['observation', 'coast'],
            audience: 'Private'
        },
        {
            id: 'note-wind',
            label: 'Afternoon wind shift',
            content: 'Wind turned west after noon; matched the tide chart for Saturday.',
            tags: ['observation', 'weather'],
            audience: 'Private'
        }
    ],
    source: {
        id: 'source-tide-chart',
        title: 'Saturday tide chart (local harbour)',
        excerpt: 'Low tide 10:42 · High 16:18 · Wind W after 12:00'
    },
    claim: {
        id: 'claim-tide-match',
        text: 'The observed low-tide window matched the harbour chart within fifteen minutes.',
        distinguishedFrom: 'Generated interpretation — not the chart text itself.'
    },
    project: {
        id: 'sample-project',
        name: 'Weekend field notebook',
        slug: 'weekend-field-notebook',
        goal: 'Turn Saturday’s walk into a reusable private notebook with notes and one output.',
        audience: 'Private — only you'
    },
    run: {
        id: 'sample-run',
        title: 'Summarise anemone counts',
        status: 'COMPLETED',
        output: 'Three anemone kinds; counts attached to Tide-pool anemones.'
    },
    app: {
        id: 'sample-app',
        title: 'Tide-pool counter',
        origin: 'Generated in a sample Chat turn (tutorial only)',
        version: '1'
    }
};

/** Pieces a person may keep into their real account after a preview. */
const KEEPABLE = {
    'note-anemones': {
        kind: 'note',
        label: SAMPLE.notes[0].label,
        content: SAMPLE.notes[0].content,
        tags: SAMPLE.notes[0].tags
    },
    'note-wind': {
        kind: 'note',
        label: SAMPLE.notes[1].label,
        content: SAMPLE.notes[1].content,
        tags: SAMPLE.notes[1].tags
    }
};

function getSample() {
    return SAMPLE;
}

function getKeepable(pieceId) {
    return KEEPABLE[pieceId] || null;
}

module.exports = {
    SAMPLE_SCENARIO_ID,
    SAMPLE,
    KEEPABLE,
    getSample,
    getKeepable
};
