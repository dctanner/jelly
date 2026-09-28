const fs=require('fs');
const names='search plus x chevron-down chevron-left folder monitor settings archive arrow-up check square ellipsis triangle-alert wifi-off refresh-cw copy chevron-right moon sun arrow-left menu external-link lock log-in file-text'.split(' ');const icons={};
for(const n of names){const s=fs.readFileSync(`node_modules/lucide-react/dist/esm/icons/${n}.js`,'utf8');const a=s.match(/createLucideIcon\("[^"]+", ([\s\S]*?)\);/);icons[n]=Function(`return (${a[1]})`)();}
fs.writeFileSync('design/ui-kit/icons.js','window.JELLY_ICONS='+JSON.stringify(icons)+';\nwindow.icon=(name)=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${(JELLY_ICONS[name]||JELLY_ICONS.folder).map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).filter(([k])=>k!=="key").map(([k,v])=>`${k}="${v}"`).join(" ")}/>`).join("")}</svg>`;');
fs.copyFileSync('node_modules/lucide-react/LICENSE','design/ui-kit/ICONS-LICENSE.txt');
