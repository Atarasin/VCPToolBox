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
      env: {
        NODE_ENV: 'production'
      },
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
      env: {
        NODE_ENV: 'production'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
