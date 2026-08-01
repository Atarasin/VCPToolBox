(function gateReviewerUi() {
    'use strict';

    const api = window.GateReviewer;
    const byId = id => document.getElementById(id);
    const elements = Object.fromEntries([
        'file', 'loadStatus', 'workspace', 'exportArea', 'position', 'dataset', 'onlyPending', 'progress',
        'caseId', 'query', 'target', 'sourceRefs', 'sourceContext', 'candidate', 'difficulty', 'notes', 'previous', 'next',
        'reviewerId', 'attestation', 'download', 'exportStatus'
    ].map(id => [id, byId(id)]));
    const labelButtons = [...document.querySelectorAll('button[data-label]')];
    let loaded = null;
    let decisions = {};
    let index = 0;
    let inputName = 'gate-review.jsonl';
    let currentRow = null;

    function visibleRows() {
        if (!loaded) return [];
        return elements.onlyPending.checked
            ? loaded.rows.filter(row => !decisions[row.caseId]?.label)
            : loaded.rows;
    }

    function persist() {
        if (!loaded) return;
        localStorage.setItem(api.stateKey(loaded.meta), JSON.stringify({
            decisions,
            reviewerId: elements.reviewerId.value
        }));
    }

    function restore() {
        decisions = {};
        elements.reviewerId.value = loaded.meta.reviewerId || '';
        try {
            const saved = JSON.parse(localStorage.getItem(api.stateKey(loaded.meta)) || 'null');
            if (saved?.decisions) decisions = saved.decisions;
            if (saved?.reviewerId) elements.reviewerId.value = saved.reviewerId;
        } catch (_) {}
    }

    function completion() {
        return loaded.rows.filter(row => api.LABELS.has(decisions[row.caseId]?.label)).length;
    }

    function render() {
        const rows = visibleRows();
        const done = completion();
        elements.progress.max = loaded.rows.length;
        elements.progress.value = done;
        elements.dataset.textContent = `${loaded.meta.datasetId} · ${loaded.meta.datasetHash} · ${done}/${loaded.rows.length}`;
        elements.download.disabled = done !== loaded.rows.length;
        if (!rows.length) {
            currentRow = null;
            elements.position.textContent = '所有 case 已完成';
            elements.caseId.textContent = '';
            elements.query.textContent = '';
            elements.target.textContent = '';
            elements.sourceRefs.textContent = '';
            elements.sourceContext.textContent = '';
            elements.candidate.textContent = '';
            elements.difficulty.textContent = '';
            elements.notes.value = '';
            labelButtons.forEach(button => { button.disabled = true; button.classList.remove('selected'); });
            return;
        }
        index = Math.max(0, Math.min(index, rows.length - 1));
        const row = rows[index];
        currentRow = row;
        const decision = decisions[row.caseId] || {};
        elements.position.textContent = `${index + 1} / ${rows.length}`;
        elements.caseId.textContent = row.caseId;
        elements.query.textContent = row.query;
        elements.target.textContent = `${row.targetType}:${row.library}`;
        elements.sourceRefs.textContent = (row.sourceRefs || []).join('；');
        elements.sourceContext.textContent = (row.sourceRefs || []).map(ref => {
            const text = loaded.meta.sourceContexts?.[ref];
            return text ? `【${ref}】\n${text}` : `【${ref}】\n（导出分片未包含该来源正文，请人工打开原始引用核对。）`;
        }).join('\n\n');
        elements.candidate.textContent = row.candidateLabel;
        elements.difficulty.textContent = row.difficulty;
        elements.notes.value = decision.notes || '';
        labelButtons.forEach(button => {
            button.disabled = false;
            button.classList.toggle('selected', button.dataset.label === decision.label);
        });
        elements.previous.disabled = index === 0;
        elements.next.disabled = index === rows.length - 1;
    }

    function saveNotes() {
        const row = currentRow;
        if (!row) return;
        const prior = decisions[row.caseId] || {};
        decisions[row.caseId] = { ...prior, notes: elements.notes.value };
        persist();
    }

    function choose(label) {
        const rows = visibleRows();
        const row = rows[index];
        if (!row) return;
        decisions[row.caseId] = { label, notes: elements.notes.value };
        persist();
        if (elements.onlyPending.checked) index = Math.min(index, Math.max(0, visibleRows().length - 1));
        else if (index < rows.length - 1) index++;
        render();
    }

    function move(delta) {
        saveNotes();
        index = Math.max(0, Math.min(index + delta, visibleRows().length - 1));
        render();
    }

    elements.file.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            loaded = api.parseJsonl(await file.text());
            inputName = file.name;
            restore();
            index = 0;
            elements.workspace.hidden = false;
            elements.exportArea.hidden = false;
            elements.loadStatus.textContent = `已加载 ${file.name}，${loaded.rows.length} 条；进度仅保存在当前浏览器。`;
            elements.loadStatus.className = 'status success';
            elements.exportStatus.textContent = '';
            elements.attestation.value = '';
            render();
        } catch (error) {
            elements.loadStatus.textContent = error.message;
            elements.loadStatus.className = 'status error';
        }
    });
    labelButtons.forEach(button => button.addEventListener('click', () => choose(button.dataset.label)));
    elements.previous.addEventListener('click', () => move(-1));
    elements.next.addEventListener('click', () => move(1));
    elements.notes.addEventListener('change', saveNotes);
    elements.onlyPending.addEventListener('change', () => { saveNotes(); index = 0; render(); });
    elements.reviewerId.addEventListener('change', persist);
    document.addEventListener('keydown', event => {
        if (!loaded || event.target.matches('input, textarea')) return;
        const key = event.key.toLowerCase();
        if (key === 'p') choose('positive');
        else if (key === 'n') choose('negative');
        else if (key === 'a') choose('ambiguous');
        else if (event.key === 'ArrowLeft') move(-1);
        else if (event.key === 'ArrowRight') move(1);
    });
    elements.download.addEventListener('click', () => {
        try {
            saveNotes();
            const text = api.buildJsonl(
                loaded.meta, loaded.rows, decisions,
                elements.reviewerId.value, elements.attestation.value
            );
            const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = api.outputName(inputName);
            anchor.click();
            URL.revokeObjectURL(url);
            elements.exportStatus.textContent = `已导出 ${anchor.download}`;
            elements.exportStatus.className = 'status success';
        } catch (error) {
            elements.exportStatus.textContent = error.message;
            elements.exportStatus.className = 'status error';
        }
    });
}());
