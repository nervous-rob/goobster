import { createRoot } from 'react-dom/client';
import '../legacy.css';
import './setup.css';
import { App } from './App';

// The manager's page has no account and no theme setting: it follows the system.
if (window.matchMedia?.('(prefers-color-scheme: light)').matches) document.body.classList.add('light');

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(<App />);
