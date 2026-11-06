// Usage: node scripts/sync-track-data.mjs [main|commit|branch]
import {writeFile} from 'node:fs/promises';
const ref=process.argv[2]||'3a1381ae5fca0963c369bca71e7f3d5fc448ccb1';
const paths={barcelona:'spain/barcelona-catalunya',monza:'italy/monza',zandvoort:'netherlands/zandvoort'};
for(const [name,path] of Object.entries(paths)){
 const r=await fetch(`https://raw.githubusercontent.com/markthebault/open-racetrack-db/${ref}/data/${path}/layouts/grand-prix.geojson`);
 if(!r.ok)throw Error(`${name}: ${r.status}`);
 const data=await r.json();if(!data.features?.some(f=>f.properties.role==='trace'))throw Error('Missing trace');
 await writeFile(new URL(`../web/public/tracks/${name}.geojson`,import.meta.url),JSON.stringify(data,null,2)+'\n');
}
await writeFile(new URL('../web/public/tracks/source.json',import.meta.url),JSON.stringify({repository:'markthebault/open-racetrack-db',ref,license:'ODbL-1.0 for trace; see per-feature licenses for borders',attribution:'© OpenStreetMap contributors'},null,2)+'\n');
