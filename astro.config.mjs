// @ts-check
import { defineConfig } from 'astro/config';

// User site at madelat-payam.github.io serves from the domain root, so base
// stays at its '/' default. When a custom domain is connected later, change
// `site` to that domain; nothing else here needs to move.
export default defineConfig({
  site: 'https://madelat-payam.github.io',
});
