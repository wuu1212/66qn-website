// 通过 GitHub Contents API 上传文件（走 api.github.com）
import fs from 'node:fs';

const [, , tokenFile, ...files] = process.argv;
const token = fs.readFileSync(tokenFile, 'utf8').split('\n').find(l => l.startsWith('password=')).slice('password='.length).trim();
const owner = 'wuu1212', repo = '66qn-website';
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

for (const f of files) {
  const b64 = fs.readFileSync(f).toString('base64');
  let sha = '';
  try {
    const gr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(f)}?ref=main`, { headers: H });
    if (gr.ok) sha = (await gr.json()).sha || '';
  } catch { /* ignore */ }
  const body = { message: 'fix: add ai_configs columns before function creation', content: b64, branch: 'main' };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(f)}`, {
    method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  console.log(`${f} -> HTTP ${res.status}`);
  if (!res.ok) console.log((await res.text()).slice(0, 240));
}
