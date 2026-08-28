import { Link } from '@tanstack/react-router';
import { LabShell } from '@music-lab/components/shared/LabShell';
import { conservatoryPath } from '@music-lab/lib/paths';

function IconWave() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M2 12h3l2-7 4 14 4-10 2 3h5" />
    </svg>
  );
}

export function ConservatoryHome() {
  return (
    <LabShell
      title="Interval Labs"
      badge="STUDIO"
      subtitle="Interactive Music Theory Laboratory"
      icon={<IconWave />}
    >
      <div className="page-intro">
        <h2>Welcome to the lab</h2>
        <p>
          Learn and explore musical intervals, chord qualities and harmonic progressions with an
          immersive Web Audio powered laboratory. Choose a topic to begin experimenting with sound and
          theory in real time.
        </p>
      </div>
      <div className="page-grid">
        <div className="page-card">
          <strong>Intervals Explorer</strong>
          <p>
            Browse ascending and descending intervals, hear them in context, and understand their
            emotional character.
          </p>
          <Link to={conservatoryPath('/intervals') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Enter Explorer
          </Link>
        </div>
        <div className="page-card">
          <strong>Chord Workbench</strong>
          <p>
            Discover chord types, build diatonic progressions in any key, audition voicings, and craft
            custom harmonies.
          </p>
          <Link to={conservatoryPath('/chords') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Go to Workbench
          </Link>
        </div>
        <div className="page-card">
          <strong>Rhythm Engine</strong>
          <p>
            Drive a kinetic groove simulator: odd meters, swing, polyrhythms, Euclidean patterns, tap
            timing and a living rhythm organism.
          </p>
          <Link to={conservatoryPath('/rhythm') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Start the Engine
          </Link>
        </div>
        <div className="page-card">
          <strong>Harmony Engine</strong>
          <p>
            Enter the gravity field: forge chords into harmonic organisms, watch resolutions pull
            across a gravity map, loop progressions and train your ear.
          </p>
          <Link to={conservatoryPath('/harmony') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Enter the Field
          </Link>
        </div>
        <div className="page-card">
          <strong>Harmonic Space</strong>
          <p>
            Orbit a 3-D constellation of the twelve notes: morph the chromatic ring into the circle of
            fifths, lift it into a brightness helix, re-home the modes, and feel intervals as distances.
          </p>
          <Link to={conservatoryPath('/space') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Enter the Space
          </Link>
        </div>
        <div className="page-card">
          <strong>Melody Engine</strong>
          <p>
            The creature hatchery: breed single-note organisms from voice, contour and register, then
            store them in your library for the Stage to hire.
          </p>
          <Link to={conservatoryPath('/melody') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Enter the Hatchery
          </Link>
        </div>
        <div className="page-card">
          <strong>Ensemble Stage</strong>
          <p>
            Cast a troupe of creatures — drums, chords, bass and melody — each with its own pattern,
            performing your song together on one stage.
          </p>
          <Link to={conservatoryPath('/stage') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Open the Stage
          </Link>
        </div>
        <div className="page-card">
          <strong>Song Studio</strong>
          <p>
            Orchestrate full songs on a timeline: structure sections, arrange creature tracks with
            measure-snapped clips, or let the wizard cast and arrange a song for you.
          </p>
          <Link to={conservatoryPath('/studio') as never} className="secondary-button" style={{ width: 'fit-content' }}>
            Enter the Studio
          </Link>
        </div>
      </div>
    </LabShell>
  );
}
