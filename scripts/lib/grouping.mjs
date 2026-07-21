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

export function deterministicGroups(notes, config) {
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
  return sortGroups(groups, notes);
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
    if (groupType === 'same_question' && !config.rules.mergeSameQuestion) fail('AI 违反同题合并设置');
    if (groupType === 'same_topic' && !config.rules.groupSimilarTopics) fail('AI 违反专题分组设置');
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
  const system = [
    '你是学习资料编排器，不是教师。只能分组和排序，禁止补充知识、答案、解法、例题、口诀、评价或总结。',
    '只返回 JSON：{"groups":[{"title":"短标题","groupType":"same_question|same_topic|standalone","sourceIds":["ID"]}]}。',
    '每个来源 ID 必须恰好出现一次。高度确定是同一道题的不同阶段才用 same_question；不同题只能用 same_topic；不确定就 standalone。',
    '标题必须来自来源中已有表述，保持简短。', `本批是${kind === 'mistake' ? '错题' : '背诵'}。`,
  ].join('\n');
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
      body: JSON.stringify({
        model: config.ai.modelId, temperature: config.ai.temperature, max_tokens: config.ai.maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
      }),
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
  if (!config.ai.enabled) return { groups: fallback, aiUsed: false, fallbackReason: 'AI 整理已关闭' };
  try {
    const groups = [];
    for (const batch of batches(notes, config.ai.maxNotesPerBatch)) groups.push(...await callAi(root, batch, kind, config));
    return { groups: sortGroups(groups, notes), aiUsed: true, fallbackReason: null };
  } catch (error) {
    return { groups: fallback, aiUsed: false, fallbackReason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
  }
}
