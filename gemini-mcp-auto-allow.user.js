// ==UserScript==
// @name         Gemini MCP & Task Auto Always Allow (+ Auto Continue)
// @namespace    https://github.com/myh333777/gemini-auto-allow-userscript
// @version      2.3.4
// @description  Automatically clicks "始终允许" (Always allow) on Gemini confirmation cards, and optionally auto-replies "继续" when Gemini asks to proceed.
// @author       myh333777
// @match        https://gemini.google.com/*
// @homepageURL  https://github.com/myh333777/gemini-auto-allow-userscript
// @supportURL   https://github.com/myh333777/gemini-auto-allow-userscript/issues
// @updateURL    https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @downloadURL  https://raw.githubusercontent.com/myh333777/gemini-auto-allow-userscript/main/gemini-mcp-auto-allow.user.js
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_VERSION = '2.3.4';

  // ==================== 配置项 ====================
  const CLICK_DELAY_MS = 200; // 仅前台使用；后台标签页立即点击
  const RETRY_COOLDOWN_MS = 1500;
  const MAX_RETRIES = 5;
  const FALLBACK_POLL_MS = 2000;
  // 若卡片没有“始终允许”，是否回退点击“在此对话中允许”或“允许 / 允许一次”
  const FALLBACK_TO_CHAT_OR_ONCE = true;

  // -------- 自动回复“继续”配置 --------
  const AUTO_CONTINUE_DEFAULT = true; // 初始是否开启自动“继续”（可在右下角小胶囊一键切换）
  const CONTINUE_TEXT = '继续';
  const CONTINUE_STABLE_MS = 1800; // 模型停止输出后，等待文本稳定多久再发送
  const MAX_CONSECUTIVE_CONTINUES = 10; // 单次会话连续自动“继续”上限，防止无限循环耗尽额度
  const SHOW_STATUS_BADGE = true; // 是否在右下角显示极简状态胶囊
  // ==============================================

  const CARD_SELECTOR = 'remy-confirmation-card, remy-confirmation-card-v2';

  // 确认这是一张工具/权限审批卡片（必须同时存在拒绝/取消类按钮，避免误点普通横幅）
  const DENY_PATTERNS = [
    /^(不允许|拒绝|取消|不同意)$/i,
    /^(deny|don['’]t allow|disallow|decline|cancel|reject)$/i,
  ];

  // 按钮点击优先级：始终允许 > 本次对话允许 > 允许/允许一次
  const ALWAYS_ALLOW_PATTERNS = [
    /^(始终允许|总是允许)$/i,
    /^(always allow|allow always)$/i,
  ];

  const FALLBACK_ALLOW_PATTERNS = [
    /^(在此对话中允许|本对话允许)$/i,
    /^allow for this chat$/i,
    /^(允许一次|允许|同意)$/i,
    /^(allow once|allow|approve)$/i,
  ];

  // 识别“请求回复继续 / 确认进入下一步”的模糊匹配规则（按单句判定，同句共现即命中）
  const CONTINUE_SENTENCE_RULES = [
    // 同句共现：回复/输入/发送/确认/告知 + 继续/下一步/proceed/continue
    {
      a: /(?:回复|输入|发送|告诉|说一声|回个|确认|同意|告知|reply|type|say|send|confirm)/i,
      b: /(?:继续|下一步|往下|接着|proceed|continue)/i,
    },
    // 同句共现：询问是否继续
    {
      a: /(?:是否|要我|需要我|要不要|能否|可以|准备好|没问题|shall\s+i|should\s+i|would\s+you\s+like|want\s+me\s+to)/i,
      b: /(?:继续|下一步|往下|接着|proceed|continue)/i,
    },
    // 兜底短句：直接以“继续吗？”、“下一步？”、“continue?”结尾
    {
      a: /(?:继续|下一步|proceed|continue)\s*[吗？?]\s*$/i,
      b: /(?:继续|下一步|proceed|continue)/i,
    },
  ];

  // 否定/无法继续的句子不触发
  const CONTINUE_NEGATIVE_PATTERN = /(?:无法|不能|不再|暂停|停止|不要|不必|无需|别|勿|don['’]t|cannot|can['’]t|unable\s+to)\s*(?:继续|proceed|continue)/i;

  const buttonState = new WeakMap();
  const stuckSendState = new WeakMap();
  const STUCK_APPROVAL_SEND_DELAY_MS = 600;
  let scanScheduled = false;
  let clickCount = 0;
  let autoContinueEnabled = AUTO_CONTINUE_DEFAULT;
  let consecutiveContinues = 0;
  let lastHandledResponseKey = '';
  let pendingContinueTimer = null;
  let pendingContinueCandidateKey = '';
  let badgeEl = null;

  function markInjected() {
    if (document.documentElement) {
      document.documentElement.dataset.geminiAutoAllow = SCRIPT_VERSION;
      document.documentElement.dataset.geminiAutoAllowClicks = String(clickCount);
      document.documentElement.dataset.geminiAutoContinue = String(autoContinueEnabled);
    }
    updateBadge();
  }

  function ensureBadge() {
    if (!SHOW_STATUS_BADGE || badgeEl || !document.body) {
      return;
    }
    badgeEl = document.createElement('button');
    badgeEl.type = 'button';
    badgeEl.id = 'gemini-auto-allow-badge';
    badgeEl.title = '点击切换：自动回复“继续”开关';
    Object.assign(badgeEl.style, {
      position: 'fixed',
      right: '14px',
      bottom: '12px',
      zIndex: '99999',
      padding: '4px 10px',
      borderRadius: '999px',
      border: '1px solid rgba(128,128,128,0.28)',
      background: 'rgba(28, 28, 32, 0.78)',
      color: '#e8eaed',
      fontSize: '11px',
      lineHeight: '16px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      cursor: 'pointer',
      backdropFilter: 'blur(6px)',
      opacity: '0.72',
      transition: 'opacity 0.15s ease',
    });
    badgeEl.addEventListener('mouseenter', () => {
      badgeEl.style.opacity = '1';
    });
    badgeEl.addEventListener('mouseleave', () => {
      badgeEl.style.opacity = '0.72';
    });
    badgeEl.addEventListener('click', () => {
      autoContinueEnabled = !autoContinueEnabled;
      if (autoContinueEnabled) {
        consecutiveContinues = 0;
      } else if (pendingContinueTimer) {
        clearTimeout(pendingContinueTimer);
        pendingContinueTimer = null;
      }
      markInjected();
    });
    document.body.appendChild(badgeEl);
  }

  function updateBadge() {
    if (!SHOW_STATUS_BADGE) {
      return;
    }
    ensureBadge();
    if (!badgeEl) {
      return;
    }
    const contText = autoContinueEnabled
      ? `自动继续:开(${consecutiveContinues}/${MAX_CONSECUTIVE_CONTINUES})`
      : '自动继续:关';
    badgeEl.textContent = `自动允许:${clickCount} | ${contText}`;
  }

  function normalizeText(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
  }

  function isButtonEnabled(button) {
    if (!button || !button.isConnected) {
      return false;
    }
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    const gemBtn = button.closest('gem-button');
    if (
      gemBtn &&
      (gemBtn.hasAttribute('inert') ||
        gemBtn.classList.contains('gem-button-disabled'))
    ) {
      return false;
    }
    const style = window.getComputedStyle(button);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') === 0
    ) {
      return false;
    }
    // 后台标签页或未完成 layout 时不做死卡，前台才校验包围盒尺寸
    if (!document.hidden) {
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
    }
    return true;
  }

  function findTargetButton(card) {
    const buttons = [...card.querySelectorAll('button')];
    if (buttons.length === 0) {
      return null;
    }

    const hasDenyButton = buttons.some((btn) =>
      matchesAny(normalizeText(btn), DENY_PATTERNS)
    );
    if (!hasDenyButton) {
      return null;
    }

    const enabledButtons = buttons.filter(isButtonEnabled);
    for (const pattern of ALWAYS_ALLOW_PATTERNS) {
      const match = enabledButtons.find((btn) =>
        pattern.test(normalizeText(btn))
      );
      if (match) {
        return match;
      }
    }

    if (FALLBACK_TO_CHAT_OR_ONCE) {
      for (const pattern of FALLBACK_ALLOW_PATTERNS) {
        const match = enabledButtons.find((btn) =>
          pattern.test(normalizeText(btn))
        );
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  function triggerClick(button) {
    const eventInit = { bubbles: true, cancelable: true, view: window };
    try {
      if (typeof PointerEvent === 'function') {
        button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        button.dispatchEvent(new PointerEvent('pointerup', eventInit));
      }
      button.dispatchEvent(new MouseEvent('mousedown', eventInit));
      button.dispatchEvent(new MouseEvent('mouseup', eventInit));
    } catch (_) {
      // 忽略构造事件异常，继续执行原生 click()
    }
    button.click();
  }

  function handleCard(card) {
    const targetButton = findTargetButton(card);
    if (!targetButton) {
      return;
    }

    const now = Date.now();
    const state = buttonState.get(targetButton) || {
      pending: false,
      attempts: 0,
      lastAttemptAt: 0,
    };

    if (
      state.pending ||
      state.attempts >= MAX_RETRIES ||
      (state.lastAttemptAt > 0 && now - state.lastAttemptAt < RETRY_COOLDOWN_MS)
    ) {
      return;
    }

    state.pending = true;
    buttonState.set(targetButton, state);
    const label = normalizeText(targetButton);

    const doClick = () => {
      state.pending = false;
      if (isButtonEnabled(targetButton) && findTargetButton(card) === targetButton) {
        state.attempts += 1;
        state.lastAttemptAt = Date.now();
        buttonState.set(targetButton, state);

        triggerClick(targetButton);
        clickCount += 1;
        markInjected();
        console.info(
          `[Gemini Auto Allow] 已自动点击「${label}」（第 ${state.attempts} 次尝试，${document.hidden ? '后台' : '前台'}）`
        );
      }
    };

    if (document.hidden) {
      doClick();
    } else {
      window.setTimeout(doClick, CLICK_DELAY_MS);
    }
  }

  // ==================== 自动回复“继续”模块 ====================
  function isGenerating() {
    return Boolean(
      document.querySelector(
        'button[aria-label*="Stop"], button[aria-label*="停止"], .stop-icon'
      )
    );
  }

  function hasPendingConfirmationCard() {
    const cards = document.querySelectorAll(CARD_SELECTOR);
    for (const card of cards) {
      if (findTargetButton(card)) {
        return true;
      }
    }
    return false;
  }

  function getLastModelResponseInfo() {
    const responses = [...document.querySelectorAll('model-response')];
    if (responses.length === 0) {
      return null;
    }
    const last = responses[responses.length - 1];
    // 如果最后一条还包含未完成的权限卡片，先不发“继续”
    if (last.querySelector(CARD_SELECTOR) && hasPendingConfirmationCard()) {
      return null;
    }
    const contentEl = last.querySelector('message-content') || last;
    const fullText = normalizeText(contentEl);
    if (!fullText) {
      return null;
    }
    const tail = fullText.slice(-1200);
    const key = `${responses.length}:${fullText.length}:${tail.slice(-80)}`;
    return { key, tail };
  }

  function sendContinueReply() {
    const editor = document.querySelector(
      'rich-textarea .ql-editor, [contenteditable="true"][role="textbox"]'
    );
    if (!editor) {
      return false;
    }
    // 如果用户正在输入框里打字，绝不覆盖用户输入
    if (normalizeText(editor).length > 0) {
      return false;
    }

    editor.focus();
    editor.textContent = CONTINUE_TEXT;
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    const tryClickSend = () => {
      const sendBtn = document.querySelector(
        'button.send-button, button[aria-label*="Send"], button[aria-label*="发送"]'
      );
      if (sendBtn && isButtonEnabled(sendBtn)) {
        triggerClick(sendBtn);
        return true;
      }
      // 兜底：派发 Enter 键提交
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      return true;
    };

    window.setTimeout(tryClickSend, 120);
    return true;
  }

  function matchesContinueTail(tail) {
    // 按句子拆分，检查末尾 1200 字内的句子（覆盖“小标题写回复继续 + 下方列清单”的格式）
    const sentences = tail
      .split(/[\n。！？!?；;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    return sentences.some((sentence) => {
      if (CONTINUE_NEGATIVE_PATTERN.test(sentence)) {
        return false;
      }
      return CONTINUE_SENTENCE_RULES.some(
        (rule) => rule.a.test(sentence) && rule.b.test(sentence)
      );
    });
  }

  function checkAutoContinue() {
    if (!autoContinueEnabled) {
      return;
    }
    if (consecutiveContinues >= MAX_CONSECUTIVE_CONTINUES) {
      return;
    }
    if (isGenerating() || hasPendingConfirmationCard()) {
      if (pendingContinueTimer) {
        clearTimeout(pendingContinueTimer);
        pendingContinueTimer = null;
      }
      return;
    }

    const info = getLastModelResponseInfo();
    if (!info || info.key === lastHandledResponseKey) {
      return;
    }

    if (!matchesContinueTail(info.tail)) {
      return;
    }

    if (pendingContinueCandidateKey === info.key && pendingContinueTimer) {
      return;
    }

    if (pendingContinueTimer) {
      clearTimeout(pendingContinueTimer);
    }
    pendingContinueCandidateKey = info.key;

    const executeContinue = () => {
      pendingContinueTimer = null;
      if (!autoContinueEnabled || isGenerating() || hasPendingConfirmationCard()) {
        return;
      }
      const latest = getLastModelResponseInfo();
      if (!latest || latest.key !== info.key || latest.key === lastHandledResponseKey) {
        return;
      }
      if (sendContinueReply()) {
        lastHandledResponseKey = latest.key;
        consecutiveContinues += 1;
        markInjected();
        console.info(
          `[Gemini Auto Allow] 检测到继续提示，已自动回复「${CONTINUE_TEXT}」（${consecutiveContinues}/${MAX_CONSECUTIVE_CONTINUES}）`
        );
      }
    };

    if (document.hidden) {
      executeContinue();
    } else {
      pendingContinueTimer = window.setTimeout(executeContinue, CONTINUE_STABLE_MS);
    }
  }
  // ==============================================================

  // ==================== 滞留审批文本自动补发 ====================
  // Gemini 部分新版 MCP 卡片在点击“始终允许/允许”后，会把文案填入输入框但偶发不自动提交
  function flushStuckApprovalInput() {
    if (isGenerating() || hasPendingConfirmationCard()) {
      return;
    }

    const responses = [...document.querySelectorAll('model-response')];
    if (responses.length === 0) {
      return;
    }
    const lastResp = responses[responses.length - 1];
    const card = lastResp.querySelector(CARD_SELECTOR);
    if (!card) {
      return;
    }

    const editor = document.querySelector(
      'rich-textarea .ql-editor, [contenteditable="true"][role="textbox"]'
    );
    if (!editor) {
      return;
    }
    const editorText = normalizeText(editor);
    if (
      !editorText ||
      (!matchesAny(editorText, ALWAYS_ALLOW_PATTERNS) &&
        !matchesAny(editorText, FALLBACK_ALLOW_PATTERNS))
    ) {
      return;
    }

    const sendBtn = document.querySelector(
      'button.send-button, button[aria-label*="Send"], button[aria-label*="发送"]'
    );
    if (!sendBtn || !isButtonEnabled(sendBtn)) {
      return;
    }

    const now = Date.now();
    const state = stuckSendState.get(card) || {
      pending: false,
      attempts: 0,
      lastAttemptAt: 0,
    };
    if (
      state.pending ||
      state.attempts >= MAX_RETRIES ||
      (state.lastAttemptAt > 0 && now - state.lastAttemptAt < RETRY_COOLDOWN_MS)
    ) {
      return;
    }

    state.pending = true;
    stuckSendState.set(card, state);

    const doSend = () => {
      state.pending = false;
      if (isGenerating() || hasPendingConfirmationCard()) {
        return;
      }
      const currentText = normalizeText(editor);
      if (currentText !== editorText) {
        return;
      }
      const currentSendBtn = document.querySelector(
        'button.send-button, button[aria-label*="Send"], button[aria-label*="发送"]'
      );
      if (!currentSendBtn || !isButtonEnabled(currentSendBtn)) {
        return;
      }
      state.attempts += 1;
      state.lastAttemptAt = Date.now();
      stuckSendState.set(card, state);

      triggerClick(currentSendBtn);
      console.info(
        `[Gemini Auto Allow] 检测到滞留输入框的审批文本「${editorText}」，已自动点击发送（第 ${state.attempts} 次尝试）`
      );
    };

    if (document.hidden) {
      doSend();
    } else {
      window.setTimeout(doSend, STUCK_APPROVAL_SEND_DELAY_MS);
    }
  }
  // ==============================================================

  function scan() {
    scanScheduled = false;
    document.querySelectorAll(CARD_SELECTOR).forEach(handleCard);
    flushStuckApprovalInput();
    checkAutoContinue();
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    queueMicrotask(scan);
  }

  // 使用轻量内联 Web Worker 减轻后台普通节流（若浏览器彻底冻结标签页，则依赖 resume 事件恢复）
  function startBackgroundHeartbeat() {
    let fallbackTimer = null;
    const startFallback = () => {
      if (!fallbackTimer) {
        fallbackTimer = window.setInterval(scan, FALLBACK_POLL_MS);
      }
    };
    try {
      const workerCode = `setInterval(() => postMessage('tick'), ${FALLBACK_POLL_MS});`;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = scan;
      worker.onerror = startFallback;
    } catch (_) {
      startFallback();
    }
  }

  markInjected();
  console.info(`[Gemini Auto Allow] v${SCRIPT_VERSION} 已启动`);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'inert', 'class', 'style'],
  });

  startBackgroundHeartbeat();
  document.addEventListener('visibilitychange', scan);
  document.addEventListener('resume', scan);
  window.addEventListener('focus', scan);
  window.addEventListener('pageshow', scan);
  scan();
})();
