const crypto = require('crypto');
const { load, save } = require('./store');

// 允许的请求方式，与页面上的下拉选项保持一致
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_LENGTH = 200 * 1024;
const MAX_HEADER_COUNT = 30;

// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
  }
}

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateMethod(method) {
  const value = pickText(method).toUpperCase();
  if (!value) throw new ApiError(400, 'METHOD_REQUIRED', '请选择请求方式', 'method');
  if (!ALLOWED_METHODS.includes(value)) {
    throw new ApiError(400, 'METHOD_INVALID', `不支持的请求方式：${value}`, 'method');
  }
  return value;
}

function validateName(name) {
  const value = pickText(name);
  if (!value) throw new ApiError(400, 'NAME_REQUIRED', '请填写用例名称', 'name');
  if (value.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `用例名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  return value;
}

// 目标地址支持两种写法：以 / 开头的本机内置示例接口路径，以及完整的 http 或 https 地址
function validateUrl(url) {
  const value = pickText(url);
  if (!value) throw new ApiError(400, 'URL_REQUIRED', '目标地址不能为空', 'url');
  if (value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'URL_TOO_LONG', `目标地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'url');
  }
  if (value.startsWith('/')) {
    if (/\s/.test(value)) {
      throw new ApiError(400, 'URL_INVALID', '目标地址里不能出现空格，请检查是否有多余字符', 'url');
    }
    return value;
  }
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new ApiError(400, 'URL_INVALID', '目标地址需要以 http:// 或 https:// 开头，或填写 / 开头的内置示例接口路径', 'url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'URL_PROTOCOL_UNSUPPORTED', '目标地址只支持 http 与 https 两种协议', 'url');
  }
  return value;
}

// 请求头逐行校验：名称必填、字符合法、同名不重复
function validateHeaders(headers) {
  if (headers === undefined || headers === null) return [];
  if (!Array.isArray(headers)) {
    throw new ApiError(400, 'HEADERS_INVALID', '请求头需要按行列表填写', 'headers');
  }
  if (headers.length > MAX_HEADER_COUNT) {
    throw new ApiError(400, 'HEADERS_TOO_MANY', `请求头最多 ${MAX_HEADER_COUNT} 行`, 'headers');
  }
  const list = [];
  const seen = new Set();
  headers.forEach((row, index) => {
    const key = pickText(row && row.key);
    const value = typeof (row && row.value) === 'string' ? row.value : '';
    if (!key && !value) return; // 整行为空的直接跳过
    if (!key) {
      throw new ApiError(400, 'HEADER_KEY_REQUIRED', `第 ${index + 1} 行请求头缺少名称`, `headers.${index}.key`);
    }
    if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(key)) {
      throw new ApiError(400, 'HEADER_KEY_INVALID', `请求头名称「${key}」含有非法字符`, `headers.${index}.key`);
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new ApiError(400, 'HEADER_KEY_DUPLICATE', `请求头「${key}」重复填写`, `headers.${index}.key`);
    }
    seen.add(lower);
    list.push({ key, value });
  });
  return list;
}

// 请求内容按请求方式与内容类型校验：GET 与 HEAD 不允许带内容，JSON 内容必须能解析
function validateBody(body, method, headers) {
  const value = typeof body === 'string' ? body : '';
  if (value.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'BODY_TOO_LONG', `请求内容不能超过 ${MAX_BODY_LENGTH} 个字符`, 'body');
  }
  if (!value.trim()) return '';
  if (method === 'GET' || method === 'HEAD') {
    throw new ApiError(400, 'BODY_NOT_ALLOWED', `请求方式为 ${method} 时不支持填写请求内容`, 'body');
  }
  const contentType = headers.find((row) => row.key.toLowerCase() === 'content-type');
  const contentTypeValue = contentType ? contentType.value.toLowerCase() : '';
  if (contentTypeValue.includes('json')) {
    try {
      JSON.parse(value);
    } catch (err) {
      throw new ApiError(400, 'BODY_INVALID_JSON', `请求内容不是合法的 JSON：${err.message}`, 'body');
    }
  }
  return value;
}

// 读取用例列表，按创建时间从新到旧排列，顺序稳定
function listCases() {
  const data = load();
  return data.cases
    .slice()
    .sort(compareNewestFirst('createdAt'));
}

function getCase(id) {
  const data = load();
  const found = data.cases.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  return found;
}

// 请求草稿的公共校验：保存用例与实际发送都走这一套，保证两边判断一致
function normalizeRequestDraft(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const method = validateMethod(input.method);
  const url = validateUrl(input.url);
  const headers = validateHeaders(input.headers);
  const body = validateBody(input.body, method, headers);
  return { method, url, headers, body };
}

function createCase(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = validateName(input.name);
  const draft = normalizeRequestDraft(input);

  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    name,
    method: draft.method,
    url: draft.url,
    headers: draft.headers,
    body: draft.body,
    createdAt: now,
    updatedAt: now,
  };
  data.cases.push(created);
  save(data);
  return created;
}

function deleteCase(id) {
  const data = load();
  const index = data.cases.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  const [removed] = data.cases.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

// ---------------- 执行记录 ----------------

// 按时刻从新到旧排列；同一时刻用 id 兜底，保证任何情况下顺序都确定
function compareNewestFirst(timeField) {
  return (a, b) => {
    if (a[timeField] === b[timeField]) return a.id < b.id ? 1 : -1;
    return a[timeField] < b[timeField] ? 1 : -1;
  };
}

// 把一次发送的结果整理成执行记录并落盘。
// 结论失败有两种：请求没有完成（网络层失败），以及目标返回了 400 及以上的失败状态码——
// 这与结果区把 4xx/5xx 标成失败状态的口径保持一致；两种失败都要给出可读原因。
// occurredAt 在真正发出前取好，记录的是这一次发送发生的时刻。
function recordExecution(draft, result, occurredAt) {
  const transportFailed = !result.ok;
  const httpFailed = !transportFailed && Number(result.status) >= 400;
  const failed = transportFailed || httpFailed;

  let reason = '';
  if (transportFailed) {
    reason = result.failure ? String(result.failure.reason || '') : '';
  } else if (httpFailed) {
    reason = result.statusText
      ? `目标地址返回失败状态码 ${result.status}（${result.statusText}）`
      : `目标地址返回失败状态码 ${result.status}`;
  }

  const record = {
    id: crypto.randomUUID(),
    method: draft.method,
    url: result.targetUrl || draft.url,
    conclusion: failed ? 'failure' : 'success',
    status: transportFailed ? null : Number(result.status) || null,
    timeMs: Number(result.timeMs) || 0,
    reason,
    occurredAt,
  };
  const data = load();
  data.executions.push(record);
  save(data);
  return record;
}

// 结论只接受这两种取值，其余按未填写处理
function normalizeConclusion(value) {
  const text = pickText(value);
  if (text === 'success' || text === 'failure') return text;
  return '';
}

// 时刻区间的端点需要能解析成时间，填了但不合法时明确指出，避免筛选静默失效
function parseTimeBoundary(value, field, label) {
  const text = pickText(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'EXEC_TIME_INVALID', `${label}需要是可识别的时间，例如 2026-09-18 09:00`, field);
  }
  return parsed.getTime();
}

// 执行记录巡检：地址关键字、结论、时刻区间多个条件同时给出时逐项取交集
function listExecutions(query) {
  const filters = query && typeof query === 'object' ? query : {};
  const urlKeyword = pickText(filters.url);
  const conclusion = normalizeConclusion(filters.conclusion);
  const lower = parseTimeBoundary(filters.from, 'from', '起始时刻');
  const upper = parseTimeBoundary(filters.to, 'to', '截止时刻');
  if (lower !== null && upper !== null && lower > upper) {
    throw new ApiError(400, 'EXEC_TIME_RANGE_INVALID', '起始时刻不能晚于截止时刻', 'from');
  }

  const keyword = urlKeyword.toLowerCase();
  const list = load().executions.filter((item) => {
    if (keyword && !item.url.toLowerCase().includes(keyword)) return false;
    if (conclusion && item.conclusion !== conclusion) return false;
    const time = Date.parse(item.occurredAt);
    if (lower !== null && time < lower) return false;
    if (upper !== null && time > upper) return false;
    return true;
  });
  return list.sort(compareNewestFirst('occurredAt'));
}

module.exports = {
  ApiError,
  ALLOWED_METHODS,
  normalizeRequestDraft,
  listCases,
  getCase,
  createCase,
  deleteCase,
  recordExecution,
  listExecutions,
};
