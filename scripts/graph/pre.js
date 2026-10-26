/*
 * 节点图 · 启动前补丁（注入位置：Weave 主脚本开头，早于 Weave 初始化）
 *
 * 只做一件事：清掉画布存档键。
 *
 * 为什么必须在初始化之前：Weave 启动时是同步读 localStorage 的（_loadStoredDoc），
 * 而所有节点图页面共用一个 origin，存档键 flow_data / flow_data_seq 彼此串用——
 * 打开节点图 B 会先看到节点图 A 的内容。趁启动之前清空，让它以空画布起来，
 * 随后由宿主补丁（post.js）从服务端装入真正的数据。
 *
 * 设置键（flow_settings / flow_lang / flow_custom_colors 等）不清：
 * 界面语言、键位这些是用户偏好，理应跨图延续。
 */
(function () {
  try {
    localStorage.removeItem("flow_data");
    localStorage.removeItem("flow_data_seq");
  } catch (e) {
    /* 隐私模式 / 存储被禁：忽略，Weave 自己也有保护 */
  }
})();
