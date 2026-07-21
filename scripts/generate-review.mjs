import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeConfig, readJson, scheduledRunIsDue, sha256, sourceDigest, validateData,
} from './lib/common.mjs';
import { organizeNotes } from './lib/grouping.mjs';
import { buildHtml, renderPdf } from './lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'index.json');
const CONFIG = path.join(ROOT, 'config', 'review-config.json');
const GENERATED = path.join(ROOT, 'generated');
const MANIFEST = path.join(GENERATED, 'manifest.json');
const flags = new Set(process.argv.slice(2));
const validateOnly = flags.has('--validate-only');
const dryRun = flags.has('--dry-run');
const scheduled = flags.has('--scheduled');

function fileRecord(filePath) {
  const content = fs.readFileSync(filePath);
  return { path: path.relative(ROOT, filePath).replace(/\\/g, '/'), bytes: content.length, sha256: sha256(content) };
}

async function main() {
  const data = validateData(ROOT, readJson(DATA, 'data/index.json'));
  const config = normalizeConfig(readJson(CONFIG, 'config/review-config.json'));
  const manifest = fs.existsSync(MANIFEST) ? readJson(MANIFEST, 'generated/manifest.json') : null;
  console.log(`Validated ${data.notes.length} confirmed notes; source revision ${data.sourceRevision}.`);
  if (validateOnly) return;
  if (scheduled && !scheduledRunIsDue(config, manifest)) {
    console.log('Scheduled run is not due in the configured time zone.');
    return;
  }
  const generatedAt = new Date().toISOString();
  const mistakes = data.notes.filter((note) => note.kind === 'mistake');
  const memory = data.notes.filter((note) => note.kind === 'memory');
  const mistakeResult = await organizeNotes(ROOT, mistakes, 'mistake', config);
  const memoryResult = await organizeNotes(ROOT, memory, 'memory', config);
  const mistakePath = path.join(GENERATED, config.output.mistakesFile);
  const memoryPath = path.join(GENERATED, config.output.memoryFile);
  await renderPdf(buildHtml(ROOT, 'mistake', mistakes, mistakeResult.groups, config, generatedAt), mistakePath, dryRun);
  await renderPdf(buildHtml(ROOT, 'memory', memory, memoryResult.groups, config, generatedAt), memoryPath, dryRun);
  if (dryRun) return console.log('Dry run complete; PDFs validated but not retained.');
  const aiUsed = mistakeResult.aiUsed || memoryResult.aiUsed;
  const reasons = [mistakeResult.fallbackReason, memoryResult.fallbackReason].filter(Boolean);
  const next = {
    version: 1, generatedAt, sourceRevision: data.sourceRevision, sourceDigest: sourceDigest(data),
    noteCounts: { mistakes: mistakes.length, memory: memory.length },
    groupCounts: { mistakes: mistakeResult.groups.length, memory: memoryResult.groups.length },
    ai: { used: aiUsed, providerId: aiUsed ? config.ai.providerId || null : null, modelId: aiUsed ? config.ai.modelId || null : null, fallbackReason: reasons.length ? reasons.join('；').slice(0, 1000) : null },
    files: { mistakes: fileRecord(mistakePath), memory: fileRecord(memoryPath) },
  };
  fs.mkdirSync(GENERATED, { recursive: true });
  const temp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, MANIFEST);
  console.log(`Generated ${config.output.mistakesFile} and ${config.output.memoryFile}.`);
  if (!aiUsed && reasons.length) console.log(`AI fallback: ${reasons.join(' | ')}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
