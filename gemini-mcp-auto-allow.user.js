// ==UserScript==
// @name         Gemini MCP & Task Auto Always Allow
// @namespace    https://github.com/myh333777/gemini-auto-allow-userscript
// @version      2.1.0
// @description  Automatically clicks "始终允许" (Always allow) — or fallback Allow — on Gemini confirmation cards across Chat & Task modes.
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

  const SCRIPT_VERSION = '2.1.0';

  // ==================== 配置项 ====================
  const CLICK_DELAY_MS = 200;
  const RETRY_COOLDOWN_MS = 1500;
  const MAX_RETRIES = 5;
  const FALLBACK_POLL_MS = 2000;
  // 若卡片没有“始终允许”，是否回退点击“在此对话中允许”或“允许 / 允许一次”
  const FALLBACK_TO_CHAT_OR_ONCE = true;
  // ==============================================

  const CARD_SELECTOR = 'remy-confirmation-card, remy-confirmation-card-v2';

  // 确认这是一张工具/权限审批卡片（必须同时存在拒绝类按钮，避免误点普通横幅）
  const DENY_PATTERNS = [
    /^(不允许|拒绝)$/i,
    /^(deny|don['’]t allow|disallow|decline)$/i,
  ];

  // 按钮点击优先级：始终允许 > 本次对话允许 > 允许/允许一次
  const ALWAYS_ALLOW_PATTERNS = [
    /^(始终允许|总是允许)$/i,
    /^(always allow|allow always)$/i,
  ];

  const FALLBACK_ALLOW_PATTERNS = [
    /^(在此对话中允许|本对话允许)$/i,
    /^allow for this chat$/i,
    /^(允许一次|允许)$/i,
    /^(allow once|allow)$/i,
  ];

  // 记录每个按钮的调度状态：{ pending: boolean, attempts: number, lastAttemptAt: number }
  const buttonState = new WeakMap();
  let scanScheduled = false;
  let clickCount = 0;

  function markInjected() {
    if (document.documentElement) {
      document.documentElement.dataset.geminiAutoAllow = SCRIPT_VERSION;
      document.documentElement.dataset.geminiAutoAllowClicks = String(clickCount);
    }
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
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findTargetButton(card) {
    const buttons = [...card.querySelectorAll('button')];
    if (buttons.length === 0) {
      return null;
    }

    // 1. 先确认卡片内存在“不允许 / 拒绝”按钮（确保是权限确认卡片）
    const hasDenyButton = buttons.some((btn) =>
      matchesAny(normalizeText(btn), DENY_PATTERNS)
    );
    if (!hasDenyButton) {
      return null;
    }

    // 2. 优先匹配“始终允许 / Always allow”
    const enabledButtons = buttons.filter(isButtonEnabled);
    for (const pattern of ALWAYS_ALLOW_PATTERNS) {
      const match = enabledButtons.find((btn) =>
        pattern.test(normalizeText(btn))
      );
      if (match) {
        return match;
      }
    }

    // 3. 按需回退匹配“在此对话中允许 / 允许一次 / 允许”
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
    // 补充鼠标按下/抬起与原生 click，兼容 Angular Material / JSAction 事件委派
    try {
      button.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })
      );
      button.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })
      );
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

    window.setTimeout(() => {
      state.pending = false;
      if (isButtonEnabled(targetButton) && findTargetButton(card) === targetButton) {
        state.attempts += 1;
        state.lastAttemptAt = Date.now();
        buttonState.set(targetButton, state);

        triggerClick(targetButton);
        clickCount += 1;
        markInjected();
        console.info(
          `[Gemini Auto Allow] 已自动点击「${label}」（第 ${state.attempts} 次尝试）`
        );
      }
    }, CLICK_DELAY_MS);
  }

  function scan() {
    scanScheduled = false;
    document.querySelectorAll(CARD_SELECTOR).forEach(handleCard);
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    window.setTimeout(scan, 50);
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

  // 定期兜底巡检，覆盖重试冷却结束或后台节流唤醒后的待审批卡片
  window.setInterval(scan, FALLBACK_POLL_MS);
  scan();
})();
