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
  const toc = [...outline.entries()].map(([subject, section]) => `
    <div class="toc-row"><strong>${escapeHtml(subject)}</strong><span>${[...section.values()].reduce((n, x) => n + x.length, 0)} 组</span></div>
    <div class="toc-tags">${[...section.keys()].map((x) => `<i>${escapeHtml(x)}</i>`).join('')}</div>`).join('');
  let index = 0;
  const content = [...outline.entries()].map(([subject, section]) => `
    <section class="subject">
      <header class="subject-head"><small>科目</small><h1>${escapeHtml(subject)}</h1></header>
      ${[...section.entries()].map(([knowledge, entries]) => `
        <section class="knowledge"><h2>${escapeHtml(knowledge)}</h2>
          ${entries.map((group) => {
            index += 1;
            const sourceNotes = group.sourceIds.map((id) => map.get(id)).filter(Boolean);
            const label = group.groupType === 'same_question' ? '同题资料合并' : group.groupType === 'same_topic' ? '同类专题' : '独立条目';
            return `<article class="group">
              <header class="group-head"><b>${String(index).padStart(2, '0')}</b><div><small>${label} · ${sourceNotes.length} 条来源</small><h3>${escapeHtml(group.title)}</h3></div></header>
              ${sourceNotes.map((note, i) => {
                const image = config.rules.includeOriginalImages ? imageData(root, note) : '';
                const tags = note.tags.slice(0, 8).map((tag) => `<i>${escapeHtml(tag)}</i>`).join('');
                const wrong = kind === 'mistake' && config.rules.includeWrongReasons && note.wrongReason
                  ? `<div class="block important"><h5>已记录错因</h5><p>${rich(note.wrongReason)}</p></div>` : '';
                const remark = config.rules.includeRemarks && note.remark
                  ? `<div class="block"><h5>原备注</h5><p>${rich(note.remark)}</p></div>` : '';
                return `<section class="source">
                  <div class="source-line"><span>来源 ${i + 1}</span><time>${escapeHtml(dateOf(note))}</time></div>
                  <h4>${escapeHtml(note.title)}</h4>${tags ? `<div class="tags">${tags}</div>` : ''}
                  ${image ? `<figure><img src="${image}" alt="${escapeHtml(note.title)}"><figcaption>原始笔记图片</figcaption></figure>` : ''}
                  ${wrong}${remark}
                  <footer>来源 ID：${escapeHtml(note.id)}${note.sourceFileName ? ` · ${escapeHtml(note.sourceFileName)}` : ''}</footer>
                </section>`;
              }).join('')}
            </article>`;
          }).join('')}
        </section>`).join('')}
    </section>`).join('');
  const empty = notes.length ? '' : `<section class="empty"><h2>暂无已确认的${kind === 'mistake' ? '错题' : '背诵'}内容</h2><p>只有主应用中已经确认分类的内容才会进入这份 PDF。</p></section>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>
@page{size:A4;margin:17mm 16mm 18mm}*{box-sizing:border-box}html{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;color:#25231f;font:10.5pt/1.68 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}.cover{min-height:250mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page;padding:12mm 4mm 4mm}.mark{width:22mm;height:4px;border-radius:99px;background:${accent}}.cover h1{margin:25mm 0 4mm;font:34pt/1.2 "Noto Serif CJK SC","STSong",serif;letter-spacing:.08em}.subtitle{color:#6c665c;font-size:13pt}.summary{margin-top:25mm;padding:10mm;border-radius:5mm;background:${soft};border:1px solid ${accent}33;display:grid;grid-template-columns:1fr 1fr;gap:6mm}.summary div{display:flex;flex-direction:column}.summary small{color:#786f64;letter-spacing:.08em}.summary strong{margin-top:2mm;font-size:16pt}.foot{color:#7c756b;font-size:9pt;border-top:1px solid #ddd6cc;padding-top:4mm}.toc{break-after:page}.toc h1{font:24pt "Noto Serif CJK SC",serif;margin:0 0 10mm}.toc-row{padding:4mm 0 2mm;display:flex;justify-content:space-between;border-bottom:1px solid #ddd7ce}.toc-row strong{font-size:14pt}.toc-tags,.tags{display:flex;flex-wrap:wrap;gap:2mm;padding:3mm 0 5mm}.toc-tags i,.tags i{font-style:normal;padding:.8mm 2.4mm;border-radius:99px;background:${soft};color:${accent};font-size:8.5pt}.subject{break-before:page}.subject-head{display:flex;align-items:flex-end;gap:4mm;border-bottom:2px solid ${accent};padding-bottom:3mm;margin-bottom:8mm}.subject-head small{color:${accent};letter-spacing:.18em}.subject-head h1{margin:0;font:24pt/1.1 "Noto Serif CJK SC",serif}.knowledge>h2{margin:9mm 0 4mm;padding-left:3mm;border-left:4px solid ${accent};font-size:16pt;break-after:avoid}.group{border:1px solid #ded8cf;border-radius:4mm;margin:0 0 7mm;overflow:hidden;break-inside:avoid-page}.group-head{display:flex;gap:4mm;align-items:center;padding:4mm 5mm;background:linear-gradient(120deg,${soft},#fff);border-bottom:1px solid #e3ddd4}.group-head>b{width:11mm;height:11mm;border-radius:50%;color:#fff;background:${accent};display:grid;place-items:center;font-size:9pt}.group-head small{color:${accent};letter-spacing:.08em}.group-head h3{margin:.5mm 0 0;font-size:15pt;line-height:1.35}.source{padding:5mm;border-top:1px dashed #ded8cf;break-inside:avoid-page}.source:first-of-type{border-top:0}.source-line{display:flex;justify-content:space-between;color:#7b746a;font-size:8.5pt}.source h4{margin:1.5mm 0 2mm;font-size:12.5pt}figure{margin:4mm 0;text-align:center}figure img{max-width:100%;max-height:165mm;object-fit:contain;border-radius:2mm;border:1px solid #d8d2c9;background:#faf9f6}figcaption{color:#8a8277;font-size:8pt}.block{margin-top:3mm;padding:3.5mm 4mm;background:#f8f7f4;border-radius:2.5mm;border-left:3px solid #b8afa3}.block.important{background:${soft};border-left-color:${accent}}.block h5{margin:0 0 1mm;color:#5d574f;font-size:9pt}.block p{margin:0;overflow-wrap:anywhere}.source footer{margin-top:4mm;padding-top:2mm;border-top:1px solid #eee9e2;color:#948b80;font-size:7.5pt;overflow-wrap:anywhere}.empty{margin-top:50mm;text-align:center;padding:18mm;background:${soft};border-radius:5mm}
</style></head><body>
<section class="cover"><div><div class="mark"></div><h1>${title}</h1><div class="subtitle">仅整理已确认内容 · 不扩写知识 · 每次重新综合生成</div><div class="summary"><div><small>有效来源</small><strong>${notes.length} 条</strong></div><div><small>整理题组</small><strong>${groups.length} 组</strong></div><div><small>生成日期</small><strong>${generatedAt.slice(0,10)}</strong></div><div><small>内容原则</small><strong>原资料优先</strong></div></div></div><div class="foot">固定模板排版。AI 只允许分组和排序，不负责补充答案、知识讲解或额外例题。</div></section>
${notes.length ? `<section class="toc"><h1>内容目录</h1>${toc}</section>` : ''}${empty}${content}</body></html>`;
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
