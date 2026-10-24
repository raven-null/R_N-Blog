/**
 * 文内术语回链（v1.3.1）
 * ------------------------------------------------------------------
 * 解决的问题：文章里某个词（比如「字符串」）第一次出现时讲过它的定义，
 * 几百字后再出现时读者已经忘了，又不想往回翻。
 *
 * 数据来源：文章的 terms 字段（写作页「术语」页签维护）
 *     [{ word: '字符串', anchor: 'first' | '<段落指纹>', def?: '自写解释', quote?: '从正文摘的语句' }]
 *
 * 渲染规则：
 *   - 词的**第一次出现**所在的段落 = 定义锚点，给它挂一个 id；
 *   - 从**第二次出现**起，把词包成 <span class="term-link">，悬停出气泡；
 *   - 只扫文本节点，跳过代码块/行内代码/链接/图片/已有的 term-link/标题；
 *   - 英文词按词边界匹配（\bString\b）且忽略大小写，避免误伤 substring；
 *   - 每个词最多包 200 处，术语最多 30 个（服务端也限了）。
 *
 * 「显示哪段文字」「点一下会怎样」是两件事：
 *   - 显示：有自写解释就用它，其次用正文摘的语句，都没有就用锚点段落；
 *   - 点击（v1.3.0 收紧）：**只有带 quote 的词才跳**，跳到那句引用所在的段落；
 *     只有自写解释 / 只有锚点的词（`.term-link-info`）点了只把气泡打开，不跳转，
 *     也不给 role=button / tabindex / 手型光标 —— 点了没反应比不能点更像坏掉。
 *     def 与 quote 可以同时存在：气泡显示 def，点击按 quote 跳。
 *
 * 气泡（按需求）：**内容不截断**，显示上面取到的那段完整文字；限定气泡尺寸并允许内部滚动。
 *
 * 用法：
 *     TermLinks.enhance(container, terms)      // 就地增强，可重复调用（分章文章逐章扫）
 *     TermLinks.clear()                         // 拆掉所有样式与气泡（换文章时用）
 *     TermLinks.anchorIdOf(word)                // 供文末术语表跳转用
 *     TermLinks.hasQuote(word)                  // 该词有没有「定义引用」（决定可不可点）
 *     TermLinks.jumpToWord(word)                // 跳到引用语句所在段落（没有则退回锚点段落）
 */
(function () {
    'use strict';

    var MAX_HITS_PER_WORD = 200;
    var ANCHOR_PREFIX = 'term-def-';
    var BUBBLE_ID = 'termBubble';

    var root = null;        // 当前文章正文容器
    var terms = [];         // 规范化后的词条
    var anchors = {};       // word -> { el, id }
    var bubble = null;
    var hideTimer = null;
    var activeWord = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** 段落文字（用于气泡与指纹比较）：压掉多余空白 */
    function blockText(el) {
        return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
    }

    /**
     * 解析某个词的「解释」：等级 def（作者自写）> quote（正文里摘的语句）> 锚点段落。
     * 只填了 anchor 的老数据行为完全不变（v3.45.0）。
     * @returns {{kind:'def'|'quote'|'anchor'|'none', text:string}}
     */
    function resolveDefinition(word, info) {
        if (!info) return { kind: 'none', text: '' };
        if (info.def) return { kind: 'def', text: String(info.def) };
        if (info.quote) return { kind: 'quote', text: String(info.quote) };
        var t = info.el ? blockText(info.el) : '';
        return t ? { kind: 'anchor', text: t } : { kind: 'none', text: '' };
    }

    /** 词 -> 稳定的 DOM id 片段 */
    function slug(word) {
        var s = String(word || '').replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]/g, '');
        if (!s) s = 'w' + Math.abs(hashCode(String(word || ''))).toString(36);
        return s.slice(0, 32);
    }
    function hashCode(str) {
        var h = 0;
        for (var i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
        return h;
    }

    /** 该节点是否在「不该加回链」的区域里 */
    var SKIP_SELECTOR = 'pre, code, a, img, kbd, samp, svg, textarea, .term-link, h1, h2, h3, h4, h5, h6, .code-block, .img-figure';
    function shouldSkip(node) {
        var el = node.parentElement;
        if (!el) return true;
        if (el.closest(SKIP_SELECTOR)) return true;
        return false;
    }

    /** 块级祖先（段落 / 列表项 / 引用 / 表格单元格） */
    function blockOf(node) {
        var el = node.parentElement;
        if (!el) return null;
        return el.closest('p, li, blockquote, td, th, div') || el;
    }

    /** 词的匹配正则：英文加词边界 + 忽略大小写；中文直接整串 */
    function matcherFor(word) {
        var w = String(word || '');
        if (!w) return null;
        var isLatin = /^[A-Za-z0-9_\-\s]+$/.test(w);
        if (isLatin) {
            var body = w.trim().split(/\s+/).map(function (p) {
                return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('\\s+');
            return new RegExp('\\b(' + body + ')\\b', 'gi');
        }
        return new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'g');
    }

    /** 收集容器里所有可扫描的文本节点 */
    function textNodes(container) {
        var out = [];
        if (!container) return out;
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = walker.nextNode())) {
            var text = n.nodeValue || '';
            if (!text.trim()) continue;
            if (shouldSkip(n)) continue;
            out.push(n);
        }
        return out;
    }

    /** 在文本节点里统计某个词的出现（返回 [{node,index}]，index 为节点内字符位置） */
    function findOccurrences(nodes, word) {
        var re = matcherFor(word);
        if (!re) return [];
        var hits = [];
        for (var i = 0; i < nodes.length; i++) {
            var text = nodes[i].nodeValue || '';
            re.lastIndex = 0;
            var m;
            while ((m = re.exec(text))) {
                hits.push({ node: nodes[i], index: m.index, length: m[0].length });
                if (hits.length >= MAX_HITS_PER_WORD) return hits;
                if (m.index === re.lastIndex) re.lastIndex++;   // 防零宽死循环
            }
        }
        return hits;
    }

    /** 找锚点块：'first' → 首次出现的块；否则按段落指纹匹配 */
    function resolveAnchorEl(term, firstHit) {
        if (!term.anchor || term.anchor === 'first') return firstHit ? blockOf(firstHit.node) : null;
        var fp = String(term.anchor);
        if (!root) return firstHit ? blockOf(firstHit.node) : null;
        var cands = root.querySelectorAll('p, li, blockquote, td, th');
        for (var i = 0; i < cands.length; i++) {
            if (blockText(cands[i]).indexOf(fp) === 0) return cands[i];
        }
        return firstHit ? blockOf(firstHit.node) : null;
    }

    /**
     * 找「定义引用」那句话所在的块（v1.2.0）。
     * 文末术语表的跳转以它为目标：作者从正文里摘了哪句话当解释，就跳回那句。
     */
    function resolveQuoteEl(quote) {
        var q = String(quote || '').replace(/\s+/g, ' ').trim();
        if (!q || !root) return null;
        var cands = root.querySelectorAll('p, li, blockquote, td, th');
        for (var i = 0; i < cands.length; i++) {
            if (blockText(cands[i]).indexOf(q) >= 0) return cands[i];
        }
        return null;
    }

    /**
     * 把第 n 处（>=1）出现包成 term-link；从后往前替换，避免索引漂移。
     * v1.3.0：只有带「定义引用」（terms[].quote）的词才做成可点跳转的按钮；
     * 其余（只有自写解释 / 只有锚点）只当**看解释**的标记 —— 不可点、没有手型光标，
     * 点一下是把气泡打开，而不是跳走。
     */
    function wrapOccurrences(hits, word, canJump) {
        for (var i = hits.length - 1; i >= 1; i--) {
            var h = hits[i];
            var node = h.node;
            if (!node || !node.parentNode) continue;
            var text = node.nodeValue || '';
            var before = text.slice(0, h.index);
            var mid = text.slice(h.index, h.index + h.length);
            var after = text.slice(h.index + h.length);
            var span = document.createElement('span');
            span.className = canJump ? 'term-link' : 'term-link term-link-info';
            span.setAttribute('data-term', word);
            if (canJump) {
                span.setAttribute('role', 'button');
                span.setAttribute('tabindex', '0');
                span.setAttribute('title', '跳到这句定义引用的出处');
            } else {
                span.setAttribute('title', '查看解释');
            }
            span.textContent = mid;
            var parent = node.parentNode;
            if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);
            parent.insertBefore(span, node.nextSibling);
            node.nodeValue = before;
        }
    }

    // ===== 气泡 =====
    function ensureBubble() {
        if (bubble && bubble.parentNode) return bubble;
        bubble = document.createElement('div');
        bubble.id = BUBBLE_ID;
        bubble.className = 'term-bubble';
        bubble.setAttribute('role', 'tooltip');
        bubble.style.display = 'none';
        document.body.appendChild(bubble);
        // 鼠标移进气泡里可以继续读（不会立刻消失），也就能滚动查看长定义
        bubble.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
        bubble.addEventListener('mouseleave', function () { hideBubble(); });
        window.addEventListener('scroll', function () { hideBubble(); }, { passive: true });
        window.addEventListener('resize', function () { hideBubble(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hideBubble();
        }, true);
        return bubble;
    }

    function hideBubble() {
        clearTimeout(hideTimer);
        activeWord = null;
        if (bubble) bubble.style.display = 'none';
    }

    /**
     * 显示气泡：**内容不截断**（整个锚点段落），尺寸由 CSS 限死（max-width/max-height）
     * 并允许内部滚动（overflow-y:auto）。上方空间不够就翻到下方，左右夹在视口内。
     * v1.1.0：解释来源改成 def（作者自写）→ quote（正文里摘的语句）→ 锚点段落，
     * 前两者优先，因为它们才是「作者想让人看到的定义」。
     */
    function showBubble(span, word) {
        var info = anchors[word];
        if (!info) return;
        var d = resolveDefinition(word, info);
        if (!d.text) return;
        var b = ensureBubble();
        activeWord = word;
        clearTimeout(hideTimer);
        b.innerHTML =
            '<div class="term-bubble-head"><span class="term-bubble-word">' + esc(word) + '</span></div>' +
            '<div class="term-bubble-def' + (d.kind === 'def' ? ' is-def' : '') + '">' + esc(d.text) + '</div>';
        b.style.display = 'block';

        var r = span.getBoundingClientRect();
        var bw = b.offsetWidth, bh = b.offsetHeight;
        var gap = 8;
        var top = r.top - bh - gap;
        if (top < 8) top = r.bottom + gap;                    // 上方放不下 → 放到下方
        var left = r.left + r.width / 2 - bw / 2;
        var maxLeft = window.innerWidth - bw - 8;
        if (left < 8) left = 8;
        if (left > maxLeft) left = Math.max(8, maxLeft);
        if (top + bh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - bh - 8);
        b.style.top = Math.round(top) + 'px';
        b.style.left = Math.round(left) + 'px';
    }

    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideBubble, 180);
    }

    function jumpTo(anchorEl) {
        if (!anchorEl) return;
        try { anchorEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (e) { anchorEl.scrollIntoView(); }
        anchorEl.classList.remove('term-flash');
        void anchorEl.offsetWidth;                 // 强制重排，让动画能重复播放
        anchorEl.classList.add('term-flash');
        setTimeout(function () { anchorEl.classList.remove('term-flash'); }, 1400);
    }

    // 事件委托：正文里可能有很多 term-link，逐个绑定太费
    function bindDelegation() {
        if (bindDelegation.done) return;
        bindDelegation.done = true;
        document.addEventListener('mouseover', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            var span = t.closest('.term-link');
            if (!span || !root || !root.contains(span)) return;
            showBubble(span, span.getAttribute('data-term'));
        }, true);
        document.addEventListener('mouseout', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            var span = t.closest('.term-link');
            if (!span) return;
            scheduleHide();
        }, true);
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            var span = t.closest('.term-link');
            if (!span || !root || !root.contains(span)) return;
            var word = span.getAttribute('data-term');
            var info = anchors[word];
            if (!info) return;
            e.preventDefault();
            // 只有「定义引用」在正文里才有位置可跳；没有引用就只把解释弹出来
            if (info.quote) jumpTo(info.quoteEl || info.el);
            else showBubble(span, word);
        }, true);
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var t = e.target;
            if (!t || !t.classList || !t.classList.contains('term-link')) return;
            var info = anchors[t.getAttribute('data-term')];
            if (!info || !info.quote) return;   // 不可点的词条本来就没给 tabindex，这里兜底
            e.preventDefault();
            jumpTo(info.quoteEl || info.el);
        }, true);
    }

    // ===== 对外 =====
    var TermLinks = {};

    /**
     * 就地增强某个容器里的术语回链。
     * @param {HTMLElement} container 正文容器（分章文章逐章调用）
     * @param {Array} list 词条 [{word, anchor}]
     * @param {object} [opts] { root: 主容器 }—— 首次调用时把主容器记下来用于找锚点
     */
    TermLinks.enhance = function (container, list, opts) {
        if (!container) return { terms: 0, links: 0 };
        if (opts && opts.root) root = opts.root;
        if (!root) root = container;
        // 词条只在第一次调用时设置；后续分章追加沿用（避免重复 normalize）
        if (Array.isArray(list) && list.length) {
            terms = list.filter(function (t) { return t && t.word; }).map(function (t) {
                var o = { word: String(t.word), anchor: String(t.anchor || 'first') };
                // v3.45.0：解释可以自写（def）或从正文摘（quote），有就带着
                if (t.def) o.def = String(t.def);
                if (t.quote) o.quote = String(t.quote);
                return o;
            });
        }
        if (!terms.length) return { terms: 0, links: 0 };
        bindDelegation();

        var links = 0;
        terms.forEach(function (term) {
            // 每个词都重新扫一遍当前 DOM，而不是复用循环外缓存的节点列表。
            // 原因：wrapOccurrences() 会把一个文本节点拆成「前段 + span + 后段」，
            // 后段是**新插入**的节点，不在旧列表里 —— 复用旧列表的话，同一段里排在
            // 前一个术语后面的词就永远扫不到（实测「字符串…不可变」这种同段两句只包到了前者）。
            // 已被包过的位置由 SKIP_SELECTOR 里的 .term-link 排除，不会重复包。
            var nodes = textNodes(container);
            var hits = findOccurrences(nodes, term.word);
            // 有自写解释时，即使正文里一次都没出现也登记（术语表要能列出来）
            if (!hits.length) {
                if (!anchors[term.word] && (term.def || term.quote)) {
                    anchors[term.word] = { el: null, id: '', def: term.def, quote: term.quote, quoteEl: resolveQuoteEl(term.quote) };
                }
                return;
            }
            // 锚点：本容器还没定锚的话，用这里的首次出现
            if (!anchors[term.word]) {
                var el = resolveAnchorEl(term, hits[0]);
                if (el) {
                    var id = ANCHOR_PREFIX + slug(term.word);
                    if (!el.id) el.id = id;
                    anchors[term.word] = { el: el, id: el.id, def: term.def, quote: term.quote, quoteEl: resolveQuoteEl(term.quote) };
                }
            }
            wrapOccurrences(hits, term.word, !!term.quote);
            links += Math.max(0, hits.length - 1);
        });
        return { terms: terms.length, links: links };
    };

    /** 供文末「本篇术语」表用：拿到该词的锚点元素 */
    TermLinks.anchorEl = function (word) {
        var info = anchors[word];
        return info ? info.el : null;
    };

    /**
     * 定义片段（不截断；调用方决定怎么展示）。
     * v1.1.0：优先 def（作者自写）→ quote（正文语句）→ 锚点段落。
     */
    TermLinks.definitionOf = function (word) {
        return resolveDefinition(word, anchors[word]).text;
    };

    /** 定义来源：'def' | 'quote' | 'anchor' | 'none'（术语表可据此加徽标） */
    TermLinks.definitionKind = function (word) {
        return resolveDefinition(word, anchors[word]).kind;
    };

    /**
     * 这个词有没有「从正文摘的语句」（terms[].quote）。
     * 文末术语表的跳转只认它：自写解释在正文里没有位置，锚点段落也不算「定义引用」。
     * 注意 def 与 quote 可以同时存在 —— 前台显示 def，但仍然按 quote 给跳转。
     */
    TermLinks.hasQuote = function (word) {
        var info = anchors[word];
        return !!(info && info.quote);
    };

    /**
     * 跳转到某个词的定义处（术语表点击用）。
     * 有「定义引用」→ 跳到那句话所在的段落；否则退回锚点段落。
     * 两者都没有（只有自写解释）→ 静默忽略，调用方本来也不该把它渲染成可点控件。
     */
    TermLinks.jumpToWord = function (word) {
        var info = anchors[word];
        if (!info) return;
        jumpTo(info.quoteEl || info.el);
    };

    /** 清空（换文章 / 预览重渲染时用） */
    TermLinks.clear = function () {
        hideBubble();
        if (root) {
            Array.prototype.forEach.call(root.querySelectorAll('.term-link'), function (span) {
                var parent = span.parentNode;
                if (!parent) return;
                parent.replaceChild(document.createTextNode(span.textContent || ''), span);
                parent.normalize();
            });
        }
        Array.prototype.forEach.call(document.querySelectorAll('.term-flash'), function (el) {
            el.classList.remove('term-flash');
        });
        anchors = {};
        terms = [];
        root = null;
    };

    TermLinks.hideBubble = hideBubble;
    window.TermLinks = TermLinks;
})();
