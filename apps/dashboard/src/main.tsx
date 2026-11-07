import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// design tokens first (packages/design): fonts and the custom properties styles.css uses
import '@theirside/design/tokens.css';
import { App } from './App';
import './styles.css';
import { applyThemeMode } from './theme';

applyThemeMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
