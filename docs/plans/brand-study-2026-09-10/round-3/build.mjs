import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '../../../..');
// The review shell uses production colors, logo, shader, CSS and Launch directly.
const css = readFileSync(resolve(root,'src/index.css'),'utf8');
const dark = css.match(/@theme static \{([\s\S]*?)\n\}/)?.[1];
if (!dark) throw Error('App theme block changed');
writeFileSync(resolve(dir,'preview-theme.css'),`:root {${dark.replace(/^\s*--[\w-]+\*:.*$/gm,'')}\n}\n`);
mkdirSync(resolve(dir,'../brand'),{recursive:true});
copyFileSync(resolve(root,'public/brand/spark.svg'),resolve(dir,'../brand/spark.svg'));
copyFileSync(resolve(root,'public/brand/spark.svg'),resolve(dir,'spark.svg'));
await build({
 entryPoints:[resolve(dir,'preview.tsx')],bundle:true,format:'esm',jsx:'automatic',
 outfile:resolve(dir,'launch-preview.js'),minify:true,define:{'process.env.NODE_ENV':'"production"'},
 plugins:[{name:'isolated-current-launch',setup(b){
   b.onResolve({filter:/^(\.\.\/|\.\/).*(launchApi|workspaceApi|App)$/},args=>{
     const resolved=resolve(dirname(args.importer),args.path);
     if(['launchApi','workspaceApi','App'].some(n=>resolved===resolve(root,'src',n)))return {path:resolve(dir,'mocks.tsx')};
   });
   b.onResolve({filter:/hooks\/useMusic$/},args=>args.importer===resolve(root,'src/Launch.tsx')?{path:resolve(dir,'PreviewMusic.tsx')}:undefined);
 }}],
});
console.log('Bundled the production intro and theme; only API stubs and audio comparison controls are preview-specific.');
