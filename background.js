/* background.js — Apple YouTube 구독 연장 반복기 (오케스트레이션)
 *
 * 역할:
 *  - 실행 상태/로그를 chrome.storage.local 에 저장 (서비스 워커가 유휴 종료되어도 유지)
 *  - keepalive: 실행 중 주기적인 Chrome API 호출로 서비스 워커 유휴 종료 방지
 *  - runId(실행 토큰)로 중지 직후 재시작해도 이전 실행과 새 실행이 겹치지 않게 함
 *  - 입력값을 팝업과 독립적으로 재검증
 *  - 단계별 폴링(250ms/최대 15초), 실패 시 bypassCache 새로고침 후 동일 회차 재시도
 *  - 완료 횟수는 3단계가 모두 성공한 경우에만 증가
 */

'use strict';

const LOG_KEY = 'logs';
const STATE_KEY = 'state';
const MAX_LOGS = 3000;

const STEP_TIMEOUT_MS = 15000;   // 각 단계 요소 탐색 최대 시간
const VERIFY_TIMEOUT_MS = 3000;  // Cancel 클릭 후 팝업 닫힘 검증 시간
const POLL_MS = 250;             // 탐색 간격 / 중지 반영 주기
const RELOAD_TIMEOUT_MS = 30000; // 새로고침 후 로드 대기 최대 시간
const KEEPALIVE_MS = 15000;      // keepalive API 호출 주기

// 실행 상태 미러 (원본은 chrome.storage.local)
let currentState = null;
let keepAliveTimer = null;

// =====================================================================
// 오류 타입
// =====================================================================

function StopError() {
  const e = new Error('stopped');
  e.name = 'StopError';
  return e;
}
function UnrecoverableError(message) {
  const e = new Error(message);
  e.name = 'UnrecoverableError';
  return e;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// =====================================================================
// 로그 (storage 저장 + 콘솔 + 팝업 브로드캐스트)
// =====================================================================

function pad(n, w) {
  return String(n).padStart(w || 2, '0');
}
function timeStr(d) {
  const x = d || new Date();
  return pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds()) + '.' + pad(x.getMilliseconds(), 3);
}
function dateTimeStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + ' ' +
    pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':' + pad(x.getSeconds());
}

async function getLogs() {
  const data = await chrome.storage.local.get(LOG_KEY);
  return Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
}

async function addLog(type, message) {
  const entry = {
    t: timeStr(),
    dt: dateTimeStr(),
    type: type,
    message: String(message == null ? '' : message)
  };
  // 백그라운드 콘솔 로그 형식: [Apple Renew][시간][유형] 메시지
  console.log('[Apple Renew][' + entry.t + '][' + type + '] ' + entry.message);
  try {
    const logs = await getLogs();
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    await chrome.storage.local.set({ [LOG_KEY]: logs });
  } catch (e) { /* 저장 실패는 무시 */ }
  try {
    chrome.runtime.sendMessage({ type: 'LOG', log: entry }).catch(function () {});
  } catch (e) { /* 팝업 없음 */ }
}

// =====================================================================
// 상태 (storage 저장 + 팝업 브로드캐스트)
// =====================================================================

async function readState() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY] || null;
}

async function saveState(patch) {
  const base = currentState || (await readState()) || {};
  currentState = Object.assign({}, base, patch, { updatedAt: Date.now() });
  await chrome.storage.local.set({ [STATE_KEY]: currentState });
  broadcastState();
}

function broadcastState() {
  try {
    chrome.runtime.sendMessage({ type: 'STATE', state: currentState }).catch(function () {});
  } catch (e) { /* 팝업 없음 */ }
}

function fmtTotal(total) {
  return total === 0 ? '∞' : String(total);
}
function displayStr(completed, total) {
  return completed + '/' + fmtTotal(total);
}

function isActive(runId) {
  return !!(currentState && currentState.running && currentState.runId === runId);
}

// =====================================================================
// keepalive — 실행 중 서비스 워커 유휴 종료 방지
// (별도 permission 없이 chrome.runtime API 호출로 idle 타이머를 리셋한다)
// =====================================================================

function keepAliveTick() {
  try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) { /* ignore */ }
  try { chrome.storage.local.get(STATE_KEY, function () {}); } catch (e) { /* ignore */ }
}

function startKeepAlive() {
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(keepAliveTick, KEEPALIVE_MS);
  }
  keepAliveTick();
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// =====================================================================
// 입력 검증 (팝업과 독립적으로 다시 검증)
// =====================================================================

function toNumber(v) {
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return NaN;
    return Number(s);
  }
  return v;
}

function validateInputs(rawTotal, rawWaitSec) {
  const total = toNumber(rawTotal);
  const waitSec = toNumber(rawWaitSec);

  if (typeof total !== 'number' || !isFinite(total) || !Number.isInteger(total)) {
    return { ok: false, error: '반복 횟수는 0~10000 사이의 정수여야 합니다.' };
  }
  if (total < 0 || total > 10000) {
    return { ok: false, error: '반복 횟수는 0~10000 사이여야 합니다. (0 = 무한)' };
  }
  if (typeof waitSec !== 'number' || !isFinite(waitSec) || Number.isNaN(waitSec)) {
    return { ok: false, error: '대기 시간이 올바르지 않습니다.' };
  }
  if (waitSec < 0.5 || waitSec > 30) {
    return { ok: false, error: '대기 시간은 0.5~30초 사이여야 합니다.' };
  }
  return { ok: true, total: total, waitSec: waitSec, waitMs: Math.round(waitSec * 1000) };
}

// =====================================================================
// 콘텐츠 스크립트 주입 및 프레임 호출
// =====================================================================

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      files: ['content.js']
    });
  } catch (e) {
    throw UnrecoverableError('콘텐츠 스크립트 주입 실패: ' + String((e && e.message) || e));
  }
}

// 모든 프레임에서 부작용 없이 후보 탐색
async function callLocate(tabId, step) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: function (s) {
        try {
          if (!window.__AppleRenewLoop) return { found: false, reason: 'no-content' };
          return window.__AppleRenewLoop.locate(s);
        } catch (e) {
          return { found: false, reason: 'exception', error: String((e && e.message) || e) };
        }
      },
      args: [step]
    });
  } catch (e) {
    throw UnrecoverableError('프레임 탐색 실패(스크립트 주입 불가/탭 종료): ' + String((e && e.message) || e));
  }
  return results || [];
}

// 선택된 프레임에서 실제 동작 수행
async function callAct(tabId, step, frameId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [frameId] },
      func: function (s) {
        try {
          if (!window.__AppleRenewLoop) return { ok: false, reason: 'no-content' };
          return window.__AppleRenewLoop.act(s);
        } catch (e) {
          return { ok: false, reason: 'exception', error: String((e && e.message) || e) };
        }
      },
      args: [step]
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 탭 자체가 사라진 경우만 복구 불가로 처리, 그 외(프레임 교체 등)는 일시적 실패
    if (/no tab|tab was closed|removed from/i.test(msg)) {
      throw UnrecoverableError('탭 접근 실패: ' + msg);
    }
    return { ok: false, reason: 'act-error: ' + msg };
  }
  if (!results || !results.length) return { ok: false, reason: 'no-result' };
  return results[0].result || { ok: false, reason: 'empty-result' };
}

// locate 결과 중 클릭 대상 프레임 선택 (YouTube 문구 우선)
function pickBestFound(results) {
  let best = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i] && results[i].result;
    if (!r || !r.found) continue;
    const cand = { frameId: results[i].frameId, result: r };
    if (!best) { best = cand; continue; }
    if (r.yt && !best.result.yt) best = cand;
  }
  return best;
}

function summarizeFailures(results) {
  const reasons = {};
  let hostname = '';
  const buttons = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i] && results[i].result;
    if (!r) continue;
    const reason = r.reason || 'unknown';
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (r.diag) {
      if (r.diag.hostname && !hostname) hostname = r.diag.hostname;
      if (Array.isArray(r.diag.buttons)) {
        for (let j = 0; j < r.diag.buttons.length; j++) {
          const b = r.diag.buttons[j];
          if (buttons.indexOf(b) === -1 && buttons.length < 20) buttons.push(b);
        }
      }
    }
  }
  return { reasons: reasons, hostname: hostname, buttons: buttons };
}

// =====================================================================
// 단계 실행 (폴링 + 중지 반영 + 클릭/검증)
// =====================================================================

async function doStep(tabId, runId, step, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const needsAct = step !== 'verifyCancel';
  let lastFailure = null;

  while (true) {
    if (!isActive(runId)) throw StopError();

    const located = await callLocate(tabId, step);
    const best = pickBestFound(located);

    if (best) {
      if (!needsAct) {
        return { ok: true, result: best.result };
      }
      const acted = await callAct(tabId, step, best.frameId);
      if (acted && acted.ok) {
        return { ok: true, result: acted };
      }
      lastFailure = { reasons: { [acted && acted.reason ? acted.reason : 'act-failed']: 1 }, hostname: best.result.diag ? best.result.diag.hostname : '', buttons: best.result.diag ? best.result.diag.buttons : [] };
    } else {
      lastFailure = summarizeFailures(located);
    }

    if (Date.now() >= deadline) {
      return { ok: false, failure: lastFailure };
    }
    await delay(POLL_MS);
  }
}

// 한 회차: Step1 Renew → Step2 Confirm → Step3 오류팝업 Cancel → 닫힘 검증
async function executeCycle(tabId, runId) {
  const r1 = await doStep(tabId, runId, 'renew', STEP_TIMEOUT_MS);
  if (!r1.ok) return { ok: false, step: 'renew', failure: r1.failure };
  await addLog('info', 'Step 1: Renew 클릭' + (r1.result && r1.result.text ? ' ("' + r1.result.text + '")' : '') + (r1.result && r1.result.yt === false ? ' [경고: YouTube 문구 미확인]' : ''));

  const r2 = await doStep(tabId, runId, 'confirm', STEP_TIMEOUT_MS);
  if (!r2.ok) return { ok: false, step: 'confirm', failure: r2.failure };
  await addLog('info', 'Step 2: Confirm 클릭' + (r2.result && r2.result.text ? ' ("' + r2.result.text + '")' : ''));

  const r3 = await doStep(tabId, runId, 'cancel', STEP_TIMEOUT_MS);
  if (!r3.ok) return { ok: false, step: 'cancel', failure: r3.failure };
  await addLog('info', 'Step 3: 결제 오류 팝업 Cancel 클릭' + (r3.result && r3.result.text ? ' ("' + r3.result.text + '")' : ''));

  const r4 = await doStep(tabId, runId, 'verifyCancel', VERIFY_TIMEOUT_MS);
  if (!r4.ok) return { ok: false, step: 'verifyCancel', failure: r4.failure };

  return { ok: true };
}

// 중지 요청에 250ms 내 반응하는 인터럽트 가능한 대기
async function interruptibleSleep(ms, runId) {
  let elapsed = 0;
  while (elapsed < ms) {
    if (!isActive(runId)) throw StopError();
    const chunk = Math.min(POLL_MS, ms - elapsed);
    await delay(chunk);
    elapsed += chunk;
  }
}

// bypassCache 전체 새로고침 후 로드 완료 대기 + 콘텐츠 스크립트 재주입
async function reloadAndWait(tabId, runId) {
  try {
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } catch (e) {
    throw UnrecoverableError('탭 새로고침 실패: ' + String((e && e.message) || e));
  }
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  while (true) {
    if (!isActive(runId)) throw StopError();
    await delay(POLL_MS);
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      throw UnrecoverableError('탭 접근 실패: ' + String((e && e.message) || e));
    }
    if (tab && tab.status === 'complete') break;
    if (Date.now() >= deadline) break;
  }
  await delay(500);
  if (!isActive(runId)) throw StopError();
  await injectContentScript(tabId);
}

async function finishRun(runId) {
  await saveState({
    running: false,
    status: 'finished',
    display: displayStr((currentState && currentState.completed) || 0, (currentState && currentState.total) || 0)
  });
  await addLog('success', '지정한 반복 횟수를 모두 완료했습니다.');
}

// =====================================================================
// 메인 루프
// =====================================================================

async function startLoop(runId, total, waitMs, tabId) {
  startKeepAlive();
  try {
    await injectContentScript(tabId);
    while (isActive(runId)) {
      const completed = (currentState && currentState.completed) || 0;

      if (total !== 0 && completed >= total) {
        await finishRun(runId);
        break;
      }

      await addLog('info', '회차 시작 (시도 ' + (completed + 1) + '/' + fmtTotal(total) + ')');
      const res = await executeCycle(tabId, runId);
      if (!isActive(runId)) throw StopError();

      if (res.ok) {
        await saveState({
          completed: completed + 1,
          display: displayStr(completed + 1, total),
          status: 'running'
        });
        await addLog('success', '완료 ' + (completed + 1) + '/' + fmtTotal(total));
        await interruptibleSleep(waitMs, runId);
      } else {
        const f = res.failure || {};
        const reasonKeys = f.reasons
          ? Object.keys(f.reasons).map(function (k) { return k + '(' + f.reasons[k] + ')'; }).join(', ')
          : 'unknown';
        await addLog('warning', '회차 실패 [' + res.step + '] ' + reasonKeys + ' → 새로고침 후 동일 회차 재시도');
        if (f.hostname || (f.buttons && f.buttons.length)) {
          await addLog('warning', '진단: iframe hostname=' + (f.hostname || '?') + ' / 표시된 버튼=' + JSON.stringify(f.buttons || []));
        }
        await reloadAndWait(tabId, runId);
      }
    }
  } catch (e) {
    if (isActive(runId)) {
      if (e && e.name === 'UnrecoverableError') {
        await addLog('error', '복구 불가 오류로 실행을 종료합니다: ' + e.message);
        await saveState({ running: false, status: 'error' });
      } else if (e && e.name === 'StopError') {
        // 중지 처리됨 (stopRun 에서 로그/상태 기록)
      } else {
        await addLog('error', '예기치 않은 오류로 실행을 종료합니다: ' + String((e && e.message) || e));
        await saveState({ running: false, status: 'error' });
      }
    }
  } finally {
    if (currentState && currentState.runId === runId && currentState.running) {
      await saveState({
        running: false,
        status: 'finished',
        display: displayStr((currentState.completed) || 0, (currentState.total) || 0)
      });
    }
    if (!currentState || !currentState.running) stopKeepAlive();
  }
}

// =====================================================================
// 시작 / 중지
// =====================================================================

async function handleStart(payload) {
  const v = validateInputs(payload.total, payload.waitSec);
  if (!v.ok) {
    await addLog('error', '입력 검증 실패: ' + v.error);
    return { ok: false, error: v.error };
  }
  if (currentState && currentState.running) {
    return { ok: false, error: '이미 실행 중입니다. 먼저 중지해 주세요.' };
  }

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) { tab = null; }

  if (!tab || typeof tab.id !== 'number') {
    const err = '활성 탭을 찾을 수 없습니다.';
    await addLog('error', err);
    return { ok: false, error: err };
  }

  const url = tab.url || '';
  if (url.indexOf('apple.com') === -1) {
    const err = 'Apple 페이지에서 실행해 주세요. (현재 탭: ' + (url || '알 수 없음') + ')';
    await addLog('error', err);
    return { ok: false, error: err };
  }

  const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

  currentState = {
    runId: runId,
    running: true,
    status: 'running',
    total: v.total,
    waitMs: v.waitMs,
    waitSec: v.waitSec,
    completed: 0,
    tabId: tab.id,
    tabUrl: url,
    display: displayStr(0, v.total),
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [STATE_KEY]: currentState });
  broadcastState();
  await addLog('info', '실행 시작: 총 ' + fmtTotal(v.total) + '회, 완료 후 대기 ' + v.waitSec + '초');

  startLoop(runId, v.total, v.waitMs, tab.id).catch(function (e) {
    addLog('error', '실행 루프 예외: ' + String((e && e.message) || e));
  });

  return { ok: true, runId: runId };
}

async function stopRun() {
  if (!currentState || !currentState.running) {
    await saveState({ running: false, status: 'stopped' });
    return { ok: true };
  }
  const completed = currentState.completed || 0;
  const total = currentState.total || 0;

  // runId 를 즉시 무효화 → 진행 중 루프가 250ms 내에 스스로 종료
  currentState.running = false;
  currentState.runId = 'stopped-' + Date.now();

  await saveState({
    running: false,
    status: 'stopped',
    runId: currentState.runId,
    display: displayStr(completed, total)
  });
  await addLog('info', '사용자가 중지했습니다. (' + displayStr(completed, total) + ')');
  stopKeepAlive();
  return { ok: true };
}

// =====================================================================
// 메시지 라우팅
// =====================================================================

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

  if (msg.type === 'START') {
    handleStart(msg.payload || {})
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type === 'STOP') {
    stopRun()
      .then(sendResponse)
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    (async function () {
      const state = await readState();
      const logs = await getLogs();
      sendResponse({ ok: true, state: state, logs: logs });
    })();
    return true;
  }

  if (msg.type === 'CLEAR_LOGS') {
    chrome.storage.local.set({ [LOG_KEY]: [] })
      .then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  return false;
});

// =====================================================================
// 서비스 워커 재시작 시 상태 복원 (실행 중이었다면 이어서 재개)
// =====================================================================

(async function restore() {
  try {
    const st = await readState();
    currentState = st;
    if (st && st.running && typeof st.tabId === 'number') {
      await addLog('warning', '서비스 워커 재시작을 감지하여 실행을 이어서 재개합니다.');
      startLoop(st.runId, st.total, st.waitMs, st.tabId).catch(function () {});
    }
  } catch (e) { /* ignore */ }
})();
