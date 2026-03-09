import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const css = execSync('npx @tailwindcss/cli -i src/styles.css --minify', { encoding: 'utf-8' });
writeFileSync('src/assets/tailwind.ts', `export const TAILWIND_CSS = ${JSON.stringify(css.trim())};\n`);
console.log(`tailwind.ts generated (${css.trim().length} bytes)`);
