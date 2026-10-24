/**
 * 写作页「术语」页签：搜索 + 列表 + 单条编辑（v1.0.0）
 * ------------------------------------------------------------------
 * v3.45.0 把术语从「属性 → 更多设置」里搬出来单独成一页，因为要做两件属性区放不下的事：
 *
 *   1. **给术语写解释**：自己写一段说明，或者从正文里选一句话当解释。
 *      存进词条的 def / quote 字段（正文本身一个字都不改，仍然只有元数据）。
 *   2. **快捷搜索**：术语多了以后要能一句话找到它；搜到但还没标成术语的词，
 *      可以当场标记（这就是「快捷搜索」的闭环）。
 *
 * 数据仍然由 admin-edit.js 持有（terms 数组 + 未保存标记 + 编辑器高亮），
 * 本模块只做界面，通过 init() 注入的读写回调操作它。
 *
 * 用法：
 *     TermEditor.init({
 *         host: $('eeSideTerms'),
 *         getTerms, setTerm, removeTerm, markTerm,
 *         findInContent,       // 词在正文里的出现次数
 *         locate,              // 滚到正文里这个词的位置并闪一下
 *         selectionText,       // 编辑器里当前选中的文字（没有则空串）
 *         anchorToCaret,       // 把锚点设成光标所在段落
 *         resetAnchor,         // 锚点改回「首次出现」
 *         onShow               // 面板显示时调用（重画）
 *     });
 */
(function () {
    'use strict';

    var els = {};
    var host = null;
    var api = {};
    var editing = '';        // 正在编辑的词（空 = 列表态）
    var keyword = '';        // 搜索关键词
    var decorOk = false;     // 编辑区高亮是否可用（决定要不要显示颜色图例）

    function el(tag, cls, text) {
        var d = document.createElement(tag);
        if (cls) d.className = cls;
        if (text != null) d.textContent = text;
        return d;
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 一个词条当前「解释」的来源：def（自写）> quote（正文语句）> 锚点段落 */
    function defOf(t) {
        if (!t) return { kind: 'none', text: '' };
        if (t.def) return { kind: 'def', text: t.def };
        if (t.quote) return { kind: 'quote', text: t.quote };
        return { kind: 'anchor', text: '' };
    }

    function build() {
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        host.innerHTML = '';
        var wrap = el('div', 'ee-terms');

        // ---- 搜索行 ----
        var searchRow = el('div', 'ee-terms-search');
        els.input = document.createElement('input');
        els.input.type = 'search';
        els.input.id = 'eeTermSearch';
        els.input.className = 'ee-rel-search';
        els.input.placeholder = '搜术语，或输入正文里的词…';
        els.input.autocomplete = 'off';
        els.input.addEventListener('input', function () {
            keyword = els.input.value.trim();
            editing = '';
            paint();
        });
        els.input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                els.input.value = '';
                keyword = '';
                editing = '';
                paint();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                quickSearch();
            }
        });
        searchRow.appendChild(els.input);
        var quick = el('button', 'ee-btn', '搜索');
        quick.type = 'button';
        quick.title = '回车同效：正文里跳到这个词，没有的话可以就地标成术语';
        quick.addEventListener('click', quickSearch);
        searchRow.appendChild(quick);
        wrap.appendChild(searchRow);

        els.hint = el('div', 'ee-terms-hint');
        wrap.appendChild(els.hint);

        els.list = el('div', 'ee-terms-list');
        els.list.id = 'eeTermsList';   // 沿用老 id，既有验证套件不用改
        wrap.appendChild(els.list);

        els.editor = el('div', 'ee-terms-editor');
        els.editor.id = 'eeTermEditor';
        els.editor.hidden = true;
        wrap.appendChild(els.editor);

        host.appendChild(wrap);
    }

    /** 搜索框回车：词已在术语里 → 定位正文并进入编辑；正文里有但没标记 → 就地标记 */
    function quickSearch() {
        var word = String(keyword || '').trim();
        if (!word) return;
        var terms = (api.getTerms && api.getTerms()) || [];
        var hit = terms.filter(function (t) { return t.word === word; })[0];
        if (hit) {
            editing = hit.word;
            if (api.locate) api.locate(hit.word);
            paint();
            return;
        }
        var n = api.findInContent ? api.findInContent(word) : 0;
        if (n > 0 && api.markTerm) {
            api.markTerm(word);
            editing = word;
            paint();
            return;
        }
        if (api.toast) api.toast(n > 0 ? '已标记为术语「' + word + '」' : '正文里没有找到「' + word + '」', n > 0 ? 'success' : 'error');
    }

    function paint() {
        if (!els.list) return;
        var terms = (api.getTerms && api.getTerms()) || [];

        // 搜索过滤（按词与解释文本都能命中）
        var kw = keyword.toLowerCase();
        var shown = kw
            ? terms.filter(function (t) {
                return String(t.word).toLowerCase().indexOf(kw) >= 0 ||
                    String(t.def || '').toLowerCase().indexOf(kw) >= 0 ||
                    String(t.quote || '').toLowerCase().indexOf(kw) >= 0;
            })
            : terms;

        // 顶部提示：数量和「搜不到但是正文里有」的补标记入口
        els.hint.innerHTML = '';
        if (!terms.length) {
            els.hint.textContent = '还没有术语。正文里选中一个词 → 右键「标记为术语」，或在上面的搜索框里输入再回车。';
        } else if (kw) {
            var exists = api.findInContent ? api.findInContent(keyword) : 0;
            var already = terms.some(function (t) { return t.word === keyword; });
            els.hint.innerHTML = '共 ' + terms.length + ' 条，匹配 ' + shown.length + ' 条' +
                (!already && exists > 0 ? '　<span class="ee-terms-add">正文里有「' + esc(keyword) + '」×' + exists + '，<button type="button" class="ee-terms-link" data-add="' + esc(keyword) + '">标成术语</button></span>' : '') +
                (!already && !exists ? '　<span class="ee-terms-dim">正文里没有「' + esc(keyword) + '」</span>' : '');
            var addBtn = els.hint.querySelector('[data-add]');
            if (addBtn) addBtn.addEventListener('click', function () {
                var w = this.getAttribute('data-add');
                if (api.markTerm) api.markTerm(w);
                editing = w;
                keyword = '';
                els.input.value = '';
                paint();
            });
        } else {
            els.hint.textContent = '共 ' + terms.length + ' 条术语 · 点一条编辑它的解释';
        }

        // 列表
        els.list.innerHTML = '';
        // 颜色图例：解释编辑区里两种高亮颜色的含义（与旧面板那条保持一致）
        if (terms.length && decorOk) {
            var legend = el('div', 'ee-term-legend');
            legend.innerHTML = '<span class="lg-anchor"></span>定义锚点<span class="lg-link"></span>其余出现（前台会变成回链）';
            els.list.appendChild(legend);
        }
        if (!shown.length) {
            if (terms.length) els.list.appendChild(el('div', 'ee-terms-empty', '没有匹配的术语'));
        }
        shown.forEach(function (t) {
            var row = el('div', 'ee-term-item');
            row.setAttribute('data-word', t.word);
            if (t.word === editing) row.classList.add('active');
            var d = defOf(t);
            var badge = d.kind === 'def' ? '自写解释' : (d.kind === 'quote' ? '正文语句' : '锚点段落');
            var n = api.findInContent ? api.findInContent(t.word) : 0;
            var custom = !!(t.anchor && t.anchor !== 'first');
            row.innerHTML =
                '<div class="ee-term-row">' +
                '<span class="ee-term-word">' + esc(t.word) + '</span>' +
                '<span class="ee-term-count' + (n ? '' : ' zero') + '" title="正文出现次数">' + n + ' 处</span>' +
                '<span class="ee-term-src" data-kind="' + d.kind + '">' + badge + '</span>' +
                '</div>' +
                '<div class="ee-term-row">' +
                '<span class="ee-term-anchor' + (custom ? ' custom' : '') + '" title="' +
                esc(custom ? ('锚点段落：' + t.anchor) : '锚点：首次出现处') + '">' +
                (custom ? '自定义锚点' : '首次出现') + '</span>' +
                '</div>' +
                '<div class="ee-term-def-preview">' + (d.text ? esc(d.text.slice(0, 60)) + (d.text.length > 60 ? '…' : '') : '<em>未写解释，暂用锚点所在段落</em>') + '</div>' +
                '<div class="ee-term-ops">' +
                '<button type="button" class="ee-term-op" data-act="edit">编辑</button>' +
                '<button type="button" class="ee-term-op" data-act="locate">定位</button>' +
                '<button type="button" class="ee-term-op danger" data-act="del">删除</button>' +
                '</div>';
            row.querySelector('[data-act="edit"]').addEventListener('click', function () {
                editing = t.word;
                paint();
            });
            row.querySelector('[data-act="locate"]').addEventListener('click', function () {
                if (api.locate) api.locate(t.word);
            });
            row.querySelector('[data-act="del"]').addEventListener('click', function () {
                if (api.removeTerm) api.removeTerm(t.word);
                if (editing === t.word) editing = '';
                paint();
            });
            els.list.appendChild(row);
        });

        paintEditor(terms);
    }

    function paintEditor(terms) {
        if (!els.editor) return;
        var t = terms.filter(function (x) { return x.word === editing; })[0];
        if (!t) { els.editor.hidden = true; els.editor.innerHTML = ''; return; }
        els.editor.hidden = false;
        var d = defOf(t);
        var sel = (api.selectionText && api.selectionText()) || '';
        els.editor.innerHTML =
            '<div class="ee-term-edit-head">' +
            '<span>编辑「' + esc(t.word) + '」</span>' +
            '<button type="button" class="ee-term-op" data-act="close">收起</button>' +
            '</div>' +
            '<label class="ee-term-label">解释（自写）</label>' +
            '<textarea id="eeTermDef" rows="4" maxlength="300" placeholder="这个词是什么意思？留空则用下面选的正文语句或锚点段落">' + esc(t.def || '') + '</textarea>' +
            '<div class="ee-term-edit-row">' +
            '<button type="button" class="ee-btn" data-act="pick">用正文选中的语句</button>' +
            '<span class="ee-term-quote">' + (t.quote ? esc(t.quote.slice(0, 40)) + (t.quote.length > 40 ? '…' : '') : '未选语句') + '</span>' +
            (t.quote ? '<button type="button" class="ee-term-op" data-act="clearquote">清除引用</button>' : '') +
            '</div>' +
            '<div class="ee-term-edit-row">' +
            '<button type="button" class="ee-btn" data-act="save">保存解释</button>' +
            '<button type="button" class="ee-btn" data-act="anchor">锚到当前段落</button>' +
            (t.anchor && t.anchor !== 'first' ? '<button type="button" class="ee-term-op" data-act="reset">改回首次</button>' : '') +
            '</div>' +
            '<div class="ee-term-edit-tip">当前解释来源：' +
            (d.kind === 'def' ? '你写的解释' : (d.kind === 'quote' ? '正文里选的语句' : '锚点所在段落')) +
            '　·　正文选词后点「用正文选中的语句」即可摘录' +
            (sel ? '（现在选中了 ' + sel.length + ' 个字）' : '') +
            '</div>';

        var defBox = els.editor.querySelector('#eeTermDef');
        els.editor.querySelector('[data-act="close"]').addEventListener('click', function () {
            editing = '';
            paint();
        });
        els.editor.querySelector('[data-act="pick"]').addEventListener('click', function () {
            var s = (api.selectionText && api.selectionText()) || '';
            if (!s) {
                if (api.toast) api.toast('先在正文里选中一句要当解释的话', 'error');
                return;
            }
            // 只摘录，不保存：让作者还能顺手改自写解释，按下「保存解释」才落库
            t.quote = s.slice(0, 240);
            paint();
        });
        var clearBtn = els.editor.querySelector('[data-act="clearquote"]');
        if (clearBtn) clearBtn.addEventListener('click', function () {
            t.quote = '';
            paint();
        });
        els.editor.querySelector('[data-act="save"]').addEventListener('click', function () {
            var v = defBox.value.replace(/\r\n?/g, '\n').trim();
            if (api.setTerm) api.setTerm(t.word, { def: v, quote: t.quote || '' });
            editing = '';
            paint();
        });
        els.editor.querySelector('[data-act="anchor"]').addEventListener('click', function () {
            if (api.anchorToCaret) api.anchorToCaret(t.word);
            paint();
        });
        var resetBtn = els.editor.querySelector('[data-act="reset"]');
        if (resetBtn) resetBtn.addEventListener('click', function () {
            if (api.resetAnchor) api.resetAnchor(t.word);
            paint();
        });
    }

    var TermEditor = {};

    TermEditor.init = function (opts) {
        opts = opts || {};
        api = opts;
        host = opts.host || document.getElementById('eeSideTerms');
        if (!host) return false;
        build();
        paint();
        return true;
    };

    /** 切到术语页签时调用：重画（出现次数、选中状态都可能变了） */
    TermEditor.onShow = function () {
        build();
        paint();
        return true;
    };

    /** 开始编辑某个词（右键菜单「编辑解释」之类的外部入口用） */
    TermEditor.edit = function (word) {
        editing = String(word || '');
        build();
        paint();
    };
    TermEditor.refresh = function (decor) {
        if (decor) decorOk = !!decor.ok;
        paint();
    };

    window.TermEditor = TermEditor;
})();
