import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './assets/fonts.css';
import './styles/index.css';
import { ApiProvider } from './api/context';
import { App } from './app/App';
import { ThemeProvider } from './theme/ThemeProvider';

// Every theme file is loaded; which one applies is decided by <html data-theme>. Dropping a new file in themes/ (plus its
// manifest line) is all a new theme needs.
import.meta.glob('./theme/themes/*.css', { eager: true });

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ApiProvider>
        <App />
      </ApiProvider>
    </ThemeProvider>
  </StrictMode>,
);
