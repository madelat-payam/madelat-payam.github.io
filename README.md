# payam-madelat-site

Personal website of Payam Madelat. Astro static site with a Three.js city
hero, deployed to GitHub Pages.

## Develop

```
npm install
npm run dev
```

## Build

```
npm run build
```

Output goes to `dist/`. Pushing to `main` builds and deploys through
`.github/workflows/deploy.yml`; set `site` (and `base` for a project repo)
in `astro.config.mjs` before the first deploy.
