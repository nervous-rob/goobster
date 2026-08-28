import { useCallback, useMemo, useState } from 'react';
import { NOTE_NAMES, type NoteName } from '@music-lab/lib/musicData';
import { PROGRESSION_PRESETS } from '@music-lab/lib/harmonyData';
import { buildPresetProgression } from '@music-lab/lib/harmonyTheory';
import { buildMelodyLane } from '@music-lab/lib/melodyTheory';
import { useRhythmOptions } from '@music-lab/hooks/useRhythmOptions';
import { totalSubdivisions } from '@music-lab/lib/rhythmTheory';
import {
  MELODY_BASE_OCTAVE,
  findContour,
  type CreatureKind,
  type SavedCreature
} from '@music-lab/lib/stageData';
import { findVoice } from '@music-lab/lib/voiceData';
import { useVoiceLibrary } from '@music-lab/hooks/useVoiceLibrary';
import {
  DRUM_VARIANTS,
  candidateToSavedCreature,
  findDrumVariant,
  recommendChordVoice,
  recommendCreatures,
  recommendDrumVariant,
  type CreatureCandidate
} from '@music-lab/lib/creatureRecommend';
import { LIBRARY_CREATURES, type LibraryCreature } from '@music-lab/lib/genreLibrary';
import {
  ALL_SONG_TEMPLATES,
  SONG_TEMPLATES,
  buildProjectFromTemplate,
  findTemplate,
  templateEnergy,
  type GeneratedTonalPart,
  type SongTemplate
} from '@music-lab/lib/songTemplates';
import type { SongProject } from '@music-lab/lib/songData';
import { useStageOrchestrator, type StagePerformerTrack } from '@music-lab/hooks/useStageOrchestrator';

type TonalChoice =
  | { type: 'default' }
  | { type: 'library'; creature: SavedCreature }
  | { type: 'candidate'; candidate: CreatureCandidate };

interface SongWizardProps {
  library: SavedCreature[];
  onSaveCreature: (creature: SavedCreature) => void;
  onGenerate: (project: SongProject) => void;
  onClose: () => void;
}

const STEPS = ['Structure', 'Feel', 'Fill the parts', 'Review'];

const DEFAULT_BASS: GeneratedTonalPart = { name: 'Bass Serpent', voiceId: 'soft-brass', contourId: 'root-anchor', octaveShift: 0 };
const DEFAULT_LEAD: GeneratedTonalPart = { name: 'Melody Wisp', voiceId: 'glass-pad', contourId: 'arpeggio-rise', octaveShift: 0 };

function choiceLabel(choice: TonalChoice, kind: CreatureKind): string {
  if (choice.type === 'library') return choice.creature.name;
  if (choice.type === 'candidate') return choice.candidate.name;
  return kind === 'bass' ? DEFAULT_BASS.name : DEFAULT_LEAD.name;
}

function creatureToCandidate(creature: LibraryCreature): CreatureCandidate {
  return {
    name: creature.name,
    kind: creature.kind,
    voiceId: creature.voiceId,
    contourId: creature.contourId,
    octaveShift: creature.octaveShift,
    reason: creature.flavor
  };
}

function partToCandidate(kind: CreatureKind, part: GeneratedTonalPart, templateName: string): CreatureCandidate {
  return {
    name: part.name,
    kind,
    voiceId: part.voiceId,
    contourId: part.contourId,
    octaveShift: part.octaveShift,
    reason: `Suggested by the ${templateName} template.`
  };
}

function choiceToPart(choice: TonalChoice, kind: CreatureKind): GeneratedTonalPart {
  if (choice.type === 'library') {
    const c = choice.creature;
    return { name: c.name, voiceId: c.voiceId, contourId: c.contourId, octaveShift: c.octaveShift };
  }
  if (choice.type === 'candidate') {
    const c = choice.candidate;
    return { name: c.name, voiceId: c.voiceId, contourId: c.contourId, octaveShift: c.octaveShift };
  }
  return kind === 'bass' ? DEFAULT_BASS : DEFAULT_LEAD;
}

/**
 * Multi-step setup wizard: pick a recommended song structure, set the feel,
 * then fill each part with the core default, a library creature, or a fresh
 * engine recommendation (auditionable before accepting). Generates a fully
 * arranged SongProject.
 */
export function SongWizard({ library, onSaveCreature, onGenerate, onClose }: SongWizardProps) {
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState(SONG_TEMPLATES[0].id);
  const [songName, setSongName] = useState('');
  const [keyRoot, setKeyRoot] = useState<NoteName>('C');
  const [bpm, setBpm] = useState(SONG_TEMPLATES[0].bpm);
  const [rhythmId, setRhythmId] = useState(SONG_TEMPLATES[0].rhythmId);

  const [drumVariantId, setDrumVariantId] = useState('classic');
  const [chordsVoiceId, setChordsVoiceId] = useState('glass-pad');
  const [bassChoice, setBassChoice] = useState<TonalChoice>({ type: 'default' });
  const [leadChoice, setLeadChoice] = useState<TonalChoice>({ type: 'default' });
  const [candidates, setCandidates] = useState<{ bass: CreatureCandidate[]; lead: CreatureCandidate[] }>({
    bass: [],
    lead: []
  });
  const [savedCandidateNames, setSavedCandidateNames] = useState<string[]>([]);
  const [auditionKey, setAuditionKey] = useState<string | null>(null);

  const { allVoices } = useVoiceLibrary();
  const { isPlaying, setConfig, stop, start } = useStageOrchestrator();

  const { rhythms, findRhythm } = useRhythmOptions();
  const template = useMemo(() => findTemplate(templateId), [templateId]);
  const energy = useMemo(() => templateEnergy(template), [template]);
  const rhythm = useMemo(() => findRhythm(rhythmId), [findRhythm, rhythmId]);

  const auditionProgressionId = useMemo(() => {
    const peak = [...template.sections].sort((a, b) => b.energy - a.energy)[0];
    return peak?.progressionId ?? 'axis';
  }, [template]);

  const handleTemplateSelect = useCallback((id: string) => {
    setTemplateId(id);
    const t = findTemplate(id);
    setBpm(t.bpm);
    setRhythmId(t.rhythmId);
    // Genre-library templates pre-fill the parts step with their suggested band.
    setDrumVariantId(t.suggest?.drumVariantId ?? 'classic');
    setChordsVoiceId(t.suggest?.chordsVoiceId ?? 'glass-pad');
    setBassChoice(
      t.suggest?.bass ? { type: 'candidate', candidate: partToCandidate('bass', t.suggest.bass, t.name) } : { type: 'default' }
    );
    setLeadChoice(
      t.suggest?.lead ? { type: 'candidate', candidate: partToCandidate('lead', t.suggest.lead, t.name) } : { type: 'default' }
    );
  }, []);

  const templateGroups = useMemo(() => {
    const groups: { label: string; templates: SongTemplate[] }[] = [];
    ALL_SONG_TEMPLATES.forEach(t => {
      const label = t.genre ?? 'Core shapes';
      let group = groups.find(g => g.label === label);
      if (!group) {
        group = { label, templates: [] };
        groups.push(group);
      }
      group.templates.push(t);
    });
    return groups;
  }, []);

  const drumOptions = useMemo(() => {
    const options = [...DRUM_VARIANTS];
    [template.suggest?.drumVariantId, drumVariantId].forEach(id => {
      if (!id || options.some(o => o.id === id)) return;
      const variant = findDrumVariant(id);
      if (variant) options.push(variant);
    });
    return options;
  }, [template, drumVariantId]);

  const stopAudition = useCallback(() => {
    stop();
    setAuditionKey(null);
  }, [stop]);

  const auditionCandidate = useCallback(
    async (kind: CreatureKind, candidate: CreatureCandidate) => {
      const key = `${kind}:${candidate.voiceId}:${candidate.contourId}:${candidate.octaveShift}`;
      if (auditionKey === key && isPlaying) {
        stopAudition();
        return;
      }

      const preset = PROGRESSION_PRESETS.find(p => p.id === auditionProgressionId) ?? PROGRESSION_PRESETS[0];
      const genomes = buildPresetProgression(preset, keyRoot).map(s => s.genome);
      const subdivisions = totalSubdivisions(rhythm.grouping);
      const role = kind === 'bass' ? 'bass' : 'melody';
      const lane = buildMelodyLane(
        findContour(candidate.contourId).steps,
        genomes,
        1,
        subdivisions,
        MELODY_BASE_OCTAVE[kind === 'bass' ? 'bass' : 'melody'] + candidate.octaveShift
      );

      const performers: StagePerformerTrack[] = [
        {
          id: 'wizard-chords',
          role: 'chords',
          enabled: true,
          mute: false,
          volume: -16,
          voiceId: chordsVoiceId,
          chordSteps: genomes.map(g => g.midi)
        },
        {
          id: 'wizard-candidate',
          role,
          enabled: true,
          mute: false,
          volume: -5,
          voiceId: candidate.voiceId,
          melodyNotes: lane
        }
      ];

      setConfig({
        bpm,
        swing: 0,
        grouping: rhythm.grouping,
        phraseLength: genomes.length,
        measuresPerChord: 1,
        harmonyHold: 0.96,
        loop: true,
        masterVolume: -2,
        reverbWet: 0.3,
        performers
      });
      setAuditionKey(key);
      await start();
    },
    [auditionKey, auditionProgressionId, bpm, chordsVoiceId, isPlaying, keyRoot, rhythm.grouping, setConfig, start, stopAudition]
  );

  const handleRecommend = useCallback(
    (kind: CreatureKind) => {
      const used = [
        chordsVoiceId,
        ...(kind === 'bass' ? [choiceToPart(leadChoice, 'lead').voiceId] : [choiceToPart(bassChoice, 'bass').voiceId])
      ];
      setCandidates(prev => ({ ...prev, [kind === 'bass' ? 'bass' : 'lead']: recommendCreatures(kind, energy, used) }));
    },
    [bassChoice, chordsVoiceId, energy, leadChoice]
  );

  const acceptCandidate = useCallback(
    (kind: CreatureKind, candidate: CreatureCandidate) => {
      if (kind === 'bass') setBassChoice({ type: 'candidate', candidate });
      else setLeadChoice({ type: 'candidate', candidate });
      if (!savedCandidateNames.includes(candidate.name)) {
        onSaveCreature(candidateToSavedCreature(candidate));
        setSavedCandidateNames(prev => [...prev, candidate.name]);
      }
    },
    [onSaveCreature, savedCandidateNames]
  );

  const handleGenerate = useCallback(() => {
    stopAudition();
    const project = buildProjectFromTemplate(template, {
      name: songName.trim() || `${template.name} in ${keyRoot}`,
      keyRoot,
      bpm,
      rhythmId,
      parts: {
        drumVariantId,
        chordsVoiceId,
        bass: choiceToPart(bassChoice, 'bass'),
        lead: choiceToPart(leadChoice, 'lead')
      }
    });
    onGenerate(project);
  }, [bassChoice, bpm, chordsVoiceId, drumVariantId, keyRoot, leadChoice, onGenerate, rhythmId, songName, stopAudition, template]);

  const handleClose = useCallback(() => {
    stopAudition();
    onClose();
  }, [onClose, stopAudition]);

  const renderCandidateList = (kind: CreatureKind) => {
    const list = kind === 'bass' ? candidates.bass : candidates.lead;
    const choice = kind === 'bass' ? bassChoice : leadChoice;
    if (!list.length) return null;
    return (
      <div className="st-candidate-list">
        {list.map(candidate => {
          const key = `${kind}:${candidate.voiceId}:${candidate.contourId}:${candidate.octaveShift}`;
          const isChosen =
            choice.type === 'candidate' &&
            choice.candidate.voiceId === candidate.voiceId &&
            choice.candidate.contourId === candidate.contourId &&
            choice.candidate.name === candidate.name;
          const isAuditioning = auditionKey === key && isPlaying;
          return (
            <div key={candidate.name + key} className={`st-candidate${isChosen ? ' chosen' : ''}`}>
              <div className="st-candidate-info">
                <strong>{candidate.name}</strong>
                <span>{candidate.reason}</span>
                <span className="st-candidate-meta">
                  {findVoice(candidate.voiceId).name} · {findContour(candidate.contourId).name} ·{' '}
                  {candidate.octaveShift > 0 ? `+${candidate.octaveShift}` : candidate.octaveShift} oct
                </span>
              </div>
              <div className="st-candidate-actions">
                <button
                  type="button"
                  className={`stage-perf-btn${isAuditioning ? ' on' : ''}`}
                  onClick={() => void auditionCandidate(kind, candidate)}
                >
                  {isAuditioning ? '■ Stop' : '▶ Audition'}
                </button>
                <button
                  type="button"
                  className={`stage-perf-btn${isChosen ? ' on' : ''}`}
                  onClick={() => acceptCandidate(kind, candidate)}
                >
                  {isChosen ? '✓ Hired' : 'Hire'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderTonalPart = (kind: CreatureKind) => {
    const choice = kind === 'bass' ? bassChoice : leadChoice;
    const setChoice = kind === 'bass' ? setBassChoice : setLeadChoice;
    const matches = library.filter(c => c.kind === kind);
    const genreMatches = LIBRARY_CREATURES.filter(c => c.kind === kind);
    const genreValue =
      choice.type === 'candidate'
        ? genreMatches.find(
            c =>
              c.name === choice.candidate.name &&
              c.voiceId === choice.candidate.voiceId &&
              c.contourId === choice.candidate.contourId
          )?.id ?? ''
        : '';
    return (
      <div className="st-part re-panel">
        <div className="st-part-head">
          <strong>{kind === 'bass' ? 'Bass creature' : 'Lead creature'}</strong>
          <span className="st-part-current">{choiceLabel(choice, kind)}</span>
        </div>
        <div className="re-pills">
          <button
            type="button"
            className={`re-pill${choice.type === 'default' ? ' on' : ''}`}
            onClick={() => setChoice({ type: 'default' })}
          >
            Core default
          </button>
          <button type="button" className="re-pill" onClick={() => handleRecommend(kind)}>
            ✨ Recommend
          </button>
        </div>
        {genreMatches.length ? (
          <div className="re-stack-sm">
            <label className="re-micro-label" htmlFor={`wiz-genre-${kind}`}>
              From the genre library
            </label>
            <select
              id={`wiz-genre-${kind}`}
              className="re-select"
              value={genreValue}
              onChange={e => {
                const creature = genreMatches.find(c => c.id === e.target.value);
                if (creature) setChoice({ type: 'candidate', candidate: creatureToCandidate(creature) });
              }}
            >
              <option value="">— pick a genre creature —</option>
              {genreMatches.map(c => (
                <option key={c.id} value={c.id}>
                  {c.genre} · {c.name} · {findVoice(c.voiceId).name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {matches.length ? (
          <div className="re-stack-sm">
            <label className="re-micro-label" htmlFor={`wiz-lib-${kind}`}>
              From your library
            </label>
            <select
              id={`wiz-lib-${kind}`}
              className="re-select"
              value={choice.type === 'library' ? choice.creature.id : ''}
              onChange={e => {
                const creature = matches.find(c => c.id === e.target.value);
                if (creature) setChoice({ type: 'library', creature });
              }}
            >
              <option value="">— pick a saved creature —</option>
              {matches.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} · {findVoice(c.voiceId).name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {renderCandidateList(kind)}
      </div>
    );
  };

  return (
    <div className="st-wizard-overlay" role="dialog" aria-modal="true" aria-label="Song setup wizard">
      <div className="st-wizard re-panel">
        <div className="st-wizard-head">
          <div>
            <h3>Song Wizard</h3>
            <p className="re-subtitle">
              Step {step + 1} of {STEPS.length} — {STEPS[step]}
            </p>
          </div>
          <button type="button" className="stage-perf-btn remove" onClick={handleClose} title="Close wizard">
            ×
          </button>
        </div>

        <div className="st-wizard-steps">
          {STEPS.map((label, i) => (
            <span key={label} className={`st-wizard-step${i === step ? ' on' : ''}${i < step ? ' done' : ''}`}>
              {label}
            </span>
          ))}
        </div>

        <div className="st-wizard-body">
          {step === 0 ? (
            <div className="st-template-groups">
              {templateGroups.map(group => (
                <div key={group.label} className="st-template-group">
                  <span className="st-template-group-label">{group.label}</span>
                  <div className="st-template-grid">
                    {group.templates.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        className={`st-template-card${t.id === templateId ? ' on' : ''}`}
                        onClick={() => handleTemplateSelect(t.id)}
                      >
                        <strong>{t.name}</strong>
                        <span>{t.blurb}</span>
                        <span className="st-template-meta">
                          {t.sections.reduce((a, s) => a + s.measures, 0)} measures · {t.sections.length} sections ·{' '}
                          {t.bpm} BPM
                        </span>
                        <span className="st-template-strip" aria-hidden>
                          {t.sections.map((s, i) => (
                            <span
                              key={i}
                              style={{ flex: s.measures, opacity: 0.35 + s.energy * 0.6 }}
                              className={`st-template-chip kind-${s.kind}`}
                            />
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="st-wizard-feel">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="wiz-key">
                  Key center
                </label>
                <select
                  id="wiz-key"
                  className="re-select"
                  value={keyRoot}
                  onChange={e => setKeyRoot(e.target.value as NoteName)}
                >
                  {NOTE_NAMES.map(n => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="wiz-rhythm">
                  Locomotion pattern
                </label>
                <select id="wiz-rhythm" className="re-select" value={rhythmId} onChange={e => setRhythmId(e.target.value)}>
                  {rhythms.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.label} · {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="re-stack-sm">
                <div className="re-slider-head sm">
                  <label htmlFor="wiz-bpm">BPM</label>
                  <span className="re-slider-val sm">{bpm}</span>
                </div>
                <input
                  id="wiz-bpm"
                  type="range"
                  min={60}
                  max={180}
                  step={1}
                  value={bpm}
                  onChange={e => setBpm(parseInt(e.target.value, 10))}
                />
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="st-wizard-parts">
              <div className="st-part re-panel">
                <div className="st-part-head">
                  <strong>Drum trio</strong>
                  <span className="st-part-current">
                    {findDrumVariant(drumVariantId)?.name ?? 'Classic Backbeat'}
                  </span>
                </div>
                <div className="re-pills">
                  {drumOptions.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      className={`re-pill${drumVariantId === v.id ? ' on' : ''}`}
                      onClick={() => setDrumVariantId(v.id)}
                      title={v.blurb}
                    >
                      {v.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="re-pill"
                    onClick={() => setDrumVariantId(recommendDrumVariant(energy).id)}
                  >
                    ✨ Recommend
                  </button>
                </div>
              </div>

              <div className="st-part re-panel">
                <div className="st-part-head">
                  <strong>Harmonic organism</strong>
                  <span className="st-part-current">{findVoice(chordsVoiceId).name}</span>
                </div>
                <div className="st-part-row">
                  <select
                    className="re-select"
                    value={chordsVoiceId}
                    onChange={e => setChordsVoiceId(e.target.value)}
                    aria-label="Chord voice"
                  >
                    {allVoices.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.name} — {v.blurb}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="re-pill"
                    onClick={() => setChordsVoiceId(recommendChordVoice(energy, []).voiceId)}
                  >
                    ✨ Recommend
                  </button>
                </div>
              </div>

              {renderTonalPart('bass')}
              {renderTonalPart('lead')}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="st-wizard-review">
              <div className="re-stack-sm">
                <label className="re-micro-label" htmlFor="wiz-name">
                  Song name
                </label>
                <input
                  id="wiz-name"
                  className="re-select"
                  type="text"
                  maxLength={40}
                  placeholder={`${template.name} in ${keyRoot}`}
                  value={songName}
                  onChange={e => setSongName(e.target.value)}
                />
              </div>
              <ul className="st-review-list">
                <li>
                  <span>Structure</span>
                  <strong>
                    {template.name} · {template.sections.reduce((a, s) => a + s.measures, 0)} measures
                  </strong>
                </li>
                <li>
                  <span>Feel</span>
                  <strong>
                    {keyRoot} · {bpm} BPM · {rhythm.label}
                  </strong>
                </li>
                <li>
                  <span>Drums</span>
                  <strong>{findDrumVariant(drumVariantId)?.name ?? 'Classic Backbeat'}</strong>
                </li>
                <li>
                  <span>Chords</span>
                  <strong>{findVoice(chordsVoiceId).name}</strong>
                </li>
                <li>
                  <span>Bass</span>
                  <strong>{choiceLabel(bassChoice, 'bass')}</strong>
                </li>
                <li>
                  <span>Lead</span>
                  <strong>{choiceLabel(leadChoice, 'lead')}</strong>
                </li>
              </ul>
              <p className="stage-perf-flavor">
                The wizard arranges each part across the song from the template&apos;s energy map — verses breathe,
                choruses stack the full troupe. Everything stays editable on the timeline.
              </p>
            </div>
          ) : null}
        </div>

        <div className="st-wizard-foot">
          <button
            type="button"
            className="re-secondary-btn"
            onClick={() => (step === 0 ? handleClose() : setStep(s => s - 1))}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="re-play-btn st-wizard-next" onClick={() => setStep(s => s + 1)}>
              Next — {STEPS[step + 1]}
            </button>
          ) : (
            <button type="button" className="re-play-btn st-wizard-next" onClick={handleGenerate}>
              Generate song
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
