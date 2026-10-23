/**
 * 代码块编辑器（v2.0.0）
 * ------------------------------------------------------------------
 * 目标：在写作页里点开一段代码，像在 IDE 里写一样舒服。
 *
 * 为什么不用「直接改 Vditor 里的代码块」：
 *   Vditor 的 WYSIWYG 代码块是「隐藏源码 <pre class="vditor-wysiwyg__pre"> + 渲染预览」两层，
 *   实测在里面用 execCommand 插空格/换行会和 Lute 的内部重渲染打架 ——
 *   出现代码被吞字（`return` → `eturn`）、闭合花括号消失。所以改成：
 *   点代码块 → 弹出本模块的编辑器（<textarea>，原生撤销栈）→ 保存时整体写回 Markdown。
 *
 * 编辑器里的手感（全部自己接管，行为可预期）：
 *   Tab          插空格到下一个缩进位（2 空格）
 *   Shift+Tab    反缩进一级（有选区时整块反缩进）
 *   Enter        沿用上一行缩进；行尾是 { ( [ 时多缩进一级
 *               光标在 { } 之间时展开成三行并落回中间那行
 *               本行只剩空白且后面紧跟 ) ] } 时反缩进一级
 *   Backspace    光标前只有缩进空格 → 删一个缩进位（不合并行）
 *   Home / End   智能行首（先跳第一个非空格）
 *   Ctrl/Cmd+Enter  保存并关闭
 *   Esc          取消（有改动会先确认）
 *
 * 另外：行号、当前行高亮、语言可改、Tab 键不跑焦点、保存后光标位置尽量还原。
 *
 * 用法：CodeEditor.attach(vditor)   // admin-edit 的编辑器 after 回调里调用
 */
(function () {
    'use strict';

    var INDENT = '  ';
    var PAIR_OPEN = '{([';
    var PAIR_CLOSE = '})]';          // 与 PAIR_OPEN 逐位对应：{ → }  ( → )  [ → ]
    var INDENT_AFTER = /[{([]\s*$/;
    var DEDENT_BEFORE = /^[)\]}]/;

    var vditor = null;
    var overlay = null, textarea = null, gutter = null, langInput = null, dirty = false, curIndex = -1;

    function $(id) { return document.getElementById(id); }
    function editorRoot() {
        return document.querySelector('#eeVditor .vditor-wysiwyg') ||
            document.querySelector('#eeVditor .vditor-ir');
    }
    function toast(msg, type) {
        if (window.EE && window.EE.toast) window.EE.toast(msg, type);
    }

    /** 从 Markdown 里取出所有围栏代码块（带位置），顺序与 DOM 里的代码块一致 */
    function mdBlocks(md) {
        var out = [];
        var re = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
        var m;
        while ((m = re.exec(md))) {
            var fenceStart = m.index + m[1].length;
            out.push({
                lang: String(m[3] || '').trim(),
                code: m[4],
                start: fenceStart,
                end: fenceStart + m[0].length - m[1].length,
                fence: m[2]
            });
        }
        return out;
    }

    // ===== 构建浮层 =====
    function build() {
        if (overlay && overlay.parentNode) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'ee-codeedit';
        overlay.id = 'eeCodeEdit';
        overlay.innerHTML =
            '<div class="ee-codeedit-mask" data-act="cancel"></div>' +
            '<div class="ee-codeedit-box" role="dialog" aria-modal="true" aria-label="编辑代码块">' +
            '  <div class="ee-codeedit-head">' +
            '    <span class="ee-codeedit-title">编辑代码块</span>' +
            '    <input class="ee-codeedit-lang" id="eeCodeLang" placeholder="语言，如 js / python" autocomplete="off" spellcheck="false">' +
            '    <span class="ee-codeedit-tip">Tab 缩进 · Shift+Tab 反缩进 · Ctrl+Enter 保存</span>' +
            '    <span class="ee-codeedit-sp"></span>' +
            '    <button type="button" class="ee-btn" data-act="cancel">取消</button>' +
            '    <button type="button" class="ee-btn primary" data-act="save">保存</button>' +
            '  </div>' +
            '  <div class="ee-codeedit-body">' +
            '    <div class="ee-codeedit-gutter" id="eeCodeGutter"></div>' +
            '    <textarea id="eeCodeArea" class="ee-codeedit-area" spellcheck="false" autocomplete="off" ' +
            '      autocapitalize="off" autocorrect="off" wrap="off" aria-label="代码内容"></textarea>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(overlay);
        textarea = overlay.querySelector('#eeCodeArea');
        gutter = overlay.querySelector('#eeCodeGutter');
        langInput = overlay.querySelector('#eeCodeLang');

        overlay.addEventListener('click', function (e) {
            var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'save') save();
            else if (act === 'cancel') cancel();
        });
        textarea.addEventListener('input', function () { dirty = true; syncGutter(); });
        textarea.addEventListener('scroll', syncScroll);
        textarea.addEventListener('keydown', onKeydown);
        return overlay;
    }

    function syncGutter() {
        if (!gutter || !textarea) return;
        var lines = textarea.value.split('\n').length;
        var html = '';
        for (var i = 1; i <= lines; i++) html += '<span>' + i + '</span>';
        gutter.innerHTML = html;
        syncScroll();
    }
    function syncScroll() {
        if (!gutter || !textarea) return;
        gutter.scrollTop = textarea.scrollTop;
    }

    // ===== 打开 / 保存 / 取消 =====
    function openForBlock(blockEl) {
        if (!vditor) return;
        build();
        var root = editorRoot();
        if (!root) return;
        var domBlocks = Array.prototype.slice.call(root.querySelectorAll('.vditor-wysiwyg__block[data-type="code-block"]'));
        var idx = domBlocks.indexOf(blockEl);
        var md = vditor.getValue() || '';
        var blocks = mdBlocks(md);
        if (idx < 0 || !blocks[idx]) { toast('找不到这段代码块，请刷新后重试', 'error'); return; }
        curIndex = idx;
        dirty = false;
        textarea.value = blocks[idx].code;
        langInput.value = blocks[idx].lang.replace(/^language-/, '');
        overlay.classList.add('open');
        syncGutter();
        setTimeout(function () { try { textarea.focus(); } catch (e) { } }, 30);
    }

    function save() {
        if (!vditor || curIndex < 0) return close();
        var md = vditor.getValue() || '';
        var blocks = mdBlocks(md);
        var b = blocks[curIndex];
        if (!b) { toast('代码块已不在正文里，可能被改动了', 'error'); return close(); }
        var lang = (langInput.value || '').trim().replace(/[^\w+#.-]/g, '');
        var code = textarea.value.replace(/\r\n/g, '\n').replace(/\s+$/, '');   // 去掉尾部空白，避免生成空行
        var fence = b.fence || '```';
        var nextFence = fence + lang + '\n' + code + '\n' + fence;
        var next = md.slice(0, b.start) + nextFence + md.slice(b.end);
        if (next === md) return close();
        vditor.setValue(next);
        if (typeof window.eeMarkDirty === 'function') window.eeMarkDirty();
        toast('代码已更新', 'success');
        close();
    }

    function cancel() {
        if (dirty && !window.confirm('这段代码还没保存，确定放弃改动？')) return;
        close();
    }

    function close() {
        if (overlay) overlay.classList.remove('open');
        dirty = false;
        curIndex = -1;
    }

    // ===== 文本编辑手感 =====
    function indentOfLine(line) {
        var m = line.match(/^[ \t]*/);
        return m ? m[0] : '';
    }

    function replaceSelection(text, keepCaretDelta) {
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var val = textarea.value;
        textarea.value = val.slice(0, start) + text + val.slice(end);
        var caret = start + (keepCaretDelta == null ? text.length : keepCaretDelta);
        textarea.selectionStart = textarea.selectionEnd = caret;
        dirty = true;
        syncGutter();
    }

    /** 对选中的每一行做操作（fn 返回替换后的行） */
    function mapSelectedLines(fn) {
        var val = textarea.value;
        var selStart = textarea.selectionStart, selEnd = textarea.selectionEnd;
        var lineStart = val.lastIndexOf('\n', selStart - 1) + 1;
        var lineEnd = val.indexOf('\n', selEnd);
        if (lineEnd < 0) lineEnd = val.length;
        var head = val.slice(0, lineStart), body = val.slice(lineStart, lineEnd), tail = val.slice(lineEnd);
        var lines = body.split('\n').map(fn);
        var nextBody = lines.join('\n');
        textarea.value = head + nextBody + tail;
        // 选区尽量保留（长度变化后夹在合法范围内）
        var delta = nextBody.length - body.length;
        textarea.selectionStart = selStart;
        textarea.selectionEnd = Math.max(selStart, selEnd + delta);
        dirty = true;
        syncGutter();
    }

    function onKeydown(e) {
        var mod = e.ctrlKey || e.metaKey;
        if (mod && e.key === 'Enter') { e.preventDefault(); save(); return; }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
        if (mod) return;   // 其它 Ctrl 组合交给浏览器（撤销/复制等）

        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                mapSelectedLines(function (line) {
                    var ind = indentOfLine(line);
                    if (!ind) return line;
                    return line.slice(Math.min(INDENT.length, ind.length));
                });
            } else if (textarea.selectionStart !== textarea.selectionEnd) {
                mapSelectedLines(function (line) { return INDENT + line; });
            } else {
                var col = textarea.selectionStart - (textarea.value.lastIndexOf('\n', textarea.selectionStart - 1) + 1);
                var need = INDENT.length - (col % INDENT.length);
                replaceSelection(new Array(need + 1).join(' '));
            }
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            var val = textarea.value;
            var pos = textarea.selectionStart;
            var ls = val.lastIndexOf('\n', pos - 1) + 1;
            var le = val.indexOf('\n', pos);
            if (le < 0) le = val.length;
            var line = val.slice(ls, le);
            var before = val.slice(ls, pos);
            var after = val.slice(pos, le);
            var ind = indentOfLine(line);
            var prevChar = val.charAt(pos - 1);
            var nextChar = val.charAt(pos);

            // 光标正好在成对括号之间 → 展开三行（落回中间那行）
            var openIdx = PAIR_OPEN.indexOf(prevChar);
            if (openIdx >= 0 && PAIR_CLOSE.charAt(openIdx) === nextChar) {
                replaceSelection('\n' + ind + INDENT + '\n' + ind, ind.length + 1 + INDENT.length);
                return;
            }
            // 本行只剩空白、后面紧跟收尾括号 → 反缩进一级
            if (/^\s*$/.test(before) && DEDENT_BEFORE.test(after)) {
                var outdent = ind.length >= INDENT.length ? ind.slice(0, ind.length - INDENT.length) : '';
                // 把本行已有缩进替换成 outdent + 换行
                textarea.setSelectionRange(ls, pos);
                replaceSelection('\n' + outdent);
                return;
            }
            var nextInd = ind + (INDENT_AFTER.test(before) ? INDENT : '');
            replaceSelection('\n' + nextInd);
            return;
        }

        if (e.key === 'Backspace') {
            var v = textarea.value;
            var p = textarea.selectionStart;
            if (p === textarea.selectionEnd) {
                var lstart = v.lastIndexOf('\n', p - 1) + 1;
                var pre = v.slice(lstart, p);
                if (pre.length && /^[ ]+$/.test(pre)) {
                    e.preventDefault();
                    var cut = Math.min(INDENT.length, pre.length);
                    textarea.setSelectionRange(p - cut, p);
                    replaceSelection('', 0);
                    textarea.selectionStart = textarea.selectionEnd = p - cut;
                    return;
                }
            }
            return;
        }

        if (e.key === 'Home') {
            var vv = textarea.value;
            var pp = textarea.selectionStart;
            if (pp !== textarea.selectionEnd) return;      // 有选区交给浏览器
            var l0 = vv.lastIndexOf('\n', pp - 1) + 1;
            var lineText = vv.slice(l0, vv.indexOf('\n', l0) < 0 ? vv.length : vv.indexOf('\n', l0));
            var ind2 = indentOfLine(lineText);
            var firstCode = l0 + ind2.length;
            e.preventDefault();
            var target = (pp === firstCode) ? l0 : firstCode;
            textarea.selectionStart = textarea.selectionEnd = target;
        }
    }

    // ===== 挂载：给每个代码块加一个「编辑代码」按钮 =====
    function decorate(root) {
        if (!root) return;
        var blocks = root.querySelectorAll('.vditor-wysiwyg__block[data-type="code-block"]');
        Array.prototype.forEach.call(blocks, function (block) {
            if (block.dataset.eeCodeEdit === '1') return;
            block.dataset.eeCodeEdit = '1';
            var preview = block.querySelector('.vditor-wysiwyg__preview');
            if (!preview) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ee-codeedit-btn';
            btn.textContent = '编辑代码';
            btn.title = '在独立编辑器里写这段代码（Tab 缩进 / 自动缩进 / 行号）';
            // 阻止冒泡：Vditor 会监听点击切到「源码内联编辑」，这里只要我们的浮层
            btn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openForBlock(block);
            });
            preview.appendChild(btn);
        });
    }

    /** 双击代码块也能打开（比找按钮快） */
    function onDblClick(e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var block = t.closest('.vditor-wysiwyg__block[data-type="code-block"]');
        if (!block) return;
        if (t.closest('.ee-codeedit-btn')) return;
        e.preventDefault();
        e.stopPropagation();
        openForBlock(block);
    }

    function attach(vd) {
        vditor = vd;
        var host = $('eeVditor');
        if (!host) return false;
        build();
        var root = editorRoot();
        decorate(root);
        host.addEventListener('dblclick', onDblClick, true);
        // 内容变化后（Vditor 会重建代码块 DOM）重新补按钮
        var obs = new MutationObserver(function () {
            var r = editorRoot();
            if (r) decorate(r);
        });
        obs.observe(host, { childList: true, subtree: true });
        return true;
    }

    window.CodeEditor = {
        attach: attach,
        open: openForBlock,
        save: save,
        close: close,
        INDENT: INDENT,
        _mdBlocks: mdBlocks
    };
})();
