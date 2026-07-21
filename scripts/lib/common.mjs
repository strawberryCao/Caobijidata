import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VALID_KINDS = new Set(['mistake', 'memory']);
export const MIME_BY_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);

export function fail(message) { throw new Error(message); }

export function readJson(filePath, label) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 的根节点必须是对象`);
    return value;
  } catch (error) {
    fail(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function cleanText(value, max = 8000) {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)
    : '';
}

export function uniqueStrings(value, maxItems = 40, maxLength = 120) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

export function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function resolveRepoPath(root, relativePath) {
  const normalized = cleanText(relativePath, 500).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const fullPath = path.resolve(root, normalized);
  const relative = path.relative(root, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`路径越出仓库：${relativePath}`);
  return fullPath;
}

function safeId(value) {
  const id = cleanText(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) fail(`不安全的笔记 ID：${id || '(空)'}`);
  return id;
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 24).map((item) => ({
    title: cleanText(item?.title, 120),
    knowledgePoint: cleanText(item?.knowledgePoint, 80),
    questionType: cleanText(item?.questionType, 80),
    summary: cleanText(item?.summary, 1200),
    wrongReason: cleanText(item?.wrongReason, 600),
    tags: uniqueStrings(item?.tags),
  })).filter((item) => item.title || item.summary || item.wrongReason);
}

function normalizeNote(root, raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`notes[${index}] 必须是对象`);
  const id = safeId(raw.id || raw.noteUid);
  const kind = cleanText(raw.kind || raw.noteType, 20);
  if (!VALID_KINDS.has(kind)) fail(`笔记 ${id} 的 kind 必须是 mistake 或 memory`);
  const organizationStatus = cleanText(raw.organizationStatus, 20) || 'confirmed';
  if (organizationStatus !== 'confirmed') fail(`笔记 ${id} 未确认，不允许导出`);
  const imagePath = cleanText(raw.imagePath, 500).replace(/\\/g, '/');
  if (imagePath) {
    const fullPath = resolveRepoPath(root, imagePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) fail(`笔记 ${id} 的图片不存在：${imagePath}`);
    if (!MIME_BY_EXT.has(path.extname(fullPath).toLowerCase())) fail(`笔记 ${id} 的图片格式不受支持`);
  }
  return {
    id, kind,
    title: cleanText(raw.title, 240) || (kind === 'mistake' ? '未命名错题' : '未命名背诵内容'),
    subject: cleanText(raw.subject, 100) || '未分类',
    knowledgePath: uniqueStrings(raw.knowledgePath, 6, 100),
    tags: uniqueStrings(raw.tags),
    remark: cleanText(raw.remark, 8000),
    wrongReason: cleanText(raw.wrongReason, 1200),
    questionType: cleanText(raw.questionType, 100),
    capturedDate: cleanText(raw.capturedDate, 20),
    createdAt: cleanText(raw.createdAt, 80),
    updatedAt: cleanText(raw.updatedAt, 80),
    imagePath,
    imageSha256: cleanText(raw.imageSha256, 64).toLowerCase(),
    sourceFileName: cleanText(raw.sourceFileName, 240),
    items: normalizeItems(raw.items),
    organizationStatus,
  };
}

export function validateData(root, raw) {
  if (raw.version !== 1 || !Array.isArray(raw.notes)) fail('data/index.json 格式错误');
  const notes = raw.notes.map((note, index) => normalizeNote(root, note, index));
  const seen = new Set();
  for (const note of notes) {
    if (seen.has(note.id)) fail(`重复的笔记 ID：${note.id}`);
    seen.add(note.id);
  }
  return {
    version: 1,
    exportedAt: cleanText(raw.exportedAt, 80) || null,
    sourceRevision: Number.isInteger(Number(raw.sourceRevision)) ? Number(raw.sourceRevision) : 0,
    notes,
  };
}

function pdfName(value, fallback) {
  const name = cleanText(value, 120).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name || fallback.replace(/\.pdf$/i, '')}.pdf`;
}

export function normalizeConfig(raw) {
  const s = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {};
  const a = raw.ai && typeof raw.ai === 'object' ? raw.ai : {};
  const r = raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
  const o = raw.output && typeof raw.output === 'object' ? raw.output : {};
  return {
    schedule: {
      timeZone: cleanText(s.timeZone, 80) || 'Asia/Shanghai',
      dayOfWeek: Math.round(clampNumber(s.dayOfWeek, 0, 0, 6)),
      hour: Math.round(clampNumber(s.hour, 21, 0, 23)),
    },
    ai: {
      enabled: a.enabled !== false,
      providerId: cleanText(a.providerId, 40),
      modelId: cleanText(process.env.REVIEW_AI_MODEL || a.modelId, 160),
      baseUrl: cleanText(process.env.REVIEW_AI_BASE_URL || a.baseUrl, 500),
      temperature: clampNumber(a.temperature, 0.1, 0, 1),
      maxTokens: Math.round(clampNumber(a.maxTokens, 2600, 600, 12000)),
      timeoutMs: Math.round(clampNumber(a.timeoutMs, 90000, 5000, 300000)),
      includeImages: a.includeImages !== false,
      maxImageBytesPerNote: Math.round(clampNumber(a.maxImageBytesPerNote, 1572864, 100000, 4000000)),
      maxNotesPerBatch: Math.round(clampNumber(a.maxNotesPerBatch, 24, 4, 40)),
    },
    rules: {
      strictNoExpansion: r.strictNoExpansion !== false,
      mergeSameQuestion: r.mergeSameQuestion !== false,
      groupSimilarTopics: r.groupSimilarTopics !== false,
      maxGroupSize: Math.round(clampNumber(r.maxGroupSize, 8, 1, 20)),
      maxGroupTitleChars: Math.round(clampNumber(r.maxGroupTitleChars, 24, 8, 50)),
      includeOriginalImages: r.includeOriginalImages !== false,
      includeRemarks: r.includeRemarks !== false,
      includeWrongReasons: r.includeWrongReasons !== false,
    },
    output: {
      mistakesFile: pdfName(o.mistakesFile, '错题综合整理.pdf'),
      memoryFile: pdfName(o.memoryFile, '背诵综合整理.pdf'),
    },
  };
}

export function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

export function sourceDigest(data) {
  const notes = [...data.notes].sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'));
  return sha256(Buffer.from(JSON.stringify({ sourceRevision: data.sourceRevision, notes })));
}

export function primaryKnowledge(note = {}) {
  return note.knowledgePath?.find((item) => item && item !== note.subject)
    || note.items?.find((item) => item.knowledgePoint)?.knowledgePoint
    || note.questionType || '其他';
}

export function clipTitle(value, max) {
  const title = cleanText(value, max + 20) || '未命名专题';
  return title.length > max ? `${title.slice(0, Math.max(1, max - 1))}…` : title;
}

export function scheduledRunIsDue(config, manifest) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.schedule.timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = (date) => Object.fromEntries(formatter.formatToParts(date).map((item) => [item.type, item.value]));
  const now = parts(new Date());
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[now.weekday];
  if (weekday !== config.schedule.dayOfWeek || Number(now.hour) !== config.schedule.hour) return false;
  if (!manifest?.generatedAt) return true;
  const previous = parts(new Date(manifest.generatedAt));
  return `${now.year}-${now.month}-${now.day}` !== `${previous.year}-${previous.month}-${previous.day}`;
}
