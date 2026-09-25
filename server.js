const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const RUNTIME = path.join(ROOT, 'runtime');
const EXAMPLE_DATA_PATH = path.join(ROOT, 'data', 'people.example.json');
const DATA_PATH = process.env.PEOPLE_DATA_PATH || path.join(ROOT, 'data', 'people.local.json');
const STATE_PATH = path.join(RUNTIME, 'state.json');
const TEMPLATE_PATH = path.join(ROOT, 'outputs', 'voting-monitor-public', 'people-import-template.xlsx');
const PORT = Number(process.env.PORT || 8787);

fs.mkdirSync(RUNTIME, { recursive: true });
if (!fs.existsSync(DATA_PATH)) fs.copyFileSync(EXAMPLE_DATA_PATH, DATA_PATH);
let people = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
let personById = new Map(people.map((person) => [person.id, person]));

const defaultState = { statuses: {}, logs: [] };
let state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : defaultState;
state.statuses ||= {};
state.logs ||= [];

const operatorIds = ['wlx', 'ydn', 'lj', 'lb', 'lqx', 'yjj', 'cw', 'wzp', '001'];
const demoPasswordsEnabled = process.env.ALLOW_DEMO_PASSWORDS === 'true' && process.env.NODE_ENV !== 'production';
const operators = Object.fromEntries(operatorIds.map((id) => [id, process.env[`OPERATOR_${id}_PASSWORD`] || (demoPasswordsEnabled ? id : '')]));
const sessions = new Map();
const pendingImports = new Map();
const eventClients = new Set();
let writeQueue = Promise.resolve();
let XLSX;

function excelLibrary() {
  if (XLSX) return XLSX;
  try {
    XLSX = require('xlsx');
    return XLSX;
  } catch {
    throw new Error('缺少 Excel 导入依赖，请在仓库目录执行 npm install 后重试');
  }
}

function replacePeople(nextPeople) {
  people = nextPeople;
  personById = new Map(people.map((person) => [person.id, person]));
}

function persist() {
  const next = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(STATE_PATH, next));
  return writeQueue;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        return;
      }
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

function readImportFile(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(Object.assign(new Error('Excel 文件不能超过 8MB'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const contentType = String(req.headers['content-type'] || '');
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) throw new Error('请通过文件选择器上传 Excel 文件');
        const body = Buffer.concat(chunks);
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'));
        const fileEnd = body.indexOf(Buffer.from(`\r\n--${boundaryMatch[1] || boundaryMatch[2]}`), headerEnd + 4);
        if (headerEnd < 0 || fileEnd < 0) throw new Error('无法读取上传的 Excel 文件');
        resolve(body.subarray(headerEnd + 4, fileEnd));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function parsePeopleImport(buffer) {
  const xlsx = excelLibrary();
  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: 'buffer', raw: false });
  } catch {
    throw new Error('文件不是有效的 Excel 工作簿');
  }
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) throw new Error('Excel 中没有找到工作表');
  const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: false });
  const headers = (rows.shift() || []).map((value) => String(value).replace(/^\uFEFF/, '').trim().toLowerCase());
  const aliases = {
    '编号': 'id', id: 'id',
    '投票点': 'point', point: 'point',
    '分组': 'group', group: 'group',
    '地址': 'address', address: 'address',
    '姓名': 'name', name: 'name',
    '身份证号': 'idCard', '身份证号码': 'idCard', idcard: 'idCard', 'id card': 'idCard',
    '电话': 'phone', '电话号码': 'phone', phone: 'phone',
    '备注': 'note', note: 'note',
  };
  const columns = headers.map((header) => aliases[header] || null);
  const required = ['id', 'point', 'group', 'address', 'name'];
  const missing = required.filter((field) => !columns.includes(field));
  if (missing.length) throw new Error(`Excel 缺少必填列：${missing.join('、')}`);
  const values = (value) => String(value ?? '').trim();
  const imported = [];
  const ids = new Set();
  rows.forEach((row, index) => {
    if (!row.some((value) => values(value))) return;
    const person = {};
    columns.forEach((field, columnIndex) => {
      if (field) person[field] = values(row[columnIndex]);
    });
    const excelRow = index + 2;
    const missingFields = required.filter((field) => !person[field]);
    if (missingFields.length) throw new Error(`第 ${excelRow} 行缺少：${missingFields.join('、')}`);
    if (ids.has(person.id)) throw new Error(`第 ${excelRow} 行的编号重复：${person.id}`);
    ids.add(person.id);
    imported.push({ id: person.id, point: person.point, group: person.group, address: person.address, name: person.name, idCard: person.idCard || '', phone: person.phone || '', note: person.note || '' });
  });
  if (!imported.length) throw new Error('Excel 中没有可导入的人员数据');
  if (imported.length > 10000) throw new Error('一次最多导入 10000 人');
  return imported;
}

async function saveImportedPeople(nextPeople) {
  const next = JSON.stringify(nextPeople, null, 2);
  await fs.promises.writeFile(DATA_PATH, next);
  replacePeople(nextPeople);
  state.statuses = {};
  state.logs = [];
  await persist();
}

function sessionOperator(req) {
  const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const queryToken = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
  const token = headerToken || queryToken;
  return sessions.get(token);
}

function snapshot() {
  const records = people.map((person) => {
    const status = state.statuses[person.id];
    return { ...person, voted: Boolean(status), ...(status || {}) };
  });
  const voted = records.filter((person) => person.voted).length;
  return {
    people: records,
    logs: state.logs.slice(-120).reverse(),
    summary: {
      total: records.length,
      voted,
      remaining: records.length - voted,
      rate: records.length ? voted / records.length : 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of eventClients) res.write(payload);
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC, target));
  const relativePath = path.relative(PUBLIC, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: '页面不存在' });
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
      res.end();
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.operatorId || '').trim();
      if (!operators[id] || operators[id] !== String(body.password || '')) return sendJson(res, 401, { error: '编号或密码错误' });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, id);
      return sendJson(res, 200, { token, operatorId: id });
    }
    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
      if (!sessionOperator(req)) return sendJson(res, 401, { error: '请先登录' });
      return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/api/import-template' && req.method === 'GET') {
      if (!sessionOperator(req)) return sendJson(res, 401, { error: '请先登录' });
      if (!fs.existsSync(TEMPLATE_PATH)) return sendJson(res, 404, { error: '导入模板暂不可用' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="people-import-template.xlsx"',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(TEMPLATE_PATH).pipe(res);
      return;
    }
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const operatorId = sessionOperator(req);
      if (!operatorId) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
      const imported = parsePeopleImport(await readImportFile(req));
      const importToken = crypto.randomBytes(24).toString('hex');
      pendingImports.set(importToken, { operatorId, people: imported, createdAt: Date.now() });
      return sendJson(res, 200, {
        importToken,
        summary: { total: imported.length, points: [...new Set(imported.map((person) => person.point))].length, groups: [...new Set(imported.map((person) => person.group))].length },
        preview: imported.slice(0, 5).map(({ id, point, group, address, name }) => ({ id, point, group, address, name })),
      });
    }
    if (url.pathname === '/api/import/confirm' && req.method === 'POST') {
      const operatorId = sessionOperator(req);
      if (!operatorId) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
      const body = await readBody(req);
      const pending = pendingImports.get(String(body.importToken || ''));
      if (!pending || pending.operatorId !== operatorId || Date.now() - pending.createdAt > 10 * 60 * 1000) {
        return sendJson(res, 400, { error: '导入预览已失效，请重新选择 Excel 文件' });
      }
      await saveImportedPeople(pending.people);
      pendingImports.delete(String(body.importToken));
      broadcast();
      return sendJson(res, 200, { message: `已导入 ${pending.people.length} 人，当前投票状态已清空`, snapshot: snapshot() });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (!sessionOperator(req)) return sendJson(res, 401, { error: '请先登录' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    if (url.pathname === '/api/vote' && req.method === 'POST') {
      const operatorId = sessionOperator(req);
      if (!operatorId) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
      const body = await readBody(req);
      const person = personById.get(String(body.personId));
      if (!person) return sendJson(res, 404, { error: '找不到该人员' });
      if (body.action !== 'vote' && body.action !== 'undo') return sendJson(res, 400, { error: '无效的操作类型' });
      const action = body.action;
      const current = state.statuses[person.id];
      if (action === 'vote' && current) return sendJson(res, 409, { error: `此人已由操作员 ${current.operatorId} 登记投票`, snapshot: snapshot() });
      if (action === 'undo' && !current) return sendJson(res, 409, { error: '此人当前不是已投票状态', snapshot: snapshot() });
      const now = new Date().toISOString();
      state.logs.push({ id: crypto.randomUUID(), personId: person.id, personName: person.name, action, operatorId, at: now });
      if (action === 'vote') state.statuses[person.id] = { operatorId, votedAt: now };
      else delete state.statuses[person.id];
      await persist();
      broadcast();
      return sendJson(res, 200, snapshot());
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || '服务器错误' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请换端口启动，例如：PORT=8788 npm run start:demo`);
  } else {
    console.error('投票系统启动失败：', error.message);
  }
  process.exitCode = 1;
});

server.listen(PORT, '0.0.0.0', () => console.log(`投票系统已启动：http://localhost:${PORT}`));
