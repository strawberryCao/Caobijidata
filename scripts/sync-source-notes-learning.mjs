import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = process.cwd();
const sourceRoot = path.join(repositoryRoot, 'source-notes');
const learningPath = path.join(repositoryRoot, 'data', 'cloud', 'learning-data.json');
const assetRoot = path.join(repositoryRoot, 'data', 'assets');
const imageExtensions = new Set(['.avif', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.webp']);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const uniqueStrings = (value) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
  : [];

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`无法解析 ${path.relative(repositoryRoot, filePath)}：${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function emptyManual() {
  return { completedTaskIds: [], note: '', debt: '', mistakes: '' };
}

function normalizeSnapshot(value) {
  const source = isObject(value) ? value : {};
  return {
    ...source,
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    revision: Number.isInteger(Number(source.revision)) ? Math.max(0, Number(source.revision)) : 0,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    days: isObject(source.days) ? source.days : {},
    cards: Array.isArray(source.cards) ? source.cards : [],
    deletedNotes: isObject(source.deletedNotes) ? source.deletedNotes : {},
  };
}

function validTimestamp(value, fallback) {
  const candidate = text(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : fallback;
}

function resolveDate(record, learning, createdAt) {
  const candidates = [learning.capturedDate, record.captureDate, record.capturedDate];
  const exact = candidates.find((value) => typeof value === 'string' && datePattern.test(value));
  return exact || createdAt.slice(0, 10);
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).slice(0, 24).map((item) => ({
    title: text(item.title),
    knowledgePoint: text(item.knowledgePoint),
    questionType: text(item.questionType),
    summary: text(item.summary),
    tags: uniqueStrings(item.tags),
    wrongReason: text(item.wrongReason),
    intent: {
      isQuestion: item.intent?.isQuestion === true,
      isMistake: item.intent?.isMistake === true,
      isGood: item.intent?.isGood === true,
      shouldMemorize: item.intent?.shouldMemorize === true,
    },
  }));
}

function stableCardId(noteUid, sourceKey, index) {
  const digest = crypto.createHash('sha256').update(`${noteUid}\0${sourceKey}\0${index}`).digest('hex').slice(0, 16);
  return `card-${noteUid}-${digest}`;
}

function buildCards(record, learning, note, timestamp) {
  if (!Array.isArray(learning.cards)) return [];
  return learning.cards.filter(isObject).slice(0, 24).flatMap((card, index) => {
    const front = text(card.front);
    const back = text(card.back);
    if (!front || !back) return [];
    const sourceKey = text(card.sourceKey, `source-notes:${index}`);
    const kind = card.kind === 'mistake' ? 'mistake' : 'memory';
    return [{
      id: text(card.id, stableCardId(note.noteUid, sourceKey, index)),
      noteUid: note.noteUid,
      sourceKey,
      kind,
      front,
      back,
      subject: note.subject,
      knowledgePath: note.knowledgePath,
      tags: note.tags,
      pageRefs: note.pageRefs,
      sourceTitle: note.title,
      sourceFilePath: note.filePath,
      status: ['draft', 'active', 'archived'].includes(card.status) ? card.status : 'active',
      dueDate: datePattern.test(card.dueDate) ? card.dueDate : note.capturedDate,
      reviewStep: 0,
      reviewCount: 0,
      lastReviewedAt: '',
      lastReviewResult: '',
      correctCount: 0,
      incorrectCount: 0,
      correctStreak: 0,
      masteredAt: '',
      reviewHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      userEdited: false,
    }];
  });
}

function filesEqual(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftStat = fs.statSync(left);
  const rightStat = fs.statSync(right);
  if (leftStat.size !== rightStat.size) return false;
  const hash = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  return hash(left) === hash(right);
}

const snapshot = normalizeSnapshot(readJson(learningPath, {
  version: 1,
  revision: 0,
  updatedAt: null,
  days: {},
  cards: [],
  deletedNotes: {},
}));

const existingNotes = new Map();
for (const [date, rawDay] of Object.entries(snapshot.days)) {
  if (!isObject(rawDay)) {
    snapshot.days[date] = { manual: emptyManual(), autoNotes: [] };
    continue;
  }
  if (!isObject(rawDay.manual)) rawDay.manual = emptyManual();
  if (!Array.isArray(rawDay.autoNotes)) rawDay.autoNotes = [];
  for (const note of rawDay.autoNotes) {
    if (isObject(note) && typeof note.noteUid === 'string' && note.noteUid) {
      existingNotes.set(note.noteUid, { date, note });
    }
  }
}

const existingCards = new Set(snapshot.cards.filter(isObject).map((card) => text(card.id)).filter(Boolean));
const deletedNotes = new Set(Object.keys(snapshot.deletedNotes));
const allSourceFiles = walkFiles(sourceRoot);
const imageByName = new Map();
for (const filePath of allSourceFiles) {
  if (filePath.split(path.sep).includes('.metadata')) continue;
  if (!imageExtensions.has(path.extname(filePath).toLowerCase())) continue;
  const name = path.basename(filePath);
  if (!imageByName.has(name)) imageByName.set(name, filePath);
}

let importedNotes = 0;
let importedCards = 0;
let copiedAssets = 0;
let skippedExisting = 0;
let skippedDeleted = 0;
let skippedInvalid = 0;

const metadataFiles = allSourceFiles.filter((filePath) => filePath.endsWith('.note.json'));
for (const metadataPath of metadataFiles) {
  const record = readJson(metadataPath, null);
  if (!isObject(record)) {
    skippedInvalid += 1;
    continue;
  }
  const learning = isObject(record.learning) ? record.learning : {};
  const noteUid = text(learning.noteUid, text(record.noteUid));
  if (!noteUid) {
    skippedInvalid += 1;
    continue;
  }
  if (deletedNotes.has(noteUid)) {
    skippedDeleted += 1;
    continue;
  }
  if (existingNotes.has(noteUid)) {
    skippedExisting += 1;
    continue;
  }

  const timestamp = new Date().toISOString();
  const createdAt = validTimestamp(record.createdAt, timestamp);
  const updatedAt = validTimestamp(record.updatedAt, createdAt);
  const capturedDate = resolveDate(record, learning, createdAt);
  const subject = text(learning.subject, text(record.subject, '默认文件夹'));
  const title = text(learning.title, text(record.title, '图片笔记'));
  const remark = typeof record.remark === 'string' ? record.remark : text(learning.remark);
  const sourceFileName = text(record.fileName, path.basename(text(record.filePath)));
  const subjectRoot = path.dirname(path.dirname(metadataPath));
  const directImage = sourceFileName ? path.join(subjectRoot, sourceFileName) : '';
  const sourceImage = directImage && fs.existsSync(directImage) ? directImage : imageByName.get(sourceFileName);
  let filePath = '';
  if (sourceImage && fs.existsSync(sourceImage)) {
    const extension = path.extname(sourceImage).toLowerCase();
    const destination = path.join(assetRoot, `${noteUid}${extension}`);
    fs.mkdirSync(assetRoot, { recursive: true });
    if (!filesEqual(sourceImage, destination)) {
      fs.copyFileSync(sourceImage, destination);
      copiedAssets += 1;
    }
    filePath = `github://data/assets/${noteUid}${extension}`;
  }

  const classificationSource = ['ai', 'local', 'manual'].includes(learning.classificationSource)
    ? learning.classificationSource
    : 'local';
  const organizationStatus = ['confirmed', 'ignored'].includes(learning.organizationStatus)
    ? learning.organizationStatus
    : 'pending';
  const reviewStatus = organizationStatus === 'ignored'
    ? 'ignored'
    : classificationSource === 'manual'
      ? 'corrected'
      : organizationStatus === 'confirmed' ? 'auto_applied' : 'pending';
  const tags = uniqueStrings(learning.tags);
  const knowledgePath = [subject, ...uniqueStrings(learning.knowledgePath).filter((item) => item !== subject)].slice(0, 3);
  const note = {
    noteUid,
    capturedDate,
    title,
    subject,
    remark,
    createdAt,
    updatedAt,
    firstSyncedAt: timestamp,
    filePath,
    pageRefs: Array.isArray(learning.pageRefs) ? learning.pageRefs : [],
    tags,
    knowledgePath,
    noteType: text(learning.noteType, 'note'),
    questionType: text(learning.questionType, text(record.questionType)),
    wrongReason: text(learning.wrongReason, text(record.wrongReason)),
    wrongReasonSource: text(learning.wrongReason) || text(record.wrongReason) ? classificationSource : '',
    wrongReasonConfidence: Number.isFinite(Number(learning.wrongReasonConfidence)) ? Number(learning.wrongReasonConfidence) : null,
    organizationStatus,
    classificationSource,
    reviewStatus,
    decisionRevision: ['corrected', 'ignored'].includes(reviewStatus) ? 1 : 0,
    lastReviewOperationId: '',
    lastReviewAction: '',
    proposalId: '',
    reviewedAt: '',
    manualCreated: false,
    userEditedFields: remark.trim() ? ['remark'] : [],
    goodQuestion: learning.intent?.isGood === true ? true : learning.intent?.isGood === false ? false : null,
    items: normalizeItems(learning.items ?? record.items),
    studyNotes: [],
    confidence: Number.isFinite(Number(learning.confidence)) ? Number(learning.confidence) : null,
    cardIds: [],
  };
  const cards = buildCards(record, learning, note, timestamp).filter((card) => !existingCards.has(card.id));
  note.cardIds = cards.map((card) => card.id);

  if (!isObject(snapshot.days[capturedDate])) snapshot.days[capturedDate] = { manual: emptyManual(), autoNotes: [] };
  if (!isObject(snapshot.days[capturedDate].manual)) snapshot.days[capturedDate].manual = emptyManual();
  if (!Array.isArray(snapshot.days[capturedDate].autoNotes)) snapshot.days[capturedDate].autoNotes = [];
  snapshot.days[capturedDate].autoNotes.push(note);
  existingNotes.set(noteUid, { date: capturedDate, note });
  importedNotes += 1;

  for (const card of cards) {
    snapshot.cards.push(card);
    existingCards.add(card.id);
    importedCards += 1;
  }
}

if (importedNotes > 0 || importedCards > 0 || copiedAssets > 0) {
  snapshot.revision += 1;
  snapshot.updatedAt = new Date().toISOString();
  writeJsonAtomic(learningPath, snapshot);
}

console.log(JSON.stringify({
  ok: true,
  metadataFiles: metadataFiles.length,
  importedNotes,
  importedCards,
  copiedAssets,
  skippedExisting,
  skippedDeleted,
  skippedInvalid,
  revision: snapshot.revision,
}, null, 2));
