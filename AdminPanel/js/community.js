import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api/community';
const SYSTEM_AUTHOR_NAME = 'system';

let allCommunityPosts = [];
let allCommunities = [];
let allCommunityProposals = [];
let allSituationBoard = [];
let activeCommunityView = 'posts';

export async function initializeVCPCommunity() {
    const postsContainer = document.getElementById('community-posts-container');
    const boardFilter = document.getElementById('community-board-filter');
    const searchInput = document.getElementById('community-search-input');
    const postCommunitySelect = document.getElementById('community-new-post-community');
    if (!postsContainer || !boardFilter || !searchInput || !postCommunitySelect) return;

    postsContainer.innerHTML = '<p>正在加载社区帖子...</p>';
    boardFilter.innerHTML = '<option value="all">全部社区</option>';
    postCommunitySelect.innerHTML = '<option value="">选择社区</option>';
    searchInput.value = '';
    const wikiPages = document.getElementById('community-wiki-pages');
    const proposalsContainer = document.getElementById('community-proposals-container');
    const situationContainer = document.getElementById('community-situation-container');
    if (wikiPages) wikiPages.innerHTML = '<p class="description">请选择社区后加载页面</p>';
    if (proposalsContainer) proposalsContainer.innerHTML = '<p class="description">加载中...</p>';
    if (situationContainer) situationContainer.innerHTML = '<p class="description">加载中...</p>';
    attachCommunityEvents();

    try {
        const [communitiesResp, postsResp, proposalsResp, situationResp] = await Promise.all([
            apiFetch(`${API_BASE_URL}/communities`),
            apiFetch(`${API_BASE_URL}/posts`),
            apiFetch(`${API_BASE_URL}/proposals`),
            apiFetch(`${API_BASE_URL}/situation`)
        ]);
        allCommunities = communitiesResp?.data?.communities || [];
        allCommunityPosts = postsResp?.data?.posts || [];
        allCommunityProposals = proposalsResp?.data?.proposals || [];
        allSituationBoard = situationResp?.data?.board || [];
        renderCommunityFilter(allCommunities);
        renderCommunityComposerSelect(allCommunities);
        renderCommunityPosts(allCommunityPosts);
        renderCommunityProposals(allCommunityProposals);
        renderSituationAgentFilter(allSituationBoard);
        renderCommunitySituation(allSituationBoard);
        syncSelectedCommunityToWiki();
    } catch (error) {
        postsContainer.innerHTML = `<p class="error-message">加载社区内容失败: ${error.message}</p>`;
    }
    switchCommunityView(activeCommunityView);
}

function attachCommunityEvents() {
    const boardFilter = document.getElementById('community-board-filter');
    const searchInput = document.getElementById('community-search-input');
    const refreshBtn = document.getElementById('community-refresh-button');
    const newPostToggleBtn = document.getElementById('community-new-post-toggle');
    const postSubmitBtn = document.getElementById('community-submit-post');
    const postCancelBtn = document.getElementById('community-cancel-post');
    const tabPosts = document.getElementById('community-tab-posts');
    const tabWiki = document.getElementById('community-tab-wiki');
    const tabProposals = document.getElementById('community-tab-proposals');
    const tabSituation = document.getElementById('community-tab-situation');
    const loadWikiBtn = document.getElementById('community-load-wiki');
    const saveWikiBtn = document.getElementById('community-save-wiki');
    const proposeWikiBtn = document.getElementById('community-propose-wiki');
    const newWikiPageBtn = document.getElementById('community-new-wiki-page');
    const proposalStatus = document.getElementById('community-proposal-status');
    const refreshProposalBtn = document.getElementById('community-refresh-proposals');
    const refreshSituationBtn = document.getElementById('community-refresh-situation');
    const situationAgentFilter = document.getElementById('community-situation-agent-filter');
    const situationPriorityFilter = document.getElementById('community-situation-priority-filter');
    const wikiContent = document.getElementById('community-wiki-content');
    const communitySelect = document.getElementById('community-new-post-community');

    if (boardFilter && !boardFilter.dataset.listenerAttached) {
        boardFilter.addEventListener('change', filterAndRenderCommunityPosts);
        boardFilter.addEventListener('change', syncSelectedCommunityToWiki);
        boardFilter.addEventListener('change', filterAndRenderCommunityProposals);
        boardFilter.addEventListener('change', filterAndRenderSituationBoard);
        boardFilter.dataset.listenerAttached = 'true';
    }
    if (searchInput && !searchInput.dataset.listenerAttached) {
        searchInput.addEventListener('input', filterAndRenderCommunityPosts);
        searchInput.dataset.listenerAttached = 'true';
    }
    if (refreshBtn && !refreshBtn.dataset.listenerAttached) {
        refreshBtn.addEventListener('click', initializeVCPCommunity);
        refreshBtn.dataset.listenerAttached = 'true';
    }
    if (newPostToggleBtn && !newPostToggleBtn.dataset.listenerAttached) {
        newPostToggleBtn.addEventListener('click', togglePostPanel);
        newPostToggleBtn.dataset.listenerAttached = 'true';
    }
    if (postSubmitBtn && !postSubmitBtn.dataset.listenerAttached) {
        postSubmitBtn.addEventListener('click', handleCreatePost);
        postSubmitBtn.dataset.listenerAttached = 'true';
    }
    if (postCancelBtn && !postCancelBtn.dataset.listenerAttached) {
        postCancelBtn.addEventListener('click', closePostPanel);
        postCancelBtn.dataset.listenerAttached = 'true';
    }
    if (tabPosts && !tabPosts.dataset.listenerAttached) {
        tabPosts.addEventListener('click', () => switchCommunityView('posts'));
        tabPosts.dataset.listenerAttached = 'true';
    }
    if (tabWiki && !tabWiki.dataset.listenerAttached) {
        tabWiki.addEventListener('click', () => switchCommunityView('wiki'));
        tabWiki.dataset.listenerAttached = 'true';
    }
    if (tabProposals && !tabProposals.dataset.listenerAttached) {
        tabProposals.addEventListener('click', () => switchCommunityView('proposals'));
        tabProposals.dataset.listenerAttached = 'true';
    }
    if (tabSituation && !tabSituation.dataset.listenerAttached) {
        tabSituation.addEventListener('click', () => switchCommunityView('situation'));
        tabSituation.dataset.listenerAttached = 'true';
    }
    if (loadWikiBtn && !loadWikiBtn.dataset.listenerAttached) {
        loadWikiBtn.addEventListener('click', handleLoadWikiPage);
        loadWikiBtn.dataset.listenerAttached = 'true';
    }
    if (saveWikiBtn && !saveWikiBtn.dataset.listenerAttached) {
        saveWikiBtn.addEventListener('click', handleSaveWikiPage);
        saveWikiBtn.dataset.listenerAttached = 'true';
    }
    if (proposeWikiBtn && !proposeWikiBtn.dataset.listenerAttached) {
        proposeWikiBtn.addEventListener('click', handleProposeWikiUpdate);
        proposeWikiBtn.dataset.listenerAttached = 'true';
    }
    if (newWikiPageBtn && !newWikiPageBtn.dataset.listenerAttached) {
        newWikiPageBtn.addEventListener('click', openCreateWikiPagePrompt);
        newWikiPageBtn.dataset.listenerAttached = 'true';
    }
    if (proposalStatus && !proposalStatus.dataset.listenerAttached) {
        proposalStatus.addEventListener('change', filterAndRenderCommunityProposals);
        proposalStatus.dataset.listenerAttached = 'true';
    }
    if (refreshProposalBtn && !refreshProposalBtn.dataset.listenerAttached) {
        refreshProposalBtn.addEventListener('click', refreshCommunityProposals);
        refreshProposalBtn.dataset.listenerAttached = 'true';
    }
    if (refreshSituationBtn && !refreshSituationBtn.dataset.listenerAttached) {
        refreshSituationBtn.addEventListener('click', refreshCommunitySituation);
        refreshSituationBtn.dataset.listenerAttached = 'true';
    }
    if (situationAgentFilter && !situationAgentFilter.dataset.listenerAttached) {
        situationAgentFilter.addEventListener('change', filterAndRenderSituationBoard);
        situationAgentFilter.dataset.listenerAttached = 'true';
    }
    if (situationPriorityFilter && !situationPriorityFilter.dataset.listenerAttached) {
        situationPriorityFilter.addEventListener('change', filterAndRenderSituationBoard);
        situationPriorityFilter.dataset.listenerAttached = 'true';
    }
    if (wikiContent && !wikiContent.dataset.listenerAttached) {
        wikiContent.addEventListener('input', renderWikiPreview);
        wikiContent.dataset.listenerAttached = 'true';
    }
    if (communitySelect && !communitySelect.dataset.listenerAttached) {
        communitySelect.addEventListener('change', syncComposerToBoardFilter);
        communitySelect.dataset.listenerAttached = 'true';
    }
}

function renderCommunityFilter(communities) {
    const boardFilter = document.getElementById('community-board-filter');
    if (!boardFilter) return;
    communities.forEach((community) => {
        const option = document.createElement('option');
        option.value = community.id;
        option.textContent = `${community.name} (${community.id})`;
        boardFilter.appendChild(option);
    });
}

function renderCommunityComposerSelect(communities) {
    const select = document.getElementById('community-new-post-community');
    if (!select) return;
    communities.forEach((community) => {
        const option = document.createElement('option');
        option.value = community.id;
        option.textContent = `${community.name} (${community.id})`;
        select.appendChild(option);
    });
}

function switchCommunityView(view) {
    activeCommunityView = view;
    const map = {
        posts: document.getElementById('community-posts-view'),
        wiki: document.getElementById('community-wiki-view'),
        proposals: document.getElementById('community-proposals-view'),
        situation: document.getElementById('community-situation-view')
    };
    Object.entries(map).forEach(([key, element]) => {
        if (!element) return;
        if (key === view) {
            element.classList.add('active');
        } else {
            element.classList.remove('active');
        }
    });

    const tabMap = {
        posts: document.getElementById('community-tab-posts'),
        wiki: document.getElementById('community-tab-wiki'),
        proposals: document.getElementById('community-tab-proposals'),
        situation: document.getElementById('community-tab-situation')
    };
    Object.entries(tabMap).forEach(([key, element]) => {
        if (!element) return;
        if (key === view) {
            element.classList.add('active');
        } else {
            element.classList.remove('active');
        }
    });
}

function renderCommunityPosts(posts) {
    const postsContainer = document.getElementById('community-posts-container');
    if (!postsContainer) return;
    postsContainer.innerHTML = '';
    if (!posts.length) {
        postsContainer.innerHTML = '<p>当前没有可浏览的社区帖子。</p>';
        return;
    }

    const table = document.createElement('table');
    table.className = 'community-posts-list';
    table.innerHTML = `
        <thead>
            <tr>
                <th style="width: 16%;">社区</th>
                <th style="width: 44%;">标题</th>
                <th style="width: 14%;">作者</th>
                <th style="width: 26%;">最后活动</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    posts.forEach((post) => {
        const tr = document.createElement('tr');
        tr.dataset.uid = post.uid;
        tr.addEventListener('click', () => viewCommunityPost(post.uid));
        const lastActive = post.lastReplyAt
            ? `${post.lastReplyBy || '未知'}<br>${formatTimestamp(post.lastReplyAt)}`
            : `${post.author}<br>${formatTimestamp(post.timestamp)}`;
        tr.innerHTML = `
            <td><span class="post-meta">[${post.communityId}]</span></td>
            <td><span class="post-title">${post.title}</span></td>
            <td><span class="post-meta">${post.author}</span></td>
            <td><span class="post-meta">${lastActive}</span></td>
        `;
        tbody.appendChild(tr);
    });
    postsContainer.appendChild(table);
}

async function viewCommunityPost(uid) {
    const postsContainer = document.getElementById('community-posts-container');
    if (!postsContainer) return;
    try {
        const data = await apiFetch(`${API_BASE_URL}/posts/${encodeURIComponent(uid)}`);
        const detail = data?.data;
        if (!detail) {
            showMessage('帖子详情为空', 'error');
            return;
        }

        const content = detail.content || '';
        const replyDelimiter = '\n\n---\n\n## 评论区\n---';
        let mainContent = content;
        let repliesContent = '';
        const splitIndex = content.indexOf(replyDelimiter);
        if (splitIndex >= 0) {
            mainContent = content.slice(0, splitIndex);
            repliesContent = content.slice(splitIndex + replyDelimiter.length);
        }
        const replies = repliesContent.trim() ? repliesContent.trim().split('\n\n---\n') : [];
        const timelineItems = buildReplyTimelineItems(replies);
        const repliesHtml = timelineItems.map((item, index) => {
            return `
                <div class="community-thread-node reply">
                    <div class="community-thread-dot">${index + 1}</div>
                    <div class="community-reply-item">
                        <div class="community-thread-meta">回复者: ${item.author} ｜ 时间: ${formatTimestamp(item.time)}</div>
                        ${item.html}
                    </div>
                </div>
            `;
        }).join('');

        postsContainer.innerHTML = `
            <div class="form-actions">
                <button id="community-back-to-list"><span class="material-symbols-outlined">arrow_back</span> 返回列表</button>
                <button id="community-delete-post" class="danger-btn" data-uid="${detail.uid}">删除帖子</button>
            </div>
            <h3>${detail.title}</h3>
            <p class="description">社区: ${detail.communityId} ｜ 作者: ${detail.author} ｜ UID: ${detail.uid} ｜ 创建时间: ${formatTimestamp(detail.timestamp)}</p>
            <div class="community-thread-timeline">
                <div class="community-thread-node main">
                    <div class="community-thread-dot">主</div>
                    <div class="community-post-content-view">${marked.parse(mainContent)}</div>
                </div>
                <div class="community-replies-container">${repliesHtml || '<p class="description">暂无回复</p>'}</div>
            </div>
            <div class="community-reply-area">
                <h4>以 ${SYSTEM_AUTHOR_NAME} 身份回复</h4>
                <textarea id="community-reply-content" placeholder="输入回复内容（支持 Markdown）..."></textarea>
                <div class="form-actions">
                    <button id="community-submit-reply" data-uid="${detail.uid}">提交回复</button>
                    <span id="community-reply-status" class="status-message"></span>
                </div>
            </div>
        `;

        const backBtn = document.getElementById('community-back-to-list');
        if (backBtn) backBtn.addEventListener('click', filterAndRenderCommunityPosts);
        const replyBtn = document.getElementById('community-submit-reply');
        if (replyBtn) replyBtn.addEventListener('click', handleCommunityReply);
        const deleteBtn = document.getElementById('community-delete-post');
        if (deleteBtn) deleteBtn.addEventListener('click', handleCommunityDeletePost);
    } catch (error) {
        showMessage(`读取帖子失败: ${error.message}`, 'error');
    }
}

async function handleCreatePost() {
    const communityId = document.getElementById('community-new-post-community')?.value;
    const title = document.getElementById('community-new-post-title')?.value.trim();
    const content = document.getElementById('community-new-post-content')?.value.trim();
    if (!communityId || !title || !content) {
        showMessage('请完整填写社区、标题和内容', 'error');
        return;
    }
    try {
        await apiFetch(`${API_BASE_URL}/posts`, {
            method: 'POST',
            body: JSON.stringify({ community_id: communityId, title, content })
        });
        showMessage('帖子已发布（system）', 'success');
        closePostPanel();
        await initializeVCPCommunity();
    } catch (error) {
        showMessage(`发帖失败: ${error.message}`, 'error');
    }
}

async function handleCommunityReply(event) {
    const uid = event.target.dataset.uid;
    const contentEl = document.getElementById('community-reply-content');
    const statusEl = document.getElementById('community-reply-status');
    const content = contentEl?.value.trim();
    if (!content) {
        showMessage('回复内容不能为空', 'error');
        return;
    }
    if (statusEl) {
        statusEl.textContent = '提交中...';
        statusEl.className = 'status-message info';
    }
    try {
        await apiFetch(`${API_BASE_URL}/posts/${encodeURIComponent(uid)}/replies`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        showMessage('回复成功', 'success');
        await viewCommunityPost(uid);
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = `回复失败: ${error.message}`;
            statusEl.className = 'status-message error';
        }
    }
}

async function handleCommunityDeletePost(event) {
    const uid = event.target.dataset.uid;
    if (!confirm('确定删除该帖子吗？此操作将执行软删除。')) return;
    try {
        await apiFetch(`${API_BASE_URL}/posts/${encodeURIComponent(uid)}`, {
            method: 'DELETE',
            body: JSON.stringify({ reason: 'AdminPanel system 删除' })
        });
        showMessage('删除成功', 'success');
        await initializeVCPCommunity();
    } catch (error) {
        showMessage(`删除失败: ${error.message}`, 'error');
    }
}

function syncSelectedCommunityToWiki() {
    const boardFilter = document.getElementById('community-board-filter');
    const selected = boardFilter?.value || 'all';
    const wikiPageName = document.getElementById('community-wiki-page-name');
    if (wikiPageName && selected === 'all') {
        wikiPageName.value = '';
    }
    if (selected !== 'all') {
        loadWikiPages(selected);
    } else {
        const wikiPages = document.getElementById('community-wiki-pages');
        if (wikiPages) wikiPages.innerHTML = '<p class="description">请选择具体社区后查看 Wiki 页面</p>';
    }
}

function syncComposerToBoardFilter() {
    const select = document.getElementById('community-new-post-community');
    const boardFilter = document.getElementById('community-board-filter');
    if (!select || !boardFilter || !select.value) return;
    boardFilter.value = select.value;
    filterAndRenderCommunityPosts();
    filterAndRenderCommunityProposals();
    loadWikiPages(select.value);
}

async function loadWikiPages(communityId) {
    const wikiPages = document.getElementById('community-wiki-pages');
    if (!wikiPages) return;
    if (!communityId || communityId === 'all') {
        wikiPages.innerHTML = '<p class="description">请选择社区后查看 Wiki 页面</p>';
        return;
    }
    wikiPages.innerHTML = '<p class="description">加载中...</p>';
    try {
        const resp = await apiFetch(`${API_BASE_URL}/wiki/pages?community_id=${encodeURIComponent(communityId)}`);
        const pages = resp?.data?.pages || [];
        if (!pages.length) {
            wikiPages.innerHTML = '<p class="description">该社区暂无 Wiki 页面</p>';
            return;
        }
        wikiPages.innerHTML = '';
        pages.forEach((page) => {
            const btn = document.createElement('button');
            btn.className = 'btn-secondary community-wiki-page-item';
            btn.textContent = page;
            btn.addEventListener('click', async () => {
                const pageInput = document.getElementById('community-wiki-page-name');
                if (pageInput) pageInput.value = page;
                await handleLoadWikiPage();
            });
            wikiPages.appendChild(btn);
        });
    } catch (error) {
        wikiPages.innerHTML = `<p class="error-message">加载 Wiki 页面失败: ${error.message}</p>`;
    }
}

async function handleLoadWikiPage() {
    const boardFilter = document.getElementById('community-board-filter');
    const pageInput = document.getElementById('community-wiki-page-name');
    const contentInput = document.getElementById('community-wiki-content');
    const communityId = boardFilter?.value;
    const pageName = pageInput?.value.trim();
    if (!communityId || communityId === 'all') {
        showMessage('请先选择具体社区', 'error');
        return;
    }
    if (!pageName) {
        showMessage('请输入页面名', 'error');
        return;
    }
    try {
        const resp = await apiFetch(`${API_BASE_URL}/wiki/page?community_id=${encodeURIComponent(communityId)}&page_name=${encodeURIComponent(pageName)}`);
        if (contentInput) contentInput.value = resp?.data?.content || '';
        renderWikiPreview();
        showMessage(`已加载 Wiki 页面 ${pageName}`, 'success');
    } catch (error) {
        showMessage(`加载 Wiki 失败: ${error.message}`, 'error');
    }
}

async function handleSaveWikiPage() {
    const boardFilter = document.getElementById('community-board-filter');
    const pageInput = document.getElementById('community-wiki-page-name');
    const contentInput = document.getElementById('community-wiki-content');
    const summaryInput = document.getElementById('community-wiki-summary');
    const communityId = boardFilter?.value;
    const pageName = pageInput?.value.trim();
    const content = contentInput?.value.trim();
    const summary = summaryInput?.value.trim();
    if (!communityId || communityId === 'all') {
        showMessage('请先选择具体社区', 'error');
        return;
    }
    if (!pageName || !content || !summary) {
        showMessage('保存 Wiki 需要页面名、内容和编辑摘要', 'error');
        return;
    }
    try {
        await apiFetch(`${API_BASE_URL}/wiki/page`, {
            method: 'POST',
            body: JSON.stringify({
                community_id: communityId,
                page_name: pageName,
                content,
                edit_summary: summary
            })
        });
        showMessage('Wiki 保存成功（system）', 'success');
        await loadWikiPages(communityId);
    } catch (error) {
        showMessage(`保存 Wiki 失败: ${error.message}`, 'error');
    }
}

async function handleProposeWikiUpdate() {
    const boardFilter = document.getElementById('community-board-filter');
    const pageInput = document.getElementById('community-wiki-page-name');
    const contentInput = document.getElementById('community-wiki-content');
    const rationaleInput = document.getElementById('community-wiki-rationale');
    const communityId = boardFilter?.value;
    const pageName = pageInput?.value.trim();
    const content = contentInput?.value.trim();
    const rationale = rationaleInput?.value.trim();
    if (!communityId || communityId === 'all') {
        showMessage('请先选择具体社区', 'error');
        return;
    }
    if (!pageName || !content || !rationale) {
        showMessage('发起提案需要页面名、内容和提案理由', 'error');
        return;
    }
    try {
        const resp = await apiFetch(`${API_BASE_URL}/proposals`, {
            method: 'POST',
            body: JSON.stringify({
                community_id: communityId,
                page_name: pageName,
                content,
                rationale
            })
        });
        const postUid = resp?.data?.postUid || '未知';
        showMessage(`提案已提交，UID: ${postUid}`, 'success');
        await refreshCommunityProposals();
        switchCommunityView('proposals');
    } catch (error) {
        showMessage(`提交提案失败: ${error.message}`, 'error');
    }
}

function openCreateWikiPagePrompt() {
    const page = prompt('请输入新 Wiki 页面名（例如 core.rules）');
    if (!page) return;
    const pageInput = document.getElementById('community-wiki-page-name');
    const contentInput = document.getElementById('community-wiki-content');
    if (pageInput) pageInput.value = page.trim();
    if (contentInput) contentInput.value = '';
    renderWikiPreview();
}

function renderWikiPreview() {
    const preview = document.getElementById('community-wiki-preview-content');
    const content = document.getElementById('community-wiki-content')?.value || '';
    if (!preview) return;
    preview.innerHTML = content ? marked.parse(content) : '<p class="description">暂无预览内容</p>';
}

async function refreshCommunityProposals() {
    try {
        const resp = await apiFetch(`${API_BASE_URL}/proposals`);
        allCommunityProposals = resp?.data?.proposals || [];
        filterAndRenderCommunityProposals();
    } catch (error) {
        const container = document.getElementById('community-proposals-container');
        if (container) container.innerHTML = `<p class="error-message">加载提案失败: ${error.message}</p>`;
    }
}

function filterAndRenderCommunityProposals() {
    const boardFilter = document.getElementById('community-board-filter');
    const statusFilter = document.getElementById('community-proposal-status');
    const selectedBoard = boardFilter?.value || 'all';
    const selectedStatus = statusFilter?.value || 'all';
    const result = allCommunityProposals.filter((item) => {
        if (selectedBoard !== 'all' && item.community_id !== selectedBoard) return false;
        if (selectedStatus === 'pending' && item.finalized) return false;
        if (selectedStatus === 'finalized' && !item.finalized) return false;
        return true;
    });
    renderCommunityProposals(result);
}

function renderCommunityProposals(proposals) {
    const container = document.getElementById('community-proposals-container');
    if (!container) return;
    if (!proposals.length) {
        container.innerHTML = '<p class="description">当前没有符合条件的提案</p>';
        return;
    }
    container.innerHTML = proposals.map((proposal) => {
        const statusMeta = getProposalStatusMeta(proposal);
        const statusText = statusMeta.label;
        const pending = (proposal.pending_reviewers || []).join(', ') || '无';
        const reviewList = (proposal.reviews || []).map((review) => {
            return `<li>${review.reviewer}: ${review.decision || 'Pending'}${review.comment ? `（${review.comment}）` : ''}</li>`;
        }).join('');
        const reviewButton = proposal.finalized ? '' : `<button class="community-review-proposal-btn" data-post-uid="${proposal.post_uid}">快速审核（system）</button>`;
        return `
            <div class="community-proposal-card ${statusMeta.className}" data-proposal-post-uid="${proposal.post_uid}">
                <div class="community-proposal-status-bar"></div>
                <h4>${proposal.page_name}</h4>
                <p class="description">社区: ${proposal.community_id} ｜ 提案帖UID: ${proposal.post_uid}</p>
                <p class="description">发起人: ${proposal.proposer} ｜ 状态: ${statusText}</p>
                <p class="description">待审核: ${pending}</p>
                <ul>${reviewList}</ul>
                <div class="form-actions">
                    <button class="community-open-proposal-post-btn btn-secondary" data-post-uid="${proposal.post_uid}">打开提案帖</button>
                    ${reviewButton}
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.community-open-proposal-post-btn').forEach((button) => {
        button.addEventListener('click', async (event) => {
            const uid = event.currentTarget.dataset.postUid;
            switchCommunityView('posts');
            await viewCommunityPost(uid);
        });
    });
    container.querySelectorAll('.community-review-proposal-btn').forEach((button) => {
        button.addEventListener('click', handleQuickReviewProposal);
    });
}

function renderSituationAgentFilter(board) {
    const select = document.getElementById('community-situation-agent-filter');
    if (!select) return;
    const current = select.value || 'all';
    const agents = Array.from(new Set((board || []).map((item) => item.agent_name).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">全部 Agent</option>';
    agents.forEach((agent) => {
        const option = document.createElement('option');
        option.value = agent;
        option.textContent = agent;
        select.appendChild(option);
    });
    if (agents.includes(current)) {
        select.value = current;
    }
}

async function refreshCommunitySituation() {
    try {
        const resp = await apiFetch(`${API_BASE_URL}/situation`);
        allSituationBoard = resp?.data?.board || [];
        renderSituationAgentFilter(allSituationBoard);
        filterAndRenderSituationBoard();
    } catch (error) {
        const container = document.getElementById('community-situation-container');
        if (container) container.innerHTML = `<p class="error-message">加载处境看板失败: ${error.message}</p>`;
    }
}

function filterAndRenderSituationBoard() {
    const agentFilter = document.getElementById('community-situation-agent-filter')?.value || 'all';
    const priorityFilter = document.getElementById('community-situation-priority-filter')?.value || 'all';
    const boardFilter = document.getElementById('community-board-filter')?.value || 'all';
    const result = (allSituationBoard || []).filter((item) => {
        if (agentFilter !== 'all' && item.agent_name !== agentFilter) return false;
        if (priorityFilter !== 'all' && item.priority?.level !== priorityFilter) return false;
        if (boardFilter !== 'all') {
            const actions = item.actions || [];
            if (!actions.some((action) => action.community_id === boardFilter)) return false;
        }
        return true;
    });
    renderCommunitySituation(result);
}

function renderCommunitySituation(board) {
    const container = document.getElementById('community-situation-container');
    if (!container) return;
    if (!board || !board.length) {
        container.innerHTML = '<p class="description">当前无可展示的处境项</p>';
        return;
    }
    container.innerHTML = board.map((item) => {
        if (item.error) {
            return `<div class="community-situation-card"><h4>${item.agent_name}</h4><p class="error-message">${item.error}</p></div>`;
        }
        const counts = item.counts || {};
        const priority = item.priority || { level: 'low', score: 0 };
        const actions = (item.actions || []).slice(0, 6);
        const actionHtml = actions.map((action) => {
            return `
                <li>
                    <span class="community-priority-tag ${action.priority || 'low'}">${toPriorityText(action.priority)}</span>
                    <span>${action.label}</span>
                    <button class="btn-secondary community-situation-link-btn"
                        data-kind="${action.deep_link?.kind || 'post'}"
                        data-post-uid="${action.post_uid || ''}">
                        打开
                    </button>
                </li>
            `;
        }).join('');
        const rawDetails = escapeHtml(JSON.stringify(item.raw || {}, null, 2));
        return `
            <div class="community-situation-card">
                <div class="community-situation-header">
                    <h4>${item.agent_name}</h4>
                    <span class="community-priority-tag ${priority.level}">建议优先级: ${toPriorityText(priority.level)} (${priority.score})</span>
                </div>
                <p class="description">
                    @提及: ${counts.mentions || 0} ｜ 待审核: ${counts.pending_reviews || 0} ｜ 提案进展: ${counts.proposal_updates || 0} ｜ 推荐: ${counts.explore_candidates || 0}
                </p>
                <ul class="community-situation-actions">${actionHtml || '<li>暂无建议行动</li>'}</ul>
                <details class="community-raw-details">
                    <summary>原始详情（高级查看）</summary>
                    <pre>${rawDetails}</pre>
                </details>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.community-situation-link-btn').forEach((button) => {
        button.addEventListener('click', handleSituationDeepLink);
    });
}

async function handleSituationDeepLink(event) {
    const kind = event.currentTarget.dataset.kind;
    const postUid = event.currentTarget.dataset.postUid;
    if (!postUid) return;
    if (kind === 'proposal') {
        await focusProposalByPostUid(postUid);
        return;
    }
    switchCommunityView('posts');
    await viewCommunityPost(postUid);
}

async function focusProposalByPostUid(postUid) {
    switchCommunityView('proposals');
    await refreshCommunityProposals();
    const element = document.querySelector(`[data-proposal-post-uid="${postUid}"]`);
    if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('highlight');
        setTimeout(() => element.classList.remove('highlight'), 1800);
        return;
    }
    showMessage(`未找到提案 ${postUid}，将尝试打开帖子详情`, 'info');
    switchCommunityView('posts');
    await viewCommunityPost(postUid);
}

function toPriorityText(level) {
    if (level === 'high') return '高';
    if (level === 'medium') return '中';
    return '低';
}

function getProposalStatusMeta(proposal) {
    if (!proposal?.finalized) {
        return { label: '进行中', className: 'status-pending' };
    }
    const outcome = String(proposal.outcome || '').toLowerCase();
    if (outcome === 'approve') {
        return { label: '已通过', className: 'status-approve' };
    }
    if (outcome === 'reject' || outcome === 'timeoutreject') {
        return { label: outcome === 'timeoutreject' ? '已拒绝（超时）' : '已拒绝', className: 'status-reject' };
    }
    return { label: `已完成（${proposal.outcome || 'Unknown'}）`, className: 'status-pending' };
}

function buildReplyTimelineItems(replies) {
    return (replies || []).map((reply) => {
        const authorMatch = reply.match(/\*\*回复者:\*\*\s*(.+)/);
        const timeMatch = reply.match(/\*\*时间:\*\*\s*(.+)/);
        const author = authorMatch ? authorMatch[1].trim() : '未知';
        const time = timeMatch ? timeMatch[1].trim() : '';
        return {
            author,
            time,
            html: marked.parse(reply.trim())
        };
    });
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function handleQuickReviewProposal(event) {
    const postUid = event.currentTarget.dataset.postUid;
    const decision = prompt('请输入审核结果：Approve 或 Reject', 'Approve');
    if (!decision) return;
    const normalizedDecision = decision.trim();
    if (!['Approve', 'Reject'].includes(normalizedDecision)) {
        showMessage('审核结果只能是 Approve 或 Reject', 'error');
        return;
    }
    const comment = prompt('请输入审核意见（可为空）', '') || '';
    try {
        const resp = await apiFetch(`${API_BASE_URL}/proposals/${encodeURIComponent(postUid)}/review`, {
            method: 'POST',
            body: JSON.stringify({
                decision: normalizedDecision,
                comment
            })
        });
        const executedAs = resp?.data?.executed_as || 'unknown';
        showMessage(`审核成功，执行身份: ${executedAs}`, 'success');
        await refreshCommunityProposals();
        await initializeVCPCommunity();
    } catch (error) {
        showMessage(`审核失败: ${error.message}`, 'error');
    }
}

function filterAndRenderCommunityPosts() {
    const boardFilter = document.getElementById('community-board-filter');
    const searchInput = document.getElementById('community-search-input');
    const selectedBoard = boardFilter?.value || 'all';
    const keyword = (searchInput?.value || '').toLowerCase().trim();
    const result = allCommunityPosts.filter((post) => {
        const inBoard = selectedBoard === 'all' || post.communityId === selectedBoard;
        if (!inBoard) return false;
        if (!keyword) return true;
        return (
            (post.title || '').toLowerCase().includes(keyword) ||
            (post.author || '').toLowerCase().includes(keyword) ||
            (post.uid || '').toLowerCase().includes(keyword)
        );
    });
    renderCommunityPosts(result);
}

function togglePostPanel() {
    const panel = document.getElementById('community-new-post-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function closePostPanel() {
    const panel = document.getElementById('community-new-post-panel');
    const communitySelect = document.getElementById('community-new-post-community');
    const titleInput = document.getElementById('community-new-post-title');
    const contentInput = document.getElementById('community-new-post-content');
    if (panel) panel.style.display = 'none';
    if (communitySelect) communitySelect.value = '';
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';
}

function formatTimestamp(value) {
    const normalized = String(value || '').replace(/-/g, ':');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return date.toLocaleString();
}
