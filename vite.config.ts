import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath} from "node:url";
export default defineConfig({plugins:[react()],resolve:{alias:{"@":fileURLToPath(new URL(".",import.meta.url))}},cacheDir:".vite-cache",build:{outDir:"dist",emptyOutDir:true}});
