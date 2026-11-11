import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './utils/authContext';
import App from './App';
import './styles/fonts.css';
import './styles/global.css';

const container = document.getElementById('root');
const tree = (
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// Public routes arrive with prerendered markup in #root (see
// scripts/seo/prerender.mjs): hydrate it. App routes and the fallback shell
// arrive empty: render from scratch.
if (container.hasChildNodes()) {
  ReactDOM.hydrateRoot(container, tree);
} else {
  ReactDOM.createRoot(container).render(tree);
}
