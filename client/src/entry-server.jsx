// Server entry, built with `vite build --ssr` and used only at build time by
// scripts/seo/prerender.mjs. Never shipped to the browser, never run by Express.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AuthProvider } from './utils/authContext';
import App from './App';

export { getRouteMeta, listPublicPaths, renderHeadTags, APP_ROUTES, SITE_URL, DEFAULT_OG_IMAGE } from './seo/routes';

/** HTML for #root at `url`. Must match the first client render exactly (hydration). */
export function render(url) {
  return renderToString(
    <React.StrictMode>
      <StaticRouter location={url}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StaticRouter>
    </React.StrictMode>
  );
}
