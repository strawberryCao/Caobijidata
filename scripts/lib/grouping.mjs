import fs from 'node:fs';
import path from 'node:path';
import {
  MIME_BY_EXT, cleanText, clipTitle, fail, primaryKnowledge, resolveRepoPath,
} from './common.mjs';

function normalizeKey(value) {
  return cleanText(value, 500).toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '').replace(/第?\d+[题问]/g, '').slice(0, 160);
}

function sortGroups(groups, notes) {
  const map = new Map(notes.map((note) => [note.id, note]));
  return groups.sort((a, b) => {
    const an = map.get(a.sourceIds[0]);
    const bn = map.get(b.sourceIds[0]);
    return `${an?.subject}\0${primaryKnowledge(an)}\0${a.title}`
      .localeCompare(`${bn?.subject}\0${primaryKnowledge(bn)}\0${b.title}`, 'zh-CN');
  });
}

const CURATED_GROUPS = Object.freeze({
  mistake: Object.freeze([
    ['导数定义式与切线', 'same_question', ['288098dd-1ba1-4b28-bdb2-5267bcc56e33', 'ed252eff-c038-402c-9877-c5d08e23120d']],
    ['奇函数导数极限', 'same_question', ['bd1c244c-5913-4b04-b6e1-9e2ca8a3656a', 'c337824f-79b5-48ef-9cf0-8fb4bb1eca8a']],
    ['复合函数与反函数求导', 'same_topic', ['09e738f4-d40a-4114-90b5-fc1f28156824', '09fb2d77-9d90-4094-9085-b5a9141459eb']],
    ['隐函数二阶导数', 'same_topic', ['e9f702d6-3989-4c3f-8250-a5e8c987e19d', 'fa9d76b9-c793-402c-9064-985db3189dbf']],
    ['极值、拐点与单调性', 'same_topic', ['5780ccbf-7260-49ea-b32f-95b190b63210', '8fe9fee6-244d-4ac6-9452-78e730dee9bf', 'bc3c59cf-d535-4dc0-a721-7bdf7d5befcb']],
    ['高阶导数与泰勒展开', 'standalone', ['d4203e69-a9aa-4da7-97b0-5ec46284239b']],
    ['数列与函数族', 'same_topic', ['01bf5c17-55ab-4072-bd2c-c3f92ce71625', 'legacy-54c396f918148f297a79bc14']],
  ]),
  memory: Object.freeze([
    ['基础求导公式', 'standalone', ['a69dfb00-def6-415e-a9c3-d4a63e78d6d6']],
    ['高阶导数公式组', 'same_topic', ['117e0611-bd52-403b-a9fd-104af40182c5', '21507d85-ce1d-4767-a108-e95f5cb0bcf9', '700a954b-072d-40b9-8fe8-d825ef452f5f', 'e871cb56-4b83-4d23-a926-ba38c6dbc7bf']],
    ['反函数二阶导数公式', 'standalone', ['626d6e0a-b61b-4291-b647-0ac72033e4ec']],
    ['常用泰勒展开', 'standalone', ['a230954a-f9c6-493f-a043-783b4637d89d']],
    ['凹凸、极值与拐点', 'same_topic', ['74c12731-5d76-461e-832c-871014e34397', '79781536-d390-43f4-890e-fcfe7a4732a9']],
  ]),
});

function curatedGroups(notes) {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const kind = notes[0]?.kind;
  const definitions = CURATED_GROUPS[kind] || [];
  const used = new Set();
  const groups = [];
  for (const [title, groupType, ids] of definitions) {
    const sourceIds = ids.filter((id) => byId.has(id));
    if (!sourceIds.length) continue;
    sourceIds.forEach((id) => used.add(id));
    groups.push({ title, groupType: sourceIds.length === 1 ? 'standalone' : groupType, sourceIds });
  }
  return { groups, remaining: notes.filter((note) => !used.has(note.id)) };
}

function automaticGroups(notes, config) {
  const exact = new Map();
  const singles = [];
  for (const note of notes) {
    const titleKey = normalizeKey(note.title);
    const imageKey = /^[a-f0-9]{64}$/.test(note.imageSha256) ? note.imageSha256 : '';
    const key = imageKey ? `image:${imageKey}` : titleKey.length >= 8 ? `title:${titleKey}` : '';
    if (!key) singles.push(note);
    else exact.set(key, [...(exact.get(key) || []), note]);
  }
  const groups = [];
  for (const bucket of exact.values()) {
    if (bucket.length > 1 && config.rules.mergeSameQuestion) {
      groups.push({ title: clipTitle(bucket[0].title, config.rules.maxGroupTitleChars), groupType: 'same_question', sourceIds: bucket.map((n) => n.id) });
    } else singles.push(...bucket);
  }
  const topics = new Map();
  for (const note of singles) {
    const key = `${note.subject}\0${primaryKnowledge(note)}`;
    topics.set(key, [...(topics.get(key) || []), note]);
  }
  for (const bucket of topics.values()) {
    if (config.rules.groupSimilarTopics && bucket.length > 1) {
      for (let i = 0; i < bucket.length; i += config.rules.maxGroupSize) {
        const part = bucket.slice(i, i + config.rules.maxGroupSize);
        groups.push({ title: clipTitle(primaryKnowledge(part[0]), config.rules.maxGroupTitleChars), groupType: 'same_topic', sourceIds: part.map((n) => n.id) });
      }
    } else {
      for (const note of bucket) groups.push({ title: clipTitle(note.title, config.rules.maxGroupTitleChars), groupType: 'standalone', sourceIds: [note.id] });
    }
  }
  return groups;
}

export function deterministicGroups(notes, config) {
  const curated = curatedGroups(notes);
  return sortGroups([...curated.groups, ...automaticGroups(curated.remaining, config)], notes);
}

function batches(notes, size) {
  const buckets = new Map();
  for (const note of notes) {
    const key = `${note.subject}\0${primaryKnowledge(note)}`;
    buckets.set(key, [...(buckets.get(key) || []), note]);
  }
  return [...buckets.values()].flatMap((bucket) => {
    const result = [];
    for (let i = 0; i < bucket.length; i += size) result.push(bucket.slice(i, i + size));
    return result;
  });
}

function imageDataUrl(root, note, config) {
  if (!config.ai.includeImages || !note.imagePath) return null;
  const full = resolveRepoPath(root, note.imagePath);
  if (!full || fs.statSync(full).size > config.ai.maxImageBytesPerNote) return null;
  const mime = MIME_BY_EXT.get(path.extname(full).toLowerCase());
  return mime ? `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` : null;
}

function endpoint(value) {
  const base = cleanText(value, 500).replace(/\/+$/g, '');
  return !base ? '' : /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function parseObject(text) {
  const value = cleanText(text, 100000);
  const candidate = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || value;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) fail('AI 没有返回 JSON 对象');
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateGroups(payload, notes, config) {
  if (!payload || !Array.isArray(payload.groups)) fail('AI 返回缺少 groups');
  const expected = new Set(notes.map((n) => n.id));
  const seen = new Set();
  const groups = payload.groups.map((raw) => {
    if (!raw || !Array.isArray(raw.sourceIds)) fail('AI 分组格式错误');
    const sourceIds = [...new Set(raw.sourceIds.map((id) => cleanText(id, 160)).filter(Boolean))];
    if (!sourceIds.length || sourceIds.length > config.rules.maxGroupSize) fail('AI 分组大小越界');
    for (const id of sourceIds) {
      if (!expected.has(id) || seen.has(id)) fail(`AI 来源 ID 非法或重复：${id}`);
      seen.add(id);
    }
    const groupType = ['same_question', 'same_topic', 'standalone'].includes(raw.groupType)
      ? raw.groupType : sourceIds.length === 1 ? 'standalone' : 'same_topic';
    return { title: clipTitle(raw.title, config.rules.maxGroupTitleChars), groupType, sourceIds };
  });
  if (seen.size !== expected.size || [...expected].some((id) => !seen.has(id))) fail('AI 没有恰好覆盖全部来源');
  return sortGroups(groups, notes);
}

async function callAi(root, notes, kind, config) {
  const apiKey = cleanText(process.env.REVIEW_AI_API_KEY, 2000);
  const url = endpoint(config.ai.baseUrl);
  if (!apiKey || !url || !config.ai.modelId) fail('AI 密钥、地址或模型未完整配置');
  const sources = notes.map((n) => ({
    id: n.id, title: n.title, subject: n.subject, knowledgePath: n.knowledgePath,
    tags: n.tags, questionType: n.questionType, remark: n.remark.slice(0, 1000),
    wrongReason: n.wrongReason.slice(0, 500), capturedDate: n.capturedDate,
    imageSha256: n.imageSha256 || null,
  }));
  const system = '只允许分组和排序，禁止补充正文。只返回包含 groups 的 JSON。';
  const content = [{ type: 'text', text: JSON.stringify(sources) }];
  for (const note of notes) {
    const image = imageDataUrl(root, note, config);
    if (image) content.push({ type: 'text', text: `来源图片：${note.id}` }, { type: 'image_url', image_url: { url: image, detail: 'low' } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.ai.modelId, temperature: config.ai.temperature, max_tokens: config.ai.maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
    });
  } finally { clearTimeout(timer); }
  const text = await response.text();
  if (!response.ok) fail(`AI 请求失败 HTTP ${response.status}：${text.slice(0, 400)}`);
  const payload = JSON.parse(text);
  const message = payload?.choices?.[0]?.message?.content;
  const answer = Array.isArray(message) ? message.map((x) => x?.text || x?.content || '').join('\n') : message;
  return validateGroups(parseObject(answer), notes, config);
}

export async function organizeNotes(root, notes, kind, config) {
  const fallback = deterministicGroups(notes, config);
  if (!notes.length) return { groups: [], aiUsed: false, fallbackReason: '没有可整理内容' };
  if (!config.ai.enabled) return { groups: fallback, aiUsed: false, fallbackReason: '由 ChatGPT 自动化整理，仓库内 AI 已关闭' };
  try {
    const groups = [];
    for (const batch of batches(notes, config.ai.maxNotesPerBatch)) groups.push(...await callAi(root, batch, kind, config));
    return { groups: sortGroups(groups, notes), aiUsed: true, fallbackReason: null };
  } catch (error) {
    return { groups: fallback, aiUsed: false, fallbackReason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
