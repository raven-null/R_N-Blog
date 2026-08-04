/**
 * Markdown解析器
 * 支持frontmatter标签提取和Markdown渲染
 */
const MarkdownParser = {
    // 解析frontmatter
    parseFrontmatter(content) {
        const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
        const match = content.match(frontmatterRegex);
        
        if (!match) {
            return { frontmatter: {}, content: content };
        }
        
        const frontmatterStr = match[1];
        const contentStr = match[2];
        
        const frontmatter = {};
        const lines = frontmatterStr.split('\n');
        let currentKey = null;
        let currentArray = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();
            
            // 跳过空行
            if (!trimmedLine) continue;
            
            // 检查是否是数组项（以 - 开头）
            if (trimmedLine.startsWith('- ') && currentKey) {
                if (!currentArray) {
                    currentArray = [];
                    frontmatter[currentKey] = currentArray;
                }
                currentArray.push(trimmedLine.substring(2).trim());
                continue;
            }
            
            // 重置数组状态
            currentArray = null;
            
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                currentKey = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();
                
                // 处理数组格式 [tag1, tag2]
                if (value.startsWith('[') && value.endsWith(']')) {
                    value = value.slice(1, -1).split(',').map(item => item.trim());
                    frontmatter[currentKey] = value;
                    currentKey = null;
                } else if (value) {
                    // 有值的情况
                    frontmatter[currentKey] = value;
                    currentKey = null;
                }
                // 如果value为空，可能是YAML数组的开始，保持currentKey
            }
        }
        
        return { frontmatter, content: contentStr };
    },
    
    // 解析Markdown内容
    parseMarkdown(content) {
        // 使用marked库（需要在HTML中引入）
        if (typeof marked !== 'undefined') {
            // 配置marked
            marked.setOptions({
                breaks: true,
                gfm: true
            });

            // 高亮扩展：==文字==
            marked.use({
                extensions: [{
                    name: 'highlight',
                    level: 'inline',
                    start(src) { return src.indexOf('=='); },
                    tokenizer(src) {
                        const match = src.match(/^==(.+?)==/);
                        if (match) {
                            return {
                                type: 'highlight',
                                raw: match[0],
                                text: match[1]
                            };
                        }
                    },
                    renderer(token) {
                        return `<mark>${token.text}</mark>`;
                    }
                }]
            });

            // 自定义渲染器
            const renderer = new marked.Renderer();

            // 图片：添加说明文字，支持绝对路径和相对路径，点击可放大查看
            renderer.image = function({href, title, text}) {
                const titleAttr = title ? ` title="${title}"` : '';
                const altText = text || '';
                const captionHtml = altText ? `<figcaption class="img-caption">${altText}</figcaption>` : '';
                const onerror = "this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22100%22%3E%3Crect fill=%22%23222%22 width=%22200%22 height=%22100%22/%3E%3Ctext fill=%22%23666%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22%3E图片加载失败%3C/text%3E%3C/svg%3E'";
                return `<figure class="img-figure"><img src="${href}" alt="${altText}"${titleAttr} loading="lazy" decoding="async" onerror="${onerror}" onclick="openLightbox(this)" style="cursor:zoom-in">${captionHtml}</figure>`;
            };

            // 代码块：添加复制按钮
            renderer.code = function({text, lang}) {
                const language = lang || '';
                const escapedCode = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                return `<div class="code-block">
                    <div class="code-header">
                        <span class="code-lang">${language}</span>
                        <button class="copy-btn" onclick="copyCode(this)" title="复制代码">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            <span>复制</span>
                        </button>
                    </div>
                    <pre><code class="language-${language}">${escapedCode}</code></pre>
                </div>`;
            };

            // 引用块：添加复制按钮
            renderer.blockquote = function({tokens}) {
                const body = tokens.map(t => t.raw || t.text || '').join('');
                return `<blockquote class="quote-block">
                    <button class="copy-btn copy-btn-quote" onclick="copyQuote(this)" title="复制引用">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span>复制</span>
                    </button>
                    ${body}
                </blockquote>`;
            };

            return marked.parse(content, { renderer });
        }
        
        // 如果没有marked库，使用简单的解析
        return this.simpleParse(content);
    },
    
    // 简单的Markdown解析（备用）
    simpleParse(content) {
        let html = content;
        
        // 标题
        html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
        
        // 粗体和斜体
        html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // 链接
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        
        // 图片
        html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;">');
        
        // 代码块
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // 列表
        html = html.replace(/^\s*[-*]\s+(.*$)/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
        
        // 段落
        html = html.replace(/\n\n/g, '</p><p>');
        html = '<p>' + html + '</p>';
        
        return html;
    },
    
    // 渲染Markdown到指定元素
    renderToElement(content, element) {
        const { frontmatter, content: markdownContent } = this.parseFrontmatter(content);
        const html = this.parseMarkdown(markdownContent);
        
        element.innerHTML = html;
        
        // 高亮代码块
        if (typeof hljs !== 'undefined') {
            element.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }
        
        return frontmatter;
    },
    
    // 从文件加载Markdown
    async loadFromFile(filePath) {
        try {
            const response = await fetch(filePath);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const content = await response.text();
            return this.parseFrontmatter(content);
        } catch (error) {
            console.error('加载Markdown文件失败:', error);
            return null;
        }
    },
    
    // 提取摘要
    extractExcerpt(content, maxLength = 150) {
        // 移除Markdown标记
        let text = content
            .replace(/#+\s+/g, '')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\n/g, ' ')
            .trim();
        
        if (text.length > maxLength) {
            text = text.substring(0, maxLength) + '...';
        }
        
        return text;
    },
    
    // 提取第一张图片
    extractFirstImage(content) {
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/;
        const match = content.match(imageRegex);
        return match ? match[2] : null;
    }
};

window.MarkdownParser = MarkdownParser;
