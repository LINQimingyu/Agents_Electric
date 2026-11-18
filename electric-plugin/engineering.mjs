import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
const MAX_BASELINE = 96000;
const MAX_PROGRAM = 5000000;
const MAX_PROGRAM_SET = 32000000;
const MAX_EVIDENCE = 250000;
const MAX_FOLDER_ENTRIES = 300;
const MAX_FOLDER_BYTES = 4000000;
const MAX_FOLDER_TEXT = 32000;

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function field(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new InputError(`${label}须在 1–${limit} 字以内。`);
  }
  return value.trim();
}

function bytes(value, cap) {
  if (typeof value !== 'string' || value.length > Math.ceil(cap / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new InputError('文件为空、格式无效或超出大小限制。');
  }
  const result = Buffer.from(value, 'base64');
  if (!result.length || result.length > cap) throw new InputError('文件为空或超出大小限制。');
  return result;
}

export function decodeCsv(data) {
  const bom = data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 :
    data.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 2 : 0;
  const encoding = bom === 2 ? 'utf16le' : 'utf8';
  let value;
  try { value = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8', { fatal: true }).decode(data.subarray(bom)); }
  catch { throw new InputError('请使用 UTF-8 或带 BOM 的 UTF-16LE CSV。'); }
  if (!value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new InputError('CSV 内容为空或含二进制控制符。');
  return { value, encoding, bom: data.subarray(0, bom) };
}

function folderPath(value) {
  const path = field(value, '资料相对路径', 480);
  if (path.split('/').some(part => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
    /[\x00-\x1f\\:<>|?*"]/.test(path)) {
    throw new InputError('资料相对路径无效。');
  }
  return path;
}

function documentText(path, data) {
  if (!/\.docx$/i.test(path)) return decodeCsv(data).value;
  const xml = unzipSync(data, { filter: entry => entry.name === 'word/document.xml' && entry.originalSize <= 512000 })['word/document.xml'];
  if (!xml) throw new Error('缺少可读取的 Word 正文。');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const content = new TextDecoder('utf-8', { fatal: true }).decode(xml);
  const paragraphs = content.split(/<\/w:p\s*>/);
  return paragraphs.map(paragraph => [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map(match => match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => entities[key])).join('')).filter(Boolean).join('\n');
}

function importFolder(source, saveFile) {
  if (!Array.isArray(source?.files) || !source.files.length || source.files.length > MAX_FOLDER_ENTRIES) {
    throw new InputError(`请选择包含 1–${MAX_FOLDER_ENTRIES} 个可见文件的资料文件夹。`);
  }
  const name = folderPath(source.name);
  if (name.includes('/')) throw new InputError('资料文件夹名称无效。');
  let received = 0, programBytes = 0, remaining = MAX_FOLDER_TEXT;
  const seen = new Set();
  const aliases = new Set();
  const files = [];
  const documents = [];
  for (const item of source.files) {
    const path = folderPath(item?.path);
    if (aliases.has(path.toLowerCase()) || !Number.isSafeInteger(item.size) || item.size < 0) throw new InputError('资料清单含重复或无效文件。');
    seen.add(path);
    aliases.add(path.toLowerCase());
    const entry = { path, size: item.size, state: 'listed' };
    if (item.data !== undefined && /\.csv$/i.test(path)) {
      const data = bytes(item.data, MAX_PROGRAM);
      programBytes += data.length;
      if (programBytes > MAX_PROGRAM_SET || data.length !== item.size) throw new InputError('程序段大小与清单不符，或整组 CSV 超过 32 MB。');
      try {
        const { value, encoding } = decodeCsv(data);
        const lines = value.trimEnd().split(/\r\n|\n|\r/).length;
        Object.assign(entry, { digest: saveFile(data), encoding, lines, state: 'read' });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        entry.state = 'unreadable';
      }
    } else if (item.data !== undefined) {
      const limit = /\.docx$/i.test(path) ? 1000000 : 64000;
      if (!/\.(txt|md|docx)$/i.test(path)) throw new InputError('无法上传此格式的需求文档。');
      const data = bytes(item.data, limit);
      received += data.length;
      if (received > MAX_FOLDER_BYTES || data.length !== item.size) throw new InputError('资料文件大小与清单不符，或文档总量超过 4 MB。');
      let extracted = '';
      try { extracted = documentText(path, data).trim(); } catch { /* The manifest retains the unreadable file. */ }
      if (!extracted) entry.state = 'unreadable';
      else {
        const text = extracted.slice(0, remaining);
        entry.state = text.length < extracted.length ? 'truncated' : 'read';
        if (text) documents.push({ path, text });
        remaining -= text.length;
      }
    }
    files.push(entry);
  }
  const baseline = source.baseline ? folderPath(source.baseline) : null;
  if (baseline && (!/\.csv$/i.test(baseline) || !seen.has(baseline))) throw new InputError('请从所选文件夹中选择原始程序 CSV。');
  return { name, files, documents, baseline };
}

function columns(line, delimiter) {
  let quoted = false;
  let count = 1;
  let atStart = true;
  let closed = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character !== '"') continue;
      if (line[index + 1] === '"') { index++; continue; }
      quoted = false;
      closed = true;
    } else if (character === delimiter) {
      count++;
      atStart = true;
      closed = false;
    } else {
      if (closed || (character === '"' && !atStart)) return null;
      if (character === '"') quoted = true;
      atStart = false;
    }
  }
  return quoted ? null : count;
}

function dataPrefix(line, delimiter) {
  let quoted = false;
  let last = -1;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (!quoted && line[index] === delimiter) last = index;
  }
  return last < 0 ? '' : line.slice(0, last + 1);
}

export function applyEdits(original, edits, testRun = false) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 60) throw new InputError('候选须包含 1–60 条逐行替换。');
  const { value, encoding, bom } = decodeCsv(original);
  const parts = value.split(/(\r\n|\n|\r)/);
  const commentHeader = testRun && parts.slice(0, 61).findIndex((row, index) =>
    index % 2 === 0 && /(?:\t|,)\s*"?(?:注解|注释|comment|annotation)"?\s*$/i.test(row));
  if (testRun && commentHeader < 0) throw new InputError('测试候选需要可识别的 CSV 注释列。');
  const commentDelimiter = testRun && (columns(parts[commentHeader], '\t') > 1 ? '\t' : ',');
  const seen = new Set();
  const diff = [];
  for (const edit of edits) {
    const index = (edit?.line - 1) * 2;
    if (!Number.isInteger(edit?.line) || index < 0 || index >= parts.length || seen.has(index) ||
        typeof edit.before !== 'string' || !edit.before.length || parts[index] !== edit.before) {
      throw new InputError('候选行号重复、超界或原文与基线不一致。');
    }
    if (typeof edit.after !== 'string' || !edit.after.length || edit.after === edit.before || /[\x00-\x08\x0a-\x1f]/.test(edit.after)) {
      throw new InputError(`第 ${edit.line} 行必须替换为一行有效的 CSV。`);
    }
    const sameShape = ['\t', ','].some(delimiter => {
      const before = columns(edit.before, delimiter);
      return before > 1 && before === columns(edit.after, delimiter);
    });
    if (!sameShape) throw new InputError(`第 ${edit.line} 行的 CSV 列数或引号结构与原文不同。`);
    if (testRun) {
      if (index <= commentHeader || columns(edit.before, commentDelimiter) !== columns(parts[commentHeader], commentDelimiter) ||
          columns(edit.after, commentDelimiter) !== columns(edit.before, commentDelimiter) ||
          dataPrefix(edit.before, commentDelimiter) !== dataPrefix(edit.after, commentDelimiter)) {
        throw new InputError(`测试候选只可修改末列注释（第 ${edit.line} 行）。`);
      }
    }
    seen.add(index);
    parts[index] = edit.after;
    diff.push({ line: edit.line, before: edit.before, after: edit.after });
  }
  const data = Buffer.concat([bom, Buffer.from(parts.join(''), encoding)]);
  if (data.length > MAX_PROGRAM * 2) throw new InputError('候选 CSV 超出大小限制。');
  return { data, diff: diff.sort((a, b) => a.line - b.line) };
}

const SAMPLE_CSV = 'Step,Instruction,Operand,Comment\r\n0,LD,X0,Start request\r\n1,AND,X2,Door interlock\r\n2,OUT,Y0,Demo status lamp\r\n3,END,,\r\n';
export const sample = {
  name: '演示 · 工位状态灯', cpu: 'MELSEC-Q · Q03UDVCPU（示例）', toolchain: 'GX Works2（离线）',
  requirements: '把第 4 物理行演示状态灯输出从 Y0 改为 Y1。保留启动输入 X0 和联锁 X2，其他指令不变。验收用例：启动且联锁满足时 Y1 点亮，联锁断开时 Y1 熄灭。回退恢复到原 CSV。',
  fileName: 'q-demo-baseline.csv', fileData: Buffer.from(SAMPLE_CSV).toString('base64'), sample: true,
};

export function programFiles(project) {
  return (project?.folder?.files || []).filter(file => file.digest && /\.csv$/i.test(file.path));
}

export function intakeDataGaps(project) {
  const programs = programFiles(project);
  const gaps = [];
  if (!project.requirements && !project.folder?.documents?.length) gaps.push('请提供变更需求或可读取的需求文档。');
  if (!project.digest && !programs.length) gaps.push('请从工程工具导出原始程序 CSV 并补充到本次核对。');
  const unreadable = (project.folder?.files || []).filter(file => /\.csv$/i.test(file.path) &&
    (file.state === 'unreadable' || programs.length && !file.digest));
  if (unreadable.length) gaps.push(`以下程序段无法读取，请检查编码后重新选取资料文件夹：${unreadable.map(file => file.path).join('、')}`);
  return gaps;
}

function writeImmutable(path, data, digest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data, { flag: 'wx', flush: true });
  try { linkSync(temporary, path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha256(readFileSync(path)) !== digest) throw new Error('已有文件与登记摘要不一致。');
  } finally { unlinkSync(temporary); }
}

function one(db, query, ...params) {
  return db.prepare(query).get(...params);
}

export function openEngineering(home) {
  const root = join(home, 'electric');
  const files = join(root, 'files');
  mkdirSync(files, { recursive: true });
  const db = new DatabaseSync(join(root, 'engineering.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      session_id TEXT NOT NULL, engine_id TEXT UNIQUE, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gates (engine_id TEXT NOT NULL, node TEXT NOT NULL, invocation TEXT NOT NULL,
      doc TEXT NOT NULL, decision TEXT, PRIMARY KEY(engine_id,node));
    CREATE TABLE IF NOT EXISTS clarifications (run_id TEXT NOT NULL REFERENCES runs(id), ticket TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidate (engine_id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, engine_id TEXT NOT NULL, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS milestones (engine_id TEXT NOT NULL, kind TEXT NOT NULL,
      doc TEXT NOT NULL, PRIMARY KEY(engine_id,kind));`);

  function saveFile(data) {
    const digest = sha256(data);
    writeImmutable(join(files, digest), data, digest);
    return digest;
  }

  function readFile(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new InputError('文件摘要无效。');
    const data = readFileSync(join(files, digest));
    if (sha256(data) !== digest) throw new Error('文件内容与登记摘要不一致。');
    return data;
  }

  const parse = row => row && JSON.parse(row.doc);
  const run = row => row && { ...parse(row), runId: row.engine_id, sessionId: row.session_id };
  const getRunByEngine = id => run(one(db, 'SELECT * FROM runs WHERE engine_id=?', id));
  const getRun = id => run(one(db, 'SELECT * FROM runs WHERE id=?', id));
  const getCandidate = id => parse(one(db, 'SELECT doc FROM candidate WHERE engine_id=?', id));
  const getEvidence = id => db.prepare('SELECT doc FROM evidence WHERE engine_id=? ORDER BY rowid').all(id).map(parse);
  const getMilestones = id => db.prepare('SELECT doc FROM milestones WHERE engine_id=? ORDER BY rowid').all(id).map(parse);
  const getGates = id => db.prepare('SELECT * FROM gates WHERE engine_id=? ORDER BY rowid').all(id).map(row => ({
    ...parse(row), node: row.node, invocation: row.invocation, decision: row.decision ? JSON.parse(row.decision) : null,
  }));
  const getProject = id => parse(one(db, 'SELECT doc FROM projects WHERE id=?', id));
  const runProject = item => ({ ...getProject(item.projectId), ...item.materials });
  const getClarifications = id => db.prepare('SELECT doc FROM clarifications WHERE run_id=? ORDER BY rowid DESC LIMIT 12').all(id).reverse().map(parse);

  function materials(source, original) {
    const replacesFolder = source.folder !== undefined;
    const folder = replacesFolder ? importFolder(source.folder, saveFile) : original?.folder;
    const draft = source.requirements ?? (replacesFolder ? '' : original?.requirements);
    const requirements = folder && (draft === undefined || typeof draft === 'string' && !draft.trim()) ? '' : field(draft, '需求', 16000);
    const captured = folder ? { folder: { ...folder, baseline: source.fileData !== undefined ? (source.folder?.baseline || null) : folder.baseline } } : {};
    if (source.fileData === undefined) {
      if (folder && (replacesFolder || !original?.digest)) {
        if (folder.baseline && replacesFolder) throw new InputError('请上传所选原始程序 CSV。');
        return { requirements, fileName: null, digest: null, ...captured };
      }
      if (!original?.digest || !original.fileName) throw new InputError('请上传原始程序 CSV。');
      return { requirements, fileName: original.fileName, digest: original.digest, ...captured };
    }
    const fileName = field(source.fileName, 'CSV 文件名', 160);
    if (!/\.csv$/i.test(fileName) || basename(fileName) !== fileName || /[\x00-\x1f\\/:]/.test(fileName)) throw new InputError('请选择有效的 CSV 文件。');
    const data = bytes(source.fileData, MAX_BASELINE);
    if (replacesFolder && folder.baseline &&
      (folder.baseline.split('/').at(-1) !== fileName || folder.files.find(entry => entry.path === folder.baseline).size !== data.length)) {
      throw new InputError('上传的 CSV 与文件夹中选择的原始程序不一致。');
    }
    decodeCsv(data);
    return { requirements, fileName, digest: saveFile(data), ...captured };
  }

  return {
    close: () => db.close(), getRun, getRunByEngine, getProject, runProject, materials, getCandidate, getEvidence, getMilestones, getGates, getClarifications, readFile,
    saveClarification(parent, ticket, questions, answers) {
      const item = getRun(parent);
      if (!item || item.sessionId !== parent) return;
      const details = answers.map(answer => ({
        question: String(questions.find(question => question.id === answer.id)?.question || '').slice(0, 1200),
        answer: [...answer.selected, answer.custom].filter(Boolean).join('、'),
      }));
      db.prepare('INSERT OR IGNORE INTO clarifications VALUES (?,?,?)').run(item.id, ticket, JSON.stringify({ details, at: Date.now() }));
    },
    projects: () => db.prepare('SELECT doc FROM projects ORDER BY rowid DESC').all().map(parse),
    runs: () => db.prepare("SELECT * FROM runs WHERE json_extract(doc,'$.deletedAt') IS NULL ORDER BY rowid DESC").all().map(run),
    deleteRun(id) {
      const row = one(db, 'SELECT doc FROM runs WHERE id=?', id);
      if (!row) throw new InputError('运行记录不存在。', 404);
      const doc = parse(row);
      if (!doc.deletedAt) {
        db.prepare('UPDATE runs SET doc=? WHERE id=? AND doc=?')
          .run(JSON.stringify({ ...doc, deletedAt: Date.now() }), id, row.doc);
      }
      return { id, deleted: true };
    },
    createProject(body) {
      const source = body.sample === true ? sample : body;
      const doc = { id: randomUUID(), name: field(source.name, '项目名称', 100), cpu: field(source.cpu, 'CPU 型号', 100),
        toolchain: field(source.toolchain, '工程工具及版本', 120), createdAt: Date.now(), sample: source.sample === true,
        ...(source.sample === true ? materials(source) : {}) };
      db.prepare('INSERT INTO projects VALUES (?,?)').run(doc.id, JSON.stringify(doc));
      mkdirSync(join(root, 'workspace', doc.id), { recursive: true });
      return doc;
    },
    workspace: id => join(root, 'workspace', id),
    reserveRun(doc, sessionId) {
      db.prepare('INSERT INTO runs VALUES (?,?,?,NULL,?)').run(doc.id, doc.projectId, sessionId, JSON.stringify(doc));
    },
    bindRun(id, engineId) {
      db.prepare('UPDATE runs SET engine_id=? WHERE id=? AND engine_id IS NULL').run(engineId, id);
      return getRun(id);
    },
    markLaunchError(id, error) {
      const doc = getRun(id);
      db.prepare('UPDATE runs SET doc=? WHERE id=? AND engine_id IS NULL').run(JSON.stringify({ ...doc, error }), id);
    },
    waitForDecision(engineId, node, invocation, details) {
      db.prepare('INSERT OR IGNORE INTO gates VALUES (?,?,?,?,NULL)').run(engineId, node, invocation, JSON.stringify(details));
      return getGates(engineId).find(item => item.node === node);
    },
    decide(engineId, node, invocation, body) {
      const gate = getGates(engineId).find(item => item.node === node);
      if (!gate || gate.invocation !== invocation) throw new InputError('待办已变化，请刷新后重试。', 409);
      if (gate.decision) return gate.decision;
      if (!['approve', 'reject'].includes(body.action)) throw new InputError('请选择通过或驳回。');
      const candidate = getCandidate(engineId);
      const approved = body.action === 'approve';
      const item = node === 'intake' ? getRunByEngine(engineId) : null;
      const namedIntake = Boolean(approved && item?.plc);
      if (namedIntake) {
        const gaps = intakeDataGaps(runProject(item));
        if (gaps.length) throw new InputError(gaps.join(' '), 409);
      } else if (approved && gate.blockers?.length) {
        throw new InputError('请先补齐 Agent 列出的必要资料，再重新核对。', 409);
      }
      if (gate.mode === 'release') {
        if (!candidate || body.digest !== candidate.digest || gate.digest !== candidate.digest) throw new InputError('候选已变化，请重新核对。', 409);
        const source = getRunByEngine(engineId)?.testRun ? 'test' : 'engineering';
        if (approved && !evidenceReady(getEvidence(engineId), candidate.digest, source)) {
          throw new InputError(source === 'test' ? '当前候选缺少通过的测试记录。' : '当前候选缺少通过的编译或仿真证据。', 409);
        }
      }
      const approver = namedIntake ? field(body.approver, '审批人', 80) : '';
      const optionalNote = body.note == null || typeof body.note === 'string' && !body.note.trim();
      const note = namedIntake && optionalNote ? '' : field(body.note, '审核说明', 1200);
      const decision = { approved, note, at: Date.now(), digest: gate.digest || null, ...(approver ? { approver } : {}) };
      db.prepare('UPDATE gates SET decision=? WHERE engine_id=? AND node=? AND invocation=? AND decision IS NULL')
        .run(JSON.stringify(decision), engineId, node, invocation);
      return getGates(engineId).find(item => item.node === node).decision;
    },
    saveCandidate(engineId, projectId, proposal) {
      const item = getRunByEngine(engineId);
      if (!item || item.projectId !== projectId) throw new InputError('工程运行不存在。', 404);
      const project = runProject(item);
      const programs = programFiles(project);
      if (programs.length) {
        const edits = proposal?.edits;
        if (!Array.isArray(edits) || edits.length < 1 || edits.length > 60) throw new InputError('候选须包含 1–60 条逐行替换。');
        const sources = new Map(programs.map(file => [file.path, file]));
        const changes = new Map();
        for (const edit of edits) {
          const source = sources.get(edit?.file);
          if (!source) throw new InputError('候选变更须注明已登记的程序段相对路径。');
          if (!changes.has(source)) changes.set(source, []);
          changes.get(source).push(edit);
        }
        const summary = field(proposal.summary, '候选说明', 3000);
        const outputs = [...changes].sort(([a], [b]) => a.path.localeCompare(b.path)).map(([source, replacements]) => {
          const { data, diff } = applyEdits(readFile(source.digest), replacements, item.testRun);
          return { data, record: { path: source.path, digest: sha256(data), sourceDigest: source.digest }, diff };
        });
        const files = outputs.map(output => output.record);
        const digest = sha256(JSON.stringify([programs.map(file => [file.path, file.digest]), files]));
        const previous = getCandidate(engineId);
        if (previous && previous.digest !== digest) throw new Error('候选已经固定。');
        if (previous) return previous;
        for (const { data, record } of outputs) {
          const destination = join(root, 'workspace', project.id, 'outputs', engineId, record.path);
          mkdirSync(dirname(destination), { recursive: true });
          saveFile(data);
          writeImmutable(destination, data, record.digest);
        }
        const doc = { digest, files, summary, createdAt: Date.now(),
          diff: outputs.flatMap(({ record, diff }) => diff.map(edit => ({ ...edit, file: record.path }))) };
        db.prepare('INSERT OR IGNORE INTO candidate VALUES (?,?)').run(engineId, JSON.stringify(doc));
        return getCandidate(engineId);
      }
      const { data, diff } = applyEdits(readFile(project.digest), proposal?.edits, item.testRun);
      const doc = { digest: saveFile(data), sourceDigest: project.digest, diff, summary: field(proposal.summary, '候选说明', 3000),
        fileName: project.fileName.replace(/\.csv$/i, '-candidate.csv'), createdAt: Date.now() };
      const prior = getCandidate(engineId);
      if (prior && prior.digest !== doc.digest) throw new Error('候选已经固定。');
      const directory = join(root, 'workspace', project.id, 'outputs', engineId);
      mkdirSync(directory, { recursive: true });
      writeImmutable(join(directory, doc.fileName), data, doc.digest);
      db.prepare('INSERT OR IGNORE INTO candidate VALUES (?,?)').run(engineId, JSON.stringify(doc));
      return getCandidate(engineId);
    },
    importEvidence(engineId, body) {
      const candidate = getCandidate(engineId);
      if (!candidate || body.digest !== candidate.digest) throw new InputError('证据须绑定当前候选。', 409);
      if (!['compile', 'simulation'].includes(body.kind) || !['pass', 'fail'].includes(body.verdict)) throw new InputError('请选择证据类型及判定。');
      const source = getRunByEngine(engineId)?.testRun ? 'test' : 'engineering';
      if (source === 'engineering' && body.source === 'test') throw new InputError('测试记录只能导入测试运行。', 409);
      if (getMilestones(engineId).length || getGates(engineId).some(gate => gate.mode === 'release' && gate.decision?.approved)) {
        throw new InputError('已批准交付的证据已锁定。', 409);
      }
      const doc = { id: randomUUID(), kind: body.kind, source, verdict: body.verdict, digest: candidate.digest,
        fileDigest: saveFile(bytes(body.fileData, MAX_EVIDENCE)), fileName: field(body.fileName, '证据文件名', 160),
        tool: field(body.tool, '工具及版本', 120), date: field(body.date, '验证时间', 80),
        note: field(body.note, '人工判定说明', 1200), importedAt: Date.now() };
      if (!Number.isFinite(Date.parse(doc.date))) throw new InputError('验证时间无效。');
      db.prepare('INSERT INTO evidence VALUES (?,?,?)').run(doc.id, engineId, JSON.stringify(doc));
      return doc;
    },
    milestone(engineId, kind, digest, note) {
      const current = getMilestones(engineId);
      const previous = { tested: null, delivered: null, implemented: 'delivered', accepted: 'implemented' };
      if (!Object.hasOwn(previous, kind)) throw new InputError('阶段未知。');
      const testRun = Boolean(getRunByEngine(engineId)?.testRun);
      if ((kind === 'tested') !== testRun) throw new InputError('测试运行只能登记测试验收。', 409);
      if (previous[kind] && !current.some(record => record.kind === previous[kind] && record.digest === digest)) {
        throw new InputError('请先完成上一阶段登记。', 409);
      }
      const doc = { kind, digest, note: field(note, '登记说明', 1200), at: Date.now() };
      db.prepare('INSERT OR IGNORE INTO milestones VALUES (?,?,?)').run(engineId, kind, JSON.stringify(doc));
      return getMilestones(engineId).find(record => record.kind === kind);
    },
  };
}

export function evidenceReady(records, digest, source = 'engineering') {
  return ['compile', 'simulation'].every(kind => records.findLast(item =>
    item.kind === kind && item.digest === digest && (item.source || 'engineering') === source)?.verdict === 'pass');
}
