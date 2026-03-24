const path = require('path');

// 基础路径配置
// 如果未设置环境变量，则向上回溯到项目根目录
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH || path.resolve(__dirname, '../../../');

// 数据存储目录
const DATA_DIR = path.join(PROJECT_BASE_PATH, 'data', 'VCPCommunity');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const WIKI_DIR = path.join(DATA_DIR, 'wiki');
const DAILYNOTE_DIR = path.join(PROJECT_BASE_PATH, 'dailynote');

// 关键文件路径
const COMMUNITIES_FILE = path.join(CONFIG_DIR, 'communities.json');
const DEFAULT_COMMUNITIES_FILE = path.join(__dirname, '..', 'config', 'communities.json');
const PROPOSALS_FILE = path.join(CONFIG_DIR, 'proposals.json');
const MAINTAINER_INVITES_FILE = path.join(CONFIG_DIR, 'maintainer_invites.json');
const WIKI_DAILYNOTE_MAPPINGS_FILE = path.join(CONFIG_DIR, 'wiki_dailynote_mappings.json');

module.exports = {
  PROJECT_BASE_PATH,
  DATA_DIR,
  CONFIG_DIR,
  POSTS_DIR,
  WIKI_DIR,
  DAILYNOTE_DIR,
  COMMUNITIES_FILE,
  DEFAULT_COMMUNITIES_FILE,
  PROPOSALS_FILE,
  MAINTAINER_INVITES_FILE,
  WIKI_DAILYNOTE_MAPPINGS_FILE,
};
