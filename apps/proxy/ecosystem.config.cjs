// PM2 process config — mirrors the shoyu-chat deploy pattern on the same
// droplet (see ../../docs/related-repos.md). Deployed at /home/an-an on
// the server; `pm2 start ecosystem.config.cjs --env production`.
module.exports = {
  apps: [
    {
      name: 'an-an-proxy',
      script: 'apps/proxy/dist/server.js',
      cwd: __dirname + '/../..', // repo root — server.ts resolves data/ paths relative to its own file, not cwd, but pm2's cwd matters for any relative .env loading
      env_production: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      error_file: 'apps/proxy/logs/error.log',
      out_file: 'apps/proxy/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_memory_restart: '300M',
      kill_timeout: 5000,
      wait_ready: false,
      autorestart: true,
      watch: false,
    },
  ],
};
