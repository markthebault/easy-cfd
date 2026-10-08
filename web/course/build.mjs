// Assemble one portable HTML file. The PDF is printed from this exact artifact.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { diagram } from './diagrams.mjs';
import './make-models.mjs';
const here=dirname(fileURLToPath(import.meta.url)),out=resolve(here,'../public/course');
const evidence=JSON.parse(readFileSync(resolve(here,'evidence/runs.json'),'utf8'));
if(evidence.cases.length!==9||evidence.cases.some(c=>!c.result))throw new Error('All nine genuine course-run records must be present before building.');
const manifest=JSON.parse(readFileSync(resolve(out,'models/manifest.json'),'utf8'));
// Minimal deterministic ZIP writer (DEFLATE + CRC32), avoiding a runtime download dependency.
function crc32(data){let crc=0xffffffff;for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zip(entries){const locals=[],central=[];let offset=0;for(const [name,data] of entries){const n=Buffer.from(name),packed=deflateRawSync(data),crc=crc32(data),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt16LE(0x5d47,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,packed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(8,10);c.writeUInt16LE(0x5d47,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=local.length+n.length+packed.length;}const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);}
const entries=[...manifest.files.map(f=>f.file),'manifest.json','README.txt'].map(name=>[name,readFileSync(resolve(out,'models',name))]);
const license=resolve(here,'../../LICENSE');if(existsSync(license))entries.push(['LICENSE.txt',readFileSync(license)]);
const modelZip=zip(entries);writeFileSync(resolve(out,'easycfd-teaching-car.zip'),modelZip);
let content=readFileSync(resolve(here,'content.html'),'utf8').replace(/(<figure data-diagram="([^"]+)">)/g,(all,start,name)=>start+diagram(name));
content=content.replace(/(<figure data-image="([^"]+)" data-alt="([^"]+)">)/g,(all,start,name,alt)=>{
  if(!/^easycfd-[a-z-]+\.png$/.test(name))throw new Error('Unexpected course screenshot path.');
  const data=readFileSync(resolve(here,'../../docs/aerodynamics-course',name)).toString('base64');
  return start+`<img class="field-image" src="data:image/png;base64,${data}" alt="${alt}" width="1500" height="1000" loading="lazy">`;
});
const lessonHeaders=[...content.matchAll(/<article class="lesson" id="([^"]+)" data-day="([^"]+)" data-title="([^"]+)">/g)];
if(lessonHeaders.length!==24)throw new Error('Course must contain 24 lessons.');
const printedContents='<section class="print-only printed-contents"><p class="eyebrow">Reading map</p><h2>Course contents</h2><ol>'+lessonHeaders.map(([,id,day,title])=>`<li><span>Day ${day}</span> <a href="#${id}">${title}</a></li>`).join('')+'</ol><p class="fine-print">Appendices: worked answers; glossary and formula sheet; lab record; sources. PDF bookmarks also follow the lesson headings.</p></section>';
content=content.replace('</header>','</header>'+printedContents);
let day='';const navigation=lessonHeaders.map(([,id,next,title],i)=>{const label=next!==day?`<p class="nav-day">Day ${next} / ${['Read the flow','Understand devices','Useful experiments','Design the car'][Number(next)-1]}</p>`:'';day=next;return `${label}<a href="#${id}" data-lesson-link="${id}"><span class="num">${String(i+1).padStart(2,'0')}</span>${title}</a>`;}).join('\n');
const css=readFileSync(resolve(here,'theme.css'),'utf8'),math=readFileSync(resolve(here,'models.mjs'),'utf8').replace(/^export /gm,'');
const data=JSON.stringify({evidence,modelZip:modelZip.toString('base64'),issues:JSON.parse(readFileSync(resolve(here,'issues.json'),'utf8'))}).replace(/</g,'\\u003c');
const js=readFileSync(resolve(here,'interactives.js'),'utf8');
const logo='<svg class="brand-icon" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7cc4ff"/><stop offset="1" stop-color="#2a78d6"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#logo-g)"/><path d="M6 12.5c5-3 9 3 14 0s4.5-2 6-2M6 17c5-3 9 3 14 0s4.5-2 6-2M6 21.5c5-3 9 3 14 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="A four-day car-aerodynamics engineering course, with original diagrams, interactive workbenches and practical EasyCFD labs."><title>Car aerodynamics · EasyCFD course</title><style>${css}</style></head>
<body><a class="skip" href="#main">Skip to course</a><header class="toolbar no-print"><button id="menu-toggle" aria-expanded="false" aria-controls="course-sidebar" aria-label="Course contents">Contents</button><a class="course-brand" href="#start">${logo}<span>EasyCFD</span></a><span class="toolbar-label">Car aerodynamics course</span><span class="spacer"></span><a class="secondary" data-app-back href="../">Open EasyCFD</a><button id="download-html" class="desktop-only">Save offline HTML</button><button id="print-course">Print / PDF</button></header>
<aside class="sidebar no-print" id="course-sidebar"><h2>Course contents</h2><div class="progress-box"><span id="progress-label">0 of 24 lessons completed</span><progress id="course-progress" max="24" value="0" aria-label="Course completion"></progress><a href="#start">Overview and learning path</a></div><label for="course-search">Find a concept</label><input type="search" id="course-search" placeholder="Pressure, wings, y+..."><p id="search-status" role="status"></p><nav aria-label="Course lessons">${navigation}<p class="nav-day">Reference</p><a href="#answers">Worked exercises and answers</a><a href="#glossary">Glossary and formula sheet</a><a href="#workbook">Notebook and feature requests</a><a href="#sources">Sources and attribution</a></nav></aside>
<main id="main">${content}</main>
<script>${math}\nwindow.CourseMath={forceModel,wingModel,diffuserModel,balanceModel,gciModel,yawModel,frontier};</script><script>window.CourseData=${data};</script><script>${js}</script></body></html>\n`;
writeFileSync(resolve(out,'index.html'),html);
const portable=resolve(here,'../../output/html');mkdirSync(portable,{recursive:true});
writeFileSync(resolve(portable,'easycfd-car-aerodynamics.html'),html);
copyFileSync(resolve(here,'evidence/runs.json'),resolve(out,'runs.json'));
copyFileSync(resolve(here,'evidence/viewer-run.json'),resolve(out,'viewer-run.json'));
const pdf=resolve(here,'../../output/pdf/easycfd-car-aerodynamics.pdf');if(existsSync(pdf))copyFileSync(pdf,resolve(out,'easycfd-car-aerodynamics.pdf'));
console.log(`Course: 24 lessons, ${[...content.matchAll(/data-diagram=/g)].length} diagrams, ${[...content.matchAll(/data-image=/g)].length} real field views, ${[...content.matchAll(/data-widget=/g)].length} workbenches, ${(Buffer.byteLength(html)/1024/1024).toFixed(2)} MB self-contained HTML.`);
