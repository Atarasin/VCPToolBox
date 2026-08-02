const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();
    const { pluginManager, vectorDBManager } = options;
    const PROJECT_BASE_PATH = path.join(__dirname, '..', '..');
    const DREAM_LOGS_DIR = path.join(PROJECT_BASE_PATH, 'Plugin', 'AgentDream', 'dream_logs');
    const DAILY_NOTE_ROOT = process.env.KNOWLEDGEBASE_ROOT_PATH || path.join(PROJECT_BASE_PATH, 'dailynote');
    // 归档文件夹。与 DailyNoteManager 的 organize 命令保持一致，且被 KnowledgeBaseManager
    // 的 ignorePrefixes 排除在索引之外 —— 归档后不再参与 RAG 召回，但文件仍在磁盘上可恢复。
    const ARCHIVE_FOLDER = '已整理';

    // 辅助: file:/// URL 转本地路径
    function _urlToFilePath(fileUrl) {
        if (fileUrl.startsWith('file:///')) {
            // Windows 下可能是 file:///C:/... 或者是 file:///H:/...
            // 处理路径分隔符
            let p = fileUrl.replace('file:///', '');
            if (process.platform === 'win32') {
                p = p.replace(/\//g, path.sep);
            } else {
                p = '/' + p;
            }
            return p;
        }
        return fileUrl;
    }

    function _createHttpError(status, message, details) {
        const error = new Error(message);
        error.status = status;
        if (details !== undefined) error.details = details;
        return error;
    }

    function _isPathWithinBase(targetPath, basePath) {
        const resolvedTarget = path.resolve(targetPath);
        const resolvedBase = path.resolve(basePath);
        return resolvedTarget === resolvedBase ||
            resolvedTarget.startsWith(resolvedBase + path.sep);
    }

    // 解析梦操作里的日记路径，并强制校验其落在日记根目录内。
    // 路径来自 AI 在梦中生成的文本，必须视为不可信输入。
    function _resolveDiaryPath(fileUrl) {
        if (!fileUrl || typeof fileUrl !== 'string') {
            throw _createHttpError(400, '日记路径为空。');
        }
        let p = _urlToFilePath(fileUrl.trim());
        // 兼容相对路径（如 迈达斯/2026-08-02-01_28_59.txt）
        if (!path.isAbsolute(p)) {
            p = path.join(DAILY_NOTE_ROOT, p.replace(/\//g, path.sep));
        }
        const resolved = path.resolve(p);
        if (!_isPathWithinBase(resolved, DAILY_NOTE_ROOT)) {
            throw _createHttpError(400, `安全检查失败：目标不在日记目录内 → ${fileUrl}`);
        }
        return resolved;
    }

    // 拆分 "[文件夹]署名" 形式的 maid 字段。
    // 梦操作里的 agentName / suggestedMaid 往往已经带了索引前缀（如 "[迈达斯的梦]迈达斯"），
    // 直接再套一层 `[${maid}的梦]${maid}` 会产出畸形目录名并被模糊匹配到别的日记本。
    function _splitMaidSignature(raw) {
        const value = String(raw || '').trim();
        const match = value.match(/^\[([^\]]+)\]\s*(.*)$/);
        if (match) {
            return { folder: match[1].trim(), maid: (match[2] || match[1]).trim() };
        }
        return { folder: null, maid: value };
    }

    // 归一化日期。梦操作里的 suggestedDate 可能是 "20260802" 这种紧凑格式。
    function _normalizeDateString(raw) {
        const value = String(raw || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
        const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
        const loose = value.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
        if (loose) {
            return `${loose[1]}-${String(loose[2]).padStart(2, '0')}-${String(loose[3]).padStart(2, '0')}`;
        }
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    // 写日记。DailyNoteWrite 插件已退役（见 CHANGELOG：写回链路收敛为仅调用 DailyNote 工具），
    // 且 DailyNote 是 hybridservice/direct，executePlugin 只支持 stdio 插件，必须走 processToolCall。
    async function _createDiaryViaDailyNote({ folder, maid, dateString, content }) {
        const args = {
            command: 'create',
            maid: maid || '未知',
            Date: dateString,
            Content: content || ''
        };
        if (folder) args.folder = folder; // folder 优先级高于 maid 的 [文件夹] 前缀，避免模糊匹配

        // processToolCall 的契约：direct 插件成功时**拆包**返回内层 result 对象（不带 status 字段），
        // 失败时直接 throw。不能按 res.status === 'success' 判定，否则成功会被误判成失败。
        const res = await pluginManager.processToolCall('DailyNote', args, null, 'admin/dream-approve');
        if (res && res.status === 'error') {
            throw new Error(res.error || res.message || 'DailyNote 插件返回错误');
        }
        return res || {};
    }

    // 软删除：把日记移动到 dailynote/已整理/，而不是 fs.unlink 硬删。
    // 梦操作的内容由 AI 生成，合并后的新日记可能丢失或篡改原文细节，必须保留可回滚的余地。
    async function _archiveDiary(diaryPath) {
        const archiveDir = path.join(DAILY_NOTE_ROOT, ARCHIVE_FOLDER);
        if (!_isPathWithinBase(archiveDir, DAILY_NOTE_ROOT)) {
            throw new Error('归档文件夹路径无效。');
        }
        await fs.mkdir(archiveDir, { recursive: true });

        await fs.access(diaryPath); // 不存在则抛错，由调用方处理

        const baseFileName = path.basename(diaryPath);
        const ext = path.extname(baseFileName);
        const nameWithoutExt = path.basename(baseFileName, ext);
        let destPath = path.join(archiveDir, baseFileName);
        let counter = 1;
        while (counter <= 50) {
            try {
                await fs.access(destPath);
                counter++;
                destPath = path.join(archiveDir, `${nameWithoutExt}(${counter})${ext}`);
            } catch {
                break; // 目标不存在，可用
            }
        }

        try {
            await fs.rename(diaryPath, destPath);
        } catch {
            // 跨设备等 rename 失败场景，退化为 copy + unlink
            await fs.copyFile(diaryPath, destPath);
            await fs.unlink(diaryPath);
        }

        // 从向量库摘除，使其不再被召回
        if (vectorDBManager && typeof vectorDBManager.removeDocument === 'function') {
            try { await vectorDBManager.removeDocument(diaryPath); } catch (e) { /* ignore */ }
        }

        return destPath;
    }

    async function _processDreamOperation(filename, opId, action) {
        if (!filename || !filename.endsWith('.json')) {
            throw _createHttpError(400, 'Invalid filename.');
        }

        if (action !== 'approve' && action !== 'reject') {
            throw _createHttpError(400, 'Invalid action.');
        }

        const filePath = path.join(DREAM_LOGS_DIR, filename);
        const content = await fs.readFile(filePath, 'utf-8');
        const dreamLog = JSON.parse(content);
        const operations = dreamLog.operations || [];
        const operation = operations.find(o => o.operationId === opId);

        if (!operation) {
            throw _createHttpError(404, `操作 ${opId} 未找到。`);
        }
        if (operation.status !== 'pending_review') {
            throw _createHttpError(400, `操作 ${opId} 已被处理 (${operation.status})，无法重复审批。`);
        }

        if (action === 'reject') {
            operation.status = 'rejected';
            operation.reviewedAt = new Date().toISOString();
            await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
            return { status: 'success', message: `操作 ${opId} 已拒绝。`, operation };
        }

        let result = {};

        switch (operation.type) {
            case 'merge': {
                // agentName 可能是 "[迈达斯的梦]迈达斯"，合并后的日记应回到 Agent 自己的主日记本
                const { maid } = _splitMaidSignature(dreamLog.agentName || '未知');
                const dateStr = _normalizeDateString(operation.suggestedDate);

                try {
                    result.newDiary = await _createDiaryViaDailyNote({
                        folder: maid,
                        maid,
                        dateString: dateStr,
                        content: operation.newContent || ''
                    });
                } catch (e) {
                    operation.status = 'error';
                    operation.error = `创建合并日记失败: ${e.message}`;
                    operation.reviewedAt = new Date().toISOString();
                    await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                    throw _createHttpError(500, operation.error);
                }

                const archiveResults = [];
                for (const diaryUrl of (operation.sourceDiaries || [])) {
                    try {
                        const diaryPath = _resolveDiaryPath(diaryUrl);
                        const destPath = await _archiveDiary(diaryPath);
                        archiveResults.push({
                            path: diaryUrl,
                            archived: true,
                            archivedTo: path.relative(DAILY_NOTE_ROOT, destPath)
                        });
                    } catch (e) {
                        archiveResults.push({ path: diaryUrl, archived: false, error: e.message });
                    }
                }
                result.archivedSources = archiveResults;
                break;
            }

            case 'delete': {
                try {
                    const targetPath = _resolveDiaryPath(operation.targetDiary || '');
                    const destPath = await _archiveDiary(targetPath);
                    result.archived = true;
                    result.archivedTo = path.relative(DAILY_NOTE_ROOT, destPath);
                } catch (e) {
                    operation.status = 'error';
                    operation.error = `归档日记失败: ${e.message}`;
                    operation.reviewedAt = new Date().toISOString();
                    await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                    throw _createHttpError(500, operation.error);
                }
                break;
            }

            case 'insight': {
                // 梦感悟写进 Agent 的梦境索引。若 suggestedMaid/agentName 已带 [X的梦] 前缀就沿用，
                // 否则才补一层 —— 绝不能无条件再包一次。
                const raw = operation.suggestedMaid || dreamLog.agentName || '未知';
                const { folder: parsedFolder, maid } = _splitMaidSignature(raw);
                const dreamFolder = parsedFolder || `${maid}的梦`;
                const dateStr = _normalizeDateString(operation.suggestedDate);

                try {
                    result.newDiary = await _createDiaryViaDailyNote({
                        folder: dreamFolder,
                        maid,
                        dateString: dateStr,
                        content: operation.insightContent || ''
                    });
                } catch (e) {
                    operation.status = 'error';
                    operation.error = `创建梦感悟失败: ${e.message}`;
                    operation.reviewedAt = new Date().toISOString();
                    await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
                    throw _createHttpError(500, operation.error);
                }
                break;
            }

            default:
                throw _createHttpError(400, `不支持的操作类型: ${operation.type}`);
        }

        operation.status = 'approved';
        operation.reviewedAt = new Date().toISOString();
        operation.result = result;
        await fs.writeFile(filePath, JSON.stringify(dreamLog, null, 2), 'utf-8');
        return { status: 'success', message: `操作 ${opId} 已批准并执行。`, operation };
    }

    // GET /dream-logs - 获取所有梦境日志文件列表（含简要元数据）
    router.get('/dream-logs', async (req, res) => {
        try {
            await fs.mkdir(DREAM_LOGS_DIR, { recursive: true });
            const files = await fs.readdir(DREAM_LOGS_DIR);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            const logs = [];
            for (const filename of jsonFiles) {
                try {
                    const filePath = path.join(DREAM_LOGS_DIR, filename);
                    const content = await fs.readFile(filePath, 'utf-8');
                    const data = JSON.parse(content);
                    const ops = data.operations || [];
                    
                    logs.push({
                        filename: filename,
                        agentName: data.agentName || '未知',
                        timestamp: data.timestamp || '',
                        operationCount: ops.length,
                        pendingCount: ops.filter(o => o.status === 'pending_review').length,
                        operationSummary: ops.map(o => ({ 
                            type: o.type, 
                            status: o.status 
                        }))
                    });
                } catch (e) {
                    console.error(`[AdminAPI] Skip corrupted log file ${filename}:`, e.message);
                }
            }

            // 按时间倒序排列
            logs.sort((a, b) => {
                const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return timeB - timeA;
            });

            res.json({ logs });
        } catch (error) {
            console.error('[AdminAPI] Error listing dream logs:', error);
            res.status(500).json({ error: 'Failed to list dream logs', details: error.message });
        }
    });

    // GET /dream-logs/:filename - 获取特定梦境日志文件内容
    router.get('/dream-logs/:filename', async (req, res) => {
        try {
            const filename = req.params.filename;
            if (!filename.endsWith('.json')) return res.status(400).json({ error: 'Invalid filename' });
            const logPath = path.join(DREAM_LOGS_DIR, filename);
            const content = await fs.readFile(logPath, 'utf-8');
            res.json(JSON.parse(content));
        } catch (error) {
            console.error('[AdminAPI] Error reading dream log:', error);
            res.status(500).json({ error: 'Failed to read dream log', details: error.message });
        }
    });

    // POST /dream-logs/batch-operations - 批量审批/拒绝 AgentDream 操作
    router.post('/dream-logs/batch-operations', async (req, res) => {
        const { action, operations } = req.body || {};

        if (action !== 'approve' && action !== 'reject') {
            return res.status(400).json({ error: 'Invalid action.' });
        }
        if (!Array.isArray(operations) || operations.length === 0) {
            return res.status(400).json({ error: 'operations must be a non-empty array.' });
        }

        const results = [];
        for (const item of operations) {
            const filename = item && item.filename;
            const operationId = item && (item.operationId || item.opId);

            try {
                const result = await _processDreamOperation(filename, operationId, action);
                results.push({
                    filename,
                    operationId,
                    ok: true,
                    message: result.message,
                    operation: result.operation
                });
            } catch (error) {
                results.push({
                    filename,
                    operationId,
                    ok: false,
                    error: error.message,
                    details: error.details
                });
            }
        }

        const successCount = results.filter(item => item.ok).length;
        res.json({
            status: successCount === results.length ? 'success' : 'partial_success',
            successCount,
            failedCount: results.length - successCount,
            results
        });
    });

    // POST /dream-logs/:filename/operations/:opId - 标记并处理 AgentDream 操作
    router.post('/dream-logs/:filename/operations/:opId', async (req, res) => {
        const opId = req.params.opId;
        const filename = req.params.filename;
        const { action } = req.body; // action: 'approve' or 'reject'

        try {
            const result = await _processDreamOperation(filename, opId, action);
            res.json(result);

        } catch (error) {
            console.error('[AdminAPI] Error processing dream operation:', error);
            res.status(error.status || 500).json({ error: error.message || 'Failed to process operation', details: error.details });
        }
    });

    return router;
};
