/*
 * 节点图 · 启动前补丁（注入位置：Weave 主脚本开头，早于 Weave 初始化）
 *
 * 做两件事：
 *   1. 清掉画布存档键 —— Weave 启动时同步读 localStorage，而所有节点图页面共用
 *      一个 origin，存档键 flow_data / flow_data_seq 会互相串数据（打开图 B 先看到图 A 的内容）。
 *      趁启动之前清空，让它以空画布起来，随后由宿主补丁（post.js）从服务端装入真正的数据。
 *      设置键（flow_settings / flow_lang / flow_custom_colors 等）不清：界面语言这些是用户偏好。
 *   2. 挂兜底诊断 —— 画布起不来时把原因直接写在页面上，不用开 Console 也能看出是哪一步挂的。
 */
(function () {
  try {
    localStorage.removeItem("flow_data");
    localStorage.removeItem("flow_data_seq");
  } catch (e) {
    /* 隐私模式 / 存储被禁：忽略，Weave 自己也有保护 */
  }

  /* ---------- 兜底诊断 ---------- */
  function show(title, detail) {
    try {
      var box = document.getElementById("gg-diag");
      if (!box) {
        box = document.createElement("div");
        box.id = "gg-diag";
        box.style.cssText =
          "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;" +
          "max-width:92vw;max-height:62vh;overflow:auto;padding:12px 16px;border-radius:12px;" +
          "background:rgba(52,16,16,.96);border:1px solid rgba(239,106,94,.55);color:#ffd9d5;" +
          "font-size:12.5px;line-height:1.75;word-break:break-all;white-space:pre-wrap;text-align:left;" +
          "box-shadow:0 18px 48px rgba(0,0,0,.55);";
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent = title + "\n" + detail;
    } catch (e) {
      /* 连诊断都画不出来就算了，不要二次报错 */
    }
  }
  window.__ggDiag = show;

  window.addEventListener("error", function (e) {
    if (!e) return;
    var msg = e.message || "未知错误";
    var at = e.filename ? "\n@" + String(e.filename).split("/").pop() + ":" + (e.lineno || 0) : "";
    show("脚本出错", msg + at);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    show("未处理的 Promise 拒绝", String((r && (r.message || r)) || r));
  });

  // 3 秒后自检：Weave 到底起没起来
  window.addEventListener("load", function () {
    setTimeout(function () {
      var hasApp = false;
      var hasCanvas = false;
      try {
        hasApp = !!(window.App && window.App.canvasState);
        hasCanvas = !!document.getElementById("canvasContainer");
      } catch (e) {
        /* 忽略 */
      }
      if (!hasApp || !hasCanvas) {
        show(
          "节点图画布没有启动",
          "window.App = " + hasApp + "\ncanvasContainer = " + hasCanvas +
            "\n\n多半是 /graph.html 没有正确加载（404 / 部署未完成 / 被拦截）。" +
            "\n先 Ctrl+F5 强制刷新；仍不行就看这条提示上方的脚本错误。",
        );
      }
    }, 3000);
  });
})();
