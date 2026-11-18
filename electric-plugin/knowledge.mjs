import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeCsv, InputError, field, programFiles, sha256 } from './engineering.mjs';

export const categories = ['站点与流程', '程序与软元件', '排查线索'];
const parse = row => row && JSON.parse(row.doc);
const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export function baselineDigest(files) {
  return files.length ? sha256(JSON.stringify(files.map(({ path, digest }) => [path.toLowerCase(), digest])
    .sort(([a], [b]) => a.localeCompare(b, 'en')))) : null;
}

export function knowledgePrograms(project, candidate) {
  const replacement = new Map(candidate?.files?.map(file => [file.path, file.digest]));
  const programs = programFiles(project);
  if (programs.length) return programs.map(file => ({ path: file.path, digest: replacement.get(file.path) || file.digest }));
  return project?.digest ? [{ path: project.fileName, digest: candidate?.digest || project.digest }] : [];
}

export const gxStep = row => row?.match(/^(?:"(\d+)"|(\d+))\t/)?.slice(1).find(Boolean) ?? null;

export function programPositions(locations, programs, readFile, requireSource = false) {
  const files = new Map(programs.map(file => [file.path, file.digest]));
  const cache = new Map();
  const seen = new Set();
  return (Array.isArray(locations) ? locations : []).slice(0, 12).flatMap(item => {
    const digest = files.get(item?.file);
    if (!digest || !Number.isSafeInteger(item.line) || item.line < 1) return [];
    if (!cache.has(digest)) cache.set(digest, decodeCsv(readFile(digest)).value.split(/\r\n|\n|\r/));
    const row = cache.get(digest)[item.line - 1];
    const key = `${item.file}:${item.line}`;
    if (!row?.trim() || seen.has(key) || requireSource && item.sourceLine !== row) return [];
    seen.add(key);
    return [{ file: item.file, line: item.line, step: gxStep(row), excerpt: row.slice(0, 300),
      ...(typeof item.meaning === 'string' ? { meaning: item.meaning.trim().slice(0, 400) } : {}) }];
  });
}

function searchText(entry) {
  return normalize([entry.title, entry.category, ...entry.keywords, entry.meaning, entry.applicability,
    ...entry.positions.map(position => position.file)].join(' '));
}

function rank(entry, query) {
  const text = normalize(query);
  const terms = [entry.title, ...entry.keywords, ...entry.positions.map(position => position.file.replace(/\.csv$/i, ''))];
  return [...new Set(terms.map(normalize))].reduce((score, term) =>
    term.length >= 2 && text.includes(term) ? score + (/^[a-z]+\d/i.test(term) ? 5 : 2) : score, 0);
}

export function retrieveKnowledge(pins, loadVersion, project) {
  const query = project.requirements || project.folder?.documents?.map(doc => doc.text).filter(Boolean).join('\n') || '';
  const digest = baselineDigest(knowledgePrograms(project));
  const devices = [];
  const ranked = [];
  let unavailable = false;
  for (const pin of pins) {
    const version = pin.version ? loadVersion(pin.deviceId, pin.version) : null;
    devices.push({ ...pin, available: Boolean(version) });
    if (!version) { unavailable ||= Boolean(pin.version); continue; }
    for (const entry of version.entries) {
      const score = rank(entry, query);
      if (!score) continue;
      const match = pin.reference ? 'reference' : digest && digest === entry.baseline ? 'exact' : 'relocate';
      ranked.push({ score, hit: { ...pin, id: entry.id, title: entry.title, meaning: entry.meaning,
        applicability: entry.applicability, status: entry.status, match, positions: entry.positions,
        sources: entry.sources, keywords: entry.keywords } });
    }
  }
  ranked.sort((a, b) => Number(a.hit.reference) - Number(b.hit.reference) || b.score - a.score);
  return { status: ranked.length ? 'matched' : unavailable ? 'unavailable' : 'empty', devices,
    hits: ranked.slice(0, 8).map(({ hit }) => hit) };
}

export function openKnowledge(home) {
  const directory = join(home, 'electric');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'knowledge.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
    CREATE TABLE IF NOT EXISTS project_devices (project_id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id));
    CREATE TABLE IF NOT EXISTS knowledge_versions (device_id TEXT REFERENCES devices(id), version INTEGER NOT NULL,
      doc TEXT NOT NULL, PRIMARY KEY(device_id,version));
    CREATE TABLE IF NOT EXISTS knowledge_drafts (run_id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id), state TEXT NOT NULL,
      doc TEXT NOT NULL);`);

  const device = id => db.prepare('SELECT id,name FROM devices WHERE id=?').get(id);
  const version = (id, rev) => parse(rev === undefined
    ? db.prepare('SELECT doc FROM knowledge_versions WHERE device_id=? ORDER BY version DESC LIMIT 1').get(id)
    : db.prepare('SELECT doc FROM knowledge_versions WHERE device_id=? AND version=?').get(id, rev));
  const projectDevice = id => db.prepare('SELECT device_id FROM project_devices WHERE project_id=?').get(id)?.device_id || null;
  const draft = id => {
    const row = db.prepare('SELECT * FROM knowledge_drafts WHERE run_id=?').get(id);
    return row && { ...parse(row), runId: row.run_id, deviceId: row.device_id, state: row.state };
  };
  function writeDraft(item, state, changes = {}) {
    const { runId, deviceId, state: previous, ...doc } = item;
    db.prepare('UPDATE knowledge_drafts SET state=?,doc=? WHERE run_id=? AND state=?')
      .run(state, JSON.stringify({ ...doc, ...changes, updatedAt: Date.now() }), runId, previous);
    return draft(runId);
  }
  function publish(id, rev, entries) {
    const result = { version: rev, publishedAt: Date.now(), entries };
    db.prepare('INSERT INTO knowledge_versions VALUES (?,?,?)').run(id, rev, JSON.stringify(result));
    return result;
  }

  return {
    close: () => db.close(), device, version, projectDevice, draft,
    devices: () => db.prepare('SELECT id,name FROM devices ORDER BY name').all().map(item =>
      ({ ...item, version: version(item.id)?.version || null })),
    createDevice(value) {
      const name = field(value, '设备名称', 80);
      const id = randomUUID();
      if (db.prepare('SELECT id FROM devices WHERE name=?').get(name)) throw new InputError('设备名称已存在。', 409);
      db.prepare('INSERT INTO devices VALUES (?,?)').run(id, name);
      return device(id);
    },
    bindProject(projectId, deviceId) {
      if (deviceId !== null && !device(deviceId)) throw new InputError('请选择已登记的设备。');
      db.prepare('INSERT INTO project_devices VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET device_id=excluded.device_id')
        .run(projectId, deviceId);
    },
    seed(id, name, entries, projectId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO devices VALUES (?,?)').run(id, name);
        if (!device(id)) throw new InputError('设备名称已由其他记录使用。', 409);
        if (!version(id)) publish(id, 1, entries);
        db.prepare('INSERT OR IGNORE INTO project_devices VALUES (?,?)').run(projectId, id);
        db.exec('COMMIT');
        return version(id);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    pins(deviceId, referenceId) {
      const pins = [];
      for (const id of new Set([deviceId, referenceId].filter(Boolean))) {
        const selected = device(id);
        if (!selected) throw new InputError('选择的知识库设备不存在。');
        pins.push({ deviceId: id, name: selected.name, version: version(id)?.version || null, reference: id !== deviceId });
      }
      return pins;
    },
    search(deviceId, query) {
      const latest = version(deviceId);
      const terms = query.trim().split(/\s+/).filter(Boolean).map(normalize);
      const combined = normalize(query);
      return { version: latest?.version || null, entries: (latest?.entries || []).filter(entry => {
        const text = searchText(entry);
        return text.includes(combined) || terms.every(term => text.includes(term));
      }) };
    },
    drafts(id) {
      const rows = id ? db.prepare('SELECT run_id FROM knowledge_drafts WHERE device_id=? ORDER BY rowid DESC').all(id) :
        db.prepare('SELECT run_id FROM knowledge_drafts ORDER BY rowid DESC').all();
      return rows.map(row => draft(row.run_id));
    },
    enqueue(runId, deviceId, testRun = false) {
      db.prepare('INSERT OR IGNORE INTO knowledge_drafts VALUES (?,?,?,?)')
        .run(runId, deviceId, 'queued', JSON.stringify({ updatedAt: Date.now(), ...(testRun ? { testRun } : {}) }));
    },
    claim() {
      const row = db.prepare("UPDATE knowledge_drafts SET state='generating' WHERE run_id=(SELECT run_id FROM knowledge_drafts WHERE state='queued' ORDER BY rowid LIMIT 1) RETURNING run_id").get();
      return row && draft(row.run_id);
    },
    recover() {
      db.prepare("UPDATE knowledge_drafts SET state='queued' WHERE state='generating'").run();
    },
    hasQueued: () => Boolean(db.prepare("SELECT 1 FROM knowledge_drafts WHERE state='queued' LIMIT 1").get()),
    finish(runId, doc) {
      const item = draft(runId);
      if (item?.state === 'generating') writeDraft(item, doc.error ? 'failed' : doc.entries.length ? 'review' : 'empty', doc);
    },
    retry(runId) {
      const item = draft(runId);
      if (item?.state !== 'failed') throw new InputError('当前草稿无需重试。', 409);
      return writeDraft(item, 'queued', { error: null });
    },
    review(runId, body) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const item = draft(runId);
        if (item?.state !== 'review') throw new InputError('草稿已处理，请刷新。', 409);
        if (body.op === 'reject') writeDraft(item, 'rejected');
        else {
          if (item.testRun) throw new InputError('测试草稿可查看和驳回。发布需要正式工程运行。', 409);
          const latest = version(item.deviceId);
          if (body.expected !== (latest?.version || 0)) throw new InputError('设备知识已更新，请对照最新条目重新审核。', 409);
          if (!Array.isArray(body.entries) || !body.entries.length || new Set(body.entries.map(entry => entry.id)).size !== body.entries.length) {
            throw new InputError('请选择至少一条不同的知识。');
          }
          const entries = new Map((latest?.entries || []).map(entry => [entry.id, entry]));
          const accepted = body.entries.map(edit => {
            const original = item.entries.find(entry => entry.id === edit.id);
            if (!original) throw new InputError('草稿条目不存在。');
            const { replaces, ...entry } = original;
            const id = replaces && entries.has(replaces) ? replaces : entry.id;
            return { ...entry, id, status: 'reviewed', title: field(edit.title, '标题', 120),
              meaning: field(edit.meaning, '程序含义', 1000), applicability: field(edit.applicability, '适用条件', 500) };
          });
          if (new Set(accepted.map(entry => entry.id)).size !== accepted.length) throw new InputError('一条旧知识只能选择一项修订。');
          for (const entry of accepted) entries.set(entry.id, entry);
          const output = publish(item.deviceId, (latest?.version || 0) + 1, [...entries.values()]);
          writeDraft(item, 'published', { publishedVersion: output.version });
        }
        db.exec('COMMIT');
        return draft(runId);
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
