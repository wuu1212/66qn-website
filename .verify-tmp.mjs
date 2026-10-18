import fs from 'node:fs';
import { execSync } from 'node:child_process';

const token = fs.readFileSync(process.argv[2], 'utf8').split('\n').find(l => l.startsWith('password=')).slice('password='.length).trim().replace(/\r/g, '');
const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
const files = [
  'app.js', 'index.html', 'frontend/app.js', 'frontend/index.html',
  'backend/supabase/schema.sql', 'backend/supabase/functions/ai/index.ts',
];
const out = [];
for (const f of files) {
  const localSha = execSync('git hash-object ' + f).toString().trim();
  const gr = await fetch('https://api.github.com/repos/wuu1212/66qn-website/contents/' + encodeURI(f) + '?ref=main', { headers: H });
  const gj = await gr.json();
  const remote = gj.sha || '';
  out.push((remote === localSha ? 'OK   ' : 'DIFF ') + f + '  ' + localSha.slice(0, 8) + ' / ' + remote.slice(0, 8));
}
fs.writeFileSync('.verify.log', out.join('\n') + '\n');
