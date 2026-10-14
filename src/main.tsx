import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './ui/App';
import { isTauri } from './platform/files';
import { cadWindowParams } from './ui/cad/cadWindow';
import { CadWindowApp } from './ui/cad/CadWindowApp';

// the same bundle serves the worksheet and its separate CAD windows
const cad = cadWindowParams();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {cad ? <CadWindowApp id={cad.id} session={cad.session} /> : <App />}
  </StrictMode>,
);

// Offline support for the web build (the native builds bundle everything already).
if (!isTauri && import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
