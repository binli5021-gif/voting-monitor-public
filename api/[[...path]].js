const crypto = require('crypto');
const people = require('../data/people.example.json');

const peopleById = new Map(people.map((person) => [String(person.id), person]));
const operatorIds = ['wlx', 'ydn', 'lj', 'lb', 'lqx', 'yjj', 'cw', 'wzp', '001'];
const demoPasswordsEnabled = process.env.ALLOW_DEMO_PASSWORDS === 'true' && process.env.NODE_ENV !== 'production';
const operators = Object.fromEntries(operatorIds.map((id) => [id, process.env[`OPERATOR_${id}_PASSWORD`] || (demoPasswordsEnabled ? id : '')]));

function json(res, status, value) {
  res.status(status).json(value);
}

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.VERCEL_ENV || process.env.NODE_ENV === 'production') throw new Error('生产环境未配置 SESSION_SECRET');
  return 'local-development-only-change-this-secret';
}

function tokenFor(operatorId) {
  const payload = Buffer.from(JSON.stringify({ operatorId, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function operatorFromToken(value) {
  try {
    const [payload, signature] = String(value || '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() && operators[data.operatorId] ? data.operatorId : null;
  } catch { return null; }
}

function requestOperator(req) {
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return operatorFromToken(header);
}

function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('尚未配置 Supabase 环境变量');
  return { url: url.replace(/\/$/, ''), key };
}

async function supabase(path, options = {}) {
  const { url, key } = supabaseConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      signal: controller.signal,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(typeof body === 'object' ? (body.message || body.error || 'Supabase 请求失败') : 'Supabase 请求失败');
  return body;
}

// Supabase REST 默认最多返回 1000 行。投票状态会超过这个数量，必须分页读取，
// 否则第 1001 条之后的人员会被错误地显示为“未投票”。
async function supabaseAll(path, pageSize = 1000) {
  const separator = path.includes('?') ? '&' : '?';
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await supabase(`${path}${separator}order=person_id.asc`, {
      headers: {
        Range: `${offset}-${offset + pageSize - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!Array.isArray(page)) throw new Error('Supabase 返回的投票状态格式错误');
    rows.push(...page);
    if (page.length < pageSize) return rows;
    offset += page.length;
  }
}

function authError(res) { return json(res, 401, { error: '登录已失效，请重新登录' }); }

async function snapshot(options = {}) {
  const statuses = await supabaseAll('voter_status?select=person_id,operator_id,voted_at');
  const statusMap = new Map((statuses || []).map((item) => [String(item.person_id), item]));
  const records = people.map((person) => {
    const status = statusMap.get(String(person.id));
    return { ...person, voted: Boolean(status), ...(status ? { operatorId: status.operator_id, votedAt: status.voted_at } : {}) };
  });
  const voted = records.filter((person) => person.voted).length;
  const result = {
    logs: [],
    summary: { total: records.length, voted, remaining: records.length - voted, rate: records.length ? voted / records.length : 0 },
    updatedAt: new Date().toISOString(),
  };
  if (options.includePeople !== false) result.people = records;
  return result;
}

module.exports = async function handler(req, res) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = req.body || {};
      const id = String(body.operatorId || '').trim();
      if (!operators[id] || operators[id] !== String(body.password || '')) return json(res, 401, { error: '编号或密码错误' });
      return json(res, 200, { token: tokenFor(id), operatorId: id });
    }
    const operatorId = requestOperator(req);
    if (!operatorId) return authError(res);
    if (req.method === 'GET' && pathname === '/api/bootstrap') return json(res, 200, await snapshot());
    if (pathname === '/api/import-template' || pathname === '/api/import' || pathname === '/api/import/confirm') {
      return json(res, 501, { error: '当前是云端示例部署，Excel 导入请使用本地电脑端服务' });
    }
    if (req.method === 'POST' && pathname === '/api/vote') {
      const body = req.body || {};
      const person = peopleById.get(String(body.personId));
      if (!person) return json(res, 404, { error: '找不到该人员' });
      if (body.action !== 'vote' && body.action !== 'undo') return json(res, 400, { error: '无效的操作类型' });
      const action = body.action;
      const result = await supabase('rpc/change_vote', { method: 'POST', body: JSON.stringify({ p_person_id: String(person.id), p_person_name: person.name, p_action: action, p_operator_id: operatorId }) });
      if (!result?.ok) {
        const current = result?.operator_id ? `此人已由操作员 ${result.operator_id} 登记投票` : (action === 'undo' ? '此人当前不是已投票状态' : '操作未完成');
        return json(res, 409, { error: current, snapshot: await snapshot() });
      }
      const updatedAt = new Date().toISOString();
      return json(res, 200, {
        updatedAt,
        changed: {
          personId: person.id,
          voted: action === 'vote',
          operatorId: action === 'vote' ? operatorId : null,
          votedAt: action === 'vote' ? updatedAt : null,
        },
      });
    }
    return json(res, 404, { error: '接口不存在' });
  } catch (error) {
    return json(res, 500, { error: error.message || '服务器错误' });
  }
};
