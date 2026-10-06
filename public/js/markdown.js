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
    // 自定义配置（==高亮==、图片 URL 重写/图注/灯箱、.code-block 包裹）统一放在
    // public/js/markdown-config.js，由主线程与 Web Worker 共用 —— 否则长文走 Worker
    // 时这些能力会静默失效（详见该文件头部说明）。
    parseMarkdown(content) {
        if (typeof marked !== 'undefined' && window.MarkdownConfig) {
            const renderer = window.MarkdownConfig.apply(marked);
            return marked.parse(content, { renderer });
        }

        // 如果没有marked库，使用简单的解析
        return this.simpleParse(content);
    },

    // 异步解析 Markdown（长文使用 Web Worker，短文直接主线程）
    parseMarkdownAsync(content) {
        return new Promise((resolve) => {
            if (content.length < 5000 || typeof Worker === 'undefined') {
                return resolve(this.parseMarkdown(content));
            }
            try {
                const worker = new Worker('js/markdown-worker.js');
                const id = Date.now();
                const timer = setTimeout(() => {
                    worker.terminate();
                    resolve(this.parseMarkdown(content));
                }, 10000);
                worker.onmessage = (e) => {
                    clearTimeout(timer);
                    worker.terminate();
                    if (e.data.error) {
                        resolve(this.parseMarkdown(content));
                    } else {
                        resolve(e.data.html);
                    }
                };
                worker.onerror = () => {
                    clearTimeout(timer);
                    worker.terminate();
                    resolve(this.parseMarkdown(content));
                };
                worker.postMessage({ content, id });
            } catch (err) {
                resolve(this.parseMarkdown(content));
            }
        });
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
    
    // 提取第一张图片（跳过代码块与行内代码，避免把语法示例当作真实图片）
    extractFirstImage(content) {
        const noCodeBlocks = content.replace(/```[\s\S]*?```/g, '');
        const noInlineCode = noCodeBlocks.replace(/`[^`]*`/g, '');
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/;
        const match = noInlineCode.match(imageRegex);
        if (!match) return null;
        let src = match[2];
        // 旧动态接口 URL → 缓存友好 URL
        if (src.startsWith('/api/article-image?key=')) {
            src = '/images/a/' + src.slice('/api/article-image?key='.length).split('&')[0];
        } else if (src.startsWith('/api/admin-image?key=')) {
            const key = src.slice('/api/admin-image?key='.length).split('&')[0];
            src = '/images/g/' + key;
        }
        return src;
    }
};

window.MarkdownParser = MarkdownParser;
