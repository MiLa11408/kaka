module.exports = {
  apps: [{
    name: 'ember',
    script: 'server.js',
    cwd: '/home/ubuntu/ember',
    env: {
      PORT: 3600,
      HOST: '127.0.0.1',
    },
    autorestart: true,
    max_memory_restart: '220M',
    out_file: '/home/ubuntu/ember/data/out.log',
    error_file: '/home/ubuntu/ember/data/err.log',
    merge_logs: true,
    time: true,
  }],
};
