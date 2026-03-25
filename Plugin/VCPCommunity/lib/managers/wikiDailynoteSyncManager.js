/**
 * Wiki 到 DailyNote 的同步管理器模块
 * 
 * 此模块负责处理 Wiki 页面更新时，将相关内容同步至对应的 DailyNote 目录下的逻辑。
 * 它主要通过读取映射配置文件 `WIKI_DAILYNOTE_MAPPINGS_FILE` 来决定是否同步以及同步到哪个目录。
 * 其中包含了大量的路径校验和规范化逻辑，以确保文件系统操作的安全性，防止路径穿越等安全漏洞。
 */

const fs = require('fs').promises; // Node.js 原生 fs 模块的 Promise 版本，用于异步文件系统操作
const path = require('path');      // Node.js 原生 path 模块，用于处理文件和目录路径
const {
    DAILYNOTE_DIR,
    WIKI_DAILYNOTE_MAPPINGS_FILE,
    WIKI_DAILYNOTE_SYNC_RESULTS_FILE,
} = require('../constants'); // 引入常量配置：日记本目录和映射配置文件路径

/**
 * WikiDailynoteSyncManager 类
 * 
 * 核心同步管理类。
 * 负责解析映射规则、校验路径安全性，并将匹配的 Wiki 页面内容写入指定的 DailyNote 目录。
 */
class WikiDailynoteSyncManager {
    
    /**
     * 规范化相对路径
     * 
     * 将输入的字符串转换为安全的 POSIX 风格的相对路径，去除首尾斜杠并检查是否有路径穿越行为。
     * 
     * @param {string} input - 待规范化的路径字符串
     * @returns {string} 规范化后的安全相对路径
     * @throws {Error} 当输入为空或包含非法的相对路径符号（如 '..' 或 '.'）时抛出异常
     */
    normalizeRelativePath(input) {
        if (typeof input !== 'string' || !input.trim()) {
            throw new Error('映射路径不能为空。');
        }
        // 将反斜杠替换为斜杠，去除首尾的斜杠，并进行路径规范化
        const normalized = path.posix.normalize(input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, ''));
        
        // 安全检查：防止相对路径穿越到上级目录
        if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/..')) {
            throw new Error('映射路径非法。');
        }
        return normalized;
    }

    /**
     * 规范化单层目录名
     * 
     * 确保输入的目录名为合法的单层目录，不能包含路径分隔符。
     * 主要用于校验配置文件中配置的 dailynote_dir。
     * 
     * @param {string} input - 待规范化的目录名
     * @returns {string} 规范化并清理非法字符后的安全单层目录名
     * @throws {Error} 当目录名包含层级（包含 '/'）或只包含非法字符时抛出异常
     */
    normalizeSingleSegment(input) {
        const normalized = this.normalizeRelativePath(input);
        if (normalized.includes('/')) {
            throw new Error('dailynote_dir 仅允许单层目录名。');
        }
        // 将可能引发文件系统问题的特殊字符替换为下划线
        const safe = normalized.replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!safe) {
            throw new Error('dailynote_dir 非法。');
        }
        return safe;
    }

    /**
     * 规范化扁平化文件名
     * 
     * 将层级结构的 Wiki 页面路径扁平化为一个安全的文件名，并确保以 .md 结尾。
     * 例如将 'folder/sub/page.md' 转换为 'folder_sub_page.md'。
     * 
     * @param {string} input - 待扁平化和规范化的相对文件路径
     * @returns {string} 扁平化且以 .md 结尾的安全文件名
     * @throws {Error} 当文件名为空或全部为非法字符时抛出异常
     */
    normalizeFlatFileName(input) {
        if (typeof input !== 'string' || !input.trim()) {
            throw new Error('目标文件名非法。');
        }
        // 将路径中的 '/' 替换为 '_'，扁平化处理，并替换非法字符
        const replaced = input
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .split('/')
            .filter(Boolean)
            .join('_')
            .replace(/[\\:*?"<>|]/g, '_')
            .trim();
            
        if (!replaced || replaced === '.' || replaced === '..') {
            throw new Error('目标文件名非法。');
        }
        return replaced.endsWith('.md') ? replaced : `${replaced}.md`;
    }

    /**
     * 规范化 Wiki 前缀
     * 
     * 内部复用 normalizeRelativePath 进行基础安全性校验。
     * 
     * @param {string} input - 配置中定义的 Wiki 路径前缀
     * @returns {string} 规范化后的前缀字符串
     */
    normalizeWikiPrefix(input) {
        if (typeof input !== 'string' || !input.trim()) {
            return '';
        }
        return this.normalizeRelativePath(input);
    }

    /**
     * 检查给定的页面名是否匹配指定的 Wiki 前缀
     * 
     * 匹配逻辑：
     * 1. 页面名完全等同于前缀（通常前缀为目录）
     * 2. 前缀不带 .md 时，页面名加上 .md 后等于前缀（兼容根页面匹配）
     * 3. 如果前缀指定为具体的 .md 文件，则不再作为目录前缀进行后续匹配
     * 4. 页面名以前缀加斜杠开头（即属于前缀目录的子页面）
     * 
     * @param {string} pageName - 实际变更的 Wiki 页面名
     * @param {string} wikiPrefix - 配置中定义的匹配前缀
     * @returns {boolean} 是否匹配
     */
    matchesPrefix(pageName, wikiPrefix) {
        if (!wikiPrefix) return true;
        if (pageName === wikiPrefix) return true;
        if (!wikiPrefix.endsWith('.md') && pageName === `${wikiPrefix}.md`) return true;
        if (wikiPrefix.endsWith('.md')) return false;
        return pageName.startsWith(`${wikiPrefix}/`);
    }

    /**
     * 获取 Wiki 页面名去掉前缀后的相对部分
     * 
     * 根据不同的前缀匹配情况，提取页面相对前缀的独立名称，以供后续构建扁平化文件名使用。
     * 
     * @param {string} pageName - Wiki 页面完整路径
     * @param {string} wikiPrefix - 匹配上的前缀
     * @returns {string} 截取前缀后的相对名称或基底文件名
     */
    getRelativePart(pageName, wikiPrefix) {
        if (!wikiPrefix) {
            return pageName;
        }
        // 如果前缀是具体文件
        if (wikiPrefix.endsWith('.md')) {
            return path.posix.basename(pageName);
        }
        // 如果页面名完全等于前缀目录名
        if (pageName === wikiPrefix) {
            return path.posix.basename(pageName);
        }
        // 兼容页面名为 '前缀.md' 的根页面情况
        if (pageName === `${wikiPrefix}.md`) {
            return path.posix.basename(pageName);
        }
        // 截取前缀目录及其后面的斜杠
        return pageName.slice(wikiPrefix.length + 1);
    }

    /**
     * 解析并构建目标同步路径
     * 
     * 结合映射配置和触发变更的页面名，计算最终同步到 DailyNote 的目录和文件路径。
     * 其中包含了严格的路径安全校验，确保最终生成的文件被限制在预期的根目录内。
     * 
     * @param {Object} mapping - 单条映射配置对象
     * @param {string} pageName - Wiki 页面路径
     * @returns {Object|null} 包含目标目录、文件路径和匹配前缀的对象。如果不匹配则返回 null。
     * @throws {Error} 若计算出的路径跨越了预期的基准目录，抛出异常。
     */
    resolveTargetPath(mapping, pageName) {
        const wikiPrefix = this.normalizeWikiPrefix(mapping.wiki_prefix);
        if (!this.matchesPrefix(pageName, wikiPrefix)) {
            return null;
        }
        
        const dailynoteDir = this.normalizeSingleSegment(mapping.dailynote_dir);
        const relativePart = this.getRelativePart(pageName, wikiPrefix);
        const fileName = this.normalizeFlatFileName(relativePart);
        
        // 计算目标文件所在的目录绝对路径
        const targetDir = path.resolve(DAILYNOTE_DIR, dailynoteDir);
        // 计算目标文件的绝对路径
        const targetPath = path.resolve(targetDir, fileName);
        
        // 安全检查：确认最终写入路径没有逃逸出 DAILYNOTE_DIR
        const relativeDir = path.relative(DAILYNOTE_DIR, targetDir);
        const relativeFile = path.relative(targetDir, targetPath);
        if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
            throw new Error('目标目录非法。');
        }
        if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) {
            throw new Error('目标文件路径非法。');
        }
        
        return { targetDir, targetPath, wikiPrefix, dailynoteDir };
    }

    /**
     * 异步加载 Wiki 到 DailyNote 的映射配置
     * 
     * 从预配置的文件 WIKI_DAILYNOTE_MAPPINGS_FILE 中读取 JSON 格式的配置。
     * 如果文件不存在或格式不正确，则降级为默认禁用的配置状态。
     * 
     * @returns {Promise<Object>} 包含 enabled (布尔值) 和 mappings (数组) 的配置对象
     */
    async loadMappingsConfig() {
        try {
            const raw = await fs.readFile(WIKI_DAILYNOTE_MAPPINGS_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return { enabled: false, mappings: [] };
            }
            const enabled = parsed.enabled === true;
            const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : [];
            return { enabled, mappings };
        } catch (e) {
            // 文件不存在时，静默视为未配置/未启用映射功能
            if (e.code === 'ENOENT') {
                return { enabled: false, mappings: [] };
            }
            throw e;
        }
    }

    async loadSyncResults() {
        try {
            const raw = await fs.readFile(WIKI_DAILYNOTE_SYNC_RESULTS_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            if (e.code === 'ENOENT') {
                return [];
            }
            throw e;
        }
    }

    async saveSyncResults(records) {
        await fs.writeFile(WIKI_DAILYNOTE_SYNC_RESULTS_FILE, JSON.stringify(records, null, 2), 'utf-8');
    }

    async persistSyncResult(record) {
        await fs.mkdir(path.dirname(WIKI_DAILYNOTE_SYNC_RESULTS_FILE), { recursive: true });
        const records = await this.loadSyncResults();
        records.push(record);
        const maxRecords = 2000;
        const trimmed = records.length > maxRecords ? records.slice(records.length - maxRecords) : records;
        await this.saveSyncResults(trimmed);
    }

    /**
     * 同步 Wiki 页面内容到 DailyNote
     * 
     * 核心业务入口方法。该方法将依次进行：
     * 1. 加载映射配置并判断功能是否开启。
     * 2. 遍历所有配置项，寻找最佳匹配（最长前缀匹配）。
     * 3. 在目标 DailyNote 目录创建必要的文件夹，并将 Wiki 内容写入其中。
     * 
     * @param {Object} args - 同步参数对象
     * @param {string} args.communityId - 社区 ID，用于匹配配置中的 community_id
     * @param {string} args.pageName - 触发更新的 Wiki 页面路径名
     * @param {string} args.content - 待同步的最新页面内容
     * @returns {Promise<Object>} 同步结果对象，包含 status (synced|skipped|failed) 以及附带的路径或原因信息
     */
    async syncWikiPage({ communityId, pageName, content, agentName = '' }) {
        const now = Date.now();
        const recordBase = {
            ts: now,
            community_id: communityId,
            page_name: pageName,
            agent_name: agentName,
        };

        let result;
        try {
            const config = await this.loadMappingsConfig();
            if (!config.enabled) {
                result = { status: 'skipped', reason: 'mapping_disabled' };
            } else {
                let matchedCandidate = null;
                let invalidReason = null;
                for (const mapping of config.mappings) {
                    if (!mapping || typeof mapping !== 'object') continue;
                    if (mapping.community_id !== communityId) continue;
                    try {
                        const resolved = this.resolveTargetPath(mapping, pageName);
                        if (!resolved) continue;
                        if (!matchedCandidate || resolved.wikiPrefix.length > matchedCandidate.wikiPrefix.length) {
                            matchedCandidate = resolved;
                        }
                    } catch (e) {
                        invalidReason = e.message;
                    }
                }

                if (!matchedCandidate) {
                    if (invalidReason) {
                        result = { status: 'failed', reason: invalidReason };
                    } else {
                        result = { status: 'skipped', reason: 'mapping_not_matched' };
                    }
                } else {
                    await fs.mkdir(matchedCandidate.targetDir, { recursive: true });
                    await fs.writeFile(matchedCandidate.targetPath, content, 'utf-8');
                    result = {
                        status: 'synced',
                        target_path: matchedCandidate.targetPath,
                        wiki_prefix: matchedCandidate.wikiPrefix,
                        dailynote_dir: matchedCandidate.dailynoteDir,
                    };
                }
            }
        } catch (e) {
            result = { status: 'failed', reason: e.message || 'sync_unknown_error' };
        }

        try {
            await this.persistSyncResult({ ...recordBase, ...result });
        } catch (e) {
            return { status: 'failed', reason: `persist_failed: ${e.message}` };
        }
        return result;
    }
}

module.exports = WikiDailynoteSyncManager;
