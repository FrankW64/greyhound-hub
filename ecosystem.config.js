'use strict';

// PM2 process manager configuration.
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 restart greyhound-hub
//   pm2 logs greyhound-hub
//   pm2 save          (persist across reboots)
//   pm2 startup       (generate systemd unit)

module.exports = {
  apps: [
    {
      name:                'greyhound-hub',
      script:              'server.js',
      instances:           1,
      autorestart:         true,
      watch:               false,
      max_memory_restart:  '300M',

      // Production environment variables.
      // Secrets (BETFAIR_*, ODDS_API_KEY) must be in the .env file on the server.
      env_production: {
        NODE_ENV: 'production',
        PORT:     3000,
      },

      // PM2 log paths (defaults to ~/.pm2/logs/ if omitted)
      error_file:      './logs/err.log',
      out_file:        './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Restart policy
      min_uptime:    '5s',
      max_restarts:  10,
      restart_delay: 4000,
    },
  ],
};
