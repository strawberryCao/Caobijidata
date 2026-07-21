import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { MIME_BY_EXT, cleanText, primaryKnowledge, resolveRepoPath } from './common.mjs';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rich(value) { return escapeHtml(cleanText(value, 12000)).replace(/\n/g, '<br>'); }
function dateOf(note) { return note.capturedDate || note.updatedAt.slice(0, 10) || note.createdAt.slice(0, 10) || ''; }
function imageData(root, note) {
  if (!note.imagePath) return '';
  const full = resolveRepoPath(root, note.imagePath);
  const mime = MIME_BY_EXT.get(path.extname(full).toLowerCase());
  return mime ? `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` : '';
}

export function buildHtml(root, kind, notes, groups, config, generatedAt) {
  const title = kind === 'mistake' ? '错题综合整理' : '背诵综合整理';
  const accent = kind === 'mistake' ? '#8f4b43' : '#315f72';
  const soft = kind === 'mistake' ? '#f7efec' : '#edf4f6';
  const map = new Map(notes.map((note) => [note.id, note]));
  const showToc = groups.length >= 6;
  const toc = groups.map((group, i) => `<div class="toc-row"><b>${String(i + 1).padStart(2, '0')}</b><span>${escapeHtml(group.title)}</span><em>${group.sourceIds.length} 项</em></div>`).join('');
  let index = 0;
  const content = groups.map((group) => {
    index += 1;
    const sourceNotes = group.sourceIds.map((id) => map.get(id)).filter(Boolean);
    return `<section class="group">
      <header class="group-head"><b>${String(index).padStart(2, '0')}</b><h2>${escapeHtml(group.title)}</h2></header>
      ${sourceNotes.map((note) => {
        const image = config.rules.includeOriginalImages ? imageData(root, note) : '';
        const wrong = kind === 'mistake' && config.rules.includeWrongReasons && note.wrongReason
          ? `<div class="block important"><strong>错因：</strong>${rich(note.wrongReason)}</div>` : '';
        const remark = config.rules.includeRemarks && note.remark
          ? `<div class="block"><strong>原备注：</strong>${rich(note.remark)}</div>` : '';
        const summary = note.items?.find((item) => item.summary)?.summary
          ? `<div class="block"><strong>内容定位：</strong>${rich(note.items.find((item) => item.summary).summary)}</div>` : '';
        return `<article class="source">
          <div class="source-title"><h3>${escapeHtml(note.title)}</h3><time>${escapeHtml(dateOf(note))}</time></div>
          ${image ? `<figure><img src="${image}" alt="${escapeHtml(note.title)}"></figure>` : ''}
          ${wrong}${remark}${summary}
        </article>`;
      }).join('')}
    </section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>
@page{size:A4;margin:10mm 11mm 13mm}*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;color:#242a2d;font:10.2pt/1.46 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}.cover{min-height:264mm;display:flex;flex-direction:column;justify-content:center;break-after:page;padding:8mm}.mark{width:24mm;height:4px;border-radius:99px;background:${accent};margin-bottom:12mm}.cover h1{margin:0 0 4mm;font:30pt/1.15 "Noto Serif CJK SC","STSong",serif;color:#17324d}.subtitle{color:#68747a;font-size:11pt}.summary{margin-top:14mm;padding:5mm 6mm;border-radius:3mm;background:${soft};display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}.summary span{display:block;color:#707b80;font-size:9pt}.summary strong{display:block;margin-top:1mm;font-size:15pt;color:#203b4a}.toc{break-after:page}.toc h1{margin:0 0 5mm;font:21pt "Noto Serif CJK SC",serif;color:#17324d}.toc-row{display:grid;grid-template-columns:12mm 1fr 18mm;gap:2mm;align-items:center;padding:3mm 1mm;border-bottom:1px solid #d9e1e4}.toc-row b{color:${accent}}.toc-row span{font-size:12pt}.toc-row em{font-style:normal;text-align:right;color:#78848a;font-size:9pt}.group{margin:0 0 5mm;break-inside:avoid-page;border:1px solid #cad7dc;border-radius:2.5mm;overflow:hidden}.group-head{display:flex;align-items:center;gap:3mm;padding:2.8mm 3.5mm;background:${soft};border-bottom:1px solid #cad7dc}.group-head>b{width:8mm;height:8mm;border-radius:50%;display:grid;place-items:center;background:${accent};color:white;font-size:8.5pt}.group-head h2{margin:0;font-size:15pt;color:#173b50}.source{padding:3mm 3.5mm;border-top:1px dashed #d6dee1;break-inside:avoid-page}.source:first-of-type{border-top:0}.source-title{display:flex;justify-content:space-between;gap:4mm;align-items:flex-start}.source h3{margin:0;font-size:12pt;line-height:1.35;color:#274f63}.source time{white-space:nowrap;color:#7b868b;font-size:8.8pt}figure{margin:2mm 0;text-align:center}figure img{display:block;max-width:100%;max-height:128mm;margin:0 auto;object-fit:contain;border:1px solid #d7dfe2;border-radius:1.5mm;background:#fff}.block{margin-top:1.8mm;padding:2.2mm 2.7mm;border-radius:1.5mm;background:#f7f8f8;overflow-wrap:anywhere}.block.important{background:${soft};border-left:3px solid ${accent}}.block strong{color:#3b515c}.empty{padding:10mm;background:${soft};border-radius:3mm}
</style></head><body>
<section class="cover"><div class="mark"></div><h1>${title}</h1><div class="subtitle">综合当前全部已确认内容；只整理，不扩写</div><div class="summary"><div><span>有效资料</span><strong>${notes.length} 条</strong></div><div><span>专题</span><strong>${groups.length} 组</strong></div><div><span>生成日期</span><strong>${generatedAt.slice(0,10)}</strong></div></div></section>
${showToc ? `<section class="toc"><h1>专题目录</h1>${toc}</section>` : ''}${content}</body></html>`;
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
