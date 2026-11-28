module.exports = {
  apps: [{
    name: 'pigpen',
    script: 'server.js',
    cwd: '/home/ubuntu/pigpen',
    env: { PORT: 3700, HOST: '127.0.0.1', ADMIN_NAME: '米拉' },
    autorestart: true,
    max_memory_restart: '220M',
    time: true,
  }],
};
