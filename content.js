/* content.js — Apple YouTube 구독 연장 반복기
 *
 * 역할:
 *  - DOM 탐색: 메인 문서 + 모든 접근 가능한 iframe + open Shadow DOM 을 재귀 탐색
 *  - 요소 탐색/검증(표시/활성), 클릭(스크롤+포커스)
 *  - 각 단계를 "탐색(locate)"과 "실행(act)"으로 분리해, 여러 프레임 중
 *    YouTube 문구가 있는 프레임의 후보를 백그라운드가 고른 뒤 클릭하도록 한다.
 *
 * 실제 DOM 이 예상과 다를 때는 아래 "선택자 및 버튼 문구 상수"만 수정하면 된다.
 */
(function () {
  'use strict';

  // 이미 주입되어 있으면 중복 정의 방지 (content_scripts + 수동 주입 모두 대응)
  if (window.__AppleRenewLoop) return;

  // =====================================================================
  // 선택자 및 버튼 문구 상수 (실제 DOM 에 맞춰 여기만 수정하면 된다)
  // =====================================================================

  // Renew 버튼 선택자
  const RENEW_SELECTORS = [
    'button[data-test="action-cta"]',
    '[data-test="action-cta"] button',
    'button[data-testid="action-cta"]',
    '[data-testid="action-cta"] button'
  ];
  // data-test / data-testid 값에 아래 문자열이 포함되면 Renew 후보
  const RENEW_ATTR_HINTS = ['renew', 'resubscribe'];
  // Renew 버튼 문구 변형
  const RENEW_TEXTS = [
    'Renew', 'Renew Subscription', 'Resubscribe', 'Subscribe Again',
    '갱신', '구독 갱신', '구독 연장', '다시 구독', '재구독'
  ];

  // Confirm 버튼
  const CONFIRM_SELECTORS = [
    'button[data-test="button-confirm"]',
    'button[data-test="confirm-button"]'
  ];
  const CONFIRM_TEXTS = ['Confirm', '확인'];

  // Cancel 버튼
  const CANCEL_SELECTORS = [
    'button[data-test="Cancel-button"]',
    'button[data-test="button-cancel"]'
  ];
  const CANCEL_TEXTS = ['Cancel', '취소'];

  // 결제 오류 문구
  const ERROR_TEXTS = [
    'Unable to Complete Purchase',
    'unable to charge',
    '구매를 완료할 수 없음',
    '결제할 수 없음'
  ];

  // =====================================================================
  // 유틸 함수
  // =====================================================================

  function normText(el) {
    let t = '';
    try {
      t = (el && el.innerText != null) ? el.innerText : (el ? el.textContent : '');
    } catch (e) {
      try { t = el ? (el.textContent || '') : ''; } catch (e2) { t = ''; }
    }
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function lc(s) {
    return String(s == null ? '' : s).toLowerCase();
  }

  function isClickable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true;
    if (el.getAttribute) {
      const role = el.getAttribute('role');
      if (role === 'button' || role === 'link') return true;
      if (el.hasAttribute('data-test') || el.hasAttribute('data-testid')) return true;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex != null && tabindex !== '-1') return true;
    }
    return false;
  }

  function matchesAny(el, selectors) {
    if (!selectors) return false;
    for (let i = 0; i < selectors.length; i++) {
      try { if (el.matches(selectors[i])) return true; } catch (e) { /* 잘못된 선택자 무시 */ }
    }
    return false;
  }

  function attrHasHint(el, hints) {
    if (!el || !el.getAttribute || !hints) return false;
    const v = lc(el.getAttribute('data-test') || '') + ' ' + lc(el.getAttribute('data-testid') || '');
    if (!v.trim()) return false;
    for (let i = 0; i < hints.length; i++) {
      if (v.indexOf(hints[i]) !== -1) return true;
    }
    return false;
  }

  function textMatches(el, variants) {
    const t = lc(normText(el));
    if (!t || !variants) return false;
    for (let i = 0; i < variants.length; i++) {
      if (t.indexOf(lc(variants[i])) !== -1) return true;
    }
    return false;
  }

  // 부모(또는 Shadow host) 방향으로 거슬러 올라가며 텍스트 확인
  function ancestorHasText(el, needle, maxDepth) {
    const target = lc(needle);
    let node = el;
    let depth = 0;
    const limit = maxDepth || 10;
    while (node && depth < limit) {
      if (lc(normText(node)).indexOf(target) !== -1) return true;
      let parent = node.parentElement;
      if (!parent && node.getRootNode) {
        const root = node.getRootNode();
        parent = (root && root.host) ? root.host : null;
      }
      node = parent;
      depth++;
    }
    return false;
  }

  // =====================================================================
  // 깊은 DOM 순회 (iframe + open Shadow DOM)
  // =====================================================================

  function forEachElementDeep(callback) {
    const visit = function (root) {
      if (!root) return;
      let nodes;
      try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        try { callback(el); } catch (e) { /* 요소 단위 예외 무시 */ }
        // open Shadow DOM 재귀
        if (el.shadowRoot) visit(el.shadowRoot);
        // 동일 출처 iframe 재귀 (교차 출처는 try/catch 로 무시)
        if (el.tagName === 'IFRAME') {
          try {
            const doc = el.contentDocument;
            if (doc) visit(doc);
          } catch (e) { /* 교차 출처 iframe 접근 불가 */ }
        }
      }
    };
    visit(document);
  }

  // 선택자/속성/문구에 매칭되는 클릭 가능 후보 수집
  function collectCandidates(selectors, attrHints, texts) {
    const found = [];
    const seen = new Set();
    const push = function (el) {
      if (!el || el.nodeType !== 1 || seen.has(el)) return;
      seen.add(el);
      found.push(el);
    };
    forEachElementDeep(function (el) {
      let matched = false;
      if (matchesAny(el, selectors)) matched = true;
      if (!matched && attrHasHint(el, attrHints)) matched = true;
      if (!matched && isClickable(el) && textMatches(el, texts)) matched = true;
      if (!matched) return;
      if (isClickable(el)) {
        push(el);
      } else {
        // 컨테이너가 매칭된 경우 내부의 클릭 가능 요소를 사용
        let inner = null;
        try {
          inner = el.querySelector('button, [role="button"], a, input[type="button"], input[type="submit"]');
        } catch (e) { inner = null; }
        push(inner || el);
      }
    });
    return found;
  }

  function firstClickable(cands) {
    for (let i = 0; i < cands.length; i++) {
      if (isVisible(cands[i]) && isEnabled(cands[i])) return cands[i];
    }
    return null;
  }

  // YouTube 문구가 있는 영역의 후보를 우선 선택
  function chooseYouTubePreferred(cands) {
    if (!cands.length) return { chosen: null, yt: false, ambiguous: false };
    const ytCands = cands.filter(function (el) { return ancestorHasText(el, 'youtube', 10); });
    if (ytCands.length) return { chosen: ytCands[0], yt: true, ambiguous: ytCands.length > 1 };
    return { chosen: cands[0], yt: false, ambiguous: cands.length > 1 };
  }

  // =====================================================================
  // 표시/활성 상태 및 클릭
  // =====================================================================

  function isVisible(el) {
    try {
      if (!el || el.nodeType !== 1) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity) === 0) return false;
      if (rect.width <= 0 && rect.height <= 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isEnabled(el) {
    try {
      if (!el) return false;
      if (el.disabled === true) return false;
      if (el.getAttribute && lc(el.getAttribute('aria-disabled')) === 'true') return false;
      if (el.getAttribute && lc(el.getAttribute('disabled')) === 'true') return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function clickElement(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    try { el.focus({ preventScroll: true }); }
    catch (e) { try { el.focus(); } catch (e2) { /* ignore */ } }
    el.click();
  }

  // =====================================================================
  // 진단 정보 (오류 시 iframe hostname + 화면 버튼 문구)
  // =====================================================================

  function diagnostics() {
    const buttons = [];
    forEachElementDeep(function (el) {
      if (buttons.length >= 20) return;
      if (!isClickable(el) || !isVisible(el)) return;
      const t = normText(el);
      if (!t) return;
      if (buttons.indexOf(t) === -1) buttons.push(t);
    });
    let hostname = '';
    let url = '';
    try { hostname = location.hostname; } catch (e) { hostname = ''; }
    try { url = location.href; } catch (e) { url = ''; }
    return { hostname: hostname, url: url, buttons: buttons.slice(0, 20) };
  }

  // =====================================================================
  // 오류 팝업 탐색
  // =====================================================================

  function findErrorElement() {
    let found = null;
    forEachElementDeep(function (el) {
      if (found) return;
      if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.tagName === 'SCRIPT') return;
      const t = lc(normText(el));
      if (!t) return;
      for (let i = 0; i < ERROR_TEXTS.length; i++) {
        if (t.indexOf(lc(ERROR_TEXTS[i])) !== -1) { found = el; return; }
      }
    });
    return found;
  }

  // 오류 팝업 내부의 Cancel 버튼 우선 선택
  function pickCancelNear(cands, errEl) {
    let fallback = null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (!isVisible(c) || !isEnabled(c)) continue;
      if (errEl) {
        let node = c;
        let depth = 0;
        while (node && depth < 12) {
          if (node === errEl) return c;
          let parent = node.parentElement;
          if (!parent && node.getRootNode) {
            const root = node.getRootNode();
            parent = (root && root.host) ? root.host : null;
          }
          node = parent;
          depth++;
        }
      }
      if (!fallback) fallback = c;
    }
    return fallback;
  }

  // =====================================================================
  // 단계 정의: locate(부작용 없음) / act(실제 수행)
  // =====================================================================

  function locateRenew() {
    const cands = collectCandidates(RENEW_SELECTORS, RENEW_ATTR_HINTS, RENEW_TEXTS);
    if (!cands.length) return { found: false, reason: 'renew-not-found', diag: diagnostics() };
    const pick = chooseYouTubePreferred(cands);
    const el = pick.chosen;
    if (!el) return { found: false, reason: 'renew-not-found', diag: diagnostics() };
    if (!isVisible(el)) return { found: false, reason: 'renew-invisible', diag: diagnostics() };
    if (!isEnabled(el)) return { found: false, reason: 'renew-disabled', diag: diagnostics() };
    return { found: true, yt: pick.yt, ambiguous: pick.ambiguous, text: normText(el), diag: diagnostics() };
  }

  function actRenew() {
    const cands = collectCandidates(RENEW_SELECTORS, RENEW_ATTR_HINTS, RENEW_TEXTS);
    const pick = chooseYouTubePreferred(cands);
    const el = pick.chosen;
    if (!el) return { ok: false, reason: 'renew-not-found', diag: diagnostics() };
    if (!isVisible(el)) return { ok: false, reason: 'renew-invisible', diag: diagnostics() };
    if (!isEnabled(el)) return { ok: false, reason: 'renew-disabled', diag: diagnostics() };
    clickElement(el);
    return { ok: true, step: 'renew', text: normText(el), yt: pick.yt, diag: diagnostics() };
  }

  function locateConfirm() {
    const cands = collectCandidates(CONFIRM_SELECTORS, null, CONFIRM_TEXTS);
    const el = firstClickable(cands);
    if (!el) return { found: false, reason: cands.length ? 'confirm-not-ready' : 'confirm-not-found', diag: diagnostics() };
    return { found: true, text: normText(el), diag: diagnostics() };
  }

  function actConfirm() {
    const cands = collectCandidates(CONFIRM_SELECTORS, null, CONFIRM_TEXTS);
    const el = firstClickable(cands);
    if (!el) return { ok: false, reason: 'confirm-not-clickable', diag: diagnostics() };
    clickElement(el);
    return { ok: true, step: 'confirm', text: normText(el), diag: diagnostics() };
  }

  function locateCancel() {
    const errEl = findErrorElement();
    if (!errEl) return { found: false, reason: 'no-error-popup', diag: diagnostics() };
    const cands = collectCandidates(CANCEL_SELECTORS, null, CANCEL_TEXTS);
    const el = pickCancelNear(cands, errEl);
    if (!el) return { found: false, reason: 'cancel-not-found', diag: diagnostics() };
    return { found: true, text: normText(el), diag: diagnostics() };
  }

  function actCancel() {
    const errEl = findErrorElement();
    if (!errEl) return { ok: false, reason: 'no-error-popup', diag: diagnostics() };
    const cands = collectCandidates(CANCEL_SELECTORS, null, CANCEL_TEXTS);
    const el = pickCancelNear(cands, errEl);
    if (!el) return { ok: false, reason: 'cancel-not-clickable', diag: diagnostics() };
    clickElement(el);
    return { ok: true, step: 'cancel', text: normText(el), diag: diagnostics() };
  }

  // Cancel 클릭 후 실제로 팝업이 닫혔는지(또는 Renew 가 다시 보이는지) 검증
  function locateVerifyCancel() {
    if (!findErrorElement()) return { found: true, reason: 'error-gone', diag: diagnostics() };
    const renewCands = collectCandidates(RENEW_SELECTORS, RENEW_ATTR_HINTS, RENEW_TEXTS);
    for (let i = 0; i < renewCands.length; i++) {
      if (isVisible(renewCands[i]) && isEnabled(renewCands[i])) {
        return { found: true, reason: 'renew-present', diag: diagnostics() };
      }
    }
    return { found: false, reason: 'popup-still-open', diag: diagnostics() };
  }

  // =====================================================================
  // 외부(백그라운드)에 노출
  // =====================================================================

  function locate(step) {
    try {
      if (step === 'renew') return locateRenew();
      if (step === 'confirm') return locateConfirm();
      if (step === 'cancel') return locateCancel();
      if (step === 'verifyCancel') return locateVerifyCancel();
      return { found: false, reason: 'unknown-step' };
    } catch (e) {
      return { found: false, reason: 'exception', error: String((e && e.message) || e) };
    }
  }

  function act(step) {
    try {
      if (step === 'renew') return actRenew();
      if (step === 'confirm') return actConfirm();
      if (step === 'cancel') return actCancel();
      if (step === 'verifyCancel') return locateVerifyCancel();
      return { ok: false, reason: 'unknown-step' };
    } catch (e) {
      return { ok: false, reason: 'exception', error: String((e && e.message) || e) };
    }
  }

  window.__AppleRenewLoop = {
    version: '1.0.0',
    locate: locate,
    act: act,
    constants: {
      RENEW_SELECTORS: RENEW_SELECTORS,
      RENEW_ATTR_HINTS: RENEW_ATTR_HINTS,
      RENEW_TEXTS: RENEW_TEXTS,
      CONFIRM_SELECTORS: CONFIRM_SELECTORS,
      CONFIRM_TEXTS: CONFIRM_TEXTS,
      CANCEL_SELECTORS: CANCEL_SELECTORS,
      CANCEL_TEXTS: CANCEL_TEXTS,
      ERROR_TEXTS: ERROR_TEXTS
    }
  };
})();
