// Copie les modules, styles, polices et icônes partagés du site web dans l'interface de l'app.
// En Node pour fonctionner aussi sous Windows (compilation de l'app).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const dest = join(root, 'app', 'ui', 'shared');
mkdirSync(join(dest, 'fonts'), { recursive: true });
mkdirSync(join(dest, 'vendor'), { recursive: true });
for (const f of ['relay.js', 'remote.js', 'devices.js', 'style.css']) cpSync(join(web, f), join(dest, f));
for (const f of ['Geist-Variable.woff2', 'GeistMono-Variable.woff2']) cpSync(join(web, 'fonts', f), join(dest, 'fonts', f));
for (const f of ['phosphor.css', 'Phosphor.woff2', 'qrcode.mjs']) cpSync(join(web, 'vendor', f), join(dest, 'vendor', f));
