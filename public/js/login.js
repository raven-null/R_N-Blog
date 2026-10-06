/* ==========================================================================
   渡鸦_NULL · 博客后台登录页交互
   --------------------------------------------------------------------------
   改造自一个 MIT 协议的开源动画登录页。职责边界写死如下：
     · 只负责「登录页的交互与角色动画」，不实现任何认证逻辑；
     · 提交时只调用后台提供的全局函数 doLogin()（无参数）；
     · 不发 fetch、不写 localStorage、不读密钥；
     · 后台失败时会做 errEl.style.display = 'block' + errEl.textContent = '...'，
       本脚本用 MutationObserver 观察 #loginError，据此播放「沮丧摇头」动画；
     · 初始化时把 #loginError 置空，用户重新输入时清空错误。

   兼容：传统脚本（非 ESM），IIFE 包裹，末尾没有 export，可直接 node --check；
   所有 getElementById 结果都做存在性判断，元素缺失时静默降级、不抛错。
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  var SHAKE_CLASS = "lg-shake-head";
  var VISIBLE_CLASS = "lg-visible";
  var BLINK_DELAY_BASE = 3000;
  var BLINK_DELAY_RANGE = 4000;
  var BLINK_DURATION = 150;
  var ERROR_RECOVER_DELAY = 2500;
  var SHAKE_DELAY = 350; /* 等身体的 0.7s 转身过渡走完再摇头 */
  var LOOK_AT_EACH_OTHER_DURATION = 800;

  /* ------------------------------------------------------------------ *
   * 「减少动效」偏好
   * ------------------------------------------------------------------ */

  var motionQuery = null;
  var reducedMotion = false;

  try {
    motionQuery = window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  } catch (err) {
    motionQuery = null;
  }

  reducedMotion = !!(motionQuery && motionQuery.matches);

  /* ------------------------------------------------------------------ *
   * DOM 引用（全部做存在性判断）
   * ------------------------------------------------------------------ */

  function byId(id) {
    return document.getElementById(id);
  }

  var loginPage = byId("loginPage");
  var keyInput = byId("adminKeyInput");
  var loginForm = byId("lg-login-form");
  var submitBtn = byId("lg-btn-login");
  var errEl = byId("loginError");
  var toggleBtn = byId("lg-toggle-password");
  var eyeIcon = byId("lg-eye-icon");
  var eyeOffIcon = byId("lg-eye-off-icon");

  /* 登录页结构不存在时直接退出，绝不抛错 */
  if (!loginPage || !keyInput) {
    return;
  }

  /* 角色 DOM：任一项缺失就整体跳过动画（页面仍可正常登录） */
  var parts = {
    purple: byId("lg-char-purple"),
    black: byId("lg-char-black"),
    orange: byId("lg-char-orange"),
    yellow: byId("lg-char-yellow"),
    purpleEyes: byId("lg-purple-eyes"),
    purpleEyeL: byId("lg-purple-eye-l"),
    purpleEyeR: byId("lg-purple-eye-r"),
    purplePupilL: byId("lg-purple-pupil-l"),
    purplePupilR: byId("lg-purple-pupil-r"),
    blackEyes: byId("lg-black-eyes"),
    blackEyeL: byId("lg-black-eye-l"),
    blackEyeR: byId("lg-black-eye-r"),
    blackPupilL: byId("lg-black-pupil-l"),
    blackPupilR: byId("lg-black-pupil-r"),
    orangeEyes: byId("lg-orange-eyes"),
    orangePupilL: byId("lg-orange-pupil-l"),
    orangePupilR: byId("lg-orange-pupil-r"),
    orangeMouth: byId("lg-orange-mouth"),
    yellowEyes: byId("lg-yellow-eyes"),
    yellowPupilL: byId("lg-yellow-pupil-l"),
    yellowPupilR: byId("lg-yellow-pupil-r"),
    yellowMouth: byId("lg-yellow-mouth")
  };

  var charactersReady = Object.keys(parts).every(function (key) {
    return !!parts[key];
  });

  var shakeTargets = charactersReady
    ? [
        parts.purpleEyes,
        parts.blackEyes,
        parts.orangeEyes,
        parts.yellowEyes,
        parts.yellowMouth,
        parts.orangeMouth
      ]
    : [];

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var mouseX = 0;
  var mouseY = 0;
  var isTyping = false;
  var isPasswordFocused = false;
  var isLookingAtEachOther = false;
  var isLoginError = false;
  var showPassword = false;
  var isPurpleBlinking = false;
  var isBlackBlinking = false;
  var isPurplePeeking = false;
  var typingTimer = null;
  var errorRecoverTimer = null;
  var shakeTimer = null;
  var purpleBlinkRunning = false;
  var blackBlinkRunning = false;

  /* ------------------------------------------------------------------ *
   * 位置计算：鼠标跟随 / 瞳孔偏移
   * 「减少动效」时一律返回零点，角色保持静态造型不随鼠标摆动
   * ------------------------------------------------------------------ */

  function calcPosition(el) {
    if (reducedMotion || !el) {
      return { faceX: 0, faceY: 0, bodySkew: 0 };
    }

    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 3;
    var dx = mouseX - cx;
    var dy = mouseY - cy;
    var faceX = Math.max(-15, Math.min(15, dx / 20));
    var faceY = Math.max(-10, Math.min(10, dy / 30));
    var bodySkew = Math.max(-6, Math.min(6, -dx / 120));

    return { faceX: faceX, faceY: faceY, bodySkew: bodySkew };
  }

  function calcPupilOffset(el, maxDist) {
    if (reducedMotion || !el) {
      return { x: 0, y: 0 };
    }

    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = mouseX - cx;
    var dy = mouseY - cy;
    var dist = Math.min(Math.sqrt(dx * dx + dy * dy), maxDist);
    var angle = Math.atan2(dy, dx);

    return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
  }

  /* ------------------------------------------------------------------ *
   * 角色渲染
   * ------------------------------------------------------------------ */

  function updateCharacters() {
    if (!charactersReady) {
      return;
    }

    /* pwdLen 只用于「密码可见时的偷笑」，不参与任何校验 */
    var pwdLen = keyInput.value.length;
    var isShowingPwd = pwdLen > 0 && showPassword;
    /* 输入密码时转头回避（源项目核心交互）；失败沮丧造型优先级更高 */
    var isLookingAway = isPasswordFocused && !showPassword && !isLoginError;

    updatePurple(isShowingPwd, isLookingAway);
    updateBlack(isShowingPwd, isLookingAway);
    updateOrange(isShowingPwd, isLookingAway);
    updateYellow(isShowingPwd, isLookingAway);
  }

  function updatePurple(isShowingPwd, isLookingAway) {
    var purplePos = calcPosition(parts.purple);

    /* 身体 */
    if (isShowingPwd) {
      parts.purple.style.transform = "skewX(0deg)";
      parts.purple.style.height = "370px";
    } else if (isLookingAway) {
      parts.purple.style.transform = "skewX(-14deg) translateX(-20px)";
      parts.purple.style.height = "410px";
    } else if (isTyping) {
      parts.purple.style.transform =
        "skewX(" + (purplePos.bodySkew - 12) + "deg) translateX(40px)";
      parts.purple.style.height = "410px";
    } else {
      parts.purple.style.transform = "skewX(" + purplePos.bodySkew + "deg)";
      parts.purple.style.height = "370px";
    }

    /* 眨眼：减少动效时保持睁眼 */
    parts.purpleEyeL.style.height = isPurpleBlinking ? "2px" : "18px";
    parts.purpleEyeR.style.height = isPurpleBlinking ? "2px" : "18px";

    /* 眼睛 */
    if (isLoginError) {
      parts.purpleEyes.style.left = "30px";
      parts.purpleEyes.style.top = "55px";
      parts.purplePupilL.style.transform = "translate(-3px, 4px)";
      parts.purplePupilR.style.transform = "translate(-3px, 4px)";
    } else if (isLookingAway) {
      parts.purpleEyes.style.left = "20px";
      parts.purpleEyes.style.top = "25px";
      parts.purplePupilL.style.transform = "translate(-5px, -5px)";
      parts.purplePupilR.style.transform = "translate(-5px, -5px)";
    } else if (isShowingPwd) {
      parts.purpleEyes.style.left = "20px";
      parts.purpleEyes.style.top = "35px";
      var px = isPurplePeeking ? 4 : -4;
      var py = isPurplePeeking ? 5 : -4;
      parts.purplePupilL.style.transform = "translate(" + px + "px, " + py + "px)";
      parts.purplePupilR.style.transform = "translate(" + px + "px, " + py + "px)";
    } else if (isLookingAtEachOther) {
      parts.purpleEyes.style.left = "55px";
      parts.purpleEyes.style.top = "65px";
      parts.purplePupilL.style.transform = "translate(3px, 4px)";
      parts.purplePupilR.style.transform = "translate(3px, 4px)";
    } else {
      parts.purpleEyes.style.left = 45 + purplePos.faceX + "px";
      parts.purpleEyes.style.top = 40 + purplePos.faceY + "px";
      var po = calcPupilOffset(parts.purpleEyeL, 5);
      parts.purplePupilL.style.transform = "translate(" + po.x + "px, " + po.y + "px)";
      parts.purplePupilR.style.transform = "translate(" + po.x + "px, " + po.y + "px)";
    }
  }

  function updateBlack(isShowingPwd, isLookingAway) {
    var blackPos = calcPosition(parts.black);

    /* 身体 */
    if (isShowingPwd) {
      parts.black.style.transform = "skewX(0deg)";
    } else if (isLookingAway) {
      parts.black.style.transform = "skewX(12deg) translateX(-10px)";
    } else if (isLookingAtEachOther) {
      parts.black.style.transform =
        "skewX(" + (blackPos.bodySkew * 1.5 + 10) + "deg) translateX(20px)";
    } else if (isTyping) {
      parts.black.style.transform = "skewX(" + blackPos.bodySkew * 1.5 + "deg)";
    } else {
      parts.black.style.transform = "skewX(" + blackPos.bodySkew + "deg)";
    }

    /* 眨眼：减少动效时保持睁眼 */
    parts.blackEyeL.style.height = isBlackBlinking ? "2px" : "16px";
    parts.blackEyeR.style.height = isBlackBlinking ? "2px" : "16px";

    /* 眼睛 */
    if (isLoginError) {
      parts.blackEyes.style.left = "15px";
      parts.blackEyes.style.top = "40px";
      parts.blackPupilL.style.transform = "translate(-3px, 4px)";
      parts.blackPupilR.style.transform = "translate(-3px, 4px)";
    } else if (isLookingAway) {
      parts.blackEyes.style.left = "10px";
      parts.blackEyes.style.top = "20px";
      parts.blackPupilL.style.transform = "translate(-4px, -5px)";
      parts.blackPupilR.style.transform = "translate(-4px, -5px)";
    } else if (isShowingPwd) {
      parts.blackEyes.style.left = "10px";
      parts.blackEyes.style.top = "28px";
      parts.blackPupilL.style.transform = "translate(-4px, -4px)";
      parts.blackPupilR.style.transform = "translate(-4px, -4px)";
    } else if (isLookingAtEachOther) {
      parts.blackEyes.style.left = "32px";
      parts.blackEyes.style.top = "12px";
      parts.blackPupilL.style.transform = "translate(0px, -4px)";
      parts.blackPupilR.style.transform = "translate(0px, -4px)";
    } else {
      parts.blackEyes.style.left = 26 + blackPos.faceX + "px";
      parts.blackEyes.style.top = 32 + blackPos.faceY + "px";
      var bo = calcPupilOffset(parts.blackEyeL, 4);
      parts.blackPupilL.style.transform = "translate(" + bo.x + "px, " + bo.y + "px)";
      parts.blackPupilR.style.transform = "translate(" + bo.x + "px, " + bo.y + "px)";
    }
  }

  function updateOrange(isShowingPwd, isLookingAway) {
    var orangePos = calcPosition(parts.orange);

    /* 身体 */
    if (isShowingPwd) {
      parts.orange.style.transform = "skewX(0deg)";
    } else {
      parts.orange.style.transform = "skewX(" + orangePos.bodySkew + "deg)";
    }

    /* 嘴（沮丧造型时跟着脸走） */
    if (isLoginError) {
      parts.orangeMouth.style.left = 80 + orangePos.faceX + "px";
      parts.orangeMouth.style.top = "130px";
    }

    /* 眼睛 */
    if (isLoginError) {
      parts.orangeEyes.style.left = "60px";
      parts.orangeEyes.style.top = "95px";
      parts.orangePupilL.style.transform = "translate(-3px, 4px)";
      parts.orangePupilR.style.transform = "translate(-3px, 4px)";
    } else if (isLookingAway) {
      parts.orangeEyes.style.left = "50px";
      parts.orangeEyes.style.top = "75px";
      parts.orangePupilL.style.transform = "translate(-5px, -5px)";
      parts.orangePupilR.style.transform = "translate(-5px, -5px)";
    } else if (isShowingPwd) {
      parts.orangeEyes.style.left = "50px";
      parts.orangeEyes.style.top = "85px";
      parts.orangePupilL.style.transform = "translate(-5px, -4px)";
      parts.orangePupilR.style.transform = "translate(-5px, -4px)";
    } else {
      parts.orangeEyes.style.left = 82 + orangePos.faceX + "px";
      parts.orangeEyes.style.top = 90 + orangePos.faceY + "px";
      var oo = calcPupilOffset(parts.orangePupilL, 5);
      parts.orangePupilL.style.transform = "translate(" + oo.x + "px, " + oo.y + "px)";
      parts.orangePupilR.style.transform = "translate(" + oo.x + "px, " + oo.y + "px)";
    }
  }

  function updateYellow(isShowingPwd, isLookingAway) {
    var yellowPos = calcPosition(parts.yellow);

    /* 身体 */
    if (isShowingPwd) {
      parts.yellow.style.transform = "skewX(0deg)";
    } else {
      parts.yellow.style.transform = "skewX(" + yellowPos.bodySkew + "deg)";
    }

    /* 眼睛与嘴 */
    if (isLoginError) {
      parts.yellowEyes.style.left = "35px";
      parts.yellowEyes.style.top = "45px";
      parts.yellowPupilL.style.transform = "translate(-3px, 4px)";
      parts.yellowPupilR.style.transform = "translate(-3px, 4px)";
      parts.yellowMouth.style.left = "30px";
      parts.yellowMouth.style.top = "92px";
      parts.yellowMouth.style.transform = "rotate(-8deg)";
    } else if (isLookingAway) {
      parts.yellowEyes.style.left = "20px";
      parts.yellowEyes.style.top = "30px";
      parts.yellowPupilL.style.transform = "translate(-5px, -5px)";
      parts.yellowPupilR.style.transform = "translate(-5px, -5px)";
      parts.yellowMouth.style.left = "15px";
      parts.yellowMouth.style.top = "78px";
      parts.yellowMouth.style.transform = "rotate(0deg)";
    } else if (isShowingPwd) {
      parts.yellowEyes.style.left = "20px";
      parts.yellowEyes.style.top = "35px";
      parts.yellowPupilL.style.transform = "translate(-5px, -4px)";
      parts.yellowPupilR.style.transform = "translate(-5px, -4px)";
      parts.yellowMouth.style.left = "10px";
      parts.yellowMouth.style.top = "88px";
      parts.yellowMouth.style.transform = "rotate(0deg)";
    } else {
      parts.yellowEyes.style.left = 52 + yellowPos.faceX + "px";
      parts.yellowEyes.style.top = 40 + yellowPos.faceY + "px";
      var yo = calcPupilOffset(parts.yellowPupilL, 5);
      parts.yellowPupilL.style.transform = "translate(" + yo.x + "px, " + yo.y + "px)";
      parts.yellowPupilR.style.transform = "translate(" + yo.x + "px, " + yo.y + "px)";
      parts.yellowMouth.style.left = 40 + yellowPos.faceX + "px";
      parts.yellowMouth.style.top = 88 + yellowPos.faceY + "px";
      parts.yellowMouth.style.transform = "rotate(0deg)";
    }
  }

  /* ------------------------------------------------------------------ *
   * 输入状态：聚焦 / 失焦 / 打字
   * ------------------------------------------------------------------ */

  function setTyping(typing) {
    isTyping = typing;

    if (typing) {
      isLookingAtEachOther = true;
      if (typingTimer) {
        clearTimeout(typingTimer);
      }
      typingTimer = setTimeout(function () {
        isLookingAtEachOther = false;
        updateCharacters();
      }, LOOK_AT_EACH_OTHER_DURATION);
    } else {
      isLookingAtEachOther = false;
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
    }

    updateCharacters();
  }

  /* ------------------------------------------------------------------ *
   * 眨眼（随机）与「密码可见时的偷笑」
   * 减少动效时整条链不启动
   * ------------------------------------------------------------------ */

  function scheduleBlinkPurple() {
    if (reducedMotion || purpleBlinkRunning) {
      return;
    }

    purpleBlinkRunning = true;

    (function loop() {
      setTimeout(function () {
        if (reducedMotion) {
          purpleBlinkRunning = false;
          return;
        }

        isPurpleBlinking = true;
        updateCharacters();

        setTimeout(function () {
          isPurpleBlinking = false;
          updateCharacters();
          loop();
        }, BLINK_DURATION);
      }, Math.random() * BLINK_DELAY_RANGE + BLINK_DELAY_BASE);
    })();
  }

  function scheduleBlinkBlack() {
    if (reducedMotion || blackBlinkRunning) {
      return;
    }

    blackBlinkRunning = true;

    (function loop() {
      setTimeout(function () {
        if (reducedMotion) {
          blackBlinkRunning = false;
          return;
        }

        isBlackBlinking = true;
        updateCharacters();

        setTimeout(function () {
          isBlackBlinking = false;
          updateCharacters();
          loop();
        }, BLINK_DURATION);
      }, Math.random() * BLINK_DELAY_RANGE + BLINK_DELAY_BASE);
    })();
  }

  function schedulePeek() {
    if (reducedMotion || !showPassword || keyInput.value.length === 0) {
      return;
    }

    setTimeout(function () {
      if (reducedMotion || !showPassword || keyInput.value.length === 0) {
        return;
      }

      isPurplePeeking = true;
      updateCharacters();

      setTimeout(function () {
        isPurplePeeking = false;
        updateCharacters();
        schedulePeek();
      }, 800);
    }, Math.random() * 3000 + 2000);
  }

  /* ------------------------------------------------------------------ *
   * 错误态：登录失败时沮丧摇头
   * ------------------------------------------------------------------ */

  function resetErrorPose() {
    if (errorRecoverTimer) {
      clearTimeout(errorRecoverTimer);
      errorRecoverTimer = null;
    }

    if (shakeTimer) {
      clearTimeout(shakeTimer);
      shakeTimer = null;
    }

    isLoginError = false;

    shakeTargets.forEach(function (el) {
      el.classList.remove(SHAKE_CLASS);
    });

    if (charactersReady) {
      parts.orangeMouth.classList.remove(VISIBLE_CLASS);
    }

    updateCharacters();
  }

  function triggerLoginError() {
    if (!charactersReady) {
      return;
    }

    /* 可重复触发：先清掉上一次的定时器与动画类（resetErrorPose 内已含移除逻辑） */
    resetErrorPose();

    isLoginError = true;
    updateCharacters();

    /* 橙色角色的沮丧嘴 */
    parts.orangeMouth.classList.add(VISIBLE_CLASS);

    /* 强制回流，保证反复失败时摇头动画能重播 */
    void document.body.offsetHeight;

    if (!reducedMotion) {
      shakeTimer = setTimeout(function () {
        shakeTimer = null;
        shakeTargets.forEach(function (el) {
          el.classList.add(SHAKE_CLASS);
        });
      }, SHAKE_DELAY);
    }
    /* 减少动效：不加摇头动画类，只保留静态沮丧造型 */

    errorRecoverTimer = setTimeout(function () {
      errorRecoverTimer = null;
      resetErrorPose();
    }, ERROR_RECOVER_DELAY);
  }

  /* ------------------------------------------------------------------ *
   * #loginError 的读写
   * ------------------------------------------------------------------ */

  function clearError() {
    if (!errEl) {
      return;
    }

    if (errEl.textContent !== "") {
      errEl.textContent = "";
    }

    /* 把显示控制权还给样式表，避免残留的 inline display 影响下一次显示 */
    if (errEl.style.display) {
      errEl.style.display = "";
    }
  }

  function showError(message) {
    if (!errEl) {
      return;
    }

    errEl.textContent = message;
    errEl.style.display = "block";
  }

  function hasVisibleError() {
    return !!errEl && (errEl.textContent || "").trim().length > 0;
  }

  /* ------------------------------------------------------------------ *
   * 提交：一律走后台的全局 doLogin()，本脚本不做认证
   * ------------------------------------------------------------------ */

  function handleSubmit() {
    var key = keyInput.value.trim();

    if (!key) {
      showError("请输入管理密钥");
    } else {
      clearError();
    }

    if (typeof window.doLogin === "function") {
      window.doLogin();
    } else if (key) {
      showError("后台脚本未加载，请刷新页面重试");
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  keyInput.addEventListener("focus", function () {
    isPasswordFocused = true;
    setTyping(true);
  });

  keyInput.addEventListener("blur", function () {
    isPasswordFocused = false;
    setTyping(false);
  });

  keyInput.addEventListener("input", function () {
    /* 用户重新输入即清空错误，并解除沮丧造型 */
    if (hasVisibleError()) {
      clearError();
    }

    if (isLoginError) {
      resetErrorPose();
    } else {
      updateCharacters();
    }
  });

  if (loginForm) {
    loginForm.addEventListener("submit", function (event) {
      event.preventDefault();
      handleSubmit();
    });
  } else if (submitBtn) {
    submitBtn.addEventListener("click", function (event) {
      event.preventDefault();
      handleSubmit();
    });
  }

  if (toggleBtn) {
    toggleBtn.addEventListener("click", function () {
      showPassword = !showPassword;

      keyInput.type = showPassword ? "text" : "password";

      if (eyeIcon) {
        eyeIcon.style.display = showPassword ? "none" : "block";
      }

      if (eyeOffIcon) {
        eyeOffIcon.style.display = showPassword ? "block" : "none";
      }

      toggleBtn.setAttribute("aria-pressed", showPassword ? "true" : "false");
      toggleBtn.setAttribute(
        "aria-label",
        showPassword ? "隐藏管理密钥" : "显示管理密钥"
      );

      updateCharacters();

      if (showPassword) {
        schedulePeek();
      }
    });
  }

  document.addEventListener(
    "mousemove",
    function (event) {
      if (reducedMotion) {
        return;
      }

      mouseX = event.clientX;
      mouseY = event.clientY;

      if (!isTyping && !isLoginError) {
        updateCharacters();
      }
    },
    { passive: true }
  );

  /* ------------------------------------------------------------------ *
   * 后台失败 → 播放沮丧摇头
   * 后台只做 el.style.display='block' + el.textContent='密钥错误'，
   * 这里通过观察该元素感知失败，不做任何网络请求。
   * ------------------------------------------------------------------ */

  if (errEl && typeof MutationObserver === "function") {
    /* 观察者会随被观察节点一起存活，无需额外持有引用 */
    new MutationObserver(function () {
      if (hasVisibleError()) {
        triggerLoginError();
      }
    }).observe(errEl, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
  }

  /* 「减少动效」设置变化时实时生效 */
  function handleMotionPreferenceChange() {
    reducedMotion = !!(motionQuery && motionQuery.matches);

    if (!reducedMotion) {
      scheduleBlinkPurple();
      scheduleBlinkBlack();
    } else {
      isPurpleBlinking = false;
      isBlackBlinking = false;
      isPurplePeeking = false;
      mouseX = 0;
      mouseY = 0;
    }

    updateCharacters();
  }

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", handleMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(handleMotionPreferenceChange);
    }
  }

  /* ------------------------------------------------------------------ *
   * 初始化：先把错误提示清空，再首帧渲染
   * ------------------------------------------------------------------ */

  clearError();
  updateCharacters();
  scheduleBlinkPurple();
  scheduleBlinkBlack();
})();
