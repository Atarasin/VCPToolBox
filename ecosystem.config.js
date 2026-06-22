const proxylessEnv = {
  NODE_ENV: 'production',
  // 显式清空代理变量，避免本地回环请求被错误转发到宿主代理。
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
  // 保留本地地址直连，防止 axios/fetch 等客户端走代理。
  NO_PROXY: 'localhost,127.0.0.1',
  no_proxy: 'localhost,127.0.0.1'
};

module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: '/home/zh/.nvm/versions/node/v22.15.1/bin/node ./server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: proxylessEnv,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'vcp-admin',
      script: '/home/zh/.nvm/versions/node/v22.15.1/bin/node ./adminServer.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: proxylessEnv,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
