/**
 * 后台管理主脚本（由 admin.html 内联脚本拆出，便于独立缓存与排查）
 */

        let adminKey=localStorage.getItem('admin_key')||'';
        let articles=[],editingId=null,cachedImages=[];
        let allArticles=[]; // 全部文章（用于搜索过滤）
        let tagModalKey='',tagModalSelected=[];
        let classifyTag='',allImageData=[];
        let imageTagNames=[];
        let articleTagNames=[];
        let selectedArticleTags=[];
        let tagPickerOpen=false;
        let selectedImageKeys=new Set();
        let batchMode=false;
        let batchSide=''; // 'left' 或 'right'
        let uploadLog=[]; // 上传记录
        let articleImages=[]; // 文中图片列表 {key, url}

        function doLogin(){const k=document.getElementById('adminKeyInput').value.trim();if(!k)return;adminKey=k;localStorage.setItem('admin_key',k);apiFetch('action=login',{method:'POST',body:JSON.stringify({key:k})}).then(r=>{if(r.status==='success')showAdmin();else{document.getElementById('loginError').style.display='block';document.getElementById('loginError').textContent=r.message||'密钥错误'}}).catch(()=>{document.getElementById('loginError').style.display='block';document.getElementById('loginError').textContent='连接失败'})}
        function doLogout(){adminKey='';localStorage.removeItem('admin_key');localStorage.removeItem('gallery_key');location.reload()}
        function showAdmin(){
            document.getElementById('loginPage').style.display='none';
            document.getElementById('adminApp').style.display='block';
            document.getElementById('sidebar').classList.add('collapsed');
            loadArticles();
            // 支持前台快捷入口：/admin.html?edit=文章id → 自动进入该篇编辑
            const editId=new URLSearchParams(location.search).get('edit');
            if(editId)setTimeout(function(){editArticle(editId)},350);
        }
        async function apiFetch(p,o={}){if(p.startsWith('action=images')&&(!o.method||o.method==='GET'))p+='&_='+Date.now();const r=await fetch(`/api/admin?${p}`,{...o,headers:{'Content-Type':'application/json','X-Admin-Key':adminKey,...(o.headers||{})}});return r.json()}
        // 图片显示 URL：附加管理员密钥参数（<img> 无法带 header，R18 图片需密钥参数才能加载）
        function displayUrl(u){if(!u||!adminKey)return u;return u+(u.includes('?')?'&':'?')+'adminKey='+encodeURIComponent(adminKey)}
        function toggleSidebar(){document.getElementById('sidebar').classList.toggle('collapsed')}

        // ===== 文章（卡片工作台） =====
        let artStatus = 'all', artType = 'all', artSort = false, artBatch = false;
        const artSel = new Set();
        async function loadArticles(){const r=await apiFetch('action=articles');if(r.status==='success'){allArticles=r.data||[];artSel.clear();renderArticles()}}
        function artKw(){const i=document.getElementById('articleSearchInput');return (i&&i.value||'').trim().toLowerCase()}
        function filteredArticles(){
            const kw=artKw();
            return allArticles.filter(a=>{
                if(artStatus!=='all'&&a.status!==artStatus)return false;
                if(artType!=='all'&&(a.type||'article')!==artType)return false;
                if(kw){
                    const hay=(((a.title||'')+' '+(a.tags||[]).join(' ')+' '+(a.id||'')).toLowerCase());
                    if(!hay.includes(kw))return false;
                }
                return true;
            });
        }
        function setArtStatus(st){
            artStatus=st;
            document.querySelectorAll('#artStatusSeg .art-chip').forEach(function(b,i){b.classList.toggle('active',['all','published','draft'][i]===st)});
            renderArticles();
        }
        function setArtType(t){
            artType=t;
            document.querySelectorAll('#artTypeSeg .art-chip').forEach(function(b,i){b.classList.toggle('active',['all','article','whiteboard','card'][i]===t)});
            renderArticles();
        }
        function filterArticles(){
            const c=document.getElementById('artSearchClear');
            if(c)c.style.display=artKw()?'':'none';
            renderArticles();
        }
        function clearArticleSearch(){
            const i=document.getElementById('articleSearchInput');
            if(i)i.value='';
            filterArticles();
        }
        function artTypeLabel(t){if(t==='whiteboard')return '白板';if(t==='card')return '随记';return ''}
        function artCardHtml(a){
            const isPub=a.status==='published';
            const type=a.type||'article';
            const tlabel=artTypeLabel(type);
            const badge=tlabel?'<span class="ac-badge">'+esc(tlabel)+'</span>':'';
            const dot='<span class="ac-status '+(isPub?'pub':'draft')+'"></span>';
            const id=escJs(a.id);
            let cover;
            if(a.image){
                cover='<div class="ac-cover" style="background-image:url('+escAttr(a.image)+')">'+badge+dot+'</div>';
            }else{
                const ph=type==='whiteboard'?'白':(type==='card'?'记':'文');
                cover='<div class="ac-cover noimg" style="background:linear-gradient(135deg,hsl('+(type==='whiteboard'?210:type==='card'?38:222)+' 26% 24%),hsl('+(type==='whiteboard'?230:type==='card'?20:230)+' 20% 17%))"><span class="ac-ph">'+ph+'</span>'+badge+dot+'</div>';
            }
            const meta='<span>'+(a.wordCount||0)+' 字</span><span>'+esc(a.date||'')+'</span>'+(a.update?'<span class="up">更新 '+esc(a.update)+'</span>':'');
            const pubBtn=isPub
                ? '<button class="btn btn-ghost btn-sm" onclick="toggleArticleStatus(\''+id+'\',\'draft\')">下架</button>'
                : '<button class="btn btn-sm" onclick="toggleArticleStatus(\''+id+'\',\'published\')">发布</button>';
            return '<div class="art-card" data-id="'+escAttr(a.id)+'" onclick="artCardClick(\''+id+'\',event)">'+
                cover+
                '<div class="ac-body">'+
                '<div class="ac-title"><span class="tt">'+esc(a.title||'(未命名)')+'</span></div>'+
                '<div class="ac-desc">'+esc(String(a.excerpt||'').slice(0,130))+'</div>'+
                '<div class="ac-meta">'+meta+'</div>'+
                '</div>'+
                '<div class="ac-ops">'+pubBtn+
                '<span class="sp"></span>'+
                '<div class="ac-more"><button class="btn btn-ghost btn-sm" onclick="toggleArtMenu(event,\''+id+'\')" title="更多操作">•••</button>'+
                '<div class="ac-menu" id="acMenu_'+escAttr(a.id)+'">'+
                '<button onclick="artPreview(\''+id+'\')">预览前台</button>'+
                '<button onclick="artCopyLink(\''+id+'\')">复制链接</button>'+
                (isPub?'<button onclick="artTop(\''+id+'\')">置顶</button>':'')+
                '<button class="danger" onclick="artDeleteOne(\''+id+'\')">删除</button>'+
                '</div></div>'+
                '<input type="checkbox" class="ac-check" onchange="artToggleSel(\''+id+'\',this.checked)">'+
                '</div></div>';
        }
        function artCardClick(id,e){
            if(e.target.closest('.ac-ops,.ac-check'))return;
            if(artBatch){
                const card=e.currentTarget;
                const cb=card.querySelector('.ac-check');
                if(cb){cb.checked=!cb.checked;artToggleSel(id,cb.checked)}
                return;
            }
            editArticle(id);
        }
        function renderArticles(){
            const list=filteredArticles();
            const cnt=function(st){return allArticles.filter(function(a){return a.status===st}).length};
            const setT=function(id,v){const el=document.getElementById(id);if(el)el.textContent=v};
            setT('artCntAll',allArticles.length);setT('artCntPub',cnt('published'));setT('artCntDraft',cnt('draft'));
            const empty=document.getElementById('artEmpty');
            const grid=document.getElementById('artCardGrid');
            const sortWrap=document.getElementById('artSortWrap');
            const sortTb=document.getElementById('artSortTbody');
            if(artSort){
                if(grid)grid.style.display='none';
                if(sortWrap)sortWrap.style.display='';
                if(empty)empty.style.display='none';
                if(sortTb){
                    const pubs=list.filter(function(a){return a.status==='published'});
                    sortTb.innerHTML=pubs.length
                        ? pubs.map(function(a){
                            const tl=artTypeLabel(a.type);
                            return '<tr draggable="true" data-id="'+escAttr(a.id)+'">'+
                                '<td class="drag-handle" title="拖动调整排序">⋮⋮</td>'+
                                '<td><strong>'+esc(a.title||'(未命名)')+'</strong>'+(tl?' <span class="tt-b" style="font-size:10px;border:1px solid var(--border-light);color:var(--text-muted);padding:1px 7px;border-radius:999px">'+tl+'</span>':'')+'</td>'+
                                '<td style="font-size:11px;color:var(--text-muted)">'+esc(a.date||'')+'</td></tr>';
                        }).join('')
                        : '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:22px">暂无已发布文章</td></tr>';
                }
                return;
            }
            if(sortWrap)sortWrap.style.display='none';
            if(grid)grid.style.display='';
            if(!list.length){
                if(grid)grid.innerHTML='';
                if(empty){empty.style.display='';empty.textContent=artKw()?'无匹配文章':'暂无文章'}
                return;
            }
            if(empty)empty.style.display='none';
            if(grid){
                grid.innerHTML=list.map(artCardHtml).join('');
                requestAnimationFrame(function(){
                    grid.querySelectorAll('.art-card').forEach(function(c,i){setTimeout(function(){c.classList.add('visible')},i*28)});
                });
            }
        }
        // 排序模式
        function toggleArtSort(force){
            artSort=force===undefined?!artSort:!!force;
            const btn=document.getElementById('artSortBtn');
            const bar=document.getElementById('artSortBar');
            if(btn)btn.classList.toggle('active',artSort);
            if(bar)bar.style.display=artSort?'':'none';
            if(artBatch)toggleArtBatch(false);
            renderArticles();
        }
        // 批量选择
        function toggleArtBatch(force){
            artBatch=force===undefined?!artBatch:!!force;
            document.body.classList.toggle('art-batch',artBatch);
            const bar=document.getElementById('artBatchBar');
            const btn=document.getElementById('artBatchBtn');
            if(bar)bar.style.display=artBatch?'':'none';
            if(btn)btn.classList.toggle('active',artBatch);
            if(!artBatch)artSel.clear();
            if(artSort)toggleArtSort(false);
            updateArtSelBar();
        }
        function artToggleSel(id,on){on?artSel.add(id):artSel.delete(id);updateArtSelBar()}
        function updateArtSelBar(){
            const c=document.getElementById('artSelCount');
            if(c)c.textContent=artSel.size;
        }
        async function artBatchRun(st){
            if(!artSel.size){showToast('请先勾选文章','error');return}
            const ids=[...artSel];
            const action=st==='published'?'发布':'下架';
            const ok=await showConfirm('确定'+action+'选中的 '+ids.length+' 篇？','批量'+action,action);
            if(!ok)return;
            let n=0;
            for(const id of ids){const r=await apiFetch('action=articles',{method:'PATCH',body:JSON.stringify({id,status:st})});if(r.status==='success')n++}
            showToast('已'+action+' '+n+' 篇','success');
            toggleArtBatch(false);loadArticles();notifyArticlesChanged();
        }
        async function artBatchTag(){
            if(!artSel.size){showToast('请先勾选文章','error');return}
            const t=prompt('为选中的文章设置标签（逗号分隔，将覆盖原标签）：','');
            if(t===null)return;
            const tags=t.split(/[,，]/).map(function(x){return x.trim()}).filter(Boolean);
            if(!tags.length)return;
            const ok=await showConfirm('为选中的 '+artSel.size+' 篇设置标签？','批量改标签','确定');
            if(!ok)return;
            let n=0;
            for(const id of [...artSel]){const r=await apiFetch('action=articles',{method:'PATCH',body:JSON.stringify({id,tags})});if(r.status==='success')n++}
            showToast('已更新 '+n+' 篇标签','success');
            toggleArtBatch(false);loadArticles();
        }
        async function artBatchDelete(){
            if(!artSel.size){showToast('请先勾选文章','error');return}
            const ok=await showConfirm('确定删除选中的 '+artSel.size+' 篇？删除后不可恢复！','批量删除','删除');
            if(!ok)return;
            for(const id of [...artSel]){await apiFetch('action=articles&id='+encodeURIComponent(id),{method:'DELETE'})}
            showToast('已删除','success');
            toggleArtBatch(false);loadArticles();notifyArticlesChanged();
        }
        // 卡片操作菜单
        function toggleArtMenu(e,id){
            e.stopPropagation();
            const m=document.getElementById('acMenu_'+id);
            const any=document.querySelector('.ac-menu.show');
            if(any&&any!==m)any.classList.remove('show');
            if(m)m.classList.toggle('show');
        }
        function artPreview(id){
            const a=allArticles.find(function(x){return x.id===id});
            if(a)openFrontPreview(buildFrontUrl({id:a.id,filename:a.filename||(a.id+'.md')}));
        }
        function artCopyLink(id){
            const a=allArticles.find(function(x){return x.id===id});
            if(!a)return;
            const url=location.origin+'/article.html?post='+encodeURIComponent(a.filename||(a.id+'.md'))+'&blob='+encodeURIComponent(a.id);
            try{navigator.clipboard.writeText(url);showToast('链接已复制','success')}catch(e){prompt('复制链接：',url)}
        }
        function artDeleteOne(id){
            const a=allArticles.find(function(x){return x.id===id});
            deleteArticle(id,a?escJs(a.title||''):'');
        }
        async function artTop(id){
            const pubs=allArticles.filter(function(a){return a.status==='published'});
            const ids=[id].concat(pubs.filter(function(a){return a.id!==id}).map(function(a){return a.id}));
            const r=await apiFetch('action=articles&reorder=1',{method:'POST',body:JSON.stringify({ids})});
            if(r.status==='success'){showToast('已置顶','success');loadArticles()}else showToast(r.message||'置顶失败','error');
        }
        // ===== 文章拖拽排序（排序模式列表） =====
        let dragArtRow=null;
        function artSortIds(){const out=[];document.querySelectorAll('#artSortTbody tr[data-id]').forEach(function(tr){out.push(tr.dataset.id)});return out}
        function syncArtSortFromDOM(){
            const map=new Map(allArticles.map(function(a){return [a.id,a]}));
            const ids=artSortIds();
            allArticles=ids.map(function(id){return map.get(id)}).filter(Boolean).concat(allArticles.filter(function(a){return ids.indexOf(a.id)<0}));
            renderArticles();
        }
        async function persistArticleOrder(){
            const ids=artSortIds();
            if(!ids.length){showToast('没有可排序的文章','error');return}
            try{
                const r=await apiFetch('action=articles&reorder=1',{method:'POST',body:JSON.stringify({ids})});
                if(r.status==='success'){showToast('排序已保存','success');notifyArticlesChanged()}
                else showToast(r.message||'排序保存失败','error');
            }catch(e){showToast('排序保存失败','error')}
        }
        document.addEventListener('dragstart',function(e){
            const tr=e.target.closest('#artSortTbody tr[data-id]');
            if(!tr)return;
            dragArtRow=tr;
            tr.classList.add('dragging');
            try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',tr.dataset.id)}catch(err){}
        });
        document.addEventListener('dragover',function(e){
            const tr=e.target.closest('#artSortTbody tr[data-id]');
            if(!tr||!dragArtRow||tr===dragArtRow)return;
            if(tr.parentNode!==dragArtRow.parentNode)return;
            e.preventDefault();
            const rect=tr.getBoundingClientRect();
            const after=(e.clientY-rect.top)>rect.height/2;
            if(after){if(tr.nextElementSibling!==dragArtRow)tr.after(dragArtRow)}
            else{if(tr.previousElementSibling!==dragArtRow)tr.before(dragArtRow)}
            document.querySelectorAll('#artSortTbody tr.drag-over').forEach(function(r){r.classList.remove('drag-over')});
            tr.classList.add('drag-over');
        });
        document.addEventListener('drop',function(e){
            if(!dragArtRow)return;
            e.preventDefault();
            document.querySelectorAll('#artSortTbody tr.dragging,#artSortTbody tr.drag-over').forEach(function(r){r.classList.remove('dragging','drag-over')});
            dragArtRow=null;
            syncArtSortFromDOM();
        });
        document.addEventListener('dragend',function(){
            document.querySelectorAll('#artSortTbody tr.dragging,#artSortTbody tr.drag-over').forEach(function(r){r.classList.remove('dragging','drag-over')});
            dragArtRow=null;
        });
        // 点击页面任意处关闭卡片菜单
        document.addEventListener('click',function(){
            document.querySelectorAll('.ac-menu.show').forEach(function(m){m.classList.remove('show')});
        });

        // 文章增删改后通知首页（同浏览器标签页）即时刷新
        function notifyArticlesChanged(){
            try{const bc=new BroadcastChannel('blog-articles');bc.postMessage({type:'articles-changed'});bc.close()}catch(e){}
        }
        async function deleteArticle(id,title){const confirmed=await showConfirm(`确定删除「${title}」？删除后不可恢复！`,'删除文章','删除');if(!confirmed)return;const r=await apiFetch(`action=articles&id=${id}`,{method:'DELETE'});if(r.status==='success'){showToast('已删除','success');loadArticles();notifyArticlesChanged()}else showToast(r.message||'删除失败','error')}
        function editArticle(id){editingId=id;setWriteMode('article');switchTab('write');loadArticleForEdit(id)}
        async function loadArticleForEdit(id){
            const r=await apiFetch(`action=articles&id=${id}`);
            if(r.status==='success'){
                const d=r.data;
                document.getElementById('edTitle').value=d.title||'';
                document.getElementById('edExcerpt').value=d.excerpt||'';
                document.getElementById('edImage').value=d.image||'';
                renderCoverPreview();
                selectedArticleTags=[...(d.tags||[])];
                renderTagPickerChips();
                document.getElementById('edStatus').value=d.status||'published';
                setEditorContent(d.content||'');
            }
        }
        function importAndEdit(f){
            if(!f)return;
            const r=new FileReader();
            r.onload=()=>{
                const raw=r.result,m=raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
                let title=f.name.replace(/\.md$/),excerpt='',tags=[],content=raw,image='';
                if(m){
                    const fm=m[1],t=fm.match(/title:\s*(.+)/);
                    if(t)title=t[1].trim();
                    const tg=fm.match(/tags:\s*\[([^\]]+)\]/);
                    if(tg)tags=tg[1].split(',').map(s=>s.trim());
                    const ex=fm.match(/excerpt:\s*(.+)/);
                    if(ex)excerpt=ex[1].trim();
                    const im=fm.match(/image:\s*(.+)/);
                    if(im)image=im[1].trim();
                    content=m[2];
                }
                editingId=null;
                switchTab('write');
                document.getElementById('edTitle').value=title;
                document.getElementById('edExcerpt').value=excerpt;
                document.getElementById('edImage').value=image;
                renderCoverPreview();
                selectedArticleTags=tags;
                renderTagPickerChips();
                setEditorContent(content);
                showToast(`已导入: ${f.name}`,'success');
            };
            r.readAsText(f);
        }

        // ===== 写文章 =====
        function resetEditor(){
            editingId=null;
            document.getElementById('edTitle').value='';
            document.getElementById('edExcerpt').value='';
            document.getElementById('edImage').value='';
            renderCoverPreview();
            selectedArticleTags=[];
            renderTagPickerChips();
            document.getElementById('edStatus').value='published';
            setEditorContent('');
            closePublishModal();
        }
        async function saveArticle(opts){
            const opt=opts||{};
            const title=document.getElementById('edTitle').value.trim();
            const excerpt=document.getElementById('edExcerpt').value.trim();
            const tags=selectedArticleTags.join(', ');
            const status=document.getElementById('edStatus').value;
            const content=getEditorContent();
            let image=document.getElementById('edImage').value.trim();
            if(!title){showToast('请填写文章标题','error');return}
            if(!content){showToast('请填写文章内容','error');return}
            // 未设置封面图时：图库有图则随机选一张，图库空则报错
            if(!image){
                const galleryRes=await apiFetch('action=images');
                const galleryImages=(galleryRes.status==='success'&&galleryRes.data)?galleryRes.data:[];
                if(galleryImages.length>0){
                    const picked=galleryImages[Math.floor(Math.random()*galleryImages.length)];
                    image=picked.url;
                    document.getElementById('edImage').value=image;
                    renderCoverPreview();
                    showToast(`已自动从图库选择封面: ${picked.key}`,'success');
                }else{
                    showConfirm('图库中没有图片，无法自动选择封面。请先上传一张封面图或先在图片管理中上传图片。','缺少封面图','知道了');
                    return;
                }
            }
            const body={title,excerpt,tags,content,status,image};
            if(editingId)body.id=editingId;
            const r=await apiFetch('action=articles',{method:'POST',body:JSON.stringify(body)});
            if(r.status==='success'){
                const meta=(r.data&&r.data.data)?r.data.data:(r.data||{});
                lastSaved={id:editingId||meta.id||'',filename:meta.filename||''};
                resetEditor();
                notifyArticlesChanged();
                showToast('已保存','success');
                // 默认留在写页（不再跳回列表），可继续改或预览
                if(opt.preview){
                    if(lastSaved.id)openFrontPreview(buildFrontUrl(lastSaved));
                    else showToast('预览需要先保存成功','error');
                }
            }else{
                showToast(r.message||'保存失败','error');
            }
        }
        // 「保存并预览」：保存后直接在右侧抽屉查看前台效果
        function saveArticlePreview(){saveArticle({preview:true})}
        // ===== 写文章 tab：形态切换（文章 / 随记 / 白板） =====
        let writeMode='article';
        function setWriteMode(mode){
            writeMode=mode;
            const pane={article:'writeModeArticle',note:'writeModeNote',board:'writeModeBoard'};
            document.querySelectorAll('#tab-write .wm-chip').forEach(function(b,i){b.classList.toggle('active',['article','note','board'][i]===mode)});
            for(const k in pane){
                const el=document.getElementById(pane[k]);
                if(el)el.style.display=k===mode?'':'none';
            }
            if(mode==='article'){ensureEditor()}
            else if(mode==='note'){loadRecentNotes()}
            else if(mode==='board'){ensureExcBundle()}
        }
        // 白板 bundle 懒加载（切到白板形态才加载 8MB）
        function ensureExcBundle(){
            if(window.ExcalidrawMount)return;
            if(document.querySelector('script[data-excalidraw-bundle-admin]'))return;
            const css=document.createElement('link');
            css.rel='stylesheet';css.href='/js/vendor/excalidraw/excalidraw-editor.v10.css';
            css.dataset.excalidrawBundleAdmin='1';
            document.head.appendChild(css);
            const s=document.createElement('script');
            s.src='/js/vendor/excalidraw/excalidraw-editor.v10.js';
            s.dataset.excalidrawBundleAdmin='1';
            s.onerror=function(){showToast('白板组件加载失败','error')};
            document.head.appendChild(s);
        }
        function wbMount(){
            const host=document.getElementById('wbBoardHost');
            const input=document.getElementById('wbNoteId');
            if(!host)return;
            const id=(input&&input.value||'').trim();
            if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)){
                host.innerHTML='<div style="height:100%;display:flex;align-items:center;justify-content:center;color:#888;font-size:13px">请输入有效画板 ID，或点「新建画板」</div>';
                return;
            }
            host.innerHTML='<div data-excalidraw data-note="'+escAttr(id)+'" data-mode="edit"></div>';
            if(window.ExcalidrawMount)window.ExcalidrawMount();
            else ensureExcBundle();
        }
        function wbNew(){
            const d=document.getElementById('wbNoteId');
            const id='wb-'+Math.random().toString(36).slice(2,10);
            if(d)d.value=id;
            wbMount();
            showToast('新画板 '+id+'：直接开画，保存需管理员','success');
        }
        async function wbSave(){
            const saver=window.__excalidrawSave;
            if(!saver){showToast('画板尚未初始化，请先新建或载入','error');return}
            const ok=await saver();
            showToast(ok?'画板已保存':'保存未完成（口令/空画布/网络？）',ok?'success':'error');
        }
        // 随记快速记录
        async function wmNoteSave(){
            const content=document.getElementById('wmNoteContent').value;
            if(!String(content||'').trim()){showToast('写点什么再保存','error');return}
            const title=(document.getElementById('wmNoteTitle').value||'').trim();
            const tags=(document.getElementById('wmNoteTags').value||'').split(/[,，]/).map(function(s){return s.trim()}).filter(Boolean);
            const finalTitle=title||String(content).replace(/\n/g,' ').trim().slice(0,20);
            const r=await apiFetch('action=articles',{method:'POST',body:JSON.stringify({title:finalTitle,content:String(content),status:'published',type:'card',tags})});
            if(r.status==='success'){
                showToast('随记已发布','success');
                document.getElementById('wmNoteTitle').value='';
                document.getElementById('wmNoteContent').value='';
                document.getElementById('wmNoteTags').value='';
                loadRecentNotes();
                notifyArticlesChanged();
            }else showToast(r.message||'保存失败','error');
        }
        async function loadRecentNotes(){
            const box=document.getElementById('wmRecentNotes');
            if(!box)return;
            const r=await apiFetch('action=articles&filter=card&withContent=1');
            const list=((r.data||[])).filter(function(a){return a.status==='published'}).slice(0,5);
            if(!list.length){box.innerHTML='<div class="wm-hint">还没有随记，上面记一条吧</div>';return}
            box.innerHTML='<div class="wm-hint" style="margin-bottom:4px">最近随记：</div>'+list.map(function(a){
                return '<div class="wm-recent-item">'+
                    '<span class="txt" onclick="switchTab(\'articles\');setArtType(\'card\')" title="到文章管理查看">'+esc(String(a.title||'').slice(0,40))+'</span>'+
                    '<span class="date">'+esc(String(a.date||'').slice(0,10))+'</span>'+
                    '<button class="btn btn-ghost btn-sm" onclick="wmNoteDelete(\''+escJs(a.id)+'\')">删除</button></div>';
            }).join('');
        }
        async function wmNoteDelete(id){
            const ok=await showConfirm('删除这条随记？','删除随记','删除');
            if(!ok)return;
            const r=await apiFetch('action=articles&id='+encodeURIComponent(id),{method:'DELETE'});
            if(r.status==='success'){showToast('已删除','success');loadRecentNotes();notifyArticlesChanged()}
            else showToast(r.message||'删除失败','error');
        }

        let lastSaved={id:'',filename:''},lastFpUrl='';
        function buildFrontUrl(ref){
            const name=encodeURIComponent(ref.filename||((ref.id||'')+'.md'));
            const bid=encodeURIComponent(ref.id||'');
            return '/article.html?post='+name+(bid?'&blob='+bid:'');
        }
        function openFrontPreview(url){
            const d=document.getElementById('fpDrawer'),m=document.getElementById('fpMask'),f=document.getElementById('fpFrame');
            if(!d||!f)return;
            lastFpUrl=url;
            f.src=url;
            d.classList.add('open');d.setAttribute('aria-hidden','false');
            if(m)m.classList.add('show');
        }
        function closeFrontPreview(){
            const d=document.getElementById('fpDrawer'),m=document.getElementById('fpMask');
            if(d)d.classList.remove('open');
            if(m)m.classList.remove('show');
        }
        function openFrontPreviewNew(){if(lastFpUrl)window.open(lastFpUrl,'_blank')}
        document.addEventListener('keydown',function(e){
            if(e.key==='Escape'){
                const d=document.getElementById('fpDrawer');
                if(d&&d.classList.contains('open'))closeFrontPreview();
            }
        });
        // ===== Vditor 编辑器（所见即所得，轻量沉浸式） =====
        let vditorInstance=null;
        let vditorReady=false;      // after 回调触发后为 true
        let vditorPendingMd=null;   // 初始化完成前暂存待写入内容
        let vditorResizeBound=false; // resize 自适应监听只绑定一次
        function ensureEditor(){
            if(vditorInstance)return vditorInstance;
            const host=document.getElementById('vditor');
            if(!host)return null;
            if(typeof Vditor==='undefined'){
                host.innerHTML='<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px">编辑器加载失败，请刷新页面重试</div>';
                return null;
            }
            // 防御：若此前某次初始化中断在 #vditor 内残留了编辑器 DOM，
            // 先清空再重建，避免页面上出现两份编辑器 DOM 上下堆叠
            if(host.querySelector('.vditor'))host.innerHTML='';
            vditorInstance=new Vditor('vditor',{
                height:Math.max(360,document.querySelector('.content')?.offsetHeight-300||500),
                // 注意：不带尾部斜杠，Vditor 内部按 cdn + '/dist/...' 拼接
                cdn:'js/vendor/vditor',
                mode:'wysiwyg',
                theme:'dark',
                lang:'zh_CN',
                placeholder:'开始写作吧……支持 Markdown 语法，拖拽或粘贴图片会自动上传',
                toolbar:[
                    'emoji','headings','bold','italic','strike','link',
                    '|','list','ordered-list','check','outdent','indent',
                    '|','quote','line','code','inline-code','table',
                    '|','upload','edit-mode','fullscreen',
                    '|','undo','redo','more'
                ],
                upload:{
                    url:'/api/article-image',
                    fieldName:'file',
                    max:10*1024*1024,
                    accept:'image/*',
                    format:(files,responseText)=>{
                        const resp=JSON.parse(responseText);
                        if(resp.status==='success'&&resp.data){
                            return JSON.stringify({
                                msg:'',
                                code:0,
                                data:{src:[resp.data.url],alt:[files[0]?.name||'图片']}
                            });
                        }
                        return JSON.stringify({msg:'上传失败',code:1,data:{src:[]}});
                    },
                    success:(editor,msg)=>{
                        const resp=JSON.parse(msg);
                        if(resp.data?.src?.[0])trackArticleImage(resp.data.src[0]);
                    }
                },
                cache:{enable:true},
                after:()=>{
                    vditorReady=true;
                    switchEditorTheme(currentEditorTheme);
                    if(!vditorResizeBound){
                        vditorResizeBound=true;
                        // 窗口尺寸变化时同步编辑器高度，避免底部留白或超高溢出
                        window.addEventListener('resize',()=>{
                            const el=vditorInstance&&vditorInstance.element;
                            if(!el||el.classList.contains('vditor--fullscreen'))return;
                            el.style.height=Math.max(360,(document.querySelector('.content')?.offsetHeight||700)-300)+'px';
                        });
                    }
                    if(vditorPendingMd!==null){
                        const md=vditorPendingMd;
                        vditorPendingMd=null;
                        vditorInstance.setValue(md);
                        scanArticleImagesFromContent(md);
                    }
                    updateEditorInfo();
                }
            });
            return vditorInstance;
        }
        function getEditorContent(){const ed=ensureEditor();return ed?ed.getValue():''}
        function setEditorContent(md){
            const ed=ensureEditor();
            if(!ed)return;
            md=md||'';
            // 编辑器尚未初始化完成（懒加载 i18n/lute 中）时先暂存，after 后写入，避免 setValue 报错或内容丢失
            if(!vditorReady){vditorPendingMd=md;return}
            ed.setValue(md);
            scanArticleImagesFromContent(md);
            updateEditorInfo();
        }
        function updateEditorInfo(){
            const el=document.getElementById('editorInfo');
            if(el&&vditorInstance){
                const val=vditorInstance.getValue()||'';
                el.textContent=val.length+' 字';
            }
        }
        function insertAtCursor(t){
            const ed=ensureEditor();
            if(!ed)return;
            ed.insertValue(t);
            updateEditorInfo();
        }

        // ===== 编辑器主题切换 =====
        const editorThemes={
            dark:{bg:'rgba(26,26,26,0.8)',text:'#fff',preBg:'rgba(8,8,8,0.6)'},
            light:{bg:'rgba(255,255,255,0.95)',text:'#1a1a1a',preBg:'#f0f0f0'},
            sepia:{bg:'rgba(244,236,216,0.95)',text:'#3e332a',preBg:'rgba(210,195,170,0.5)'},
            green:{bg:'rgba(199,237,204,0.9)',text:'#1a3a1a',preBg:'rgba(170,210,175,0.5)'},
            blue:{bg:'rgba(220,232,245,0.9)',text:'#1a2a3a',preBg:'rgba(190,205,225,0.5)'}
        };
        let currentEditorTheme=localStorage.getItem('editor_theme')||'dark';
        function switchEditorTheme(theme){
            currentEditorTheme=theme;
            localStorage.setItem('editor_theme',theme);
            const vditorEl=document.getElementById('vditor');
            if(vditorEl){
                vditorEl.className='vditor-wrap vditor-theme-'+theme;
                const t=editorThemes[theme];
                vditorEl.style.setProperty('--editor-bg',t.bg);
                vditorEl.style.setProperty('--editor-text',t.text);
                vditorEl.style.setProperty('--editor-pre-bg',t.preBg);
            }
            document.querySelectorAll('.theme-dot').forEach(d=>{
                d.classList.toggle('active',d.dataset.theme===theme);
            });
        }

        // ===== 发布弹窗 =====
        function openPublishModal(){
            document.getElementById('publishModal').classList.add('open');
            loadArticleTagNames();
        }
        function closePublishModal(){
            document.getElementById('publishModal').classList.remove('open');
        }

        // ===== 图片上传 =====
        // tags 参数：可选的初始标签
        // 上传文章图片（存入独立 article-images store，不影响图库）
        async function uploadArticleImageAndGetUrl(file){
            const prog=document.getElementById('uploadProgress'),pt=document.getElementById('uploadProgressText');
            prog.classList.add('show');pt.textContent=`上传 ${file.name}...`;
            try{
                const compressed = await compressImage(file);
                const body={data:compressed.data,mime:compressed.mime,name:file.name};
                const res=await fetch('/api/article-image',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},
                    body:JSON.stringify(body)
                });
                const r=await res.json();
                if(r.status==='success'){
                    addUploadLog({file:file.name,status:'success',message:'上传成功',key:r.key,time:new Date().toLocaleTimeString()});
                    return r.url;
                }else{
                    addUploadLog({file:file.name,status:'fail',message:r.message||'上传失败',time:new Date().toLocaleTimeString()});
                    showToast(r.message||'上传失败','error');
                    return null;
                }
            }catch(e){
                addUploadLog({file:file.name,status:'fail',message:e.message||'上传异常',time:new Date().toLocaleTimeString()});
                showToast('上传失败','error');
                return null;
            }finally{prog.classList.remove('show')}
        }

        // 删除文章图片（只删除独立 article-images store）
        async function deleteArticleImageFile(key){
            const res=await fetch(`/api/article-image?key=${encodeURIComponent(key)}`,{
                method:'DELETE',
                headers:{'X-Admin-Key':adminKey}
            });
            return res.json();
        }

        async function uploadImageAndGetUrl(file, tags){
            const prog=document.getElementById('uploadProgress'),pt=document.getElementById('uploadProgressText');
            prog.classList.add('show');pt.textContent=`上传 ${file.name}...`;
            try{
                // 先压缩图片（限制在 1920x1080 内，WebP 质量 82）
                const compressed = await compressImage(file);
                const b64 = compressed.data;
                const mime = compressed.mime;
                const body={data:b64,mime,name:file.name};
                if(tags)body.tags=tags;
                const r=await apiFetch('action=images',{method:'POST',body:JSON.stringify(body)});
                if(r.status==='success'){
                    addUploadLog({file:file.name,status:'success',message:'上传成功',key:r.key,time:new Date().toLocaleTimeString()});
                    showToast(`已上传: ${r.key}`,'success');
                    return r.url;
                }else{
                    addUploadLog({file:file.name,status:'fail',message:r.message||'上传失败',time:new Date().toLocaleTimeString()});
                    showToast(r.message||'上传失败','error');
                    return null;
                }
            }catch(e){
                addUploadLog({file:file.name,status:'fail',message:e.message||'上传异常',time:new Date().toLocaleTimeString()});
                showToast('上传失败','error');
                return null;
            }finally{prog.classList.remove('show')}
        }

        // 添加上传记录
        function addUploadLog(entry){
            uploadLog.unshift(entry);
            // 只保留最近 100 条
            if(uploadLog.length>100)uploadLog.pop();
            updateUploadLogBtn();
        }

        // 更新上传记录按钮显示
        function updateUploadLogBtn(){
            const btn=document.getElementById('uploadLogBtn');
            const failCount=document.getElementById('uploadFailCount');
            const fails=uploadLog.filter(l=>l.status==='fail').length;
            if(failCount){
                if(fails>0){
                    failCount.textContent=`(${fails} 失败)`;
                    failCount.style.display='';
                }else{
                    failCount.style.display='none';
                }
            }
        }

        // 显示上传记录弹窗
        function showUploadLog(){
            const modal=document.getElementById('uploadLogModal');
            const list=document.getElementById('uploadLogList');
            if(!uploadLog.length){
                list.innerHTML='<div class="empty">暂无上传记录</div>';
            }else{
                list.innerHTML=uploadLog.map(l=>`
                    <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);font-size:12px">
                        <span style="color:${l.status==='success'?'var(--success)':'var(--danger)'};font-weight:600;flex-shrink:0">${l.status==='success'?'✓':'✗'}</span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.file)}</span>
                        <span style="color:var(--text-muted);flex-shrink:0">${l.time}</span>
                        <span style="color:${l.status==='success'?'var(--text-muted)':'var(--danger)'};max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.message||'')}</span>
                    </div>
                `).join('');
            }
            modal.classList.add('open');
        }
        function closeUploadLog(){document.getElementById('uploadLogModal').classList.remove('open')}
        function clearUploadLog(){uploadLog=[];updateUploadLogBtn();const list=document.getElementById('uploadLogList');if(list)list.innerHTML='<div class="empty">暂无上传记录</div>'}

        // 压缩图片：限制尺寸并转 WebP，避免超过函数请求体限制
        function compressImage(file){
            return new Promise((resolve,reject)=>{
                const reader=new FileReader();
                reader.onerror=reject;
                reader.onload=()=>{
                    const img=new Image();
                    img.onerror=reject;
                    img.onload=()=>{
                        // 计算目标尺寸（最大 1920x1080）
                        let {width,height}=img;
                        const maxW=1920,maxH=1080;
                        if(width>maxW||height>maxH){
                            const ratio=Math.min(maxW/width,maxH/height);
                            width=Math.round(width*ratio);
                            height=Math.round(height*ratio);
                        }
                        // SVG 不压缩，直接返回
                        if(file.type==='image/svg+xml'){
                            resolve({data:reader.result.split(',')[1],mime:file.type});
                            return;
                        }
                        const canvas=document.createElement('canvas');
                        canvas.width=width;
                        canvas.height=height;
                        const ctx=canvas.getContext('2d');
                        if(!ctx){reject(new Error('无法创建画布'));return}
                        ctx.drawImage(img,0,0,width,height);
                        // 转 WebP（质量 82）
                        const webpData=canvas.toDataURL('image/webp',0.82).split(',')[1];
                        resolve({data:webpData,mime:'image/webp'});
                    };
                    img.src=reader.result;
                };
                reader.readAsDataURL(file);
            });
        }
        // 图片管理上传：targetTag 为 null/undefined 表示上传到未分类，否则上传到指定标签
        async function uploadImages(files, targetTag){
            const total = files.length;
            let success = 0, fail = 0;
            for(const f of files){
                showToast(`上传中 (${success + fail + 1}/${total}): ${f.name}`, 'success');
                const url = await uploadImageAndGetUrl(f, targetTag ? [targetTag] : undefined);
                if(url){
                    success++;
                    // 乐观更新：上传成功后立即添加到本地数据
                    // 从 API 重新获取图片信息（key 和 tags）
                    try{
                        const imgRes=await apiFetch('action=images');
                        if(imgRes.status==='success'){
                            allImageData=imgRes.data||[];
                            cachedImages=allImageData;
                            // 刷新标签
                            const tagRes=await apiFetch('action=tags');
                            if(tagRes.status==='success'){
                                imageTagNames=(tagRes.data||[]).filter(t=>t.inImageRegistry).map(t=>({name:t.name,count:t.imageCount}));
                            }
                            if(targetTag && imageTagNames.some(t=>t.name===targetTag)){
                                classifyTag=targetTag;
                            }
                            renderTagSel();
                            renderPanels();
                        }
                    }catch(e){}
                }else{
                    fail++;
                }
            }
            // 最后完整刷新一次，确保与服务器一致
            await loadData();
            if(fail === 0){
                showToast(`上传完成: ${success} 张图片全部成功`, 'success');
            }else{
                showToast(`上传完成: ${success} 成功, ${fail} 失败`, fail > 0 ? 'error' : 'success');
            }
        }
        function importToEditor(f){if(!f)return;const r=new FileReader();r.onload=()=>{const m=r.result.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);insertAtCursor(m?m[2]:r.result);showToast(`已插入: ${f.name}`,'success')};r.readAsText(f)}
        function exportMarkdown(){const title=document.getElementById('edTitle').value.trim()||'untitled',excerpt=document.getElementById('edExcerpt').value.trim(),image=document.getElementById('edImage').value.trim(),md=`---\ntitle: ${title}\ndate: ${new Date().toISOString().slice(0,10)}\n${excerpt?`excerpt: ${excerpt}\n`:''}${image?`image: ${image}\n`:''}tags: [${selectedArticleTags.join(', ')}]\nauthor: 博主\n---\n\n${getEditorContent()}`,a=document.createElement('a');a.href=URL.createObjectURL(new Blob([md],{type:'text/markdown'}));a.download=`${title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'-')}.md`;a.click();showToast('已导出','success')}

        // 编辑器内上传图片并插入（多文件）
        async function uploadAndInsertToEditor(files){
            for(const f of files){
                const url=await uploadArticleImageAndGetUrl(f);
                if(url){
                    insertAtCursor(`![${f.name.replace(/\.\w+$/,'')}](${url})`);
                    trackArticleImage(url);
                }
            }
        }

        // ===== 文中图片管理 =====
        // 从图片 URL 提取 key 并记录到文中图片列表
        function trackArticleImage(url){
            if(!url)return;
            let key='';
            let type='gallery';
            try{
                const u=new URL(url,window.location.href);
                // 新缓存友好格式：/images/a/xxx.webp、/images/g/xxx.webp、/images/t/xxx.webp（缩略图）
                const m=u.pathname.match(/^\/images\/(a|g|g-thumb|t)\/([^/]+)$/);
                if(m){
                    type=m[1]==='a'?'article':'gallery';
                    key=decodeURIComponent(m[2]);
                }else{
                    // 旧格式：/api/article-image?key=...、/api/admin-image?key=...
                    key=decodeURIComponent(u.searchParams.get('key')||'');
                    type=u.pathname.includes('/api/article-image')?'article':'gallery';
                }
            }catch(e){}
            if(!key){
                // 可能是完整 URL，尝试从末尾提取
                const m=url.match(/key=([^&]+)/);
                if(m)key=decodeURIComponent(m[1]);
            }
            if(!key)return;
            // 去重（同 key 同类型）
            if(!articleImages.some(i=>i.key===key&&i.type===type)){
                articleImages.push({key,url,type});
            }
            renderArticleImages();
        }
        // 渲染文中图片列表
        function renderArticleImages(){
            const list=document.getElementById('articleImagesList');
            const count=document.getElementById('articleImgCount');
            if(!list)return;
            if(count)count.textContent=articleImages.length;
            if(!articleImages.length){
                list.innerHTML='<span class="write-article-images-empty">暂无图片，上传或从图库插入后显示</span>';
                return;
            }
            list.innerHTML=articleImages.map(img=>`
                <div class="write-article-img-item" title="${esc(img.key)}">
                    <img src="${displayUrl(img.url)}" loading="lazy">
                    <button class="del" onclick="deleteArticleImage('${escAttr(img.key)}')" title="删除图片">&times;</button>
                </div>
            `).join('');
        }
        // 删除文中图片：文章图片删除独立存储，图库图片仅从文中移除
        async function deleteArticleImage(key){
            const item=articleImages.find(i=>i.key===key);
            const isArticleImg=item&&item.type==='article';
            const confirmed=await showConfirm(`确定删除 ${key}？${isArticleImg?'图片将同时从后端移除。':'该图片来自图库，仅从本文移除，不影响图库。'}`,'删除图片','删除');
            if(!confirmed)return;
            let ok=true;
            if(isArticleImg){
                const r=await deleteArticleImageFile(key);
                if(r.status!=='success'){
                    showToast(r.message||'删除失败','error');
                    ok=false;
                }
            }
            if(ok){
                showToast('已删除','success');
                articleImages=articleImages.filter(i=>i.key!==key);
                renderArticleImages();
            }
        }
        // 根据正文扫描图片（编辑已有文章时初始化）
        function scanArticleImagesFromContent(content){
            articleImages=[];
            if(content){
                const regex=/!\[[^\]]*\]\(([^)]+)\)/g;
                let m;
                while((m=regex.exec(content))){
                    trackArticleImage(m[1]);
                }
            }
            renderArticleImages();
        }

        // ===== 封面图设置 =====
        // 显示封面预览
        function renderCoverPreview(){
            const img=document.getElementById('coverPreviewImg');
            const placeholder=document.getElementById('coverPlaceholder');
            const clearBtn=document.getElementById('coverClearBtn');
            const image=document.getElementById('edImage').value.trim();
            if(image){
                img.src=image;
                img.style.display='block';
                placeholder.style.display='none';
                clearBtn.style.display='';
            }else{
                img.style.display='none';
                placeholder.style.display='';
                clearBtn.style.display='none';
            }
        }
        // 上传封面图
        async function setCoverImage(file){
            if(!file)return;
            const url=await uploadArticleImageAndGetUrl(file);
            if(url){
                document.getElementById('edImage').value=url;
                renderCoverPreview();
                showToast('封面已设置','success');
            }
        }
        // 从图库选择封面
        async function pickCoverFromGallery(){
            document.getElementById('imagePickerPanel').classList.add('open');
            const r=await apiFetch('action=images');
            if(r.status==='success'){
                cachedImages=r.data||[];
                window.__coverMode=true; // 标记为封面选择模式
                renderImagePicker();
            }
        }
        // 移除封面
        function clearCoverImage(){
            document.getElementById('edImage').value='';
            renderCoverPreview();
            showToast('封面已移除','success');
        }
        // 封面模式下的图片选择
        function coverSelectFromPicker(url){
            document.getElementById('edImage').value=url;
            renderCoverPreview();
            closeImagePicker();
            window.__coverMode=false;
            showToast('封面已设置','success');
        }

        // ===== 图片管理（显示所有图片）=====
        async function loadData(){
            // 并行加载图片和标签
            const [imgRes,tagRes]=await Promise.all([apiFetch('action=images'),apiFetch('action=tags')]);
            if(imgRes.status==='success'){
                // 显示所有图片
                allImageData=imgRes.data||[];
                cachedImages=allImageData;
            }
            // 刷新图片标签名称（与标签管理的图片标签保持一致）
            await refreshImageTags(tagRes);
            // 默认选中第一个标签
            if(!classifyTag||!imageTagNames.some(t=>t.name===classifyTag)){
                classifyTag=imageTagNames[0]?.name||'';
            }
            renderTagSel();
            renderPanels();
        }

        // 刷新图片标签名称（使用注册表中的图片标签，与标签管理保持一致）
        async function refreshImageTags(tagRes){
            if(!tagRes){
                tagRes=await apiFetch('action=tags');
            }
            if(tagRes.status==='success'){
                // 与标签管理一致：使用注册表中的图片标签（inImageRegistry）
                // 保存 {name, count} 结构，用于显示图片张数
                imageTagNames=(tagRes.data||[])
                    .filter(t=>t.inImageRegistry)
                    .map(t=>({name:t.name,count:t.imageCount}));
            }
        }

        function renderTagSel(){
            const sel=document.getElementById('classifyTagSel');
            if(!imageTagNames.length){sel.innerHTML='<span style="color:var(--text-muted);font-size:12px">暂无图片标签，请先在标签管理中添加</span>';return}
            sel.innerHTML=imageTagNames.map(t=>`<button class="${classifyTag===t.name?'active':''}" onclick="selectTag('${escJs(t.name)}')">${esc(t.name)}<span style="font-size:10px;opacity:.7;margin-left:4px">(${t.count})</span></button>`).join('');
        }

        function selectTag(tag){classifyTag=tag;renderTagSel();renderPanels()}

        function renderPanels(){
            // 未分类：没有任何标签的图片
            const untagged=allImageData.filter(i=>{
                const tags=i.tags||[];
                return tags.length===0;
            });
            const classified=allImageData.filter(i=>(i.tags||[]).includes(classifyTag));

            document.getElementById('unclassifiedCount').textContent=untagged.length;
            const leftGrid=document.getElementById('unclassifiedGrid');
            if(!untagged.length){leftGrid.innerHTML='<div class="classify-empty" style="border:none">所有图片已分类 ✓</div>'}
            else{leftGrid.innerHTML=untagged.map(img=>classifyCardHtml(img, true)).join('')}

            const rightGrid=document.getElementById('classifiedGrid');
            if(!classified.length){rightGrid.innerHTML='<div class="classify-empty">拖拽图片到这里分类</div>'}
            else{rightGrid.innerHTML=classified.map(img=>classifyCardHtml(img, true)).join('')}

            // 更新批量操作按钮状态
            updateBatchButtons();

            // 左侧放置区：拖入清除标签 或 拖入文件上传
            const leftPanel=document.getElementById('classifyLeft');
            leftPanel.ondragover=e=>{
                e.preventDefault();
                leftPanel.classList.add('drag-over');
            };
            leftPanel.ondragleave=()=>leftPanel.classList.remove('drag-over');
            leftPanel.ondrop=async e=>{
                e.preventDefault();
                leftPanel.classList.remove('drag-over');
                // 优先判断是否为站内图片拖拽（通过自定义 data type）
                const types=e.dataTransfer.types||[];
                const isInternalDrag=types.includes('text/key');
                if(isInternalDrag){
                    const key=e.dataTransfer.getData('text/key');
                    if(key)await clearTags(key);
                    return;
                }
                // 否则是外部文件拖拽（上传到未分类）
                if(e.dataTransfer.files && e.dataTransfer.files.length > 0){
                    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                    if(files.length > 0){
                        await uploadImages(files);
                        return;
                    }
                }
            };

            // 右侧放置区：拖入打标签 或 拖入文件上传到当前分类
            const rightPanel=document.getElementById('classifyRight');
            rightPanel.ondragover=e=>{e.preventDefault();rightPanel.classList.add('drag-over')};
            rightPanel.ondragleave=()=>rightPanel.classList.remove('drag-over');
            rightPanel.ondrop=async e=>{
                e.preventDefault();
                rightPanel.classList.remove('drag-over');
                // 优先判断是否为站内图片拖拽（通过自定义 data type）
                const types=e.dataTransfer.types||[];
                const isInternalDrag=types.includes('text/key');
                if(isInternalDrag){
                    const key=e.dataTransfer.getData('text/key');
                    if(key)await assignTag(key,classifyTag);
                    return;
                }
                // 否则是外部文件拖拽（上传到当前分类）
                if(e.dataTransfer.files && e.dataTransfer.files.length > 0){
                    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                    if(files.length > 0){
                        await uploadImages(files, classifyTag);
                        return;
                    }
                }
            };
        }

        function classifyCardHtml(img, showCheckbox=false){
            const checked = selectedImageKeys.has(img.key) ? 'checked' : '';
            const checkbox = (showCheckbox && batchMode) ? `<input type="checkbox" class="img-checkbox" ${checked} style="position:absolute;top:4px;left:4px;z-index:2">` : '';
            return `<div class="classify-card${selectedImageKeys.has(img.key) && batchMode ? ' selected' : ''}" draggable="true" data-key="${escAttr(img.key)}">${checkbox}<img src="${displayUrl(img.url)}" loading="lazy"><div class="cc-bottom"><span class="cc-name" title="${escAttr(img.key)}">${esc(img.key)}</span><button class="cc-del" title="删除">&times;</button></div></div>`;
        }

        // HTML 属性转义（用于 data-key）
        function escAttr(s){return String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

        function dragStart(e){
            const key=e.target.closest('.classify-card')?.getAttribute('data-key');
            if(!key)return;
            e.dataTransfer.setData('text/key',key);
            e.target.classList.add('dragging');
            e.target.addEventListener('dragend',()=>e.target.classList.remove('dragging'),{once:true});
        }

        async function clearTags(key){
            const img=allImageData.find(i=>i.key===key);
            const cur=img?(img.tags||[]):[];
            // 清空所有标签
            const newTags=[];
            if(cur.length===0){showToast('本就未分类','error');return}
            // 乐观更新
            if(img)img.tags=newTags;
            renderPanels();
            showToast('已移至未分类','success');
            // 后台同步
            const r=await apiFetch('action=images',{method:'PATCH',body:JSON.stringify({key,tags:newTags})});
            if(r.status!=='success'){if(img)img.tags=cur;renderPanels();showToast(r.message||'同步失败','error')}
        }

        // 切换批量模式（支持左右两侧）
        function toggleBatchMode(side){
            // 如果切换到另一侧，先清除当前选择
            if(batchMode && batchSide !== side){
                selectedImageKeys.clear();
            }
            batchSide = side;
            batchMode = !batchMode;
            
            if(batchMode){
                // 显示当前侧的批量操作按钮
                if(side==='left'){
                    document.getElementById('btnBatchModeLeft').style.display = 'none';
                    document.getElementById('batchActionsLeft').style.display = 'flex';
                }else{
                    document.getElementById('btnBatchMode').style.display = 'none';
                    document.getElementById('batchActions').style.display = 'flex';
                }
            }else{
                // 隐藏所有批量操作按钮
                document.getElementById('btnBatchModeLeft').style.display = '';
                document.getElementById('batchActionsLeft').style.display = 'none';
                document.getElementById('btnBatchMode').style.display = '';
                document.getElementById('batchActions').style.display = 'none';
                selectedImageKeys.clear();
            }
            renderPanels();
        }

        // 切换图片选中状态
        function toggleImageSelect(key){
            if(selectedImageKeys.has(key)){
                selectedImageKeys.delete(key);
            }else{
                selectedImageKeys.add(key);
            }
            renderPanels();
        }

        // 全选/取消全选（根据所在侧）
        function toggleSelectAll(side){
            let list;
            if(side==='left'){
                list=allImageData.filter(i=>{
                    const tags=i.tags||[];
                    return tags.length===0;
                });
            }else{
                list=allImageData.filter(i=>(i.tags||[]).includes(classifyTag));
            }
            if(selectedImageKeys.size === list.length && list.length > 0){
                // 取消全选
                selectedImageKeys.clear();
            }else{
                // 全选
                selectedImageKeys.clear();
                list.forEach(img=>selectedImageKeys.add(img.key));
            }
            renderPanels();
        }

        // 更新批量操作按钮状态
        function updateBatchButtons(){
            if(!batchMode) return;
            
            let list;
            if(batchSide==='left'){
                list=allImageData.filter(i=>{
                    const tags=i.tags||[];
                    return tags.length===0;
                });
            }else{
                list=allImageData.filter(i=>(i.tags||[]).includes(classifyTag));
            }
            
            if(batchSide==='left'){
                const btnSelectAll=document.querySelector('#batchActionsLeft button:first-child');
                const btnMove=document.querySelector('#batchActionsLeft button:nth-child(2)');
                const btnDel=document.querySelector('#batchActionsLeft button:nth-child(3)');
                if(btnSelectAll)btnSelectAll.textContent = selectedImageKeys.size === list.length && list.length > 0 ? '取消全选' : '全选';
                if(btnMove)btnMove.disabled = selectedImageKeys.size === 0;
                if(btnDel)btnDel.disabled = selectedImageKeys.size === 0;
            }else{
                const btnSelectAll=document.getElementById('btnSelectAll');
                const btnBatchClear=document.getElementById('btnBatchClear');
                const btnDel=document.querySelector('#batchActions button:nth-child(3)');
                if(btnSelectAll)btnSelectAll.textContent = selectedImageKeys.size === list.length && list.length > 0 ? '取消全选' : '全选';
                if(btnBatchClear)btnBatchClear.disabled = selectedImageKeys.size === 0;
                if(btnDel)btnDel.disabled = selectedImageKeys.size === 0;
            }
        }

        // 批量清除标签（移到未分类）
        async function batchClearTags(){
            if(selectedImageKeys.size === 0){showToast('请先选择图片','error');return}
            
            const count = selectedImageKeys.size;
            const confirmed=await showConfirm(`确定将 ${count} 张图片移至未分类？`,'移至未分类','确认');
            if(!confirmed)return;

            let success = 0, fail = 0;
            const keys = Array.from(selectedImageKeys);
            
            for(const key of keys){
                const img=allImageData.find(i=>i.key===key);
                const cur=img?(img.tags||[]):[];
                const newTags=[];
                
                // 乐观更新
                if(img)img.tags=newTags;
                
                // 后台同步
                const r=await apiFetch('action=images',{method:'PATCH',body:JSON.stringify({key,tags:newTags})});
                if(r.status==='success'){
                    success++;
                }else{
                    fail++;
                    if(img)img.tags=cur;
                }
            }

            selectedImageKeys.clear();
            exitBatchMode();
            renderPanels();
            
            if(fail === 0){
                showToast(`已将 ${success} 张图片移至未分类`,'success');
            }else{
                showToast(`${success} 成功，${fail} 失败`,'error');
            }
        }

        // 批量删除图片
        async function batchDeleteImages(){
            if(selectedImageKeys.size === 0){showToast('请先选择图片','error');return}
            
            const count = selectedImageKeys.size;
            const confirmed=await showConfirm(`确定删除 ${count} 张图片？此操作不可恢复！`,'删除图片','删除');
            if(!confirmed)return;

            let success = 0, fail = 0;
            const keys = Array.from(selectedImageKeys);
            
            for(const key of keys){
                // 乐观删除
                const idx=allImageData.findIndex(i=>i.key===key);
                if(idx>=0)allImageData.splice(idx,1);
                
                // 后台同步
                const r=await apiFetch(`action=images&key=${encodeURIComponent(key)}`,{method:'DELETE'});
                if(r.status==='success'){
                    success++;
                }else{
                    fail++;
                }
            }

            selectedImageKeys.clear();
            exitBatchMode();
            renderPanels();
            
            if(fail === 0){
                showToast(`已删除 ${success} 张图片`,'success');
            }else{
                showToast(`${success} 删除成功，${fail} 失败`,'error');
            }
        }

        // 批量转移到右侧（添加当前分类标签）
        async function batchMoveToTag(){
            if(selectedImageKeys.size === 0){showToast('请先选择图片','error');return}
            if(!classifyTag){showToast('请先选择分类标签','error');return}
            
            const count = selectedImageKeys.size;
            const confirmed=await showConfirm(`确定将 ${count} 张图片移至「${classifyTag}」分类？`,'移至分类','确认');
            if(!confirmed)return;

            let success = 0, fail = 0;
            const keys = Array.from(selectedImageKeys);
            
            for(const key of keys){
                const img=allImageData.find(i=>i.key===key);
                const cur=img?(img.tags||[]):[];
                const newTags=[...cur,classifyTag];
                
                // 乐观更新
                if(img)img.tags=newTags;
                
                // 后台同步
                const r=await apiFetch('action=images',{method:'PATCH',body:JSON.stringify({key,tags:newTags})});
                if(r.status==='success'){
                    success++;
                }else{
                    fail++;
                    if(img)img.tags=cur;
                }
            }

            selectedImageKeys.clear();
            exitBatchMode();
            renderPanels();
            
            if(fail === 0){
                showToast(`已将 ${success} 张图片移至「${classifyTag}」`,'success');
            }else{
                showToast(`${success} 成功，${fail} 失败`,'error');
            }
        }

        // 退出批量模式
        function exitBatchMode(){
            batchMode=false;
            batchSide='';
            document.getElementById('btnBatchModeLeft').style.display = '';
            document.getElementById('batchActionsLeft').style.display = 'none';
            document.getElementById('btnBatchMode').style.display = '';
            document.getElementById('batchActions').style.display = 'none';
        }

        async function assignTag(key,tag){
            const img=allImageData.find(i=>i.key===key);
            const cur=img?(img.tags||[]):[];
            if(cur.includes(tag)){showToast(`已属于「${tag}」`,'error');return}
            const newTags=[...cur,tag];
            // 乐观更新：先改本地数据并刷新 UI
            if(img)img.tags=newTags;
            renderPanels();
            showToast(`已归入「${tag}」`,'success');
            // 后台同步
            const r=await apiFetch('action=images',{method:'PATCH',body:JSON.stringify({key,tags:newTags})});
            if(r.status!=='success'){
                // 失败则回滚
                if(img)img.tags=cur;
                renderPanels();
                showToast(r.message||'同步失败','error');
            }
        }

        // 记录最近一次点击位置，弹窗就近弹出
        document.addEventListener('click',e=>{window.__lastClick={x:e.clientX,y:e.clientY}},true);
        // 通用确认弹窗：就近（光标/锚点）弹出，resolve(true) 确认，resolve(false) 取消
        function showConfirm(message, title='确认操作', okText='确认', anchor){
            return new Promise(resolve=>{
                const modal=document.getElementById('confirmModal');
                const box=modal.querySelector('.confirm-box');
                document.getElementById('confirmTitle').textContent=title;
                document.getElementById('confirmMessage').textContent=message;
                const okBtn=document.getElementById('confirmOkBtn');
                const cancelBtn=document.getElementById('confirmCancelBtn');
                okBtn.textContent=okText;
                okBtn.className=okText==='删除'?'btn btn-danger':'btn btn-primary';
                let settled=false;
                const finish=(result)=>{
                    if(settled)return;
                    settled=true;
                    modal.classList.remove('open');
                    modal.onclick=null;okBtn.onclick=null;cancelBtn.onclick=null;
                    resolve(result);
                };
                okBtn.onclick=()=>finish(true);
                cancelBtn.onclick=()=>finish(false);
                modal.onclick=e=>{if(e.target===modal)finish(false)};
                // 就近定位：优先锚点/最近点击位置，超出视口则自动修正，无锚点则居中
                box.style.transform='none';box.style.left='0px';box.style.top='0px';
                modal.classList.add('open');
                const a=anchor||window.__lastClick;
                if(a&&a.x!=null&&a.y!=null){
                    const r=box.getBoundingClientRect();
                    let x=a.x+12,y=a.y+12;
                    x=Math.max(8,Math.min(x,window.innerWidth-r.width-8));
                    y=Math.max(8,Math.min(y,window.innerHeight-r.height-8));
                    box.style.left=x+'px';box.style.top=y+'px';
                }else{
                    box.style.left='50%';box.style.top='50%';box.style.transform='translate(-50%,-50%)';
                }
            });
        }
        function closeConfirmModal(){document.getElementById('confirmModal').classList.remove('open')}

        async function deleteImage(key){const confirmed=await showConfirm(`确定删除 ${key}？`,'删除图片','删除');if(!confirmed)return;
            // 乐观删除：先从本地移除
            const idx=allImageData.findIndex(i=>i.key===key);
            if(idx>=0)allImageData.splice(idx,1);
            renderPanels();
            // 后台同步
            const r=await apiFetch(`action=images&key=${encodeURIComponent(key)}`,{method:'DELETE'});
            if(r.status==='success'){showToast('已删除','success')}else{showToast(r.message||'删除失败','error');await loadData()}
        }

        // ===== 图片灯箱 =====
        let lightboxKeys=[]; // 灯箱中显示的图片 key 列表
        let lightboxIndex=0;

        // 打开灯箱（显示当前面板中的所有图片）
        function openAdminLightbox(key){
            // 收集当前视图下所有图片 key（含未分类 + 当前分类）
            const untagged=allImageData.filter(i=>(i.tags||[]).length===0);
            const classified=allImageData.filter(i=>(i.tags||[]).includes(classifyTag));
            lightboxKeys=[...untagged,...classified].map(i=>i.key);
            // 去重
            lightboxKeys=[...new Set(lightboxKeys)];
            lightboxIndex=lightboxKeys.indexOf(key);
            if(lightboxIndex<0)lightboxIndex=0;
            renderAdminLightbox();
            document.getElementById('adminLightbox').classList.add('open');
        }

        // 渲染灯箱当前图片
        function renderAdminLightbox(){
            if(!lightboxKeys.length)return;
            const key=lightboxKeys[lightboxIndex];
            const img=allImageData.find(i=>i.key===key);
            if(!img)return;
            const lb=document.getElementById('adminLightbox');
            document.getElementById('adminLbImg').src=displayUrl(img.url);
            document.getElementById('adminLbName').textContent=`${key} · ${(img.tags||[]).join(', ')||'未分类'}`;
            document.getElementById('adminLbCounter').textContent=`${lightboxIndex+1} / ${lightboxKeys.length}`;
            document.getElementById('adminLbDownload').href=displayUrl(img.url);
            document.getElementById('adminLbDownload').download=key;
        }

        // 灯箱切换
        function adminLightboxNav(dir){
            if(!lightboxKeys.length)return;
            lightboxIndex=(lightboxIndex+dir+lightboxKeys.length)%lightboxKeys.length;
            renderAdminLightbox();
        }

        // 关闭灯箱
        function closeAdminLightbox(){
            const lb=document.getElementById('adminLightbox');
            lb.classList.remove('open');
            document.getElementById('adminLbImg').src='';
            lightboxKeys=[];
        }

        // 从灯箱删除当前图片
        async function deleteImageFromLightbox(){
            const key=lightboxKeys[lightboxIndex];
            if(!key)return;
            const confirmed=await showConfirm(`确定删除 ${key}？`,'删除图片','删除');
            if(!confirmed)return;
            const idx=allImageData.findIndex(i=>i.key===key);
            if(idx>=0)allImageData.splice(idx,1);
            renderPanels();
            const r=await apiFetch(`action=images&key=${encodeURIComponent(key)}`,{method:'DELETE'});
            if(r.status==='success'){
                showToast('已删除','success');
                // 更新灯箱列表
                lightboxKeys.splice(lightboxIndex,1);
                if(!lightboxKeys.length){
                    closeAdminLightbox();
                }else{
                    if(lightboxIndex>=lightboxKeys.length)lightboxIndex=0;
                    renderAdminLightbox();
                }
            }else{
                showToast(r.message||'删除失败','error');
                await loadData();
            }
        }

        // 预览图片点击查看大图（复用管理灯箱）
        function openLightbox(img){
            const src=img.src;
            if(!src)return;
            // 从 URL 推断 key
            let key='图片';
            try{key=decodeURIComponent(new URL(src).searchParams.get('key')||'图片')}catch(e){}
            lightboxKeys=[key];
            lightboxIndex=0;
            renderAdminLightbox();
            document.getElementById('adminLightbox').classList.add('open');
        }

        // ESC 关闭灯箱，左右键切换
        document.addEventListener('keydown',e=>{
            const lb=document.getElementById('adminLightbox');
            if(!lb||!lb.classList.contains('open'))return;
            if(e.key==='Escape')closeAdminLightbox();
            if(e.key==='ArrowLeft')adminLightboxNav(-1);
            if(e.key==='ArrowRight')adminLightboxNav(1);
        });

        // ===== 标签弹窗 =====
        function openTagModal(key,tags){tagModalKey=key;tagModalSelected=[...tags];const o=document.getElementById('tagModalOptions');o.innerHTML=imageTagNames.map(t=>`<span class="tag-opt ${tagModalSelected.includes(t.name)?'selected':''}" onclick="toggleTagOpt(this,'${escJs(t.name)}')">${esc(t.name)}</span>`).join('');document.getElementById('customTagInput').value='';document.getElementById('tagModal').classList.add('open')}
        function closeTagModal(){document.getElementById('tagModal').classList.remove('open')}
        function toggleTagOpt(el,tag){if(tagModalSelected.includes(tag)){tagModalSelected=tagModalSelected.filter(t=>t!==tag);el.classList.remove('selected')}else{tagModalSelected.push(tag);el.classList.add('selected')}}
        function addCustomTag(){const input=document.getElementById('customTagInput'),tag=input.value.trim();if(!tag||tagModalSelected.includes(tag))return;tagModalSelected.push(tag);const o=document.getElementById('tagModalOptions'),s=document.createElement('span');s.className='tag-opt selected';s.textContent=tag;s.onclick=()=>toggleTagOpt(s,tag);o.appendChild(s);input.value=''}
        async function saveTagModal(){const r=await apiFetch('action=images',{method:'PATCH',body:JSON.stringify({key:tagModalKey,tags:tagModalSelected})});if(r.status==='success'){showToast('标签已更新','success');closeTagModal();await loadData();await loadTags()}else showToast(r.message||'更新失败','error')}

        // ===== 图片选择面板 =====
        async function openImagePicker(){
            document.getElementById('imagePickerPanel').classList.add('open');
            // 图片选择器加载所有图片（包括文章图片）
            const r=await apiFetch('action=images');
            if(r.status==='success')cachedImages=r.data||[];
            renderImagePicker();
        }
        function closeImagePicker(){document.getElementById('imagePickerPanel').classList.remove('open');window.__coverMode=false;window.__avatarMode=false;window.__faviconMode=false}
        function renderImagePicker(){const l=document.getElementById('imagePickerList');if(!cachedImages.length){l.innerHTML='<div class="empty" style="padding:32px">暂无图片</div>';return}l.innerHTML=cachedImages.map(img=>`<div class="image-picker-item" data-key="${escAttr(img.key)}"><img src="${displayUrl(img.url)}" loading="lazy" onclick="onPickerImageClick(this)"><span class="name" onclick="onPickerImageClick(this.previousElementSibling)">${esc(img.key)}</span><button class="picker-del" onclick="event.stopPropagation();deletePickerImage('${escAttr(img.key)}')" title="删除图片">&times;</button></div>`).join('')}
        // 图片点击：favicon/封面/头像模式设置，否则插入正文
        function onPickerImageClick(imgEl){
            const item=imgEl.closest('.image-picker-item');
            if(!item)return;
            const key=item.getAttribute('data-key');
            const img=cachedImages.find(i=>i.key===key);
            if(!img)return;
            if(window.__faviconMode){
                faviconSelectFromPicker(img.url);
            }else if(window.__avatarMode){
                avatarSelectFromPicker(img.url);
            }else if(window.__coverMode){
                coverSelectFromPicker(img.url);
            }else{
                insertFromPicker(img.url);
            }
        }
        // 删除图片（避免后端堆积）
        async function deletePickerImage(key){
            const confirmed=await showConfirm(`确定删除 ${key}？`,'删除图片','删除');
            if(!confirmed)return;
            const r=await apiFetch(`action=images&key=${encodeURIComponent(key)}`,{method:'DELETE'});
            if(r.status==='success'){
                showToast('已删除','success');
                cachedImages=cachedImages.filter(i=>i.key!==key);
                renderImagePicker();
            }else{
                showToast(r.message||'删除失败','error');
            }
        }
        function insertFromPicker(url){insertAtCursor(`![图片](${url})`);trackArticleImage(url);closeImagePicker();showToast('已插入','success')}
        async function uploadAndInsert(files){for(const f of files){const url=await uploadArticleImageAndGetUrl(f);if(url){insertAtCursor(`![${f.name}](${url})`);trackArticleImage(url)}}cachedImages=[];openImagePicker()}

        // ===== 标签选择器（写文章） =====
        async function loadArticleTagNames(){
            const r=await apiFetch('action=tags');
            if(r.status==='success'){
                articleTagNames=(r.data||[]).filter(t=>t.articleCount>0).map(t=>t.name);
            }
        }

        function renderTagPickerChips(){
            const wrap=document.getElementById('tagPickerInput');
            const input=document.getElementById('tagPickerText');
            // 移除旧的 chips
            wrap.querySelectorAll('.tp-chip').forEach(c=>c.remove());
            // 在 input 前插入 chips
            selectedArticleTags.forEach(tag=>{
                const chip=document.createElement('span');
                chip.className='tp-chip';
                chip.innerHTML=`${esc(tag)}<button onclick="removeArticleTag('${escJs(tag)}')">&times;</button>`;
                wrap.insertBefore(chip,input);
            });
        }

        function addArticleTag(tag){
            tag=tag.trim();
            if(!tag||selectedArticleTags.includes(tag))return;
            selectedArticleTags.push(tag);
            renderTagPickerChips();
            closeTagDropdown();
            document.getElementById('tagPickerText').value='';
        }

        function removeArticleTag(tag){
            selectedArticleTags=selectedArticleTags.filter(t=>t!==tag);
            renderTagPickerChips();
        }

        function focusTagPicker(){
            document.getElementById('tagPickerText').focus();
            openTagDropdown();
        }

        function openTagDropdown(){
            if(tagPickerOpen)return;
            tagPickerOpen=true;
            renderTagDropdown();
            document.getElementById('tagPickerDropdown').classList.add('open');
            // 点击外部关闭
            setTimeout(()=>document.addEventListener('click',closeTagDropdownOutside),0);
        }

        function closeTagDropdown(){
            tagPickerOpen=false;
            document.getElementById('tagPickerDropdown').classList.remove('open');
            document.removeEventListener('click',closeTagDropdownOutside);
        }

        function closeTagDropdownOutside(e){
            const wrap=document.querySelector('.tag-picker-wrap');
            if(wrap&&!wrap.contains(e.target))closeTagDropdown();
        }

        function renderTagDropdown(){
            const dd=document.getElementById('tagPickerDropdown');
            const input=document.getElementById('tagPickerText').value.toLowerCase();
            const filtered=articleTagNames.filter(t=>!selectedArticleTags.includes(t)&&(!input||t.toLowerCase().includes(input)));
            if(!filtered.length){dd.innerHTML='<div style="padding:10px 12px;font-size:12px;color:var(--text-muted)">无匹配标签，回车添加新标签</div>';return}
            dd.innerHTML=filtered.map(t=>`<div class="tp-item" onclick="addArticleTag('${escJs(t)}')">${esc(t)}</div>`).join('');
        }

        function filterTagDropdown(){if(tagPickerOpen)renderTagDropdown()}

        function tagPickerKeydown(e){
            const input=e.target.value.trim();
            if(e.key==='Enter'&&input){
                e.preventDefault();
                addArticleTag(input);
            }
            if(e.key==='Backspace'&&!input&&selectedArticleTags.length){
                selectedArticleTags.pop();
                renderTagPickerChips();
            }
        }

        // ===== Tab =====
        function switchTab(tab){
            document.querySelectorAll('.sidebar-item').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
            document.querySelectorAll('.mobile-tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
            ['articles','write','comments','images','tags','excalidraw','cards','settings'].forEach(t=>document.getElementById('tab-'+t).style.display=t===tab?'block':'none');
            if(tab==='articles')loadArticles();
            if(tab==='comments')loadComments();
            if(tab==='settings')loadSettings();
            if(tab==='images'){loadData();loadTags()}
            if(tab==='tags'){loadTags();loadData()}
            if(tab==='excalidraw')loadExcalidrawNotes();
            if(tab==='cards')loadCards();
            if(tab==='write'){ensureEditor();if(!editingId)resetEditor();loadArticleTagNames();setWriteMode(writeMode)}
        }

        // ===== 白板管理 =====
        async function excApi(q, opts){
            const r=await fetch(`/api/excalidraw?${q}`,{...opts,headers:{'Content-Type':'application/json','X-Admin-Key':adminKey,...((opts&&opts.headers)||{})}});
            return r.json();
        }
        function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
        async function loadExcalidrawNotes(){
            const list=document.getElementById('excalidrawNoteList');
            if(!list)return;
            list.innerHTML='<div class="exc-empty">加载中…</div>';
            try{
                const d=await excApi('action=list');
                if(d.status!=='success'){list.innerHTML='<div class="exc-empty">加载失败：'+(escHtml(d.message)||'')+'</div>';return}
                const notes=d.data||[];
                if(!notes.length){
                    list.innerHTML='<div class="exc-empty">还没有白板笔记。去 <a href="/excalidraw.html?edit=1" target="_blank">新建一个</a>（需管理员登录）</div>';
                    return;
                }
                list.innerHTML=notes.map(n=>{
                    const editBadge=n.editable===1?'<span class="exc-badge on">公开可编辑</span>':'<span class="exc-badge off">只读</span>';
                    const lockBadge=n.hasKey?'<span class="exc-badge">口令保护</span>':'';
                    const updated=(n.updatedAt||'').slice(0,16).replace('T',' ');
                    return `<div class="exc-card">
                        <div style="min-width:150px">
                            <div class="exc-title">${escHtml(n.title||'(未命名)')}</div>
                            <div class="exc-id">${escHtml(n.id)}</div>
                        </div>
                        <div class="exc-meta">${editBadge}${lockBadge}<span>rev ${n.rev}</span><span>更新 ${updated}</span></div>
                        <div class="exc-ops">
                            <a class="exc-btn" href="/excalidraw.html?note=${encodeURIComponent(n.id)}" target="_blank">打开</a>
                            <a class="exc-btn" href="/excalidraw.html?note=${encodeURIComponent(n.id)}&edit=1" target="_blank">编辑</a>
                            <button class="exc-btn" onclick="excRename('${n.id}')">改名</button>
                            <button class="exc-btn" onclick="excToggleEdit('${n.id}',${n.editable})">${n.editable===1?'设为只读':'开放编辑'}</button>
                            <button class="exc-btn" onclick="excSetKey('${n.id}')">${n.hasKey?'重设口令':'设口令'}</button>
                            <button class="exc-btn" onclick="excPublish('${n.id}')" title="创建 type=whiteboard 的草稿文章（整页白板、无目录）">发布文章</button>
                            <button class="exc-btn" onclick="excRollback('${n.id}')">回滚</button>
                            <button class="exc-btn danger" onclick="excDelete('${n.id}')">删除</button>
                        </div>
                    </div>`;
                }).join('');
            }catch(e){
                list.innerHTML='<div class="exc-empty">加载出错：'+escHtml(e.message)+'</div>';
            }
        }
        async function excRename(id){
            const cur=await excApi('action=list').then(d=>((d.data||[]).find(n=>n.id===id)||{}).title||'');
            const t=prompt('设置标题（留空并确定 = 清除标题）：',cur);
            if(t===null)return;
            const d=await excApi(`action=meta&id=${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({title:t.trim()})});
            alert(d.status==='success'?'已保存':(d.message||'操作失败'));
            if(d.status==='success')loadExcalidrawNotes();
        }
        async function excToggleEdit(id,cur){
            const d=await excApi(`action=meta&id=${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({editable:cur===1?0:1})});
            alert(d.status==='success'?'已更新':(d.message||'操作失败'));
            if(d.status==='success')loadExcalidrawNotes();
        }
        async function excSetKey(id){
            const t=prompt('设置编辑口令（至少 4 位；留空并确定 = 清除口令）：','');
            if(t===null)return;
            const d=await excApi(`action=meta&id=${encodeURIComponent(id)}`,{method:'POST',body:JSON.stringify({editKey:t.trim()})});
            alert(d.status==='success'?'已更新':(d.message||'操作失败'));
            if(d.status==='success')loadExcalidrawNotes();
        }
        async function excRollback(id){
            const h=await excApi(`action=history&id=${encodeURIComponent(id)}`);
            if(h.status!=='success'){alert(h.message||'读取历史失败');return}
            const revs=[...(h.revs||[])].reverse();
            const rev=prompt(`「${id}」可用快照版本：${revs.length?revs.join(', '):'（无）'}；当前 rev ${h.current}\n输入要恢复的 rev 数字（0 = 初始版）：`);
            if(rev===null)return;
            const n=Number(rev);
            if(!Number.isInteger(n)||n<0){alert('rev 非法');return}
            const d=await excApi(`action=rollback&id=${encodeURIComponent(id)}&rev=${n}`,{method:'POST'});
            alert(d.status==='success'?`已回滚到 rev ${n}`:(d.message||'回滚失败'));
            if(d.status==='success')loadExcalidrawNotes();
        }
        // 发布为纯白板文章草稿（无封面；想要自动封面前往编辑器「发布为博文 → 纯白板文章」）
        async function excPublish(id){
            const t=prompt(`将白板「${id}」发布为纯白板文章草稿。文章标题：`,'白板：'+id);
            if(t===null)return;
            const title=(t||'').trim()||('白板：'+id);
            try{
                const r=await fetch('/api/admin?action=articles',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},body:JSON.stringify({title,content:'',status:'draft',type:'whiteboard',boardId:id,tags:[]})});
                const d=await r.json();
                alert(d.status==='success'?`白板文章草稿已创建（id: ${d.data&&d.data.id}），去文章管理发布`:(d.message||'创建失败'));
            }catch(e){alert('创建失败：'+e.message)}
        }
        async function excDelete(id){
            if(!confirm(`确定删除白板「${id}」？场景与全部历史快照将一并删除，不可恢复！`))return;
            const d=await excApi(`action=delete&id=${encodeURIComponent(id)}`,{method:'POST'});
            alert(d.status==='success'?`已删除（${d.removed} 个数据项）`:(d.message||'删除失败'));
            if(d.status==='success')loadExcalidrawNotes();
        }

        // ===== 卡片笔记（type=card 快速记录） =====
        let editingCardId = null;
        function toggleCardForm(show) {
            const wrap = document.getElementById('cardFormWrap');
            if (!wrap) return;
            const willShow = (show === undefined) ? (wrap.style.display === 'none') : show;
            wrap.style.display = willShow ? 'block' : 'none';
            if (!willShow) editingCardId = null;
        }
        async function loadCards() {
            const list = document.getElementById('cardList');
            if (!list) return;
            list.innerHTML = '<div class="exc-empty">加载中…</div>';
            try {
                const d = await apiFetch('action=articles');
                const cards = (d.data || []).filter(a => a.type === 'card');
                if (!cards.length) { list.innerHTML = '<div class="exc-empty">还没有卡片笔记。点「新建卡片」记一条，保存即发布。</div>'; return; }
                list.innerHTML = cards.map(c => {
                    const text = String(c.content || '');
                    const snippet = text.length > 140 ? text.slice(0, 140) + '…' : text;
                    return `<div class="card-item">
                        <div class="ci-body">
                            ${c.title ? '<div style="font-weight:600;margin-bottom:4px">' + escHtml(c.title) + '</div>' : ''}
                            <div class="ci-text">${escHtml(snippet)}</div>
                            <div class="ci-meta">${escHtml(c.date || '')}${c.update ? ' · 更新 ' + escHtml(c.update) : ''} · ${escHtml((c.tags || []).join(' / ') || '无标签')} · ${c.status === 'draft' ? '草稿' : '已发布'}</div>
                        </div>
                        <div class="ci-ops">
                            <button class="btn btn-ghost btn-sm" onclick="editCard('${escJs(c.id)}','${escJs(c.title || '')}','${escJs(text)}','${escJs((c.tags || []).join(', '))}')">编辑</button>
                            <button class="btn btn-danger btn-sm" onclick="deleteCard('${escJs(c.id)}','${escJs(c.title || text.slice(0, 20))}')">删除</button>
                        </div>
                    </div>`;
                }).join('');
            } catch (e) { list.innerHTML = '<div class="exc-empty">加载失败：' + escHtml(e.message) + '</div>'; }
        }
        function editCard(id, title, content, tags) {
            editingCardId = id;
            document.getElementById('cardTitle').value = title;
            document.getElementById('cardContent').value = content;
            document.getElementById('cardTags').value = tags || '';
            document.getElementById('cardFormWrap').style.display = 'block';
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        async function saveCard() {
            const content = document.getElementById('cardContent').value;
            if (!String(content || '').trim()) { showToast('内容不能为空', 'error'); return; }
            const title = (document.getElementById('cardTitle').value || '').trim();
            const tags = (document.getElementById('cardTags').value || '').split(',').map(s => s.trim()).filter(Boolean);
            const finalTitle = title || String(content).replace(/\n/g, ' ').trim().slice(0, 20);
            const body = { title: finalTitle, content, status: 'published', type: 'card', tags };
            if (editingCardId) body.id = editingCardId;
            try {
                const d = await apiFetch('action=articles', { method: 'POST', body: JSON.stringify(body) });
                if (d.status === 'success') { showToast('卡片已保存并发布', 'success'); toggleCardForm(false); loadCards(); }
                else showToast(d.message || '保存失败', 'error');
            } catch (e) { showToast('保存失败：' + e.message, 'error'); }
        }
        async function deleteCard(id, title) {
            const ok = await showConfirm('删除卡片「' + (title || id) + '」？删除后不可恢复！', '删除卡片', '删除');
            if (!ok) return;
            try {
                const r = await apiFetch('action=articles&id=' + encodeURIComponent(id), { method: 'DELETE' });
                if (r.status === 'success') { showToast('已删除', 'success'); loadCards(); }
                else showToast(r.message || '删除失败', 'error');
            } catch (e) { showToast('删除失败：' + e.message, 'error'); }
        }

        // ===== 评论管理 =====
        async function loadComments(){
            try{
                // 加载文章列表，建立 postId → 标题 映射
                let titleMap={};
                try{
                    const artRes=await apiFetch('action=articles');
                    if(artRes.status==='success'){
                        (artRes.data||[]).forEach(a=>{titleMap[a.id]=a.title});
                    }
                }catch(e){}
                const res=await fetch('/api/comments?list=1');
                const data=await res.json();
                if(data.status!=='success'){showToast('加载评论失败','error');return}
                const stats=document.getElementById('commentStats');
                stats.innerHTML=`
                    <div class="comment-stats-card"><div class="num">${data.total||0}</div><div class="label">评论总数</div></div>
                    <div class="comment-stats-card"><div class="num">${(data.posts||[]).length}</div><div class="label">涉及文章</div></div>
                `;
                const list=document.getElementById('commentManageList');
                const all=(data.posts||[]).flatMap(p=>(p.comments||[]).map(c=>({...c,postId:p.postId})));
                if(!all.length){list.innerHTML='<div class="empty">暂无评论</div>';return}
                list.innerHTML=all.map(c=>{
                    const title=titleMap[c.postId]||c.postId;
                    return `
                    <div class="comment-manage-item">
                        <div class="comment-manage-head">
                            <div class="comment-manage-name">
                                <span>${esc(c.name||'匿名')}</span>
                                <span class="comment-manage-post" title="${esc(c.postId)}">${esc(title)}</span>
                            </div>
                            <span class="comment-manage-time">${formatCommentTime(c.createdAt)}</span>
                        </div>
                        <div class="comment-manage-content">${esc(c.content).replace(/@([\u4e00-\u9fa5\w\-]{1,20})/g,'<span class="mention">@$1</span>')}</div>
                        <div class="comment-manage-actions">
                            <button class="btn btn-danger btn-sm" onclick="deleteComment('${escJs(c.postId)}','${escJs(c.id)}')">删除</button>
                        </div>
                    </div>`;
                }).join('');
            }catch(e){showToast('加载评论失败','error')}
        }
        async function deleteComment(postId,id){
            const confirmed=await showConfirm(`确定删除这条评论？`,'删除评论','删除');
            if(!confirmed)return;
            const res=await fetch(`/api/comments?postId=${encodeURIComponent(postId)}&id=${encodeURIComponent(id)}`,{
                method:'DELETE',
                headers:{'X-Admin-Key':adminKey}
            });
            const data=await res.json();
            if(data.status==='success'){showToast('已删除','success');loadComments()}
            else showToast(data.message||'删除失败','error');
        }
        function formatCommentTime(ts){
            const d=new Date(ts);
            if(isNaN(d.getTime()))return '';
            const pad=n=>String(n).padStart(2,'0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }

        // ===== 博客设置 =====
        // ===== AI 模型库选择（厂商 → 模型 → Key） =====
        let modelCatalog=[];
        async function loadModelCatalog(){
            if(modelCatalog.length)return modelCatalog;
            try{
                const r=await apiFetch('action=models');
                if(r.status==='success'&&Array.isArray(r.data))modelCatalog=r.data;
            }catch(e){}
            return modelCatalog;
        }
        // prefix: 'Ai' / 'Wr'
        function fillModelOptions(prefix,curModel){
            const providerSel=document.getElementById('set'+prefix+'Provider');
            const modelSel=document.getElementById('set'+prefix+'Model');
            const customRow=document.getElementById(prefix+'CustomRow');
            const isCustom=providerSel.value==='custom';
            if(modelSel)modelSel.style.display=isCustom?'none':'';
            if(customRow)customRow.style.display=isCustom?'':'none';
            if(!modelSel)return;
            modelSel.innerHTML='';
            if(isCustom)return;
            const p=modelCatalog.find(x=>x.id===providerSel.value);
            if(p){
                p.models.forEach(m=>{
                    const o=document.createElement('option');
                    o.value=m.id;
                    o.textContent=(m.label||m.id)+(m.tags&&m.tags.length?'（'+m.tags.join('、')+'）':'');
                    modelSel.appendChild(o);
                });
            }
            if(curModel)modelSel.value=curModel;
        }
        async function renderSettingsModels(prefix,provider,model,customUrl,customModel){
            const cat=await loadModelCatalog();
            const providerSel=document.getElementById('set'+prefix+'Provider');
            providerSel.innerHTML='';
            cat.forEach(p=>{
                const o=document.createElement('option');o.value=p.id;o.textContent=p.name;providerSel.appendChild(o);
            });
            const co=document.createElement('option');co.value='custom';co.textContent='自定义';providerSel.appendChild(co);
            providerSel.value=cat.some(p=>p.id===provider)?provider:'custom';
            if(providerSel.value==='custom'){
                if(document.getElementById('set'+prefix+'CustomUrl'))document.getElementById('set'+prefix+'CustomUrl').value=customUrl||'';
                if(document.getElementById('set'+prefix+'CustomModel'))document.getElementById('set'+prefix+'CustomModel').value=customModel||'';
            }
            fillModelOptions(prefix,model);
        }
        function toggleAdvanced(prefix){
            const body=document.getElementById(prefix+'AdvancedBody');
            const adv=body?body.closest('.settings-advanced'):null;
            const arrow=adv?adv.querySelector('.settings-advanced-toggle span'):null;
            const show=body.style.display!=='block';
            body.style.display=show?'block':'none';
            if(arrow)arrow.style.transform=show?'rotate(180deg)':'';
        }
        async function testAiConnection(prefix,btn){
            const provider=document.getElementById('set'+prefix+'Provider').value;
            const isCustom=provider==='custom';
            const model=isCustom?document.getElementById('set'+prefix+'CustomModel').value.trim():document.getElementById('set'+prefix+'Model').value;
            const customUrl=isCustom?document.getElementById('set'+prefix+'CustomUrl').value.trim():'';
            const apiKey=document.getElementById('set'+prefix+'ApiKey').value.trim();
            const resultEl=document.getElementById(prefix+'TestResult');
            if(!apiKey){resultEl.textContent='请先填写 API Key';resultEl.className='settings-test-result error';return}
            if(!model){resultEl.textContent='请选择 / 填写模型';resultEl.className='settings-test-result error';return}
            btn.disabled=true;
            resultEl.textContent='测试中…';resultEl.className='settings-test-result';
            try{
                const r=await apiFetch('action=test-ai',{method:'POST',body:JSON.stringify({provider,model,apiKey,apiUrl:customUrl})});
                if(r.status==='success'){resultEl.textContent='✓ 连接成功';resultEl.className='settings-test-result ok'}
                else{resultEl.textContent='✗ '+(r.message||'连接失败');resultEl.className='settings-test-result error'}
            }catch(e){
                resultEl.textContent='✗ 请求失败';resultEl.className='settings-test-result error';
            }finally{btn.disabled=false}
        }

        // 设置分类切换（前台 / AI / 后台）
        function switchSettingsTab(tab){
            document.querySelectorAll('.settings-tab').forEach(b=>b.classList.toggle('active',b.dataset.stab===tab));
            document.querySelectorAll('.settings-section').forEach(s=>s.classList.toggle('active',s.dataset.section===tab));
        }
        async function loadSettings(){
            const r=await apiFetch('action=settings');
            const s=r.status==='success'&&r.data?r.data:{};
            document.getElementById('setSiteTitle').value=s.siteTitle||'';
            document.getElementById('setFavicon').value=s.favicon||'';
            renderSettingsFavicon(s.favicon);
            document.getElementById('setSiteName').value=s.siteName||'';
            document.getElementById('setAvatar').value=s.avatar||'';
            renderSettingsAvatar(s.avatar);
            document.getElementById('setAuthorName').value=s.authorName||'';
            document.getElementById('setBio').value=s.bio||'';
            document.getElementById('setViewBlog').checked=s.views?s.views.blog!==false:true;
            document.getElementById('setViewGallery').checked=s.views?s.views.gallery!==false:true;
            document.getElementById('setViewNews').checked=s.views?s.views.news!==false:true;
            document.getElementById('setViewDashboard').checked=s.views?s.views.dashboard!==false:true;
            document.getElementById('setStatPosts').checked=s.stats?s.stats.posts!==false:true;
            document.getElementById('setStatTags').checked=s.stats?s.stats.tags!==false:true;
            document.getElementById('setStatWords').checked=s.stats?s.stats.words!==false:true;
            document.getElementById('setStatImages').checked=s.stats?s.stats.images!==false:true;
            document.getElementById('setNavTags').value=(s.navTags||[]).join(',');
            document.getElementById('setAboutVersion').value=s.about?s.about.version||'':'';
            document.getElementById('setAboutTech').value=s.about?s.about.tech||'':'';
            document.getElementById('setAboutUpdated').value=s.about?s.about.updated||'':'';
            const ai=s.ai||{};
            document.getElementById('setAiEnabled').checked=ai.enabled!==false;
            document.getElementById('setAiApiKey').value=ai.apiKey||'';
            document.getElementById('setAiSystemPrompt').value=ai.systemPrompt||'';
            document.getElementById('setAiMaxTokens').value=ai.maxTokens||'';
            const aiTemp=ai.temperature;
            document.getElementById('setAiTemperature').value=(aiTemp===undefined||aiTemp===null||aiTemp==='')?'':aiTemp;
            renderSettingsModels('Ai',ai.provider,ai.model,ai.apiUrl,ai.model);
        }
        // 头像预览
        function renderSettingsAvatar(src){
            const img=document.getElementById('settingsAvatarImg');
            const span=document.querySelector('#settingsAvatarPreview span');
            if(src){
                img.src=src;
                img.style.display='block';
                span.style.display='none';
            }else{
                img.style.display='none';
                span.style.display='';
            }
        }
        // favicon 预览
        function renderSettingsFavicon(src){
            const img=document.getElementById('settingsFaviconImg');
            const span=document.querySelector('#settingsFaviconPreview span');
            if(src){
                img.src=src;
                img.style.display='block';
                span.style.display='none';
            }else{
                img.style.display='none';
                span.style.display='';
            }
        }
        // 上传 favicon（存入独立 avatar-images store）
        async function uploadFaviconImage(file){
            if(!file)return;
            const cur=document.getElementById('setFavicon').value.trim();
            if(cur&&cur.includes('/api/avatar-image?')){
                try{
                    const m=cur.match(/key=([^&]+)/);
                    if(m){
                        const oldKey=decodeURIComponent(m[1]);
                        await fetch(`/api/avatar-image?key=${encodeURIComponent(oldKey)}`,{method:'DELETE',headers:{'X-Admin-Key':adminKey}});
                    }
                }catch(e){}
            }
            const prog=document.getElementById('uploadProgress'),pt=document.getElementById('uploadProgressText');
            prog.classList.add('show');pt.textContent=`上传图标 ${file.name}...`;
            try{
                const compressed=await compressImage(file);
                const res=await fetch('/api/avatar-image',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},
                    body:JSON.stringify({data:compressed.data,mime:compressed.mime,name:file.name})
                });
                const r=await res.json();
                if(r.status==='success'){
                    document.getElementById('setFavicon').value=r.url;
                    renderSettingsFavicon(r.url);
                    showToast('图标已上传','success');
                }else{
                    showToast(r.message||'上传失败','error');
                }
            }catch(e){
                showToast('上传失败','error');
            }finally{prog.classList.remove('show')}
        }
        // 从图库选择 favicon
        async function pickFaviconFromGallery(){
            document.getElementById('imagePickerPanel').classList.add('open');
            const r=await apiFetch('action=images');
            if(r.status==='success'){
                cachedImages=r.data||[];
                window.__faviconMode=true;
                renderImagePicker();
            }
        }
        // favicon 选择完成
        function faviconSelectFromPicker(url){
            document.getElementById('setFavicon').value=url;
            renderSettingsFavicon(url);
            closeImagePicker();
            window.__faviconMode=false;
            showToast('图标已设置','success');
        }
        // 移除 favicon（若为已上传的则删除后端存储）
        async function clearFaviconImage(){
            const cur=document.getElementById('setFavicon').value.trim();
            if(cur&&cur.includes('/api/avatar-image?')){
                try{
                    const m=cur.match(/key=([^&]+)/);
                    if(m){
                        const oldKey=decodeURIComponent(m[1]);
                        await fetch(`/api/avatar-image?key=${encodeURIComponent(oldKey)}`,{method:'DELETE',headers:{'X-Admin-Key':adminKey}});
                    }
                }catch(e){}
            }
            document.getElementById('setFavicon').value='';
            renderSettingsFavicon('');
            showToast('图标已移除','success');
        }
        // 上传头像（存入独立 avatar-images store，与图库/文章图片分离）
        async function uploadAvatarImage(file){
            if(!file)return;
            // 如果已有头像（是已上传的），先删除旧的
            const cur=document.getElementById('setAvatar').value.trim();
            if(cur&&cur.includes('/api/avatar-image?')){
                try{
                    const m=cur.match(/key=([^&]+)/);
                    if(m){
                        const oldKey=decodeURIComponent(m[1]);
                        await fetch(`/api/avatar-image?key=${encodeURIComponent(oldKey)}`,{method:'DELETE',headers:{'X-Admin-Key':adminKey}});
                    }
                }catch(e){}
            }
            const prog=document.getElementById('uploadProgress'),pt=document.getElementById('uploadProgressText');
            prog.classList.add('show');pt.textContent=`上传头像 ${file.name}...`;
            try{
                const compressed=await compressImage(file);
                const res=await fetch('/api/avatar-image',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},
                    body:JSON.stringify({data:compressed.data,mime:compressed.mime,name:file.name})
                });
                const r=await res.json();
                if(r.status==='success'){
                    document.getElementById('setAvatar').value=r.url;
                    renderSettingsAvatar(r.url);
                    showToast('头像已上传','success');
                }else{
                    showToast(r.message||'上传失败','error');
                }
            }catch(e){
                showToast('上传失败','error');
            }finally{prog.classList.remove('show')}
        }
        // 移除头像（若为已上传头像则删除后端存储）
        async function clearAvatarImage(){
            const cur=document.getElementById('setAvatar').value.trim();
            if(cur&&cur.includes('/api/avatar-image?')){
                try{
                    const m=cur.match(/key=([^&]+)/);
                    if(m){
                        const oldKey=decodeURIComponent(m[1]);
                        await fetch(`/api/avatar-image?key=${encodeURIComponent(oldKey)}`,{method:'DELETE',headers:{'X-Admin-Key':adminKey}});
                    }
                }catch(e){}
            }
            document.getElementById('setAvatar').value='';
            renderSettingsAvatar('');
            showToast('头像已移除','success');
        }
        // 从图库选择头像
        async function pickAvatarFromGallery(){
            document.getElementById('imagePickerPanel').classList.add('open');
            const r=await apiFetch('action=images');
            if(r.status==='success'){
                cachedImages=r.data||[];
                window.__avatarMode=true;
                renderImagePicker();
            }
        }
        // 头像选择完成
        function avatarSelectFromPicker(url){
            document.getElementById('setAvatar').value=url;
            renderSettingsAvatar(url);
            closeImagePicker();
            window.__avatarMode=false;
            showToast('头像已设置','success');
        }
        async function saveSettings(){
            const siteName=document.getElementById('setSiteName').value.trim();
            const authorName=document.getElementById('setAuthorName').value.trim();
            // 必填校验
            if(!siteName){showToast('站点名称不能为空','error');document.getElementById('setSiteName').focus();return}
            if(!authorName){showToast('用户名不能为空','error');document.getElementById('setAuthorName').focus();return}
            const body={
                siteTitle:document.getElementById('setSiteTitle').value.trim(),
                favicon:document.getElementById('setFavicon').value.trim(),
                siteName,
                avatar:document.getElementById('setAvatar').value.trim(),
                authorName,
                bio:document.getElementById('setBio').value.trim(),
                views:{
                    blog:document.getElementById('setViewBlog').checked,
                    gallery:document.getElementById('setViewGallery').checked,
                    news:document.getElementById('setViewNews').checked,
                    dashboard:document.getElementById('setViewDashboard').checked,
                },
                stats:{
                    posts:document.getElementById('setStatPosts').checked,
                    tags:document.getElementById('setStatTags').checked,
                    words:document.getElementById('setStatWords').checked,
                    images:document.getElementById('setStatImages').checked,
                },
                navTags:document.getElementById('setNavTags').value.split(',').map(s=>s.trim()).filter(Boolean),
                about:{
                    version:document.getElementById('setAboutVersion').value.trim(),
                    tech:document.getElementById('setAboutTech').value.trim(),
                    updated:document.getElementById('setAboutUpdated').value.trim(),
                },
                ai:{
                    enabled:document.getElementById('setAiEnabled').checked,
                    provider:document.getElementById('setAiProvider').value,
                    apiUrl:document.getElementById('setAiProvider').value==='custom'?document.getElementById('setAiCustomUrl').value.trim():'',
                    apiKey:document.getElementById('setAiApiKey').value.trim(),
                    model:document.getElementById('setAiProvider').value==='custom'?document.getElementById('setAiCustomModel').value.trim():document.getElementById('setAiModel').value,
                    systemPrompt:document.getElementById('setAiSystemPrompt').value.trim(),
                    maxTokens:parseInt(document.getElementById('setAiMaxTokens').value)||2048,
                    temperature:document.getElementById('setAiTemperature').value!==''?parseFloat(document.getElementById('setAiTemperature').value):0.7,
                },
            };
            const r=await apiFetch('action=settings',{method:'POST',body:JSON.stringify(body)});
            if(r.status==='success')showToast('设置已保存','success');
            else showToast(r.message||'保存失败','error');
        }
        // 修改后台密码
        async function changePassword(){
            const oldPassword=document.getElementById('setOldPassword').value;
            const newPassword=document.getElementById('setNewPassword').value;
            const confirmPassword=document.getElementById('setConfirmPassword').value;
            if(!oldPassword){showToast('请输入当前密码','error');return}
            if(!newPassword){showToast('请输入新密码','error');return}
            if(newPassword.length<4){showToast('新密码至少 4 位','error');return}
            if(newPassword!==confirmPassword){showToast('两次输入的新密码不一致','error');return}
            const r=await apiFetch('action=settings',{method:'POST',body:JSON.stringify({oldPassword,newPassword})});
            if(r.status==='success'){
                showToast('密码已修改','success');
                document.getElementById('setOldPassword').value='';
                document.getElementById('setNewPassword').value='';
                document.getElementById('setConfirmPassword').value='';
            }else{
                showToast(r.message||'修改失败','error');
            }
        }

        // ===== 标签管理 =====
        let articleTagsData=[];
        let imageTagsData=[];
        let currentTagsView='article';
        let renameOldName='';
        let renameType='article';

        async function loadTags(){
            const r=await apiFetch('action=tags');
            if(r.status!=='success')return;
            const all=r.data||[];
            // 文章标签：注册表中的 + 所有文章中实际使用的（确保显示所有文章标签）
            // 图片标签：注册表中的图片标签
            articleTagsData=all.filter(t=>t.inArticleRegistry || t.articleCount>0).map(t=>({name:t.name,count:t.articleCount}));
            imageTagsData=all.filter(t=>t.inImageRegistry || t.imageCount>0).map(t=>({name:t.name,count:t.imageCount}));
            renderTags();
        }

        function switchTagsView(view){
            currentTagsView=view;
            document.querySelectorAll('.tags-nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tview===view));
            document.getElementById('tagsViewArticle').style.display=view==='article'?'block':'none';
            document.getElementById('tagsViewImage').style.display=view==='image'?'block':'none';
            renderTags();
        }

        function renderTags(){
            const data=currentTagsView==='article'?articleTagsData:imageTagsData;
            const gridId=currentTagsView==='article'?'articleTagsGrid':'imageTagsGrid';
            const grid=document.getElementById(gridId);
            const typeLabel=currentTagsView==='article'?'文章':'图片';
            if(!data.length){grid.innerHTML=`<div class="empty">暂无${typeLabel}标签</div>`;return}
            grid.innerHTML=data.map(t=>`
                <div class="tags-card">
                    <div class="tc-info">
                        <div class="tc-name">${esc(t.name)}</div>
                        <div class="tc-counts"><span>${t.count} 个${typeLabel}</span></div>
                    </div>
                    <div class="tc-actions">
                        <button class="btn btn-ghost btn-sm" onclick="openRenameModal('${escJs(t.name)}','${currentTagsView}')">重命名</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteTag('${escJs(t.name)}',${t.count},'${currentTagsView}')">删除</button>
                    </div>
                </div>
            `).join('');
        }

        async function addNewTag(){
            const input=document.getElementById('newTagInput');
            const name=input.value.trim();
            if(!name){showToast('标签名不能为空','error');return}
            const data=currentTagsView==='article'?articleTagsData:imageTagsData;
            if(data.some(t=>t.name===name)){showToast('标签已存在','error');return}
            // 调用 API 保存到注册表
            const r=await apiFetch('action=tags',{method:'POST',body:JSON.stringify({name,type:currentTagsView})});
            if(r.status==='success'){
                input.value='';
                showToast(`${currentTagsView==='article'?'文章':'图片'}标签「${name}」已添加`,'success');
                await loadTags(); // 重新加载标签数据
                await loadData(); // 同步刷新图片管理标签
            }else showToast(r.message||'添加失败','error');
        }

        function openRenameModal(oldName,type){
            renameOldName=oldName;
            renameType=type||currentTagsView;
            document.getElementById('renameInput').value=oldName;
            document.getElementById('renameModal').classList.add('open');
            setTimeout(()=>document.getElementById('renameInput').focus(),100);
        }
        function closeRenameModal(){document.getElementById('renameModal').classList.remove('open');renameOldName=''}

        async function confirmRename(){
            const newName=document.getElementById('renameInput').value.trim();
            if(!newName){showToast('名称不能为空','error');return}
            if(newName===renameOldName){closeRenameModal();return}
            const data=renameType==='article'?articleTagsData:imageTagsData;
            if(data.some(t=>t.name===newName)){showToast('标签名已存在','error');return}
            const r=await apiFetch('action=tags',{method:'PATCH',body:JSON.stringify({oldName:renameOldName,newName})});
            if(r.status==='success'){
                showToast(`已重命名：${renameOldName} → ${newName}`,'success');
                closeRenameModal();
                await loadTags();
                await loadData();
            }else showToast(r.message||'重命名失败','error');
        }

        async function deleteTag(name,count,type){
            const typeLabel=type==='article'?'文章':'图片';
            if(count>0&&!confirm(`标签「${name}」下有 ${count} 个${typeLabel}，确定删除？`))return;
            if(count===0&&!confirm(`确定删除空标签「${name}」？`))return;
            const r=await apiFetch(`action=tags&name=${encodeURIComponent(name)}`,{method:'DELETE'});
            if(r.status==='success'){
                showToast(`已删除「${name}」，影响 ${r.imageChanges} 张图片、${r.articleChanges} 篇文章`,'success');
                await loadTags(); // 立即刷新标签
                await loadData(); // 刷新图片数据
            }else showToast(r.message||'删除失败','error');
        }

        function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
        // 用于内联事件参数中的 JS 字符串转义（转义单引号）
        function escJs(s){return String(s||'').replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\r?\n/g,' ')}
        function showToast(msg,type){const t=document.getElementById('toast');t.textContent=msg;t.className=`toast toast-${type}`;t.style.display='block';setTimeout(()=>t.style.display='none',2500)}

        // ===== 图片卡片事件委托（避免内联事件的特殊字符问题）=====
        function initCardDelegation(){
            const grids=[document.getElementById('unclassifiedGrid'),document.getElementById('classifiedGrid')];

            // 点击：图片打开灯箱，复选框选中，删除按钮删除
            grids.forEach(grid=>{
                if(!grid)return;
                grid.addEventListener('click',e=>{
                    const card=e.target.closest('.classify-card');
                    if(!card)return;
                    const key=card.getAttribute('data-key');
                    if(!key)return;
                    // 复选框
                    if(e.target.classList.contains('img-checkbox')){
                        e.stopPropagation();
                        toggleImageSelect(key);
                        return;
                    }
                    // 删除按钮
                    if(e.target.classList.contains('cc-del')){
                        e.stopPropagation();
                        deleteImage(key);
                        return;
                    }
                    // 图片点击 → 打开灯箱
                    if(e.target.tagName==='IMG'){
                        e.stopPropagation();
                        openAdminLightbox(key);
                        return;
                    }
                });
            });

            // 拖拽开始
            grids.forEach(grid=>{
                if(!grid)return;
                grid.addEventListener('dragstart',e=>{
                    const card=e.target.closest('.classify-card');
                    if(!card)return;
                    const key=card.getAttribute('data-key');
                    if(!key)return;
                    e.dataTransfer.setData('text/key',key);
                    e.target.classList.add('dragging');
                    e.target.addEventListener('dragend',()=>e.target.classList.remove('dragging'),{once:true});
                });
            });
        }
        // 页面加载后初始化事件委托
        document.addEventListener('DOMContentLoaded',initCardDelegation);
        // 设置卡片拖拽排序（每个分类内自由拖动，顺序存 localStorage）
        let settingsDragCard=null;
        const settingsOrderKey='admin_settings_order_v1';
        function settingsCardKey(card){
            const h=card.querySelector('h3 .settings-title')||card.querySelector('h3');
            return h?h.textContent.replace(/⠿/g,'').trim():'';
        }
        // 卡片折叠：点标题展开/收起，状态存 localStorage
        let suppressSettingsClick=false;
        function saveSettingsCollapse(){
            const collapsed=[];
            document.querySelectorAll('.settings-section .settings-group.collapsed').forEach(c=>collapsed.push(settingsCardKey(c)));
            try{localStorage.setItem('admin_settings_collapsed',JSON.stringify(collapsed))}catch(e){}
        }
        function restoreSettingsCollapse(){
            try{
                const raw=localStorage.getItem('admin_settings_collapsed');
                if(!raw)return;
                const names=JSON.parse(raw);
                if(!Array.isArray(names))return;
                document.querySelectorAll('.settings-section .settings-group').forEach(c=>{
                    if(names.includes(settingsCardKey(c)))c.classList.add('collapsed');
                });
            }catch(e){}
        }
        function initSettingsCollapse(){
            document.querySelectorAll('.settings-section .settings-group').forEach(card=>{
                const h=card.querySelector('h3');
                if(!h)return;
                h.addEventListener('click',e=>{
                    if(suppressSettingsClick){suppressSettingsClick=false;return}
                    if(e.target.closest('.settings-grip'))return;
                    card.classList.toggle('collapsed');
                    saveSettingsCollapse();
                });
            });
            restoreSettingsCollapse();
        }
        function saveSettingsOrder(){
            const order={};
            document.querySelectorAll('.settings-section').forEach(section=>{
                order[section.dataset.section]=[...section.querySelectorAll(':scope > .settings-group')].map(settingsCardKey);
            });
            try{localStorage.setItem(settingsOrderKey,JSON.stringify(order))}catch(e){}
            // 同步到服务端，保证任何刷新 / 设备都不变
            try{
                fetch('/api/admin?action=setting-order',{
                    method:'POST',
                    headers:{'Content-Type':'application/json','X-Admin-Key':adminKey},
                    body:JSON.stringify({order})
                }).catch(()=>{});
            }catch(e){}
        }
        async function restoreSettingsOrder(){
            let order=null;
            try{order=JSON.parse(localStorage.getItem(settingsOrderKey)||'null')}catch(e){}
            // 优先使用服务端排序（跨设备一致）
            try{
                const r=await fetch('/api/admin?action=setting-order',{headers:{'X-Admin-Key':adminKey}});
                const d=await r.json();
                if(d.status==='success'&&d.data&&Object.keys(d.data).length)order=d.data;
            }catch(e){}
            if(!order)return;
            document.querySelectorAll('.settings-section').forEach(section=>{
                const names=order[section.dataset.section];
                if(!Array.isArray(names)||!names.length)return;
                const cards=[...section.querySelectorAll(':scope > .settings-group')];
                const byName=new Map(cards.map(c=>[settingsCardKey(c),c]));
                names.forEach(n=>{
                    const card=byName.get(n);
                    if(card){section.appendChild(card);byName.delete(n)}
                });
            });
            // 回写本地缓存
            try{localStorage.setItem(settingsOrderKey,JSON.stringify(order))}catch(e){}
        }
        function initSettingsDrag(){
            document.querySelectorAll('.settings-section').forEach(section=>{
                section.querySelectorAll(':scope > .settings-group').forEach(card=>{
                    card.setAttribute('draggable','true');
                    card.addEventListener('dragstart',e=>{
                        if(e.target.closest('input,textarea,select,button,label,a,img')){e.preventDefault();return}
                        settingsDragCard=card;
                        card.classList.add('dragging');
                        e.dataTransfer.effectAllowed='move';
                        try{e.dataTransfer.setData('text/plain','')}catch(err){}
                    });
                    card.addEventListener('dragover',e=>{
                        if(!settingsDragCard||settingsDragCard===card)return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect='move';
                        const r=card.getBoundingClientRect();
                        if(e.clientY>r.top+r.height/2)card.after(settingsDragCard);
                        else card.before(settingsDragCard);
                    });
                    card.addEventListener('drop',e=>e.preventDefault());
                    card.addEventListener('dragend',()=>{
                        card.classList.remove('dragging');
                        suppressSettingsClick=true;
                        if(settingsDragCard===card){
                            settingsDragCard=null;
                            saveSettingsOrder();
                        }
                    });
                });
            });
        }
        document.addEventListener('DOMContentLoaded',()=>{
            initSettingsDrag();
            initSettingsCollapse();
            restoreSettingsOrder();
        });

        // 应用网站图标 favicon（从设置读取）
        fetch('/api/admin?action=settings').then(r=>r.json()).then(d=>{
            if(d.status==='success'&&d.data&&d.data.favicon){
                const icon=document.getElementById('siteFavicon');
                if(icon)icon.setAttribute('href',d.data.favicon);
            }
        }).catch(()=>{});

        (function(){if(adminKey)apiFetch('action=login',{method:'POST',body:JSON.stringify({key:adminKey})}).then(r=>{if(r.status==='success')showAdmin();else doLogout()}).catch(()=>doLogout())})();
    