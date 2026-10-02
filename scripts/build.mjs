import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
// Recria a entrada fonte para impedir que um index.html de dist quebre a publicação.
const root=fileURLToPath(new URL('../',import.meta.url));
await writeFile(new URL('../index.html',import.meta.url),"<!doctype html><html lang=\"pt-BR\" class=\"dark\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"icon\" href=\"/favicon.svg\"><title>Controle de Produ\u00e7\u00e3o</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/main.tsx\"></script></body></html>\n");
// Use Vite's runner loader so the config is evaluated in place. This avoids
// writing a temporary bundled config into a read-only node_modules cache.
await build({root,configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),configLoader:'runner'});
