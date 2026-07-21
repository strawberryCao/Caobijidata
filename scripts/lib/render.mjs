import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { MIME_BY_EXT, cleanText, primaryKnowledge, resolveRepoPath } from './common.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rich(value) { return escapeHtml(cleanText(value, 12000)).replace(/\n/g, '<br>'); }
function dateOf(note) { return note.capturedDate || note.updatedAt.slice(0, 10) || note.createdAt.slice(0, 10) || '日期未记录'; }
function imageData(root, note) {
  if (!note.imagePath) return '';
  const full = resolveRepoPath(root, note.imagePath);
  const mime = MIME_BY_EXT.get(path.extname(full).toLowerCase());
  return mime ? `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` : '';
}

export function buildHtml(root, kind, notes, groups, config, generatedAt) {
  const title = kind === 'mistake' ? '错题综合整理' : '背诵综合整理';
  const accent = kind === 'mistake' ? '#a34b3f' : '#315f72';
  const soft = kind === 'mistake' ? '#f7ece8' : '#eaf2f4';
  const map = new Map(notes.map((note) => [note.id, note]));
  const outline = new Map();
  for (const group of groups) {
    const first = map.get(group.sourceIds[0]);
    const subject = first?.subject || '未分类';
    const knowledge = primaryKnowledge(first);
    const section = outline.get(subject) || new Map();
    section.set(knowledge, [...(section.get(knowledge) || []), group]);
    outline.set(subject, section);
  }
  const showToc = groups.length >= 5;
  const toc = [...outline.entries()].map(([subject, section]) => `
    <div class="toc-row"><strong>${escapeHtml(subject)}</strong><span>${[...section.values()].reduce((n, x) => n + x.length, 0)} 组</span></div>
    <div class="toc-tags">${[...section.keys()].map((x) => `<i>${escapeHtml(x)}</i>`).join('')}</div>`).join('');
  let index = 0;
  const content = [...outline.entries()].map(([subject, section]) => `
    <section class="subject">
      <header class="subject-head"><h1>${escapeHtml(subject)}</h1></header>
      ${[...section.entries()].map(([knowledge, entries]) => `
        <section class="knowledge"><h2>${escapeHtml(knowledge)}</h2>
          ${entries.map((group) => {
            index += 1;
            const sourceNotes = group.sourceIds.map((id) => map.get(id)).filter(Boolean);
            const label = group.groupType === 'same_question' ? '同题合并' : group.groupType === 'same_topic' ? '同类专题' : '独立条目';
            return `<article class="group">
              <header class="group-head"><b>${String(index).padStart(2, '0')}</b><div><h3>${escapeHtml(group.title)}</h3><span class="group-kind">${label} · ${sourceNotes.length} 条</span></div></header>
              ${sourceNotes.map((note) => {
                const image = config.rules.includeOriginalImages ? imageData(root, note) : '';
                const tags = note.tags.slice(0, 8).map((tag) => `<i>${escapeHtml(tag)}</i>`).join('');
                const wrong = kind === 'mistake' && config.rules.includeWrongReasons && note.wrongReason
                  ? `<div class="block important"><h5>已记录错因</h5><p>${rich(note.wrongReason)}</p></div>` : '';
                const remark = config.rules.includeRemarks && note.remark
                  ? `<div class="block"><h5>原备注</h5><p>${rich(note.remark)}</p></div>` : '';
                return `<section class="source">
                  <div class="source-title"><h4>${escapeHtml(note.title)}</h4><time>${escapeHtml(dateOf(note))}</time></div>
                  ${tags ? `<div class="tags">${tags}</div>` : ''}
                  ${image ? `<figure><img src="${image}" alt="${escapeHtml(note.title)}"></figure>` : ''}
                  ${wrong}${remark}
                </section>`;
              }).join('')}
            </article>`;
          }).join('')}
        </section>`).join('')}
    </section>`).join('');
  const coverClass = notes.length ? 'cover' : 'cover is-empty';
  const empty = notes.length ? '' : `<div class="empty"><h2>暂无已确认的${kind === 'mistake' ? '错题' : '背诵'}内容</h2><p>在主应用中确认分类后，内容会在下次同步时进入这里。</p></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>
@page{size:A4;margin:12mm 12mm 14mm}*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;color:#25231f;font:10.5pt/1.5 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}.cover{min-height:257mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page;padding:8mm 3mm 2mm}.cover.is-empty{break-after:auto}.mark{width:20mm;height:4px;border-radius:99px;background:${accent}}.cover h1{margin:19mm 0 3mm;font:32pt/1.15 "Noto Serif CJK SC","STSong",serif;letter-spacing:.06em}.subtitle{color:#635f58;font-size:12pt}.summary{margin-top:16mm;padding:7mm;border-radius:4mm;background:${soft};border:1px solid ${accent}33;display:grid;grid-template-columns:repeat(3,1fr);gap:4mm}.summary div{display:flex;flex-direction:column;gap:1mm}.summary span{color:#6f685f;font-size:9.5pt}.summary strong{font-size:15pt}.toc{break-after:page}.toc h1{font:22pt "Noto Serif CJK SC",serif;margin:0 0 6mm}.toc-row{padding:3mm 0 1.5mm;display:flex;justify-content:space-between;border-bottom:1px solid #ddd7ce}.toc-row strong{font-size:13pt}.toc-row span{font-size:10pt;color:#736d64}.toc-tags,.tags{display:flex;flex-wrap:wrap;gap:1.5mm;padding:2mm 0 3mm}.toc-tags i,.tags i{font-style:normal;padding:.7mm 2.1mm;border-radius:99px;background:${soft};color:${accent};font-size:9pt}.subject+.subject{break-before:page}.subject-head{border-bottom:2px solid ${accent};padding-bottom:2mm;margin-bottom:5mm}.subject-head h1{margin:0;font:22pt/1.1 "Noto Serif CJK SC",serif}.knowledge>h2{margin:6mm 0 3mm;padding-left:2.5mm;border-left:4px solid ${accent};font-size:15pt;break-after:avoid}.group{border:1px solid #ded8cf;border-radius:3mm;margin:0 0 4.5mm;overflow:hidden}.group-head{display:flex;gap:3mm;align-items:center;padding:3mm 4mm;background:linear-gradient(120deg,${soft},#fff);border-bottom:1px solid #e3ddd4;break-after:avoid}.group-head>b{width:9mm;height:9mm;flex:0 0 9mm;border-radius:50%;color:#fff;background:${accent};display:grid;place-items:center;font-size:9pt}.group-head h3{margin:0;font-size:14pt;line-height:1.28}.group-kind{display:block;margin-top:.7mm;color:#736b62;font-size:9pt}.source{padding:3.5mm 4mm;border-top:1px dashed #ded8cf;break-inside:avoid-page}.source:first-of-type{border-top:0}.source-title{display:flex;align-items:flex-start;justify-content:space-between;gap:4mm}.source h4{margin:0;font-size:12pt;line-height:1.35}.source time{flex:0 0 auto;color:#777066;font-size:9pt;line-height:1.35}figure{margin:2.5mm 0;text-align:center}figure img{display:block;max-width:100%;max-height:148mm;margin:0 auto;object-fit:contain;border-radius:2mm;border:1px solid #d8d2c9;background:#faf9f6}.block{margin-top:2.2mm;padding:2.7mm 3.2mm;background:#f8f7f4;border-radius:2mm;border-left:3px solid #b8afa3}.block.important{background:${soft};border-left-color:${accent}}.block h5{margin:0 0 .8mm;color:#514c45;font-size:9.5pt}.block p{margin:0;overflow-wrap:anywhere}.empty{margin-top:20mm;padding:12mm;background:${soft};border-radius:4mm}.empty h2{margin:0 0 2mm;font-size:17pt}.empty p{margin:0;color:#686259;font-size:10.5pt}
</style></head><body>
<section class="${coverClass}"><div><div class="mark"></div><h1>${title}</h1><div class="subtitle">只整理已确认内容，不扩写、不补充</div><div class="summary"><div><span>有效来源</span><strong>${notes.length} 条</strong></div><div><span>整理题组</span><strong>${groups.length} 组</strong></div><div><span>生成日期</span><strong>${generatedAt.slice(0,10)}</strong></div></div>${empty}</div></section>
${showToc ? `<section class="toc"><h1>内容目录</h1>${toc}</section>` : ''}${content}</body></html>`;
}

export async function renderPdf(html, outputPath, dryRun = false) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    await page.setContent(html, { waitUntil: 'load', timeout: 120000 });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: temp, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    if (!fs.existsSync(temp) || fs.statSync(temp).size < 800 || fs.readFileSync(temp).subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('浏览器没有生成有效 PDF');
    if (!dryRun) fs.renameSync(temp, outputPath);
  } finally {
    await browser.close();
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
