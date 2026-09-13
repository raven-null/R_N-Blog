/**
 * 通用标签选择器（chips + 下拉建议 + 回车确认）
 *
 * 后台各处需要填标签的地方统一使用它，交互与视觉和「写文章」页原有的标签选择器一致。
 * 自带样式（注入到 <head>，id=tagPickerSharedStyles），因此任何页面只要引入本脚本即可用；
 * 样式变量都带 fallback，未引入 glass.css 的页面（如 admin-edit.html）也能正常显示。
 *
 * 用法：
 *   const p = TagPicker.create(document.getElementById('xxx'), {
 *       placeholder: '添加标签，回车确认…',
 *       suggestions: ['技术', '生活'],   // 可选，之后可用 setSuggestions 更新
 *       onChange: function (tags) {}     // 可选，标签变化时回调
 *   });
 *   p.getTags();            // 当前标签数组
 *   p.setTags(['a','b']);   // 设置标签（第二个参数传 true 可静默，不触发 onChange）
 *   p.setSuggestions([...]);
 */
(function () {
    'use strict';

    var STYLE_ID = 'tagPickerSharedStyles';

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var css = [
            '.tag-picker-wrap{position:relative}',
            '.tag-picker-input{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;' +
            'background:rgba(255,255,255,0.06);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
            'border:1px solid var(--glass-border,var(--border,rgba(255,255,255,.14)));' +
            'border-radius:var(--radius-sm,10px);min-height:36px;cursor:text;align-items:center;transition:all .25s ease}',
            '.tag-picker-input:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px rgba(79,195,247,0.15)}',
            '.tag-picker-input .tp-chip{display:flex;align-items:center;gap:4px;padding:3px 10px;' +
            'background:linear-gradient(135deg,rgba(79,195,247,0.2),rgba(79,195,247,0.1));color:var(--accent);' +
            'border-radius:16px;font-size:11px;border:1px solid rgba(79,195,247,0.2);transition:all .2s ease}',
            '.tag-picker-input .tp-chip:hover{background:rgba(79,195,247,0.25)}',
            '.tag-picker-input .tp-chip button{background:none;border:none;color:var(--accent);cursor:pointer;' +
            'font-size:13px;padding:0;line-height:1;opacity:.7;transition:all .2s ease}',
            '.tag-picker-input .tp-chip button:hover{opacity:1;transform:scale(1.2)}',
            '.tag-picker-input input{flex:1;min-width:80px;border:none;background:transparent;' +
            'color:var(--text,#fff);font-size:12px;outline:none;font-family:inherit}',
            '.tag-picker-input input::placeholder{color:rgba(255,255,255,0.4)}',
            '.tag-picker-dropdown{display:none;position:absolute;top:100%;left:0;right:0;' +
            'background:var(--glass-bg,var(--bg-card,#15161c));backdrop-filter:blur(24px) saturate(170%);' +
            '-webkit-backdrop-filter:blur(24px) saturate(170%);' +
            'border:1px solid var(--glass-border,var(--border,rgba(255,255,255,.14)));' +
            'border-radius:var(--radius-sm,10px);margin-top:6px;max-height:180px;overflow-y:auto;z-index:50;' +
            'box-shadow:0 16px 48px -8px rgba(0,0,0,0.6);animation:tpSlide .25s ease}',
            '@keyframes tpSlide{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}',
            '.tag-picker-dropdown.open{display:block}',
            '.tag-picker-dropdown .tp-item{padding:8px 14px;font-size:12px;color:rgba(255,255,255,0.7);cursor:pointer;transition:all .2s ease}',
            '.tag-picker-dropdown .tp-item:hover{background:rgba(255,255,255,0.1);color:var(--text,#fff);padding-left:18px}',
            '.tag-picker-dropdown .tp-item.selected{color:var(--accent);background:rgba(79,195,247,0.1)}',
            '.tag-picker-dropdown .tp-empty{padding:10px 12px;font-size:12px;color:var(--text-muted,rgba(255,255,255,.5))}',
        ].join('\n');
        var el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = css;
        document.head.appendChild(el);
    }

    function splitTags(raw) {
        return String(raw || '')
            .split(/[,，]/)
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
    }

    function create(host, opts) {
        if (!host) return null;
        opts = opts || {};
        ensureStyles();

        host.classList.add('tag-picker-wrap');
        host.innerHTML = '';

        var box = document.createElement('div');
        box.className = 'tag-picker-input';

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'tp-text';
        input.placeholder = opts.placeholder || '添加标签，回车确认…';
        input.autocomplete = 'off';
        box.appendChild(input);

        var dd = document.createElement('div');
        dd.className = 'tag-picker-dropdown';

        host.appendChild(box);
        host.appendChild(dd);

        var tags = [];
        var suggestions = (opts.suggestions || []).slice();
        var opened = false;

        function fire() {
            if (typeof opts.onChange === 'function') opts.onChange(tags.slice());
        }

        function renderChips() {
            Array.prototype.forEach.call(box.querySelectorAll('.tp-chip'), function (c) { c.remove(); });
            tags.forEach(function (t) {
                var chip = document.createElement('span');
                chip.className = 'tp-chip';
                var label = document.createElement('span');
                label.textContent = t;
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.innerHTML = '&times;';
                btn.title = '移除';
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    remove(t);
                });
                chip.appendChild(label);
                chip.appendChild(btn);
                box.insertBefore(chip, input);
            });
        }

        function renderDropdown() {
            var q = input.value.trim().toLowerCase();
            var list = suggestions.filter(function (t) {
                return tags.indexOf(t) === -1 && (!q || String(t).toLowerCase().indexOf(q) !== -1);
            });
            if (!list.length) {
                var tip = q
                    ? '回车添加「' + input.value.trim() + '」'
                    : '暂无已有标签，输入后回车新建';
                dd.innerHTML = '<div class="tp-empty"></div>';
                dd.querySelector('.tp-empty').textContent = tip;
                return;
            }
            dd.innerHTML = '';
            list.forEach(function (t) {
                var item = document.createElement('div');
                item.className = 'tp-item';
                item.textContent = t;
                // mousedown + preventDefault：避免 input 先失焦导致下拉被收起
                item.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    add(t);
                });
                dd.appendChild(item);
            });
        }

        function openDropdown() {
            if (opened) return;
            opened = true;
            renderDropdown();
            dd.classList.add('open');
            setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
        }

        function closeDropdown() {
            if (!opened) return;
            opened = false;
            dd.classList.remove('open');
            document.removeEventListener('click', onDocClick);
        }

        function onDocClick(e) {
            if (!host.contains(e.target)) closeDropdown();
        }

        function add(value) {
            var list = splitTags(value);
            if (!list.length) return;
            var changed = false;
            list.forEach(function (t) {
                if (tags.indexOf(t) === -1) { tags.push(t); changed = true; }
            });
            input.value = '';
            if (!changed) return;
            renderChips();
            if (opened) renderDropdown();
            fire();
        }

        function remove(t) {
            var i = tags.indexOf(t);
            if (i === -1) return;
            tags.splice(i, 1);
            renderChips();
            if (opened) renderDropdown();
            fire();
        }

        // 事件
        box.addEventListener('click', function () { input.focus(); });
        input.addEventListener('focus', openDropdown);
        input.addEventListener('input', function () {
            // 输入逗号即视为分隔，直接成标签
            if (/[,，]/.test(input.value)) { add(input.value); return; }
            openDropdown();
            renderDropdown();
        });
        input.addEventListener('keydown', function (e) {
            var v = input.value.trim();
            if (e.key === 'Enter') {
                e.preventDefault();
                if (v) add(v);
                return;
            }
            if (e.key === 'Backspace' && !v && tags.length) {
                tags.pop();
                renderChips();
                renderDropdown();
                fire();
                return;
            }
            if (e.key === 'Escape') { closeDropdown(); input.blur(); }
        });
        input.addEventListener('blur', function () {
            setTimeout(closeDropdown, 120);
        });

        renderChips();

        return {
            getTags: function () { return tags.slice(); },
            setTags: function (arr, silent) {
                tags = (arr || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
                // 去重但保留顺序
                tags = tags.filter(function (t, i) { return tags.indexOf(t) === i; });
                renderChips();
                if (!silent) fire();
            },
            setSuggestions: function (arr) {
                suggestions = (arr || []).slice();
                if (opened) renderDropdown();
            },
            clear: function () { this.setTags([]); },
            getInput: function () { return input; },
            destroy: function () { document.removeEventListener('click', onDocClick); host.innerHTML = ''; },
        };
    }

    window.TagPicker = { create: create, split: splitTags };
})();
