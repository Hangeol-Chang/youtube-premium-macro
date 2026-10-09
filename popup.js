/* popup.js — Apple YouTube 구독 연장 반복기 (팝업 UI)
 *  - 입력 검증, 시작/중지, 상태 표시
 *  - 로그 표시(모두 textContent 사용 → XSS 방지), 로그 삭제, CSV 다운로드
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  const els = {
    total: $('total'),
    waitSec: $('waitSec'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    statusBadge: $('statusBadge'),
    progressText: $('progressText'),
    logList: $('logList'),
    clearBtn: $('clearBtn'),
    csvBtn: $('csvBtn'),
    message: $('message')
  };

  let logs = [];
  let seenKeys = new Set();
  let lastRunning = false;

  function logKey(entry) {
    const e = entry || {};
    return (e.t || '') + '|' + (e.type || '') + '|' + (e.message || '');
  }

  // =====================================================================
  // 입력 검증 (background.js 와 동일 규칙)
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
      return { ok: false, error: '반복 횟수는 0~10000 사이의 정수만 입력할 수 있습니다.' };
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
    return { ok: true, total: total, waitSec: waitSec };
  }

  // =====================================================================
  // UI 렌더링
  // =====================================================================

  function showMessage(text, kind) {
    els.message.textContent = text || '';
    els.message.className = 'message' + (kind ? ' ' + kind : '');
    els.message.hidden = !text;
  }

  function fmtTotal(total) {
    return total === 0 ? '∞' : String(total);
  }

  function setBadge(kind, text) {
    els.statusBadge.className = 'badge ' + kind;
    els.statusBadge.textContent = text;
  }

  function renderState(state) {
    const running = !!(state && state.running);
    const total = state && typeof state.total === 'number' ? state.total : 0;
    const completed = state && typeof state.completed === 'number' ? state.completed : 0;
    const display = (state && state.display) ? state.display : (completed + '/' + fmtTotal(total));

    els.progressText.textContent = display;

    if (running) {
      setBadge('running', '실행 중');
    } else if (state && state.status === 'finished') {
      setBadge('done', '완료');
    } else if (state && state.status === 'error') {
      setBadge('error', '오류');
    } else if (state && state.status === 'stopped') {
      setBadge('idle', '중지됨');
    } else {
      setBadge('idle', '대기 중');
    }

    els.startBtn.disabled = running;
    els.stopBtn.disabled = !running;

    // 실행이 막 끝난 경우 안내
    if (lastRunning && !running) {
      if (state && state.status === 'finished') showMessage('지정한 반복 횟수를 모두 완료했습니다.', 'ok');
      else if (state && state.status === 'error') showMessage('복구 불가 오류로 실행이 종료되었습니다.', 'error');
      else if (state && state.status === 'stopped') showMessage('중지되었습니다.', 'ok');
    }
    lastRunning = running;
  }

  function appendLog(entry) {
    const row = document.createElement('div');
    row.className = 'log-row log-' + (entry.type || 'info');

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.t || '';

    const type = document.createElement('span');
    type.className = 'log-type';
    type.textContent = '[' + (entry.type || 'info') + ']';

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = entry.message || '';

    row.appendChild(time);
    row.appendChild(type);
    row.appendChild(msg);
    els.logList.appendChild(row);
    els.logList.scrollTop = els.logList.scrollHeight;
  }

  function renderLogs(list) {
    els.logList.textContent = '';
    seenKeys = new Set();
    if (!list || !list.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '로그가 없습니다.';
      els.logList.appendChild(empty);
      return;
    }
    list.forEach(function (entry) {
      seenKeys.add(logKey(entry));
      appendLog(entry);
    });
  }

  // =====================================================================
  // 초기 로드
  // =====================================================================

  chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(function (res) {
    if (res && res.ok) {
      logs = res.logs || [];
      renderLogs(logs);
      renderState(res.state);
    }
  }).catch(function () { renderLogs([]); });

  // 백그라운드에서 오는 실시간 로그/상태
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'LOG') {
      const key = logKey(msg.log);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      logs.push(msg.log);
      els.logList.querySelectorAll('.log-empty').forEach(function (n) { n.remove(); });
      appendLog(msg.log);
    } else if (msg.type === 'STATE') {
      renderState(msg.state);
    }
  });

  // storage 변경(다른 경로에서 로그/상태 변경) 대비
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.logs) {
      logs = changes.logs.newValue || [];
      renderLogs(logs);
    }
    if (changes.state) {
      renderState(changes.state.newValue);
    }
  });

  // =====================================================================
  // 버튼 이벤트
  // =====================================================================

  els.startBtn.addEventListener('click', function () {
    const v = validateInputs(els.total.value, els.waitSec.value);
    if (!v.ok) {
      showMessage(v.error, 'error');
      return;
    }
    showMessage('', '');
    els.startBtn.disabled = true;

    chrome.runtime.sendMessage({
      type: 'START',
      payload: { total: els.total.value, waitSec: els.waitSec.value }
    }).then(function (res) {
      if (!res || !res.ok) {
        showMessage((res && res.error) || '시작에 실패했습니다.', 'error');
        els.startBtn.disabled = false;
      } else {
        showMessage('실행을 시작했습니다.', 'ok');
      }
    }).catch(function (e) {
      showMessage('시작 실패: ' + (e && e.message ? e.message : e), 'error');
      els.startBtn.disabled = false;
    });
  });

  els.stopBtn.addEventListener('click', function () {
    els.stopBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'STOP' }).then(function () {
      showMessage('중지 요청을 보냈습니다.', 'ok');
    }).catch(function () { /* ignore */ });
  });

  els.clearBtn.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }).then(function () {
      logs = [];
      renderLogs(logs);
      showMessage('로그를 삭제했습니다.', 'ok');
    }).catch(function () { /* ignore */ });
  });

  els.csvBtn.addEventListener('click', function () {
    if (!logs.length) {
      showMessage('다운로드할 로그가 없습니다.', 'error');
      return;
    }
    const header = 'time,type,message';
    const lines = [header];
    logs.forEach(function (l) {
      lines.push([l.dt || l.t || '', l.type || '', l.message || ''].map(csvCell).join(','));
    });
    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'apple-renew-log-' + tsName() + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showMessage('CSV 로그를 다운로드했습니다.', 'ok');
  });

  function csvCell(value) {
    const s = String(value == null ? '' : value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function tsName() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
})();
